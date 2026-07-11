import type { World } from 'miniplex';
import type { Entity } from '../components';
import type { EventQueue, GameEvent } from '../events';
import { distSqXZ } from './combatHelpers';
import { PICKUP_RANGE } from '@shared/balance';

const PICKUP_RANGE_SQ = PICKUP_RANGE * PICKUP_RANGE;

/** Spawn a material pickup entity for each LootDropped event drained this tick. */
export const spawnPickupsFromEvents = (world: World<Entity>, events: GameEvent[]): void => {
  for (const ev of events) {
    if (ev.type !== 'LootDropped') continue;
    world.add({
      transform: { position: [ev.position[0], 0.5, ev.position[2]], rotationY: 0 },
      pickup: { tableId: ev.tableId },
    });
  }
};

/**
 * Auto-collect pickups any player walks over. Emits `MaterialCollected`
 * (provisional/local this phase; Phase 3 makes the grant server-authoritative).
 */
export const pickupSystem = (world: World<Entity>, events: EventQueue): void => {
  const collected: Entity[] = [];
  for (const p of world.with('pickup', 'transform')) {
    for (const player of world.with('playerControlled', 'transform')) {
      if (distSqXZ(p, player) > PICKUP_RANGE_SQ) continue;
      events.emit({ type: 'MaterialCollected', tableId: p.pickup.tableId });
      collected.push(p);
      break; // first collector wins; the pickup is gone
    }
  }
  for (const p of collected) world.remove(p);
};
