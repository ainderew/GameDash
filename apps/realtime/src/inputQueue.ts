import type { InputCmd, MoveIntent } from '@shared/net/input';
import { BTN_DODGE, BTN_JUMP, intentFromCmd } from '@shared/net/input';
import {
  JITTER_BUFFER_INITIAL_DEPTH,
  JITTER_BUFFER_MAX_DEPTH,
  JITTER_BUFFER_OVERFLOW_SLACK,
  JITTER_BUFFER_SHRINK_TICKS,
  STARVATION_COAST_MAX_TICKS,
} from '@shared/net/constants';

/**
 * Per-player server input queue (Phase 3, Task 1): de-dup by seq, ADAPTIVE jitter buffer,
 * starvation coasting. Invariants (no-rubberband contract #2):
 *   - A cmd with seq ≤ lastProcessedSeq is DISCARDED — the server never rewrites
 *     already-simulated ticks because a packet was late.
 *   - Starvation (queue empty at consume time) COASTS on the last movement cmd with all
 *     one-shot actions stripped, for at most STARVATION_COAST_MAX_TICKS, then stops.
 *   - COAST SUBSTITUTION: each coast tick already integrated one tick of guessed
 *     movement, so when the late cmds finally arrive, an equal number of stale PURE
 *     MOVEMENT cmds are absorbed (lastProcessedSeq advances over them without
 *     re-simulating). Without this, gap movement would be integrated twice (coast + the
 *     delayed cmds) and every starvation would cost a coast-length correction; with it,
 *     a steady-intent gap reconciles to ≈ zero error. Cmds carrying one-shot verbs
 *     (jump/dodge) are NEVER swallowed — substitution stops at them.
 *   - The jitter target depth grows by one on every starvation (bounded), and shrinks
 *     one step after JITTER_BUFFER_SHRINK_TICKS ticks without starving — grow fast,
 *     shrink slowly, never trade a late packet for a retroactive correction.
 */

export interface ConsumeResult {
  intent: MoveIntent;
  /** The consumed cmd's seq; null while coasting/idle (lastProcessedSeq unchanged). */
  seq: number | null;
  coasting: boolean;
  /**
   * The consumed wire cmd, for combat/aim decoding (Phase 4). Null while coasting/idle —
   * a coast carries movement only, never a one-shot verb (melee/parry never fire on a guess).
   */
  cmd: InputCmd | null;
}

const IDLE_INTENT: MoveIntent = { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false };

const stripActions = (intent: MoveIntent): MoveIntent => ({
  moveX: intent.moveX,
  moveZ: intent.moveZ,
  sprint: intent.sprint,
  jump: false,
  dodge: false,
});

export class PlayerInputQueue {
  private readonly cmds = new Map<number, InputCmd>();
  lastProcessedSeq = 0;

  /** Starvation-driven floor of the buffer target (grows on starvation, shrinks slowly). */
  private starvationDepth = JITTER_BUFFER_INITIAL_DEPTH;
  /** EWMA of packet inter-arrival deviation from the nominal cadence, ms. */
  private jitterEwmaMs = 0;
  private lastArrivalMs: number | null = null;
  private maxOfferedSeq = 0;

  /** Waiting for the buffer to refill to targetDepth before consuming (initial + post-starvation). */
  private filling = true;
  private lastIntent: MoveIntent = IDLE_INTENT;
  private coastTicks = 0;
  private everReceived = false;
  private ticksSinceStarvation = 0;

  /** Coast ticks not yet matched with an absorbed stale cmd. */
  private pendingSubstitutions = 0;

  // Telemetry
  starvations = 0;
  duplicatesDropped = 0;
  overflowDropped = 0;
  gapsSkipped = 0;
  substituted = 0;

  /** Buffered cmds not yet consumed. */
  get depth(): number {
    return this.cmds.size;
  }

  /**
   * Live buffer target: 1–2 in calm conditions, grown by MEASURED arrival jitter
   * (a 2.5× EWMA margin in ticks — a starvation costs a correction, an extra buffered
   * tick costs 33 ms of server-side lag, so the margin errs generously) and by observed
   * starvations — whichever demands more.
   */
  get targetDepth(): number {
    const MS_PER_CMD = 1000 / 30;
    const jitterTicks = Math.ceil((this.jitterEwmaMs * 2.5) / MS_PER_CMD);
    return Math.min(JITTER_BUFFER_MAX_DEPTH, Math.max(this.starvationDepth, 1 + jitterTicks));
  }

  /** Offer cmds from an input packet (redundant window — most are duplicates). */
  offer(cmd: InputCmd, nowMs?: number): void {
    // Arrival jitter is measured per fresh head cmd (one per packet in steady state).
    if (nowMs !== undefined && cmd.seq > this.maxOfferedSeq) {
      if (this.lastArrivalMs !== null) {
        const gap = nowMs - this.lastArrivalMs;
        const nominal = (cmd.seq - this.maxOfferedSeq) * (1000 / 30);
        this.jitterEwmaMs += 0.1 * (Math.abs(gap - nominal) - this.jitterEwmaMs);
      }
      this.lastArrivalMs = nowMs;
      this.maxOfferedSeq = cmd.seq;
    }

    if (cmd.seq <= this.lastProcessedSeq || this.cmds.has(cmd.seq)) {
      this.duplicatesDropped += 1;
      return;
    }
    this.cmds.set(cmd.seq, cmd);
    this.everReceived = true;

    // Bounded latency: a runaway backlog (client clock fast / burst after a stall) drops
    // its OLDEST cmds — stale inputs, never future ones.
    const maxDepth = this.targetDepth + JITTER_BUFFER_OVERFLOW_SLACK;
    while (this.cmds.size > maxDepth) {
      const oldest = Math.min(...this.cmds.keys());
      this.cmds.delete(oldest);
      this.overflowDropped += 1;
    }
  }

  /** Called once per server tick. Never blocks, never rewinds. */
  consume(): ConsumeResult {
    this.ticksSinceStarvation += 1;
    if (this.ticksSinceStarvation >= JITTER_BUFFER_SHRINK_TICKS) {
      this.ticksSinceStarvation = 0;
      this.starvationDepth = Math.max(1, this.starvationDepth - 1);
    }

    if (this.filling) {
      if (this.cmds.size < this.targetDepth) return this.coastOrIdle();
      this.filling = false;
    }

    if (this.cmds.size === 0) {
      // Starvation: coast, grow the buffer target, refill before resuming.
      if (this.everReceived) {
        this.starvations += 1;
        this.starvationDepth = Math.min(JITTER_BUFFER_MAX_DEPTH, this.starvationDepth + 1);
        this.ticksSinceStarvation = 0;
      }
      this.filling = true;
      return this.coastOrIdle();
    }

    // Coast substitution: absorb stale pure-movement cmds the coast already stood in
    // for (keep at least one cmd to actually consume this tick; stop at any verb).
    while (this.pendingSubstitutions > 0 && this.cmds.size > 1) {
      const oldest = Math.min(...this.cmds.keys());
      const stale = this.cmds.get(oldest)!;
      if ((stale.buttons & (BTN_JUMP | BTN_DODGE)) !== 0) break;
      this.cmds.delete(oldest);
      this.lastProcessedSeq = oldest;
      this.lastIntent = intentFromCmd(stale);
      this.pendingSubstitutions -= 1;
      this.substituted += 1;
    }
    this.pendingSubstitutions = 0; // unmatched coast ticks can never be matched later

    // Consume the oldest buffered cmd. A gap below it means those cmds are lost for good
    // (redundancy already failed) — skip forward, never wait for the past.
    const seq = Math.min(...this.cmds.keys());
    if (seq > this.lastProcessedSeq + 1) this.gapsSkipped += seq - this.lastProcessedSeq - 1;
    const cmd = this.cmds.get(seq)!;
    this.cmds.delete(seq);
    this.lastProcessedSeq = seq;
    this.lastIntent = intentFromCmd(cmd);
    this.coastTicks = 0;
    return { intent: this.lastIntent, seq, coasting: false, cmd };
  }

  private coastOrIdle(): ConsumeResult {
    if (!this.everReceived) return { intent: IDLE_INTENT, seq: null, coasting: false, cmd: null };
    this.coastTicks += 1;
    if (this.coastTicks > STARVATION_COAST_MAX_TICKS) {
      // Full stop: no movement was guessed, so there is nothing to substitute for.
      return { intent: IDLE_INTENT, seq: null, coasting: true, cmd: null };
    }
    const intent = stripActions(this.lastIntent);
    // Only a MOVING coast integrated guessed displacement worth substituting; an idle
    // coast moved nothing, so the (late) real cmds must still be simulated in full.
    if (intent.moveX !== 0 || intent.moveZ !== 0) this.pendingSubstitutions += 1;
    return { intent, seq: null, coasting: true, cmd: null };
  }
}
