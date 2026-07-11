import type { Vector3Tuple } from '@shared/types';

/**
 * A tiny typed event queue drained once per tick. This is the seam Phase 3 will
 * route to the server: `LootDropped` becomes a server-validated reportHuntResult call.
 */

export interface LootDropped {
  type: 'LootDropped';
  tableId: string;
  position: Vector3Tuple;
}

export interface PlayerDowned {
  type: 'PlayerDowned';
}

export interface MaterialCollected {
  type: 'MaterialCollected';
  tableId: string;
}

// ── Relic pass lifecycle ────────────────────────────────────────────────────
// Feedback (audio/UI) hangs off these events, never off the pass call sites —
// when netcode lands, the emits move to the server-ack handler and every
// consumer follows unchanged. (Spec: "once the server accepts a pass".)

export interface RelicPassLaunched {
  type: 'RelicPassLaunched';
  /** True when the LOCAL player is the receiver — gates receiver-side feedback. */
  toLocalPlayer: boolean;
  /** Launch position (directional audio panning). */
  from: Vector3Tuple;
}

export interface RelicCaught {
  type: 'RelicCaught';
  byLocalPlayer: boolean;
  position: Vector3Tuple;
}

export interface RelicPassFailed {
  type: 'RelicPassFailed';
  position: Vector3Tuple;
  reason: 'receiver_downed' | 'receiver_escaped';
}

export type GameEvent =
  | LootDropped
  | PlayerDowned
  | MaterialCollected
  | RelicPassLaunched
  | RelicCaught
  | RelicPassFailed;

/**
 * Per-world event queue (was a module-level queue in single-player). The room server runs
 * one world per session — each needs an isolated queue, so the queue is an instance that
 * travels alongside its world through stepSim.
 */
export class EventQueue {
  private queue: GameEvent[] = [];

  emit(event: GameEvent): void {
    this.queue.push(event);
  }

  /** Drain all queued events. Called once per tick after systems run (see stepSim). */
  drain(): GameEvent[] {
    if (this.queue.length === 0) return [];
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  /** Test helper — clear without draining. */
  reset(): void {
    this.queue = [];
  }
}
