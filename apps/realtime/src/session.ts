import type { PlayerId, Vector3Tuple } from '@shared/types';
import type {
  ImpulseMessage,
  PlayerScoreWire,
  RelicFlightWire,
  RelicWelcomeState,
  ServerMessage,
  SessionMemberInfo,
} from '@shared/net/messages';
import type { CharacterId } from '@shared/net/character';
import { generatePlayerId, generateResumeToken, generateSessionCode } from '@shared/net/ids';
import {
  ANIM_FLAG_AIRBORNE,
  ANIM_FLAG_ATTACK,
  ANIM_FLAG_DODGE,
  ANIM_FLAG_DOWNED,
  ANIM_FLAG_HURT,
  ANIM_FLAG_RELIC_CATCH,
  ANIM_FLAG_RELIC_THROW,
  ANIM_FLAG_SPRINT,
  DEFAULT_IDLE_SESSION_TIMEOUT_MS,
  DEFAULT_MAX_SESSIONS,
  MON_AISTATE,
  MON_FLAG_ATTACK,
  MON_FLAG_STAGGER,
  MS_PER_TICK,
  POSITION_HISTORY_TICKS,
  RELIC_PHASE_FLAG,
  RESUME_WINDOW_MS,
  SESSION_GC_GRACE_MS,
  SESSION_MAX_PLAYERS,
  SIM_HZ,
  SNAPSHOT_KEYFRAME_INTERVAL_MS,
  ZONE_COUNTDOWN_SECONDS,
} from '@shared/net/constants';
import {
  MATERIAL_PER_PICKUP,
  NET_MELEE_PAD,
  RELIC_PASS_RANGE,
  RELIC_RELEASE_CONE_DEG,
  SCORE_PER_ENEMY_KILL,
} from '@shared/balance';
import {
  ACK_FLAG_DOWNED,
  ENTITY_KIND,
  encodeSnapshot,
  patchSnapshotAck,
  quantizeEntity,
  type QuantEntityState,
} from '@shared/net/snapshot';
import type { AiState, Entity } from '@sim/components';
import { createGameWorld, type GameWorld } from '@sim/world';
import { EventQueue, type GameEvent } from '@sim/events';
import { stepSim, type IntentsByPlayer, type PlayerIntent, type SimMode } from '@sim/step';
import { applyImpulse } from '@sim/prediction';
import { groundHeldRelic, spawnRelic } from '@sim/systems/relicSystem';
import { combatFromCmd } from '@shared/net/input';
import { heightAt } from '@sim/terrain/terrainHeight';
import { rewindPos } from './lagComp';
import { PlayerInputQueue } from './inputQueue';
import { makeServerCombatHooks, type CapturedHit } from './combatHooks';
import {
  makeMeleeRewind,
  viewTickFromMs,
  NET_LAGCOMP_MAX_TICKS,
  type HistorySample,
} from './lagComp';
import { logger, type Logger } from './log';

/** Where players spawn when the party enters the expedition (ring around the arena origin). */
const EXPEDITION_ORIGIN: Vector3Tuple = [0, 0, 0];

/** Where THE relic waits at expedition start (offset from the origin, ahead of the spawn ring). */
const RELIC_SPAWN: Vector3Tuple = [1.5, 0, -4];

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
  /** Hitstun window length, ms (monster-hit shoves; 0 for pure server knockback). */
  staggerMs: number;
}

interface PlayerRunStats {
  score: number;
  kills: number;
  damage: number;
}

/** Spawn ring around the hub campfire — one slot per join order. */
const spawnPos = (index: number): Vector3Tuple => {
  const angle = (index % SESSION_MAX_PLAYERS) * (Math.PI / 2) + Math.PI / 4;
  return [Math.sin(angle) * 3.2, 0, Math.cos(angle) * 3.2];
};

const REMOTE_HURT_ANIM_MS = 700;
const REMOTE_THROW_ANIM_MS = 550;

export const playerAnimFlagsFor = (e: Entity, now: number, relic?: Entity | null): number => {
  if (!e.transform || !e.velocity) return 0;
  const [x, y, z] = e.transform.position;
  const speed = Math.hypot(e.velocity.linear[0], e.velocity.linear[2]);
  let flags = 0;
  if (speed > 4.4) flags |= ANIM_FLAG_SPRINT;
  if (y > heightAt(x, z) + 0.06) flags |= ANIM_FLAG_AIRBORNE;
  if (e.downed) flags |= ANIM_FLAG_DOWNED;
  // Combat pose windows the server authors from the intent stream — remote clients play the
  // matching one-shot clip so a teammate's swing/roll is visible (not just locomotion).
  if (now < (e.attackAnimUntil ?? 0)) flags |= ANIM_FLAG_ATTACK;
  if (now < (e.dodgingUntil ?? 0)) flags |= ANIM_FLAG_DODGE;
  if (e.hitReactionAt !== undefined && now < e.hitReactionAt + REMOTE_HURT_ANIM_MS) {
    flags |= ANIM_FLAG_HURT;
  }
  if (now < (e.catchRootUntil ?? 0)) flags |= ANIM_FLAG_RELIC_CATCH;
  const relicState = relic?.relic;
  if (
    relicState?.phase === 'inFlight' &&
    relicState.thrower === e &&
    relicState.startedAt !== undefined &&
    now < relicState.startedAt + REMOTE_THROW_ANIM_MS
  ) {
    flags |= ANIM_FLAG_RELIC_THROW;
  }
  return flags;
};

/** Pack a monster's aiState + stagger/attack into the snapshot anim-flags byte (Phase 4). */
const monsterFlagsFor = (e: Entity, now: number): number => {
  const state: AiState = e.aiBrain?.state ?? 'idle';
  let flags = MON_AISTATE[state] ?? MON_AISTATE.idle;
  if ((e.staggerUntil ?? 0) > now) flags |= MON_FLAG_STAGGER;
  // A recent attack start drives the client lunge anim (window ≈ one attack cooldown-ish).
  if ((e.attackStartedAt ?? -Infinity) > now - 300) flags |= MON_FLAG_ATTACK;
  return flags;
};

export class Session {
  readonly players = new Map<PlayerId, SessionPlayer>();
  /** Recently disconnected members, keyed by resumeToken (reconnect keeps playerId). */
  readonly departed = new Map<string, DepartedPlayer>();
  /** Set when the last player leaves; sessions are GC'd after the grace window. */
  emptySince: number | null = null;
  /** Wall-clock ms of the last input frame from any member — feeds idle-session GC. */
  lastActivityAt: number;
  /** Bytes broadcast in the most recent snapshot tick (all recipients) — metrics probe. */
  lastSnapshotBytes = 0;

  // ── Authoritative sim (one isolated world per session — never shared) ────────
  readonly world: GameWorld = createGameWorld();
  readonly events = new EventQueue();
  /** Fixed-tick counter; sim time = tick × MS_PER_TICK. NEVER wall clock inside the sim. */
  tick = 0;
  private spawnCounter = 0;
  private readonly pendingImpulses: PendingImpulse[] = [];

  // ── Expedition combat state (Phase 4) ────────────────────────────────────────
  /** Party-wide zone. Hub = safe social space (movement only); expedition = full combat. */
  zone: SimMode = 'hub';
  /** Tick the expedition countdown fires on (null = no countdown running). Phase 6 Task 2. */
  private countdownEndsAtTick: number | null = null;
  /** Last whole-second value broadcast, so ticks only emit on a change. */
  private countdownLastSecond = -1;
  /** SHARED-POOL material tally — everyone's count. Server-authoritative (loot events only). */
  materials = 0;
  /** Per-expedition results, retained through the hub return for the MVP screen. */
  private readonly runStats = new Map<PlayerId, PlayerRunStats>();
  /** Confirmed hits captured from the sim this tick → DamageDealt/ParrySuccess wire events. */
  private readonly hitSink: CapturedHit[] = [];
  private readonly combatHooks = makeServerCombatHooks(this.hitSink, (target, impulse, staggerMs) =>
    this.queuePlayerImpulse(target, impulse, staggerMs),
  );
  /** Monster ids currently live in the world (spawn/despawn detection). */
  private readonly knownMonsters = new Set<number>();
  /** Projectile + pickup ids live last tick — their births are implicit in the snapshot, but
   * their deaths need a reliable `entityGone` so clients don't render a lingering corpse. */
  private readonly knownEntities = new Set<number>();
  /** entityId → position-history ring for LIVING monsters (lag-comp rewind target). */
  private readonly monsterHistory = new Map<number, HistorySample[]>();
  /** entityId → server tick a monster died at (kept briefly so a stale swing can't revive it). */
  private readonly monsterDeathTick = new Map<number, number>();
  /** attacker entityId → view tick recorded when its current swing started (lag-comp). */
  private readonly attackerViewTick = new Map<number, number>();
  /** Wave index observed last tick — a change emits WaveStarted. */
  private lastWave = -1;

  // ── Relic (Phase 5): server-authoritative state machine, one per session ────
  /** THE relic entity in the world (expedition only; null in the hub). */
  private relicEntity: Entity | null = null;
  /**
   * Last relic state we broadcast, so `syncRelicEvents` diffs the sim's relic each tick and
   * emits reliable events on transitions — flight starts (new `startedAt`), catches (new
   * carrier), fails, grounds. State-diffing keeps the sim itself untouched (solo byte-identical).
   */
  private relicWire = { phase: '' as string, startedAt: -1, carrierId: -1, failedAt: -1 };
  /** Reason to attach to the NEXT lob launch the diff detects (intentional G vs disconnect). */
  private pendingLobReason: 'intentional' | 'disconnect' | null = null;

  // ── Snapshot baseline (keyframe the deltas diff against) ────────────────────
  private baseline = new Map<number, QuantEntityState>();
  private baselineTick = 0;
  private lastKeyframeAtMs = -Infinity;
  private keyframeRequested = true; // first snapshot is always a keyframe

  private readonly intents = new Map<Entity, PlayerIntent>();

  constructor(
    readonly code: string,
    readonly createdAt: number,
  ) {
    this.lastActivityAt = createdAt;
  }

  get simNowMs(): number {
    return this.tick * MS_PER_TICK;
  }

  /** Record that a member is actively sending input (idle-GC keepalive). */
  markActivity(nowWall: number): void {
    this.lastActivityAt = nowWall;
  }

  /** Event-queue depth this session drained last tick — a backpressure metric. */
  get eventQueueDepth(): number {
    return this.lastDrainedCount;
  }
  private lastDrainedCount = 0;

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

  scoreStandings(): PlayerScoreWire[] {
    return [...this.players.values()]
      .sort((a, b) => {
        const sa = this.runStats.get(a.id) ?? { score: 0, kills: 0, damage: 0 };
        const sb = this.runStats.get(b.id) ?? { score: 0, kills: 0, damage: 0 };
        return (
          sb.score - sa.score ||
          sb.damage - sa.damage ||
          a.joinedAt - b.joinedAt ||
          a.id.localeCompare(b.id)
        );
      })
      .map((player) => {
        const stats = this.runStats.get(player.id) ?? { score: 0, kills: 0, damage: 0 };
        return { playerId: player.id, name: player.name, score: stats.score, kills: stats.kills };
      });
  }

  broadcast(msg: ServerMessage, exceptId?: PlayerId): void {
    for (const player of this.players.values()) {
      if (player.id === exceptId) continue;
      player.link.send(msg);
    }
  }

  /** Spawn a player avatar into the session world (at the current zone's origin ring). */
  attachAvatar(
    player: Omit<SessionPlayer, 'entity' | 'input' | 'ackState' | 'posHistory'>,
  ): SessionPlayer {
    const pos = this.playerSpawnPos(this.spawnCounter++);
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
    if (!this.runStats.has(full.id)) {
      this.runStats.set(full.id, { score: 0, kills: 0, damage: 0 });
    }
    this.emptySince = null;
    // Membership changed → the next snapshot must be a keyframe (existence is
    // keyframe-authoritative and the joiner has no baseline yet).
    this.keyframeRequested = true;
    return full;
  }

  detachAvatar(player: SessionPlayer): void {
    this.world.remove(player.entity);
    this.attackerViewTick.delete(player.entity.id!);
    this.keyframeRequested = true;
  }

  /** A spawn slot in the current zone: the hub campfire ring, or the expedition origin ring. */
  private playerSpawnPos(index: number): Vector3Tuple {
    if (this.zone === 'expedition') {
      const angle = (index % SESSION_MAX_PLAYERS) * (Math.PI / 2) + Math.PI / 4;
      return [
        EXPEDITION_ORIGIN[0] + Math.sin(angle) * 2.5,
        0,
        EXPEDITION_ORIGIN[2] + Math.cos(angle) * 2.5,
      ];
    }
    return spawnPos(index);
  }

  // ── Expedition-gate countdown (Phase 6 Task 2) ───────────────────────────────
  /** True while a countdown is ticking (drives the client's cancelable banner). */
  get countdownActive(): boolean {
    return this.countdownEndsAtTick !== null;
  }

  /** Any member at the gate pressed E: open the shared 5 s countdown (hub only, once). */
  startExpeditionCountdown(): void {
    if (this.zone !== 'hub' || this.countdownEndsAtTick !== null) return;
    this.countdownEndsAtTick = this.tick + ZONE_COUNTDOWN_SECONDS * SIM_HZ;
    this.countdownLastSecond = ZONE_COUNTDOWN_SECONDS;
    this.broadcast({
      type: 'zoneCountdown',
      active: true,
      secondsLeft: ZONE_COUNTDOWN_SECONDS,
      serverTick: this.tick,
    });
  }

  /** Any member cancels the countdown before it fires. No-op if none is running. */
  cancelCountdown(): void {
    if (this.countdownEndsAtTick === null) return;
    this.countdownEndsAtTick = null;
    this.countdownLastSecond = -1;
    this.broadcast({ type: 'zoneCountdown', active: false, secondsLeft: 0, serverTick: this.tick });
  }

  /** Return the party to the hub on demand (hunt-failed overlay / expedition exit). */
  returnToHub(): void {
    this.cancelCountdown();
    this.enterZone('hub');
  }

  /** Advance a running countdown one tick; fires the zone flip at zero. Called each hub tick. */
  private advanceCountdown(): void {
    if (this.countdownEndsAtTick === null) return;
    const ticksLeft = this.countdownEndsAtTick - this.tick;
    if (ticksLeft <= 0) {
      this.countdownEndsAtTick = null;
      this.countdownLastSecond = -1;
      this.enterZone('expedition');
      return;
    }
    const secondsLeft = Math.ceil(ticksLeft / SIM_HZ);
    if (secondsLeft !== this.countdownLastSecond) {
      this.countdownLastSecond = secondsLeft;
      this.broadcast({ type: 'zoneCountdown', active: true, secondsLeft, serverTick: this.tick });
    }
  }

  /**
   * Move the WHOLE party between the hub and an expedition (Phase 4, Task 1). On entry the
   * server resets combat state, reseeds the deterministic spawner, and teleports every
   * player to the zone origin; the next snapshot is a keyframe (existence + a hard teleport)
   * and a reliable `zoneChanged` announces it. No-op if already in the target zone.
   */
  enterZone(zone: SimMode): void {
    if (zone === this.zone) return;
    this.zone = zone;

    // Purge all expedition entities (monsters, projectiles, pickups, relic) and bookkeeping.
    for (const m of [...this.world.with('monster')]) this.world.remove(m);
    for (const p of [...this.world.with('projectile')]) this.world.remove(p);
    for (const pk of [...this.world.with('pickup')]) this.world.remove(pk);
    for (const r of [...this.world.with('relic')]) this.world.remove(r);
    this.relicEntity = null;
    this.relicWire = { phase: '', startedAt: -1, carrierId: -1, failedAt: -1 };
    this.pendingLobReason = null;
    this.knownMonsters.clear();
    this.knownEntities.clear();
    this.monsterHistory.clear();
    this.monsterDeathTick.clear();
    this.attackerViewTick.clear();
    this.hitSink.length = 0;
    this.lastWave = -1;
    // Reseed the wave progression so each expedition starts at wave 1.
    this.world.spawn.wave = 0;
    this.world.spawn.nextSpawnAt = 0;
    this.world.spawn.started = false;

    // Reset + reposition every player at the zone origin (full heal on entry).
    let i = 0;
    for (const player of this.players.values()) {
      const e = player.entity;
      const pos = this.playerSpawnPos(i++);
      if (e.transform) {
        e.transform.position = [...pos] as Vector3Tuple;
        e.transform.rotationY = Math.PI;
      }
      if (e.velocity) e.velocity.linear = [0, 0, 0];
      if (e.health) e.health.current = e.health.max;
      e.downed = false;
      e.reviveProgressMs = 0;
      e.knockback = undefined;
      e.staggerUntil = 0;
      // The reconciliation anchor must jump with the avatar or the client would "correct"
      // back to the old zone; a >TELEPORT_EPSILON delta is the one sanctioned hard snap.
      player.ackState = {
        seq: player.ackState.seq,
        pos: [...pos] as Vector3Tuple,
        vel: [0, 0, 0],
        rotY: Math.PI,
      };
      player.posHistory = [];
    }
    // Spawn THE relic, grounded, when entering the expedition (Task 1). Its EXISTENCE and
    // grounded phase ride the snapshot (kind=relic, phase in the flags byte) + the welcome
    // block for late joiners — no separate spawn broadcast, so the combat/relay send stream
    // isn't perturbed by an extra reliable frame. Carrier binding + flight arcs are events.
    if (zone === 'expedition') {
      this.runStats.clear();
      for (const player of this.players.values()) {
        this.runStats.set(player.id, { score: 0, kills: 0, damage: 0 });
      }
      this.relicEntity = spawnRelic(this.world, RELIC_SPAWN);
      this.relicWire = {
        phase: 'grounded',
        startedAt: -1,
        carrierId: -1,
        failedAt: -1,
      };
    }

    this.keyframeRequested = true;
    this.broadcast({ type: 'zoneChanged', zone, serverTick: this.tick });
    logger.info('zone_changed', { code: this.code, zone, players: this.players.size });
  }

  /**
   * Queue a server-initiated force on a player's avatar. Applied at the START of the
   * next tick and broadcast as a sequenced ImpulseMessage stamped with that tick, so the
   * owning client can inject it into its prediction replay stream (contract #3).
   */
  queueImpulse(playerId: PlayerId, impulse: Vector3Tuple, staggerMs = 0): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const tick = this.tick + 1;
    this.pendingImpulses.push({ tick, entity: player.entity, impulse, staggerMs });
    // The owner's copy carries the replay seq (applied BEFORE that cmd's step); everyone
    // else just observes the shove through snapshots.
    for (const p of this.players.values()) {
      const msg: ImpulseMessage = {
        type: 'impulse',
        tick,
        entityId: player.entity.id!,
        impulse: [impulse[0], impulse[1], impulse[2]],
        staggerMs,
      };
      if (p.id === playerId) msg.seq = player.input.lastProcessedSeq + 1;
      p.link.send(msg);
    }
  }

  /** Route a deferred monster-hit shove on a player into the sequenced impulse pipeline. */
  private queuePlayerImpulse(target: Entity, impulse: Vector3Tuple, staggerMs: number): void {
    for (const p of this.players.values()) {
      if (p.entity === target) {
        this.queueImpulse(p.id, impulse, staggerMs);
        return;
      }
    }
  }

  /** One fixed 30 Hz step: consume inputs → stepSim (zone-scoped, lag-comp) → wire events. */
  step(fixedDtSec: number): void {
    this.tick += 1;
    const now = this.simNowMs;

    // Server-initiated forces enter the sim at tick start (mirrors client replay order).
    for (let i = this.pendingImpulses.length - 1; i >= 0; i -= 1) {
      const p = this.pendingImpulses[i]!;
      if (p.tick <= this.tick) {
        applyImpulse(p.entity, p.impulse, p.staggerMs > 0 ? now + p.staggerMs : undefined);
        this.pendingImpulses.splice(i, 1);
      }
    }

    // Build intents from the jitter buffer; in expedition, decode combat verbs + record the
    // attacker's view tick for lag comp (the swing's rewind target).
    this.intents.clear();
    const consumed: { player: SessionPlayer; seq: number | null }[] = [];
    for (const player of this.players.values()) {
      const result = player.input.consume();
      const intent: PlayerIntent = { ...result.intent };
      if (this.zone === 'expedition' && result.cmd) {
        const c = combatFromCmd(result.cmd);
        intent.melee = c.melee;
        intent.ranged = c.ranged;
        intent.parry = c.parry;
        intent.drop = c.drop;
        intent.revive = c.revive;
        // Holding pass-aim steadies the carried relic anchor (cosmetic; matches solo feel).
        intent.passAiming = c.passHold;
        // Position-independent yaw → the sim faces exactly the same on server, client, and
        // every reconciliation replay (an aimAt world point would drift the lunge on rewind).
        intent.aimYaw = c.aimYaw;
        // Record the view tick at each melee PRESS — the whole swing rewinds to what the
        // attacker saw when they pressed (clamped to the ≤200 ms policy window on read).
        if (c.melee) {
          const view = Math.max(
            this.tick - NET_LAGCOMP_MAX_TICKS,
            Math.min(this.tick, viewTickFromMs(c.viewServerTimeMs)),
          );
          this.attackerViewTick.set(player.entity.id!, view);
        }
        // Relic pass release: a non-zero passTargetId is "throw to this receiver THIS tick".
        // The server validates (carrier / target alive / range+cone vs the target's lag-comp
        // rewound position / rotation rule) and only then hands the sim a passTo intent; an
        // invalid attempt is rejected back to the thrower (Task 2). The flight itself is
        // computed inside stepSim's passRelic using the SERVER-predicted live catch position.
        if (c.passTargetId !== 0) {
          const target = this.validatePass(player, c.passTargetId, c.aimYaw, c.viewServerTimeMs);
          if (target) intent.passTo = target;
        }
        // Intentional G-drop by the current carrier → tag the lob so syncRelicEvents can
        // announce it as a RelicDropped (the sim lobs it inside stepSim).
        if (c.drop && this.carriedRelic(player.entity)) this.pendingLobReason = 'intentional';
      }
      this.intents.set(player.entity, intent);
      consumed.push({ player, seq: result.seq });
    }

    if (this.zone === 'hub') {
      stepSim(this.world, this.events, this.intents as IntentsByPlayer, fixedDtSec, now, 'hub');
      this.captureAckStatesAndHistory(consumed);
      this.lastDrainedCount = 0;
      this.events.reset(); // hub emits no events today; drain defensively
      this.advanceCountdown(); // may enterZone('expedition') when it reaches zero
      return;
    }

    // ── Expedition: full authoritative combat with lag-compensated melee. ────────
    this.hitSink.length = 0;
    const rewind = makeMeleeRewind({
      currentTick: this.tick,
      history: this.monsterHistory,
      deathTick: this.monsterDeathTick,
      viewTickOf: (id) => this.attackerViewTick.get(id),
    });
    const drained = stepSim(
      this.world,
      this.events,
      this.intents as IntentsByPlayer,
      fixedDtSec,
      now,
      'expedition',
      this.combatHooks,
      { authority: 'server', melee: { rewind, pad: NET_MELEE_PAD } },
    );

    this.captureAckStatesAndHistory(consumed);
    this.lastDrainedCount = drained.length;
    this.recordMonsterHistory();
    this.emitCombatEvents(drained);
    this.detectSpawnsAndWaves();
    this.detectEntityDespawns();
    this.syncRelicEvents(now);
    this.checkHuntFailed();
  }

  /** Reliable removal signal for projectiles/pickups gone since last tick (see knownEntities). */
  private detectEntityDespawns(): void {
    const current = new Set<number>();
    for (const p of this.world.with('projectile', 'transform'))
      if (p.id !== undefined) current.add(p.id);
    for (const pk of this.world.with('pickup', 'transform'))
      if (pk.id !== undefined) current.add(pk.id);
    for (const id of this.knownEntities) {
      if (!current.has(id)) this.broadcast({ type: 'entityGone', serverTick: this.tick, id });
    }
    this.knownEntities.clear();
    for (const id of current) this.knownEntities.add(id);
  }

  /** Live monster roster (id → archetype) for a joiner's welcome — they missed the spawn events
   * that teach the client which model to render, so without this their monsters default wrong. */
  monsterRoster(): { id: number; archetype: string }[] {
    const out: { id: number; archetype: string }[] = [];
    for (const m of this.world.with('monster', 'transform')) {
      if (m.id !== undefined) out.push({ id: m.id, archetype: m.monster ?? 'chaser' });
    }
    return out;
  }

  /** Capture per-player reconciliation anchors + the position-history ring (Phase 3 seam). */
  private captureAckStatesAndHistory(
    consumed: { player: SessionPlayer; seq: number | null }[],
  ): void {
    for (const { player, seq } of consumed) {
      const e = player.entity;
      if (!e.transform || !e.velocity) continue;
      if (seq !== null) {
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
  }

  /** Record every living monster's position into its lag-comp ring; GC stale death ticks. */
  private recordMonsterHistory(): void {
    for (const m of this.world.with('monster', 'transform')) {
      if (m.id === undefined) continue;
      let ring = this.monsterHistory.get(m.id);
      if (!ring) {
        ring = [];
        this.monsterHistory.set(m.id, ring);
      }
      ring.push({ tick: this.tick, pos: [...m.transform.position] as Vector3Tuple });
      if (ring.length > POSITION_HISTORY_TICKS) ring.shift();
    }
    // Forget deaths older than the rewind window (their corpses can no longer be hit).
    for (const [id, tick] of this.monsterDeathTick) {
      if (this.tick - tick > NET_LAGCOMP_MAX_TICKS + 2) {
        this.monsterDeathTick.delete(id);
        this.monsterHistory.delete(id);
        this.attackerViewTick.delete(id);
      }
    }
  }

  /** Translate the tick's captured hits + drained sim events into reliable wire events. */
  private emitCombatEvents(drained: readonly GameEvent[]): void {
    const ownerOf = (entityId: number | undefined): PlayerId | undefined => {
      if (entityId === undefined) return undefined;
      for (const p of this.players.values()) if (p.entity.id === entityId) return p.id;
      return undefined;
    };
    const playerIdOfAttacker = (attacker: Entity | undefined): PlayerId | undefined => {
      const owner = attacker?.projectileOwner ?? attacker;
      if (owner?.ownerId && this.players.has(owner.ownerId)) return owner.ownerId;
      return ownerOf(owner?.id);
    };

    // Confirmed hits/parries (from the sim's feel hooks the server captured).
    for (const h of this.hitSink) {
      const { ctx } = h;
      if (h.kind === 'parry') {
        const pid = ownerOf(ctx.target.id);
        if (pid) this.broadcast({ type: 'parrySuccess', serverTick: this.tick, playerId: pid });
        continue;
      }
      if (!ctx.target.playerControlled) {
        const scorerId = playerIdOfAttacker(ctx.attacker);
        if (scorerId) {
          const stats = this.runStats.get(scorerId) ?? { score: 0, kills: 0, damage: 0 };
          stats.damage += ctx.amount;
          if (ctx.lethal) {
            stats.kills += 1;
            stats.score += SCORE_PER_ENEMY_KILL;
            this.broadcast({
              type: 'scoreUpdated',
              serverTick: this.tick,
              scorerId,
              points: SCORE_PER_ENEMY_KILL,
              standings: this.scoreStandings(),
            });
          }
          this.runStats.set(scorerId, stats);
        }
      }
      this.broadcast({
        type: 'damageDealt',
        serverTick: this.tick,
        targetId: ctx.target.id ?? 0,
        targetKind: ctx.target.playerControlled ? 'player' : 'monster',
        sourceId: ctx.attacker?.id ?? 0,
        amount: ctx.amount,
        strength: ctx.strength,
        crit: ctx.crit,
        point: [ctx.point[0], ctx.point[1], ctx.point[2]],
        dir: [ctx.dirX, ctx.dirZ],
      });
    }

    // Discrete sim events → wire.
    for (const ev of drained) {
      switch (ev.type) {
        case 'MonsterKilled': {
          if (ev.id !== undefined) {
            this.monsterDeathTick.set(ev.id, this.tick);
            this.knownMonsters.delete(ev.id);
          }
          this.broadcast({
            type: 'monsterDespawned',
            serverTick: this.tick,
            id: ev.id ?? 0,
            reason: 'killed',
            pos: [ev.position[0], ev.position[1], ev.position[2]],
          });
          this.keyframeRequested = true; // existence changed — resync the baseline
          break;
        }
        case 'PlayerDowned': {
          const pid = ownerOf(ev.id);
          if (pid) this.broadcast({ type: 'playerDowned', serverTick: this.tick, playerId: pid });
          break;
        }
        case 'PlayerRevived': {
          const pid = ownerOf(ev.id);
          if (pid) this.broadcast({ type: 'playerRevived', serverTick: this.tick, playerId: pid });
          break;
        }
        case 'MaterialCollected': {
          this.materials += MATERIAL_PER_PICKUP;
          this.broadcast({
            type: 'materialTally',
            serverTick: this.tick,
            tableId: ev.tableId,
            total: this.materials,
          });
          this.keyframeRequested = true; // the pickup entity was removed
          break;
        }
        case 'RelicErupted': {
          this.broadcast({
            type: 'relicErupted',
            serverTick: this.tick,
            holderId: ev.holderId,
            pos: [ev.position[0], ev.position[1], ev.position[2]],
          });
          break;
        }
        case 'RelicVolatileDischarge': {
          this.broadcast({
            type: 'relicVolatileDischarge',
            serverTick: this.tick,
            holderId: ev.holderId,
            pos: [ev.position[0], ev.position[1], ev.position[2]],
            radius: ev.radius,
            tierIndex: ev.tierIndex,
          });
          break;
        }
        default:
          break; // LootDropped is internal (spawns a pickup entity, replicated by snapshot)
      }
    }
  }

  /** Detect monsters that spawned this tick + wave rollovers → MonsterSpawned / WaveStarted. */
  private detectSpawnsAndWaves(): void {
    let spawnedThisTick = 0;
    for (const m of this.world.with('monster', 'transform')) {
      if (m.id === undefined || this.knownMonsters.has(m.id)) continue;
      this.knownMonsters.add(m.id);
      this.monsterDeathTick.delete(m.id);
      spawnedThisTick += 1;
      this.broadcast({
        type: 'monsterSpawned',
        serverTick: this.tick,
        id: m.id,
        archetype: m.monster ?? 'chaser',
        pos: [m.transform.position[0], m.transform.position[1], m.transform.position[2]],
      });
    }
    if (spawnedThisTick > 0) {
      this.keyframeRequested = true; // existence changed
      // spawnSystem bumps world.spawn.wave AFTER placing a wave, so the wave that just
      // spawned is the prior index; display it 1-indexed.
      const displayWave = Math.max(1, this.world.spawn.wave);
      if (displayWave !== this.lastWave) {
        this.lastWave = displayWave;
        this.broadcast({
          type: 'waveStarted',
          serverTick: this.tick,
          wave: displayWave,
          count: this.knownMonsters.size,
        });
      }
    }
  }

  /** All party members downed → the hunt failed; announce it and return the party to the hub. */
  private checkHuntFailed(): void {
    if (this.players.size === 0) return;
    let anyAlive = false;
    for (const p of this.players.values()) {
      if (!p.entity.downed) {
        anyAlive = true;
        break;
      }
    }
    if (anyAlive) return;
    const standings = this.scoreStandings();
    this.broadcast({
      type: 'huntFailed',
      serverTick: this.tick,
      standings,
      mvpPlayerId: standings[0]?.playerId ?? null,
    });
    this.enterZone('hub');
  }

  // ── Relic relay (Phase 5) ────────────────────────────────────────────────────

  /** The relic held by `carrier` right now, or null. */
  private carriedRelic(carrier: Entity): Entity | null {
    const r = this.relicEntity;
    return r?.relic?.phase === 'carried' && r.relic.carrier === carrier ? r : null;
  }

  /**
   * Validate a pass intent server-side (Task 2). The thrower must be the carrier; the target
   * must be a living OTHER player, eligible (rotation rule), and within range + release cone
   * of the thrower's aim — checked against the target's LAG-COMP rewound position (what the
   * thrower saw). Returns the target entity to hand the sim, or null after rejecting the
   * attempt back to the thrower. Favor-the-thrower: the wider release cone + a rewound target.
   */
  private validatePass(
    thrower: SessionPlayer,
    targetId: number,
    aimYaw: number,
    viewServerTimeMs: number,
  ): Entity | null {
    const reject = (
      reason: 'not_carrier' | 'target_invalid' | 'out_of_range' | 'rotation',
    ): null => {
      thrower.link.send({ type: 'passRejected', serverTick: this.tick, reason });
      return null;
    };

    const carrier = thrower.entity;
    if (!this.carriedRelic(carrier) || !carrier.transform) return reject('not_carrier');
    if (targetId === carrier.id) return reject('target_invalid');

    const targetPlayer = [...this.players.values()].find((p) => p.entity.id === targetId);
    const target = targetPlayer?.entity;
    if (!target?.transform) return reject('target_invalid');
    if (target.downed || (target.health?.current ?? 0) <= 0) return reject('target_invalid');
    // Rotation rule: a receiver still inside their post-pass re-catch cooldown is ineligible.
    if (this.simNowMs < (target.relicRecatchUntil ?? 0)) return reject('rotation');

    // Rewind the target to what the thrower saw (their interp view time), clamped to the ring.
    const viewTick = Math.max(
      this.tick - NET_LAGCOMP_MAX_TICKS,
      Math.min(this.tick, viewTickFromMs(viewServerTimeMs)),
    );
    const seen = rewindPos(targetPlayer!.posHistory, viewTick) ?? target.transform.position;

    const cp = carrier.transform.position;
    const dx = seen[0] - cp[0];
    const dz = seen[2] - cp[2];
    const dist = Math.hypot(dx, dz);
    if (dist > RELIC_PASS_RANGE) return reject('out_of_range');
    if (dist > 1e-3) {
      // Cone: angle between the thrower's aim (yaw → forward = [sin, cos]) and the target dir.
      const dot = (Math.sin(aimYaw) * dx + Math.cos(aimYaw) * dz) / dist;
      const angleDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
      if (angleDeg > RELIC_RELEASE_CONE_DEG) return reject('out_of_range');
    }
    return target;
  }

  /** Full flight description read straight off the relic's live state (Task 2 broadcast). */
  private flightWire(s: NonNullable<Entity['relic']>): RelicFlightWire {
    const from = s.from ?? [0, 0, 0];
    const to = s.to ?? [0, 0, 0];
    const control = s.control ?? [
      (from[0] + to[0]) / 2,
      (from[1] + to[1]) / 2,
      (from[2] + to[2]) / 2,
    ];
    return {
      mode: s.mode === 'pass' ? 'pass' : 'lob',
      from: [from[0], from[1], from[2]],
      control: [control[0], control[1], control[2]],
      to: [to[0], to[1], to[2]],
      arcHeight: s.arcHeight ?? 1.5,
      startedAt: s.startedAt ?? this.simNowMs,
      flightMs: s.flightMs ?? 1,
      targetId: s.target?.id,
      throwerId: s.thrower?.id,
    };
  }

  /**
   * Diff the sim's relic against what we last broadcast and emit reliable relic events on each
   * transition (Task 4). State-diffing (not sim events) keeps the sim untouched — solo play is
   * byte-identical. A new flight `startedAt` = a launch; a new carrier = a catch; a fresh
   * `failedAt` accompanies a failed pass; the first grounded tick settles it.
   */
  private syncRelicEvents(now: number): void {
    const r = this.relicEntity;
    if (!r?.relic || !r.transform) return;
    const s = r.relic;
    const pos = r.transform.position;
    const at = (): [number, number, number] => [pos[0], pos[1], pos[2]];

    if (
      s.phase === 'inFlight' &&
      s.startedAt !== undefined &&
      s.startedAt !== this.relicWire.startedAt
    ) {
      this.relicWire.startedAt = s.startedAt;
      this.broadcast({ type: 'relicLaunched', serverTick: this.tick, flight: this.flightWire(s) });
      // A failed pass bounces as a lob — announce the failure (reason drives the fail feedback).
      if (s.failedAt === now && s.failedAt !== this.relicWire.failedAt) {
        this.relicWire.failedAt = s.failedAt;
        this.broadcast({
          type: 'relicPassFailed',
          serverTick: this.tick,
          reason: s.failReason ?? 'receiver_escaped',
          pos: at(),
        });
      } else if (s.mode === 'lob' && this.pendingLobReason) {
        // An intentional G-drop or a carrier-disconnect lob — carries its own reason.
        this.broadcast({
          type: 'relicDropped',
          serverTick: this.tick,
          reason: this.pendingLobReason,
          pos: at(),
        });
      }
      this.pendingLobReason = null;
    }

    if (
      s.phase === 'carried' &&
      s.carrier?.id !== undefined &&
      s.carrier.id !== this.relicWire.carrierId
    ) {
      this.relicWire.carrierId = s.carrier.id;
      this.broadcast({
        type: 'relicCaught',
        serverTick: this.tick,
        carrierId: s.carrier.id,
        pos: at(),
        corruption: s.corruption,
      });
    }
    if (s.phase !== 'carried') this.relicWire.carrierId = -1;

    if (s.phase === 'grounded' && this.relicWire.phase !== 'grounded') {
      this.broadcast({ type: 'relicGrounded', serverTick: this.tick, pos: at() });
    }
    this.relicWire.phase = s.phase;
  }

  /** The relic's live state for a joining/reconnecting client's welcome (Task 5). */
  relicWelcome(): RelicWelcomeState | undefined {
    const r = this.relicEntity;
    if (this.zone !== 'expedition' || !r?.relic || !r.transform) return undefined;
    const s = r.relic;
    const p = r.transform.position;
    return {
      entityId: r.id!,
      phase: s.phase,
      pos: [p[0], p[1], p[2]],
      corruption: s.corruption,
      carrierId: s.phase === 'carried' ? s.carrier?.id : undefined,
      flight: s.phase === 'inFlight' ? this.flightWire(s) : undefined,
    };
  }

  /**
   * A carrier is leaving: drop the relic as a lob at their last position (Task 5), reusing the
   * intentional-drop path, so it lands walk-in catchable within one grace tick. Called BEFORE
   * the avatar is detached (dropRelic reads the carrier transform).
   */
  handleCarrierDisconnect(entity: Entity): void {
    if (this.carriedRelic(entity)) {
      this.pendingLobReason = null;
      groundHeldRelic(this.world, entity, this.events);
    }
  }

  /** Encode + send one snapshot per connected player (20 Hz, keyframe every 2 s). */
  broadcastSnapshots(): void {
    if (this.players.size === 0) return;
    const now = this.simNowMs;
    const keyframe =
      this.keyframeRequested || now - this.lastKeyframeAtMs >= SNAPSHOT_KEYFRAME_INTERVAL_MS;

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
          flags: playerAnimFlagsFor(e, now, this.relicEntity),
        }),
      );
    }

    // Expedition entities replicate too. Monsters carry aiState/stagger in flags; projectiles
    // carry velocity so clients dead-reckon fast movers between snapshots; pickups are static.
    if (this.zone === 'expedition') {
      for (const m of this.world.with('monster', 'transform')) {
        states.push(
          quantizeEntity({
            id: m.id!,
            kind: ENTITY_KIND.monster,
            pos: m.transform.position,
            rotY: m.transform.rotationY,
            hp: m.health?.current ?? 0,
            vel: [0, 0, 0],
            flags: monsterFlagsFor(m, now),
          }),
        );
      }
      for (const p of this.world.with('projectile', 'transform', 'velocity')) {
        states.push(
          quantizeEntity({
            id: p.id!,
            kind: ENTITY_KIND.projectile,
            pos: p.transform.position,
            rotY: p.transform.rotationY,
            hp: 0,
            vel: p.velocity.linear,
            flags: 0,
          }),
        );
      }
      for (const pk of this.world.with('pickup', 'transform')) {
        states.push(
          quantizeEntity({
            id: pk.id!,
            kind: ENTITY_KIND.pickup,
            pos: pk.transform.position,
            rotY: pk.transform.rotationY,
            hp: 0,
            vel: [0, 0, 0],
            flags: 0,
          }),
        );
      }
      // The relic replicates as COARSE truth: phase in the flags byte + its position (for
      // grounded drift + late-join reconcile). Its carrier binding + flight arc ride the
      // reliable relic events, so the snapshot needs neither.
      const relic = this.relicEntity;
      if (relic?.transform && relic.relic) {
        states.push(
          quantizeEntity({
            id: relic.id!,
            kind: ENTITY_KIND.relic,
            pos: relic.transform.position,
            rotY: 0,
            // The generic uint16 HP lane carries Relic corruption at snapshot rate. It is
            // authoritative scalar state and avoids a noisy reliable JSON event every tick.
            hp: relic.relic.corruption,
            vel: [0, 0, 0],
            flags: RELIC_PHASE_FLAG[relic.relic.phase],
          }),
        );
      }
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

    let bytes = 0;
    for (const player of this.players.values()) {
      // Records are shared; only the ack block differs per recipient.
      const per = buf.slice(0);
      patchSnapshotAck(
        per,
        player.ackState.seq,
        player.ackState.pos,
        player.ackState.vel,
        player.ackState.rotY,
        player.entity.downed ? ACK_FLAG_DOWNED : 0,
      );
      player.link.sendBinary(per);
      bytes += per.byteLength;
    }
    this.lastSnapshotBytes = bytes;
  }
}

export interface PlayerProfile {
  name: string;
  character: CharacterId;
}

export type JoinResult =
  | { ok: true; session: Session; player: SessionPlayer; resumed: boolean }
  | { ok: false; error: 'unknown_session' | 'session_full' };

export interface SessionManagerOptions {
  now?: () => number;
  log?: Logger;
  /** Hard cap on concurrent sessions (env MAX_SESSIONS). Refused creates get `server_full`. */
  maxSessions?: number;
  /** A session with connected players but no input for this long is reaped. */
  idleTimeoutMs?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly log: Logger;
  readonly maxSessions: number;
  private readonly idleTimeoutMs: number;

  constructor(opts: SessionManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? logger;
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** True when a new session may not be created (concurrent-session cap reached). */
  get atCapacity(): boolean {
    return this.sessions.size >= this.maxSessions;
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

  /** Send one control message to every connected player across all sessions (shutdown drain). */
  notifyAll(msg: ServerMessage): void {
    for (const session of this.sessions.values()) {
      for (const player of session.players.values()) {
        try {
          player.link.send(msg);
        } catch {
          // socket already dying — the ws close handler cleans up.
        }
      }
    }
  }

  /**
   * Advance every session's authoritative sim by one fixed step. Each room is stepped inside
   * its own try/catch (panic-safe isolation, Phase 6 Task 3): a bug that throws in one room's
   * tick tears THAT room down with a notice to its clients — it can never take the process or
   * a sibling room down with it.
   */
  stepAll(fixedDtSec: number): void {
    for (const session of [...this.sessions.values()]) {
      try {
        session.step(fixedDtSec);
      } catch (err) {
        this.log.error('room_tick_panic', { code: session.code, error: String(err) });
        this.destroySession(session, 'internal_error');
      }
    }
  }

  /** Broadcast one snapshot per room, isolated the same way stepAll is. */
  broadcastAll(): void {
    for (const session of [...this.sessions.values()]) {
      try {
        session.broadcastSnapshots();
      } catch (err) {
        this.log.error('room_snapshot_panic', { code: session.code, error: String(err) });
        this.destroySession(session, 'internal_error');
      }
    }
  }

  /** Tear a room down, notifying every connected client first (poisoned-room / idle reap). */
  destroySession(session: Session, reason: 'internal_error' | 'idle'): void {
    for (const player of [...session.players.values()]) {
      try {
        player.link.send({
          type: 'error',
          code: 'not_in_session',
          message: `session ended (${reason})`,
        });
      } catch {
        // socket already dying — the ws close handler will clean up.
      }
    }
    this.sessions.delete(session.code);
    this.log.warn('session_destroyed', {
      code: session.code,
      reason,
      players: session.players.size,
    });
  }

  // ── Aggregate metrics for the /metrics endpoint (Phase 6 Task 5) ─────────────
  metricsSnapshot(): {
    sessions: number;
    players: number;
    snapshotBytes: number;
    eventQueueDepth: number;
  } {
    let snapshotBytes = 0;
    let eventQueueDepth = 0;
    for (const s of this.sessions.values()) {
      snapshotBytes += s.lastSnapshotBytes;
      eventQueueDepth += s.eventQueueDepth;
    }
    return {
      sessions: this.sessions.size,
      players: this.playerCount,
      snapshotBytes,
      eventQueueDepth,
    };
  }

  createSession(
    profile: PlayerProfile,
    link: PeerLink,
  ): { session: Session; player: SessionPlayer } {
    let code = generateSessionCode();
    while (this.sessions.has(code)) code = generateSessionCode(); // collision paranoia
    const session = new Session(code, this.now());
    this.sessions.set(code, session);
    const player = this.attach(session, profile, link, generatePlayerId());
    this.log.info('session_created', { code, playerId: player.id, name: player.name });
    return { session, player };
  }

  joinSession(
    code: string,
    profile: PlayerProfile,
    link: PeerLink,
    resumeToken?: string,
  ): JoinResult {
    const session = this.sessions.get(code);
    if (!session) return { ok: false, error: 'unknown_session' };

    // Resume path: a valid token within the window reclaims the departed playerId.
    if (resumeToken) {
      const departed = session.departed.get(resumeToken);
      if (departed && this.now() - departed.leftAt <= RESUME_WINDOW_MS) {
        session.departed.delete(resumeToken);
        if (session.players.size >= SESSION_MAX_PLAYERS)
          return { ok: false, error: 'session_full' };
        const player = this.attach(session, profile, link, departed.id, resumeToken);
        this.log.info('session_resumed', { code, playerId: player.id });
        return { ok: true, session, player, resumed: true };
      }
    }

    if (session.players.size >= SESSION_MAX_PLAYERS) return { ok: false, error: 'session_full' };
    const player = this.attach(session, profile, link, generatePlayerId());
    this.log.info('session_joined', {
      code,
      playerId: player.id,
      name: player.name,
      players: session.players.size,
    });
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
    // If they were carrying the relic, lob it out at their last position BEFORE the avatar
    // is detached (the drop reads the carrier transform) — Phase 5 Task 5.
    session.handleCarrierDisconnect(player.entity);
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
    this.log.info('session_left', {
      code: session.code,
      playerId,
      reason,
      players: session.players.size,
    });
  }

  /**
   * Drop sessions that have been empty past the grace window OR idle (connected players but no
   * input for the idle timeout — an abandoned/backgrounded room). Returns removed count.
   */
  gcSweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [code, session] of this.sessions) {
      if (session.emptySince !== null && now - session.emptySince >= SESSION_GC_GRACE_MS) {
        this.sessions.delete(code);
        removed += 1;
        this.log.info('session_gc', { code, ageMs: now - session.createdAt });
        continue;
      }
      // Idle reap: still-populated but silent past the timeout → notify + tear down.
      if (session.players.size > 0 && now - session.lastActivityAt >= this.idleTimeoutMs) {
        this.destroySession(session, 'idle');
        removed += 1;
        continue;
      }
      // Expire stale resume tokens regardless.
      for (const [token, departed] of session.departed) {
        if (now - departed.leftAt > RESUME_WINDOW_MS) session.departed.delete(token);
      }
    }
    return removed;
  }
}
