import type { PlayerId, Vector3Tuple } from '@shared/types';
import type { ImpulseMessage, ServerMessage, SessionMemberInfo } from '@shared/net/messages';
import type { CharacterId } from '@shared/net/character';
import { generatePlayerId, generateResumeToken, generateSessionCode } from '@shared/net/ids';
import {
  ANIM_FLAG_AIRBORNE,
  ANIM_FLAG_SPRINT,
  MS_PER_TICK,
  POSITION_HISTORY_TICKS,
  RESUME_WINDOW_MS,
  SESSION_GC_GRACE_MS,
  SESSION_MAX_PLAYERS,
  SNAPSHOT_KEYFRAME_INTERVAL_MS,
} from '@shared/net/constants';
import {
  ENTITY_KIND,
  encodeSnapshot,
  patchSnapshotAck,
  quantizeEntity,
  type QuantEntityState,
} from '@shared/net/snapshot';
import type { Entity } from '@sim/components';
import { createGameWorld, type GameWorld } from '@sim/world';
import { EventQueue } from '@sim/events';
import { stepSim, type IntentsByPlayer, type PlayerIntent } from '@sim/step';
import { applyImpulse } from '@sim/prediction';
import { heightAt } from '@sim/terrain/terrainHeight';
import { PlayerInputQueue } from './inputQueue';
import { logger, type Logger } from './log';

/**
 * Session model (Phase 3): a party of ≤4 players behind a 6-char join code, each session
 * owning ONE isolated GameWorld stepped at a fixed 30 Hz (hub mode: movement + hub
 * collisions — the sim's existing hub branch). Players send binary InputCmds; the server
 * runs `stepSim` — the identical function the clients predict with — and broadcasts
 * binary snapshots at 20 Hz. SERVER OWNS every gameplay outcome; client transforms are
 * rejected by the protocol itself (the v1 relay messages no longer exist).
 *
 * Transport-agnostic: players hold a `PeerLink`, so unit tests drive sessions with fakes
 * and the ws layer stays in connection.ts/index.ts.
 */

export interface PeerLink {
  send(msg: ServerMessage): void;
  /** Binary hot path (snapshots). */
  sendBinary(data: ArrayBuffer): void;
}

/** One tick of an entity's position history (Phase 4 melee lag-comp rewinds this). */
export interface PosHistoryEntry {
  tick: number;
  pos: Vector3Tuple;
}

export interface SessionPlayer {
  id: PlayerId;
  name: string;
  character: CharacterId;
  resumeToken: string;
  link: PeerLink;
  /** EWMA RTT, ms. Null until the first heartbeat round-trip. */
  pingMs: number | null;
  joinedAt: number;
  /** The player's avatar in the session world. */
  entity: Entity;
  input: PlayerInputQueue;
  /** Authoritative state captured the tick each cmd is consumed — snapshot ack block.
   * Deliberately NOT the live state: starvation-coast ticks never contaminate it, so
   * client reconciliation always compares apples to apples. */
  ackState: { seq: number; pos: Vector3Tuple; vel: Vector3Tuple; rotY: number };
  /** Ring of the last POSITION_HISTORY_TICKS positions (Phase 4 lag-comp). */
  posHistory: PosHistoryEntry[];
}

interface DepartedPlayer {
  id: PlayerId;
  name: string;
  character: CharacterId;
  resumeToken: string;
  leftAt: number;
}

interface PendingImpulse {
  tick: number;
  entity: Entity;
  impulse: Vector3Tuple;
}

/** Spawn ring around the hub campfire — one slot per join order. */
const spawnPos = (index: number): Vector3Tuple => {
  const angle = (index % SESSION_MAX_PLAYERS) * (Math.PI / 2) + Math.PI / 4;
  return [Math.sin(angle) * 3.2, 0, Math.cos(angle) * 3.2];
};

const animFlagsFor = (e: Entity): number => {
  if (!e.transform || !e.velocity) return 0;
  const [x, y, z] = e.transform.position;
  const speed = Math.hypot(e.velocity.linear[0], e.velocity.linear[2]);
  let flags = 0;
  if (speed > 4.4) flags |= ANIM_FLAG_SPRINT;
  if (y > heightAt(x, z) + 0.06) flags |= ANIM_FLAG_AIRBORNE;
  return flags;
};

export class Session {
  readonly players = new Map<PlayerId, SessionPlayer>();
  /** Recently disconnected members, keyed by resumeToken (reconnect keeps playerId). */
  readonly departed = new Map<string, DepartedPlayer>();
  /** Set when the last player leaves; sessions are GC'd after the grace window. */
  emptySince: number | null = null;

  // ── Authoritative sim (one isolated world per session — never shared) ────────
  readonly world: GameWorld = createGameWorld();
  readonly events = new EventQueue();
  /** Fixed-tick counter; sim time = tick × MS_PER_TICK. NEVER wall clock inside the sim. */
  tick = 0;
  private spawnCounter = 0;
  private readonly pendingImpulses: PendingImpulse[] = [];

  // ── Snapshot baseline (keyframe the deltas diff against) ────────────────────
  private baseline = new Map<number, QuantEntityState>();
  private baselineTick = 0;
  private lastKeyframeAtMs = -Infinity;
  private keyframeRequested = true; // first snapshot is always a keyframe

  private readonly intents = new Map<Entity, PlayerIntent>();

  constructor(
    readonly code: string,
    readonly createdAt: number,
  ) {}

  get simNowMs(): number {
    return this.tick * MS_PER_TICK;
  }

  memberInfos(): SessionMemberInfo[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      character: p.character,
      entityId: p.entity.id!,
      ping: p.pingMs,
      connected: true,
    }));
  }

  broadcast(msg: ServerMessage, exceptId?: PlayerId): void {
    for (const player of this.players.values()) {
      if (player.id === exceptId) continue;
      player.link.send(msg);
    }
  }

  /** Spawn a player avatar into the session world. */
  attachAvatar(player: Omit<SessionPlayer, 'entity' | 'input' | 'ackState' | 'posHistory'>): SessionPlayer {
    const pos = spawnPos(this.spawnCounter++);
    const entity = this.world.add({
      transform: { position: [...pos] as Vector3Tuple, rotationY: Math.PI },
      velocity: { linear: [0, 0, 0] },
      health: { current: 100, max: 100 },
      faction: 'player',
      radius: 0.45,
      playerControlled: true,
      ownerId: player.id,
    });
    const full: SessionPlayer = {
      ...player,
      entity,
      input: new PlayerInputQueue(),
      ackState: { seq: 0, pos: [...pos] as Vector3Tuple, vel: [0, 0, 0], rotY: Math.PI },
      posHistory: [],
    };
    this.players.set(full.id, full);
    this.emptySince = null;
    // Membership changed → the next snapshot must be a keyframe (existence is
    // keyframe-authoritative and the joiner has no baseline yet).
    this.keyframeRequested = true;
    return full;
  }

  detachAvatar(player: SessionPlayer): void {
    this.world.remove(player.entity);
    this.keyframeRequested = true;
  }

  /**
   * Queue a server-initiated force on a player's avatar. Applied at the START of the
   * next tick and broadcast as a sequenced ImpulseMessage stamped with that tick, so the
   * owning client can inject it into its prediction replay stream (contract #3).
   */
  queueImpulse(playerId: PlayerId, impulse: Vector3Tuple): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const tick = this.tick + 1;
    this.pendingImpulses.push({ tick, entity: player.entity, impulse });
    // The owner's copy carries the replay seq (applied BEFORE that cmd's step); everyone
    // else just observes the shove through snapshots.
    for (const p of this.players.values()) {
      const msg: ImpulseMessage = {
        type: 'impulse',
        tick,
        entityId: player.entity.id!,
        impulse: [impulse[0], impulse[1], impulse[2]],
      };
      if (p.id === playerId) msg.seq = player.input.lastProcessedSeq + 1;
      p.link.send(msg);
    }
  }

  /** One fixed 30 Hz step: consume inputs → stepSim → capture ack states + history. */
  step(fixedDtSec: number): void {
    this.tick += 1;
    const now = this.simNowMs;

    // Server-initiated forces enter the sim at tick start (mirrors client replay order).
    for (let i = this.pendingImpulses.length - 1; i >= 0; i -= 1) {
      const p = this.pendingImpulses[i]!;
      if (p.tick <= this.tick) {
        applyImpulse(p.entity, p.impulse);
        this.pendingImpulses.splice(i, 1);
      }
    }

    this.intents.clear();
    const consumed: { player: SessionPlayer; seq: number | null }[] = [];
    for (const player of this.players.values()) {
      const result = player.input.consume();
      this.intents.set(player.entity, result.intent);
      consumed.push({ player, seq: result.seq });
    }

    stepSim(this.world, this.events, this.intents as IntentsByPlayer, fixedDtSec, now, 'hub');

    for (const { player, seq } of consumed) {
      const e = player.entity;
      if (!e.transform || !e.velocity) continue;
      if (seq !== null) {
        // Capture the post-cmd state — the reconciliation anchor for this player.
        player.ackState = {
          seq,
          pos: [...e.transform.position] as Vector3Tuple,
          vel: [...e.velocity.linear] as Vector3Tuple,
          rotY: e.transform.rotationY,
        };
      }
      player.posHistory.push({ tick: this.tick, pos: [...e.transform.position] as Vector3Tuple });
      if (player.posHistory.length > POSITION_HISTORY_TICKS) player.posHistory.shift();
    }

    // Hub mode emits no events today; drain defensively so nothing accumulates.
    this.events.reset();
  }

  /** Encode + send one snapshot per connected player (20 Hz, keyframe every 2 s). */
  broadcastSnapshots(): void {
    if (this.players.size === 0) return;
    const now = this.simNowMs;
    const keyframe = this.keyframeRequested || now - this.lastKeyframeAtMs >= SNAPSHOT_KEYFRAME_INTERVAL_MS;

    const states: QuantEntityState[] = [];
    for (const player of this.players.values()) {
      const e = player.entity;
      if (!e.transform || !e.velocity) continue;
      states.push(
        quantizeEntity({
          id: e.id!,
          kind: ENTITY_KIND.player,
          pos: e.transform.position,
          rotY: e.transform.rotationY,
          hp: e.health?.current ?? 0,
          vel: e.velocity.linear,
          flags: animFlagsFor(e),
        }),
      );
    }

    if (keyframe) {
      this.baseline = new Map(states.map((s) => [s.id, s]));
      this.baselineTick = this.tick;
      this.lastKeyframeAtMs = now;
      this.keyframeRequested = false;
    }

    const first = this.players.values().next().value as SessionPlayer;
    const buf = encodeSnapshot(
      {
        serverTick: this.tick,
        baselineTick: this.baselineTick,
        serverTimeMs: now,
        yourLastProcessedSeq: first.ackState.seq,
        ackPos: first.ackState.pos,
        ackVel: first.ackState.vel,
        ackRotY: first.ackState.rotY,
      },
      states,
      keyframe ? null : this.baseline,
    );

    for (const player of this.players.values()) {
      // Records are shared; only the ack block differs per recipient.
      const per = buf.slice(0);
      patchSnapshotAck(
        per,
        player.ackState.seq,
        player.ackState.pos,
        player.ackState.vel,
        player.ackState.rotY,
      );
      player.link.sendBinary(per);
    }
  }
}

export interface PlayerProfile {
  name: string;
  character: CharacterId;
}

export type JoinResult =
  | { ok: true; session: Session; player: SessionPlayer; resumed: boolean }
  | { ok: false; error: 'unknown_session' | 'session_full' };

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: Logger = logger,
  ) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) n += s.players.size;
    return n;
  }

  getSession(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  /** All live sessions — the sim/snapshot/roster loops iterate this. */
  allSessions(): IterableIterator<Session> {
    return this.sessions.values();
  }

  /** Advance every session's authoritative sim by one fixed step. */
  stepAll(fixedDtSec: number): void {
    for (const session of this.sessions.values()) session.step(fixedDtSec);
  }

  createSession(profile: PlayerProfile, link: PeerLink): { session: Session; player: SessionPlayer } {
    let code = generateSessionCode();
    while (this.sessions.has(code)) code = generateSessionCode(); // collision paranoia
    const session = new Session(code, this.now());
    this.sessions.set(code, session);
    const player = this.attach(session, profile, link, generatePlayerId());
    this.log.info('session_created', { code, playerId: player.id, name: player.name });
    return { session, player };
  }

  joinSession(code: string, profile: PlayerProfile, link: PeerLink, resumeToken?: string): JoinResult {
    const session = this.sessions.get(code);
    if (!session) return { ok: false, error: 'unknown_session' };

    // Resume path: a valid token within the window reclaims the departed playerId.
    if (resumeToken) {
      const departed = session.departed.get(resumeToken);
      if (departed && this.now() - departed.leftAt <= RESUME_WINDOW_MS) {
        session.departed.delete(resumeToken);
        if (session.players.size >= SESSION_MAX_PLAYERS) return { ok: false, error: 'session_full' };
        const player = this.attach(session, profile, link, departed.id, resumeToken);
        this.log.info('session_resumed', { code, playerId: player.id });
        return { ok: true, session, player, resumed: true };
      }
    }

    if (session.players.size >= SESSION_MAX_PLAYERS) return { ok: false, error: 'session_full' };
    const player = this.attach(session, profile, link, generatePlayerId());
    this.log.info('session_joined', { code, playerId: player.id, name: player.name, players: session.players.size });
    return { ok: true, session, player, resumed: false };
  }

  private attach(
    session: Session,
    profile: PlayerProfile,
    link: PeerLink,
    id: PlayerId,
    resumeToken = generateResumeToken(),
  ): SessionPlayer {
    const player = session.attachAvatar({
      id,
      name: profile.name,
      character: profile.character,
      resumeToken,
      link,
      pingMs: null,
      joinedAt: this.now(),
    });
    // Announce to the OTHERS — the joiner gets the full roster in its welcome.
    session.broadcast(
      {
        type: 'playerJoined',
        member: {
          id: player.id,
          name: player.name,
          character: player.character,
          entityId: player.entity.id!,
          ping: null,
          connected: true,
        },
      },
      player.id,
    );
    return player;
  }

  removePlayer(session: Session, playerId: PlayerId, reason: 'left' | 'disconnected'): void {
    const player = session.players.get(playerId);
    if (!player) return;
    session.detachAvatar(player);
    session.players.delete(playerId);
    session.departed.set(player.resumeToken, {
      id: player.id,
      name: player.name,
      character: player.character,
      resumeToken: player.resumeToken,
      leftAt: this.now(),
    });
    session.broadcast({ type: 'playerLeft', playerId, reason });
    if (session.players.size === 0) session.emptySince = this.now();
    this.log.info('session_left', { code: session.code, playerId, reason, players: session.players.size });
  }

  /** Drop sessions that have been empty past the grace window. Returns removed count. */
  gcSweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [code, session] of this.sessions) {
      if (session.emptySince !== null && now - session.emptySince >= SESSION_GC_GRACE_MS) {
        this.sessions.delete(code);
        removed += 1;
        this.log.info('session_gc', { code, ageMs: now - session.createdAt });
      }
      // Expire stale resume tokens regardless.
      for (const [token, departed] of session.departed) {
        if (now - departed.leftAt > RESUME_WINDOW_MS) session.departed.delete(token);
      }
    }
    return removed;
  }
}
