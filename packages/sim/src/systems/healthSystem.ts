import type { World } from 'miniplex';
import type { Entity } from '../components';
import type { EventQueue } from '../events';

/**
 * Resolve deaths: any entity at ≤0 HP is removed. Monsters with a loot table emit
 * a `LootDropped` event (the Phase 3 server seam); a player emits `PlayerDowned`.
 * Damage itself is applied by weapon/AI/projectile systems via applyDamage.
 */
export const healthSystem = (world: World<Entity>, events: EventQueue): void => {
  const dead: Entity[] = [];

  for (const e of world.with('health')) {
    if (e.health.current > 0) continue;
    dead.push(e);

    if (e.playerControlled) {
      events.emit({ type: 'PlayerDowned' });
      continue; // don't remove the player entity; the hunt-failed UI takes over
    }
    if (e.lootTableId && e.transform) {
      events.emit({
        type: 'LootDropped',
        tableId: e.lootTableId,
        position: [...e.transform.position],
      });
    }
  }

  for (const e of dead) {
    if (e.playerControlled) continue;
    world.remove(e);
  }
};
