import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { dealDamage } from '@/game/ecs/systems/combatHelpers';
import { COMBO_CONTINUE_MS, COMBO_MOVES, comboAt } from '@/game/combat/combo';
import { computeDamage } from '@shared/combat';
import {
  MELEE_DAMAGE,
  MELEE_RANGE,
  PROJECTILE_LIFETIME_MS,
  PROJECTILE_SPEED,
  RANGED_COOLDOWN_MS,
  RANGED_DAMAGE,
} from '@shared/balance';

/** One-shot attack intents produced by input, consumed here. */
export interface AttackIntent {
  melee: boolean;
  ranged: boolean;
}

const MELEE_RANGE_SQ = MELEE_RANGE * MELEE_RANGE;

/**
 * Start the next melee swing if off the (short) per-move lockout. Pressing within the
 * combo window advances the chain (slash → alt → spin → uppercut → loop); otherwise it
 * restarts at the first move. The chosen move rides on the attackState for the renderer.
 */
export const startMelee = (player: Entity, now: number): void => {
  if (now < (player.meleeReadyAt ?? 0)) return;
  const chaining = now <= (player.meleeComboExpiresAt ?? 0);
  const index = chaining ? ((player.meleeCombo ?? -1) + 1) % COMBO_MOVES.length : 0;
  const move = comboAt(index);
  player.meleeCombo = index;
  player.attackState = { kind: 'melee', startedAt: now, hitSet: new Set(), combo: index };
  player.meleeReadyAt = now + move.recoveryMs;
  player.meleeComboExpiresAt = now + move.animMs + COMBO_CONTINUE_MS;
};

/** Spawn a projectile in the player's facing direction if off cooldown. */
export const fireRanged = (world: World<Entity>, player: Entity, now: number): void => {
  if (now < (player.rangedReadyAt ?? 0)) return;
  const t = player.transform;
  if (!t) return;
  player.rangedReadyAt = now + RANGED_COOLDOWN_MS;

  const dirX = Math.sin(t.rotationY);
  const dirZ = Math.cos(t.rotationY);
  world.add({
    transform: {
      position: [t.position[0] + dirX, t.position[1] + 1, t.position[2] + dirZ],
      rotationY: t.rotationY,
    },
    velocity: { linear: [dirX * PROJECTILE_SPEED, 0, dirZ * PROJECTILE_SPEED] },
    projectile: true,
    faction: 'player',
    damage: computeDamage(RANGED_DAMAGE),
    spawnedAt: now,
  });
};

/**
 * Resolve active melee swings: during the active window, damage monsters inside the
 * arc in front of the player, at most once per target per swing.
 */
export const weaponSystem = (world: World<Entity>, now: number): void => {
  const expired: Entity[] = [];

  for (const player of world.with('attackState', 'transform', 'playerControlled')) {
    const atk = player.attackState;
    if (atk.kind !== 'melee') continue;
    const move = comboAt(atk.combo ?? 0);
    if (now - atk.startedAt > move.activeMs) {
      expired.push(player);
      continue;
    }

    const t = player.transform;
    const fx = Math.sin(t.rotationY);
    const fz = Math.cos(t.rotationY);
    const cosHalfArc = Math.cos(move.halfArc);

    for (const m of world.with('transform', 'health', 'faction')) {
      if (m.faction !== 'monster') continue;
      if (atk.hitSet.has(m)) continue;
      const dx = m.transform.position[0] - t.position[0];
      const dz = m.transform.position[2] - t.position[2];
      const distSq = dx * dx + dz * dz;
      const reach = MELEE_RANGE + (m.radius ?? 0);
      if (distSq > reach * reach && distSq > MELEE_RANGE_SQ) continue;

      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx / len) * fx + (dz / len) * fz;
      if (dot < cosHalfArc) continue; // outside the swing arc

      dealDamage(world, m, computeDamage(MELEE_DAMAGE * move.damageMul), now);
      atk.hitSet.add(m);
    }
  }

  for (const player of expired) world.removeComponent(player, 'attackState');
};

/** Despawn projectiles past their lifetime (movement + hits handled in projectileSystem). */
export const isProjectileExpired = (p: Entity, now: number): boolean =>
  now - (p.spawnedAt ?? now) > PROJECTILE_LIFETIME_MS;
