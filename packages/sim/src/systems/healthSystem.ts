import type { World } from 'miniplex';
import type { Entity } from '../components';
import type { EventQueue } from '../events';

/**
 * Resolve deaths: any entity at ≤0 HP is removed. Monsters with a loot table emit
 * a `LootDropped` (loot) + `MonsterKilled` (despawn/FX) event; a player is DOWNED — kept
 * in the world (co-op revive, Phase 4), emitting `PlayerDowned` exactly once on the
 * transition. Damage itself is applied by weapon/AI/projectile systems via applyDamage.
 */
export const healthSystem = (world: World<Entity>, events: EventQueue): void => {
  const dead: Entity[] = [];

  for (const e of world.with('health')) {
    if (e.health.current > 0) continue;

    if (e.playerControlled) {
      // Downed, not despawned. Fire the event only on the transition so the wire/HUD
      // aren't spammed every tick the player sits at 0 HP awaiting revive.
      if (!e.downed) {
        e.downed = true;
        e.reviveProgressMs = 0;
        events.emit({ type: 'PlayerDowned', id: e.id });
      }
      continue;
    }

    dead.push(e);
    if (e.transform) {
      events.emit({
        type: 'MonsterKilled',
        id: e.id,
        archetype: e.monster ?? 'chaser',
        position: [...e.transform.position],
      });
    }
    if (e.lootTableId && e.transform) {
      events.emit({
        type: 'LootDropped',
        tableId: e.lootTableId,
        position: [...e.transform.position],
      });
    }
  }

  for (const e of dead) world.remove(e);
};
