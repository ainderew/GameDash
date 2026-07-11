import type { World } from 'miniplex';
import type { AttackState, Entity } from '../components';
import { dealDamage } from './combatHelpers';
import {
  chainReadyMs,
  COMBO_CONTINUE_MS,
  COMBO_MOVES,
  comboAt,
  moveActiveWindow,
  moveAnimMs,
} from '../combat/combo';
import { NOOP_HOOKS, type SimHooks } from '../hooks';
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

/** How long a melee press made during the swing lockout stays buffered, ms. */
export const MELEE_BUFFER_MS = 250;

/** Snap an entity's facing toward a world-space XZ point (cursor aim). */
const faceToward = (e: Entity, aimAt: [number, number]): void => {
  const t = e.transform;
  if (!t) return;
  const dx = aimAt[0] - t.position[0];
  const dz = aimAt[1] - t.position[2];
  if (dx * dx + dz * dz > 1e-6) t.rotationY = Math.atan2(dx, dz);
};

/**
 * Start the next melee swing if off the (short) per-move lockout. Pressing within the
 * combo window advances the chain (slash → alt → spin → uppercut → loop); otherwise it
 * restarts at the first move. The chosen move rides on the attackState for the renderer.
 * `aimAt` (ground point under the cursor, XZ) snaps the facing AT swing start, so the
 * arc, lunge, and animation all fire toward the mouse; facing then stays locked (rooted).
 * Returns whether a swing actually started (false while locked out — caller may buffer).
 */
export const startMelee = (
  world: World<Entity>,
  player: Entity,
  now: number,
  aimAt?: [number, number],
  hooks: SimHooks = NOOP_HOOKS,
): boolean => {
  if (now < (player.meleeReadyAt ?? 0)) return false;
  // No swings mid-dash — a buffered press fires the moment the dodge ends instead.
  if (now < (player.dodgingUntil ?? 0)) return false;
  if (aimAt) faceToward(player, aimAt);
  const chaining = now <= (player.meleeComboExpiresAt ?? 0);
  const index = chaining ? ((player.meleeCombo ?? -1) + 1) % COMBO_MOVES.length : 0;
  const move = comboAt(index);
  player.meleeCombo = index;
  const atk: AttackState = { kind: 'melee', startedAt: now, hitSet: new Set(), combo: index };
  // MUST go through addComponent (not a plain property write) so miniplex indexes the
  // entity into the 'attackState' archetype that weaponSystem queries. A chain press while
  // the previous swing is still indexed just swaps the value in place.
  if (player.attackState) player.attackState = atk;
  else world.addComponent(player, 'attackState', atk);
  // The swing's window IS the animation's length — the player is rooted (see
  // applyPlayerIntent) and the clip plays to completion unless a dodge cancels it.
  player.meleeStartedAt = now;
  player.attackAnimUntil = now + moveAnimMs(move);
  // The tail of the swing is cancelable into the next chain press; a fresh press earlier
  // than that is buffered by the caller, so mashing still never drops an input.
  player.meleeReadyAt = now + chainReadyMs(move);
  player.meleeComboExpiresAt = now + moveAnimMs(move) + COMBO_CONTINUE_MS;

  // Whoosh on the swing itself so even a whiff feels like effort (client feel hook).
  hooks.onSwing?.(player, move.weight);
  return true;
};

/** Spawn a projectile in the player's facing direction (snapped to `aimAt`) if off cooldown. */
export const fireRanged = (
  world: World<Entity>,
  player: Entity,
  now: number,
  aimAt?: [number, number],
): void => {
  if (now < (player.rangedReadyAt ?? 0)) return;
  const t = player.transform;
  if (!t) return;
  if (aimAt) faceToward(player, aimAt);
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
export const weaponSystem = (
  world: World<Entity>,
  now: number,
  hooks: SimHooks = NOOP_HOOKS,
): void => {
  const expired: Entity[] = [];

  for (const player of world.with('attackState', 'transform', 'playerControlled')) {
    const atk = player.attackState;
    if (atk.kind !== 'melee') continue;
    // A dodge cancels the swing — kill the hitbox immediately (rooting/anim were already
    // cleared by applyPlayerIntent when the dash started).
    if (now < (player.dodgingUntil ?? 0)) {
      expired.push(player);
      continue;
    }
    const move = comboAt(atk.combo ?? 0);
    const { start, end } = moveActiveWindow(move);
    const age = now - atk.startedAt;
    if (age > end) {
      expired.push(player);
      continue;
    }
    if (age < start) continue; // still winding up — the hitbox isn't live yet

    const t = player.transform;
    const fx = Math.sin(t.rotationY);
    const fz = Math.cos(t.rotationY);
    const cosHalfArc = Math.cos(move.halfArc);
    // The wielded weapon scales reach (greatsword > katana > dagger) — loadout data
    // synced onto the entity by the client adapter (SystemRunner).
    const range = MELEE_RANGE * (player.weaponReachMul ?? 1);
    const rangeSq = range * range;

    for (const m of world.with('transform', 'health', 'faction')) {
      if (m.faction !== 'monster') continue;
      if (atk.hitSet.has(m)) continue;
      const dx = m.transform.position[0] - t.position[0];
      const dz = m.transform.position[2] - t.position[2];
      const distSq = dx * dx + dz * dz;
      const reach = range + (m.radius ?? 0);
      if (distSq > reach * reach && distSq > rangeSq) continue;

      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      const dot = ux * fx + uz * fz;
      if (dot < cosHalfArc) continue; // outside the swing arc

      // Contact point on the near edge of the target, chest height — where sparks land.
      const mr = m.radius ?? 0.5;
      const point: [number, number, number] = [
        m.transform.position[0] - ux * mr,
        m.transform.position[1] + 1.0,
        m.transform.position[2] - uz * mr,
      ];
      // Renderer-owned weapon sockets may refine the visual contact point against the
      // previous rendered blade pose (local play only). The deterministic arc broad phase
      // above stays the gameplay truth — the server will never run this hook.
      hooks.refineMeleeHit?.(player, m, point);
      dealDamage(
        world,
        m,
        computeDamage(MELEE_DAMAGE * move.damageMul),
        now,
        false,
        { attacker: player, strength: move.weight, dir: [ux, uz], point },
        hooks,
      );
      atk.hitSet.add(m);
    }
  }

  for (const player of expired) world.removeComponent(player, 'attackState');
};

/** Despawn projectiles past their lifetime (movement + hits handled in projectileSystem). */
export const isProjectileExpired = (p: Entity, now: number): boolean =>
  now - (p.spawnedAt ?? now) > PROJECTILE_LIFETIME_MS;
