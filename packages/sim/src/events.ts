import type { Vector3Tuple } from '@shared/types';
import type { RelicTierDefinition } from '@shared/balance';

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
  /** Entity id of the downed player (server maps it to a playerId for the wire). */
  id?: number;
}

/** A downed player was revived by a teammate (reviveSystem, Phase 4 co-op mechanic). */
export interface PlayerRevived {
  type: 'PlayerRevived';
  id?: number;
}

/** A monster died — carries its id/archetype so the server can broadcast a despawn + FX. */
export interface MonsterKilled {
  type: 'MonsterKilled';
  id?: number;
  archetype: string;
  position: Vector3Tuple;
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

export interface RelicThrown {
  type: 'RelicThrown';
  holderId?: number;
  targetId?: number;
}

export interface RelicCorruptionChanged {
  type: 'RelicCorruptionChanged';
  value: number;
  tierIndex: number;
  tier: RelicTierDefinition;
}

export interface RelicTierChanged {
  type: 'RelicTierChanged';
  oldTierIndex: number;
  newTierIndex: number;
  oldTier: RelicTierDefinition;
  newTier: RelicTierDefinition;
}

export interface RelicGrounded {
  type: 'RelicGrounded';
  position: Vector3Tuple;
}

export interface RelicPickedUp {
  type: 'RelicPickedUp';
  playerId?: number;
}

export interface RelicErupted {
  type: 'RelicErupted';
  holderId?: number;
  position: Vector3Tuple;
}

export interface RelicVolatileDischarge {
  type: 'RelicVolatileDischarge';
  holderId?: number;
  position: Vector3Tuple;
  radius: number;
  tierIndex: number;
}

export type GameEvent =
  | LootDropped
  | PlayerDowned
  | PlayerRevived
  | MonsterKilled
  | MaterialCollected
  | RelicPassLaunched
  | RelicThrown
  | RelicCaught
  | RelicPassFailed
  | RelicCorruptionChanged
  | RelicTierChanged
  | RelicGrounded
  | RelicPickedUp
  | RelicErupted
  | RelicVolatileDischarge;

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
