import type { Vector3Tuple } from '@shared/types';
import { CORRECTION_SMOOTH_MS, MS_PER_TICK, RECONCILE_EPSILON_M, TELEPORT_EPSILON_M, PREDICTION_RING_SIZE } from '@shared/net/constants';
import { makeInputCmd, intentFromCmd, encodeInputPacket, type CmdIntent, type InputCmd } from '@shared/net/input';
import { ACK_FLAG_DOWNED, type SnapshotHeader } from '@shared/net/snapshot';
import type { Entity } from '@sim/components';
import type { GameWorld } from '@sim/world';
import type { EventQueue } from '@sim/events';
import type { SimMode } from '@sim/step';
import { PredictionEngine } from '@sim/prediction';
import { netStats } from '@/net/netStats';

/**
 * The client side of the input-authoritative loop (Phase 3, Tasks 1+4): owns the
 * PredictionEngine for the LOCAL player, the outgoing cmd ring (last-3 redundancy), and
 * the presentation-error smoother. SystemRunner drives `clientTick` at the fixed 30 Hz
 * step; NetClient feeds `onAuthoritative`/`onImpulse` from the wire. Kept out of both so
 * the netcode brain has no React and no socket.
 */

export type SendBinary = (data: ArrayBuffer) => void;

class NetGame {
  private engine: PredictionEngine | null = null;
  private send: SendBinary | null = null;
  private seq = 0;
  private readonly cmdRing: InputCmd[] = [];

  /** Residual correction being folded into the PRESENTATION transform (never the sim). */
  private offset: Vector3Tuple = [0, 0, 0];
  private offsetUpdatedAt = 0;

  get active(): boolean {
    return this.engine !== null;
  }

  get tickTimeMs(): number {
    return this.seq * MS_PER_TICK;
  }

  /** Enter networked driving (SystemRunner, on session play start). */
  start(world: GameWorld, events: EventQueue, entity: Entity, send: SendBinary): void {
    this.engine = new PredictionEngine(world, events, entity, MS_PER_TICK / 1000, {
      epsilonM: RECONCILE_EPSILON_M,
      teleportEpsilonM: TELEPORT_EPSILON_M,
      ringSize: PREDICTION_RING_SIZE,
      mode: 'hub',
    });
    this.send = send;
    // NOTE: seq is deliberately NOT reset here. It must stay strictly ahead of the SERVER's
    // per-player `lastProcessedSeq`, which persists for the whole session. If we restarted at
    // 0 on every start() — a transient reconnect flip, or returning to the hub from an
    // expedition — the server's input queue would DISCARD the fresh low seqs as stale
    // duplicates (cmd.seq <= lastProcessedSeq), never advancing the avatar, and every ack
    // would land in prediction's teleport-back branch: the "can't move" freeze. A monotonic
    // seq across restarts is always accepted (a fresh session's server queue starts at 0, so
    // any positive seq is new; a resumed session's queue keeps counting up). Reset only on a
    // full disconnect(), where a brand-new connection genuinely starts a new epoch.
    this.cmdRing.length = 0;
    this.offset = [0, 0, 0];
    netStats.reset();
  }

  stop(): void {
    this.engine = null;
    this.send = null;
    this.cmdRing.length = 0;
    this.offset = [0, 0, 0];
  }

  /** Full teardown on disconnect: the next connection is a new input epoch, so reset seq. */
  resetEpoch(): void {
    this.stop();
    this.seq = 0;
  }

  /** Switch prediction sim mode on a zone transition (hub ⇄ expedition). */
  setMode(mode: SimMode): void {
    this.engine?.setMode(mode);
  }

  /**
   * One fixed client tick: quantize the intent to a wire cmd, PREDICT with the decoded
   * cmd (identical rounding to what the server will simulate — contract #1), and send
   * the redundant packet (this cmd + the previous two — contract #2).
   *
   * Accepts the FULL CmdIntent (movement + combat): in the hub only movement is populated;
   * in a networked expedition the caller adds melee/ranged/parry/aim so the swing animation
   * is predicted locally (its DAMAGE stays server-authoritative) and lag-comp gets the yaw.
   */
  clientTick(intent: CmdIntent): void {
    const engine = this.engine;
    if (!engine || !this.send) return;
    this.seq += 1;
    const cmd = makeInputCmd(this.seq, this.seq, intent);
    // Predict with the DECODED movement + the combat verbs that drive the predicted swing.
    engine.predict(
      this.seq,
      {
        ...intentFromCmd(cmd),
        melee: intent.melee,
        ranged: intent.ranged,
        parry: intent.parry,
        aimYaw: intent.aimYaw,
        passAiming: intent.passHold,
        revive: intent.revive,
      },
      this.seq * MS_PER_TICK,
    );
    this.cmdRing.push(cmd);
    if (this.cmdRing.length > 3) this.cmdRing.shift();
    this.send(encodeInputPacket(this.cmdRing));
    netStats.headSeq = this.seq;
  }

  /** Authoritative ack from a decoded snapshot header. */
  onAuthoritative(header: SnapshotHeader): void {
    const engine = this.engine;
    if (!engine) return;
    const result = engine.onAuthoritative(
      { pos: header.ackPos, vel: header.ackVel, rotY: header.ackRotY },
      header.yourLastProcessedSeq,
      (header.ackFlags & ACK_FLAG_DOWNED) !== 0,
    );
    if (!result) return;
    netStats.lastAckSeq = result.ackSeq;
    if (result.kind === 'corrected') {
      // Sim corrected instantly; fold the visual residue in over ~100 ms (contract #4).
      this.offset[0] += result.presentationDelta[0];
      this.offset[1] += result.presentationDelta[1];
      this.offset[2] += result.presentationDelta[2];
      netStats.noteCorrection(result.errorM);
    } else if (result.kind === 'teleport') {
      // Genuine teleport (spawn/zone/resume) — the ONE sanctioned hard place.
      this.offset = [0, 0, 0];
      netStats.teleports += 1;
    }
  }

  /** Server-initiated force, keyed by the input seq it precedes (contract #3). */
  onImpulse(seq: number, impulse: Vector3Tuple, staggerMs = 0): void {
    if (!this.engine) return;
    // The shove lands retroactively at its true tick; fold the late-knowledge jump into
    // the presentation so it reads as a hit, not a teleport.
    const delta = this.engine.scheduleImpulse(seq, impulse, staggerMs);
    this.offset[0] += delta[0];
    this.offset[1] += delta[1];
    this.offset[2] += delta[2];
  }

  /**
   * Presentation offset for the local player mesh, decayed toward zero with a
   * CORRECTION_SMOOTH_MS time-constant fold. Called once per render frame (Player.tsx).
   */
  presentationOffset(): Vector3Tuple {
    const now = performance.now();
    const dt = this.offsetUpdatedAt === 0 ? 0 : (now - this.offsetUpdatedAt) / 1000;
    this.offsetUpdatedAt = now;
    if (dt > 0) {
      // exp decay: ~95% folded after CORRECTION_SMOOTH_MS.
      const k = Math.exp((-3 * dt * 1000) / CORRECTION_SMOOTH_MS);
      this.offset[0] *= k;
      this.offset[1] *= k;
      this.offset[2] *= k;
      if (Math.hypot(this.offset[0], this.offset[1], this.offset[2]) < 1e-4) {
        this.offset[0] = 0;
        this.offset[1] = 0;
        this.offset[2] = 0;
      }
    }
    return this.offset;
  }
}

/** Client singleton (one local player per tab). */
export const netGame = new NetGame();
