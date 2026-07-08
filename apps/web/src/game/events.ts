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

export type GameEvent = LootDropped | PlayerDowned | MaterialCollected;

let queue: GameEvent[] = [];

export const emit = (event: GameEvent): void => {
  queue.push(event);
};

/** Drain all queued events. Call once per tick after systems run. */
export const drainEvents = (): GameEvent[] => {
  if (queue.length === 0) return [];
  const drained = queue;
  queue = [];
  return drained;
};

/** Test helper — clear without draining. */
export const resetEvents = (): void => {
  queue = [];
};
