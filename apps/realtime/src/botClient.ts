import type { Vector3Tuple } from '@shared/types';
import { MS_PER_TICK } from '@shared/net/constants';
import {
  encodeInputPacket,
  intentFromCmd,
  makeInputCmd,
  quantizeMove,
  type InputCmd,
} from '@shared/net/input';
import { decodeSnapshot } from '@shared/net/snapshot';
import type { Entity } from '@sim/components';
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

  constructor(opts: BotClientOptions = {}) {
    this.hacked = opts.hacked ?? false;
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
      mode: 'hub',
    });
  }

  /** One fixed client tick: script an intent, predict with it, emit the input packet. */
  tick(): ArrayBuffer {
    this.seq += 1;
    this.stats.ticks += 1;
    const raw = this.intentFn(this.seq);
    const cmd = makeInputCmd(this.seq, this.seq, raw);
    if (this.hacked) {
      // Inflate the wire move vector past any legal magnitude.
      cmd.moveX = raw.moveX >= 0 ? 127 : -127;
      cmd.moveZ = raw.moveZ >= 0 ? 127 : -127;
    } else {
      cmd.moveX = quantizeMove(raw.moveX);
      cmd.moveZ = quantizeMove(raw.moveZ);
    }
    // Predict with the DECODED intent — the same clamped values the server simulates.
    this.engine.predict(this.seq, intentFromCmd(cmd), this.seq * MS_PER_TICK);

    this.recentCmds.push(cmd);
    if (this.recentCmds.length > 3) this.recentCmds.shift();
    return encodeInputPacket(this.recentCmds);
  }

  /** Authoritative snapshot arrived. Returns the reconcile outcome (null = stale). */
  onSnapshot(buf: ArrayBufferLike): ReconcileResult | null {
    const snap = decodeSnapshot(buf);
    if (!snap) return null;
    const h = snap.header;
    const result = this.engine.onAuthoritative(
      { pos: h.ackPos, vel: h.ackVel, rotY: h.ackRotY },
      h.yourLastProcessedSeq,
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

  onImpulse(seq: number | undefined, impulse: Vector3Tuple): void {
    if (seq === undefined) return; // not ours
    this.engine.scheduleImpulse(seq, impulse);
  }

  pos(): Vector3Tuple {
    return [...this.entity.transform!.position] as Vector3Tuple;
  }
}
