import type { Vector3Tuple } from '@shared/types';
import { INTERP_DELAY_MS, MS_PER_TICK } from '@shared/net/constants';
import {
  encodeInputPacket,
  intentFromCmd,
  makeInputCmd,
  quantizeMove,
  type CmdIntent,
  type InputCmd,
} from '@shared/net/input';
import { ACK_FLAG_DOWNED, decodeSnapshot, ENTITY_KIND, type DecodedEntityRecord } from '@shared/net/snapshot';
import type { ServerMessage } from '@shared/net/messages';
import type { Entity } from '@sim/components';
import type { SimMode } from '@sim/step';
import { createGameWorld, type GameWorld } from '@sim/world';
import { EventQueue } from '@sim/events';
import { PredictionEngine, type ReconcileResult } from '@sim/prediction';

/**
 * Headless bot client (Phase 3, Task 6): runs the REAL `PredictionEngine` — the same
 * module the browser client uses — against a live server, over a (possibly simulated)
 * wire. Consumed by the virtual-clock integration test (the phase KPI) and by
 * `bot.ts` for real-socket soak runs.
 */

export interface BotStats {
  ticks: number;
  acks: number;
  corrections: { seq: number; magnitudeM: number }[];
  teleports: number;
  /** |auth − predicted| of the latest ack, meters (convergence probe). */
  lastAckErrorM: number;
  maxCleanErrorM: number;
}

/** Deterministic LCG so integration runs are reproducible. */
export const makeRng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

/**
 * Scripted wandering inputs: hold a heading for a while, occasionally sprint, dodge and
 * jump — enough verb coverage to exercise dodge-dash replay and airborne integration.
 */
export class BotBrain {
  private readonly rng: () => number;
  private angle = 0;
  private sprint = false;

  constructor(seed: number) {
    this.rng = makeRng(seed);
    this.angle = this.rng() * Math.PI * 2;
  }

  intentAt(tick: number): { moveX: number; moveZ: number; jump: boolean; dodge: boolean; sprint: boolean } {
    if (tick % 45 === 0) this.angle += (this.rng() - 0.5) * Math.PI;
    if (tick % 150 === 0) this.sprint = this.rng() < 0.5;
    return {
      moveX: Math.sin(this.angle),
      moveZ: Math.cos(this.angle),
      jump: tick % 137 === 0,
      dodge: tick % 97 === 0,
      sprint: this.sprint,
    };
  }
}

export interface RawIntent {
  moveX: number;
  moveZ: number;
  jump: boolean;
  dodge: boolean;
  sprint: boolean;
}

export interface BotClientOptions {
  seed?: number;
  /**
   * Speed-hack mode: craft raw wire cmds with maxed move components (int8 ±127 ⇒ a
   * 1.79× diagonal) while predicting HONESTLY with the decoded (server-clamped) intent —
   * used to prove position is server-derived and inflated vectors are ignored.
   */
  hacked?: boolean;
  /** Override the scripted wander (e.g. pure strafe for the impulse test). */
  intentFn?: (tick: number) => RawIntent;
  /** Prediction sim mode — must match the session's zone (expedition for combat). */
  mode?: SimMode;
  /**
   * Combat AI: seek the nearest live monster the bot sees in its replicated world view and
   * mash melee at it (aim yaw + viewServerTimeMs → lag-compensated server hit). Used by the
   * 2-bot expedition integration test.
   */
  combat?: boolean;
}

/** The bot's snapshot-derived view of one replicated entity (server truth it renders). */
interface ViewEntity {
  kind: number;
  pos: Vector3Tuple;
  hp: number;
}

export class BotClient {
  readonly world: GameWorld = createGameWorld();
  readonly events = new EventQueue();
  readonly entity: Entity;
  readonly engine: PredictionEngine;
  readonly brain: BotBrain;
  readonly stats: BotStats = {
    ticks: 0,
    acks: 0,
    corrections: [],
    teleports: 0,
    lastAckErrorM: 0,
    maxCleanErrorM: 0,
  };

  private seq = 0;
  private readonly recentCmds: InputCmd[] = [];
  private readonly hacked: boolean;
  private readonly intentFn: (tick: number) => RawIntent;
  private readonly combat: boolean;

  // ── Replicated world view (snapshot-derived server truth) ───────────────────
  /** Keyframe baselines keyed by keyframe tick — the last two, exactly like the browser. */
  private readonly baselines = new Map<number, Map<number, ViewEntity>>();
  /** Current server-truth entity view (baseline patched by the newest delta). */
  private readonly view = new Map<number, ViewEntity>();
  /** Materials (SHARED-POOL tally) as last told by the server. */
  materials = 0;
  /** Newest server time we've seen, ms — the lag-comp view clock. */
  private latestServerTimeMs = 0;
  /** Our own avatar entity id in the session world (from welcome), for HP-aware AI. */
  private ownEntityId: number | null = null;
  private dodgeReadyAtMs = 0;

  constructor(opts: BotClientOptions = {}) {
    this.hacked = opts.hacked ?? false;
    this.combat = opts.combat ?? false;
    this.brain = new BotBrain(opts.seed ?? 1);
    this.intentFn = opts.intentFn ?? ((tick) => this.brain.intentAt(tick));
    this.entity = this.world.add({
      transform: { position: [0, 0, 0], rotationY: Math.PI },
      velocity: { linear: [0, 0, 0] },
      health: { current: 100, max: 100 },
      faction: 'player',
      radius: 0.45,
      playerControlled: true,
      localPlayer: true,
    });
    this.engine = new PredictionEngine(this.world, this.events, this.entity, MS_PER_TICK / 1000, {
      mode: opts.mode ?? 'hub',
      authority: 'local',
    });
  }

  /** Live monsters in the bot's replicated view: id → hp (server truth, snapshot-derived). */
  monsterHp(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [id, e] of this.view) if (e.kind === ENTITY_KIND.monster) out.set(id, e.hp);
    return out;
  }

  /** One fixed client tick: script an intent, predict with it, emit the input packet. */
  tick(): ArrayBuffer {
    this.seq += 1;
    this.stats.ticks += 1;
    const raw = this.intentFn(this.seq);
    const cmdIntent: CmdIntent = { ...raw };
    if (this.combat) this.combatIntent(cmdIntent);
    const cmd = makeInputCmd(this.seq, this.seq, cmdIntent);
    if (this.hacked) {
      // Inflate the wire move vector past any legal magnitude.
      cmd.moveX = raw.moveX >= 0 ? 127 : -127;
      cmd.moveZ = raw.moveZ >= 0 ? 127 : -127;
    } else {
      cmd.moveX = quantizeMove(cmdIntent.moveX);
      cmd.moveZ = quantizeMove(cmdIntent.moveZ);
    }
    // Predict with the DECODED intent — the same clamped values the server simulates. Combat
    // verbs ride the cmd too (the swing anim is predicted; its DAMAGE is server-authoritative).
    // Facing is predicted from the YAW (position-independent) so replay never drifts the lunge.
    const move = intentFromCmd(cmd);
    this.engine.predict(
      this.seq,
      { ...move, melee: cmdIntent.melee, parry: cmdIntent.parry, aimYaw: cmdIntent.aimYaw },
      this.seq * MS_PER_TICK,
    );

    this.recentCmds.push(cmd);
    if (this.recentCmds.length > 3) this.recentCmds.shift();
    return encodeInputPacket(this.recentCmds);
  }

  /**
   * Combat brain: steer toward the nearest live monster in the replicated view and melee it
   * when in reach. The aim yaw + interpolated viewServerTimeMs feed the server's lag-comp.
   */
  private combatIntent(intent: CmdIntent): void {
    const me = this.entity.transform!.position;
    let best: ViewEntity | null = null;
    let bestD = Infinity;
    for (const e of this.view.values()) {
      if (e.kind !== ENTITY_KIND.monster || e.hp <= 0) continue;
      const d = Math.hypot(e.pos[0] - me[0], e.pos[2] - me[2]);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) {
      intent.moveX = 0;
      intent.moveZ = 0;
      return;
    }
    const dx = best.pos[0] - me[0];
    const dz = best.pos[2] - me[2];
    const len = Math.hypot(dx, dz) || 1;
    intent.aimYaw = Math.atan2(dx, dz);
    // Kite when hurt: back away from the nearest monster to recover, else close the gap and
    // stop pushing once nearly in reach so the swing lands clean.
    const ownHp = this.ownEntityId !== null ? this.view.get(this.ownEntityId)?.hp ?? 100 : 100;
    if (ownHp > 0 && ownHp < 35) {
      intent.moveX = -dx / len;
      intent.moveZ = -dz / len;
      intent.sprint = true;
    } else if (bestD > 2.0) {
      intent.moveX = dx / len;
      intent.moveZ = dz / len;
      intent.sprint = true;
    } else {
      intent.moveX = 0;
      intent.moveZ = 0;
    }
    intent.melee = bestD < 2.6 && ownHp >= 35;
    // Dodge on ~cooldown cadence for near-continuous i-frames — a lone bot isn't ground
    // down between swings (the sim gates the actual dodge on its own cooldown either way).
    intent.dodge = this.seq % 16 === 0 && bestD < 4;
    intent.viewServerTimeMs = Math.max(0, this.latestServerTimeMs - INTERP_DELAY_MS);
  }

  /** Authoritative snapshot arrived. Returns the reconcile outcome (null = stale). */
  onSnapshot(buf: ArrayBufferLike): ReconcileResult | null {
    const snap = decodeSnapshot(buf);
    if (!snap) return null;
    const h = snap.header;
    this.latestServerTimeMs = Math.max(this.latestServerTimeMs, h.serverTimeMs);
    this.updateView(snap.header.keyframe, snap.header.baselineTick, snap.entities);
    const result = this.engine.onAuthoritative(
      { pos: h.ackPos, vel: h.ackVel, rotY: h.ackRotY },
      h.yourLastProcessedSeq,
      (h.ackFlags & ACK_FLAG_DOWNED) !== 0,
    );
    if (!result) return null;
    this.stats.acks += 1;
    this.stats.lastAckErrorM = result.errorM;
    if (result.kind === 'corrected') {
      this.stats.corrections.push({ seq: result.ackSeq, magnitudeM: result.errorM });
    } else if (result.kind === 'teleport') {
      this.stats.teleports += 1;
    } else {
      this.stats.maxCleanErrorM = Math.max(this.stats.maxCleanErrorM, result.errorM);
    }
    return result;
  }

  onImpulse(seq: number | undefined, impulse: Vector3Tuple, staggerMs = 0): void {
    if (seq === undefined) return; // not ours
    this.engine.scheduleImpulse(seq, impulse, staggerMs);
  }

  /** Reliable server events (welcome, zone transitions, shared-pool loot tally, despawns). */
  onServerMessage(msg: ServerMessage): void {
    if (msg.type === 'welcome') {
      const me = msg.session.members.find((m) => m.id === msg.playerId);
      if (me) this.ownEntityId = me.entityId;
    } else if (msg.type === 'materialTally') {
      this.materials = msg.total;
    } else if (msg.type === 'monsterDespawned') {
      this.view.delete(msg.id); // death is authoritative even if a delta was dropped
    } else if (msg.type === 'zoneChanged') {
      // The party moved zones: switch the prediction sim mode and drop the stale world view.
      // The teleport that accompanies it re-anchors prediction on the next snapshot ack.
      this.engine.setMode(msg.zone);
      this.view.clear();
      this.baselines.clear();
    }
  }

  /**
   * Patch the replicated world view from a snapshot (keyframe → new baseline; delta → apply
   * changed fields over the baseline). Mirrors the browser client's stateless-delta decode,
   * so the bot's monster/HP view IS what a real player would render — the replication probe.
   */
  private updateView(keyframe: boolean, baselineTick: number, records: DecodedEntityRecord[]): void {
    if (keyframe) {
      const base = new Map<number, ViewEntity>();
      for (const r of records) base.set(r.id, { kind: r.kind, pos: r.pos ?? [0, 0, 0], hp: r.hp ?? 0 });
      this.baselines.set(baselineTick, base);
      const ticks = [...this.baselines.keys()].sort((a, b) => b - a);
      for (const t of ticks.slice(2)) this.baselines.delete(t);
    }
    const base = this.baselines.get(baselineTick);
    if (!base) return; // can't resolve deltas — the next keyframe (≤2 s) resyncs
    const patched = new Map<number, DecodedEntityRecord>();
    for (const r of records) patched.set(r.id, r);
    this.view.clear();
    for (const [id, b] of base) {
      const r = patched.get(id);
      this.view.set(id, {
        kind: b.kind,
        pos: r?.pos ?? b.pos,
        hp: r?.hp ?? b.hp,
      });
    }
  }

  pos(): Vector3Tuple {
    return [...this.entity.transform!.position] as Vector3Tuple;
  }
}
