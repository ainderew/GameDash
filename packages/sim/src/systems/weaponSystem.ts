import type { World } from 'miniplex';
import type { Vector3Tuple } from '@shared/types';
import type { AttackState, Entity } from '../components';
import { dealDamage } from './combatHelpers';
import {
  chainReadyMs,
  COMBO_CONTINUE_MS,
  COMBO_MOVES,
  comboAt,
  DASH_SLASH_MOVE,
  moveActiveWindow,
  moveAnimMs,
  moveForAttack,
  moveTrailWindow,
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

/** How much harder the "1" dash-slash shoves its targets vs a normal heavy swing. */
const DASH_SLASH_KNOCKBACK = 2.6;

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
 * combo window advances the chain (horizontal → reverse → overhead → thrust → loop); otherwise it
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

  if (move.damaging) hooks.onSwing?.(player, move.weight, moveTrailWindow(move).start);
  return true;
};

/** Dash-slash cooldown, ms — long enough that it reads as a committed skill, not a spam button. */
export const DASH_SLASH_COOLDOWN_MS = 2500;

/**
 * Start the "1" dash-slash skill: a committed heavy lunge whose own root motion carries the
 * hero forward (DASH_SLASH_MOVE.lungeDist), landing a big cleave at the end. It borrows the
 * thrust clip (meleeCombo = its index) so the renderer animates it with no new state, while
 * the sim resolves the real move data via `moveForAttack` (dashSlash flag on the attackState).
 * Grants i-frames through the dash so it reads as a heroic gap-closer, and cancels any swing
 * in progress. Gated only by its own cooldown. Returns whether it actually fired.
 */
export const startDashSlash = (
  world: World<Entity>,
  player: Entity,
  now: number,
  aimAt?: [number, number],
  hooks: SimHooks = NOOP_HOOKS,
): boolean => {
  if (now < (player.skill1ReadyAt ?? 0)) return false;
  if (now < (player.dodgingUntil ?? 0)) return false; // a dodge owns the body; don't stack
  if (aimAt) faceToward(player, aimAt);

  const move = DASH_SLASH_MOVE;
  const atk: AttackState = { kind: 'melee', startedAt: now, hitSet: new Set(), dashSlash: true };
  // addComponent (not a bare write) so miniplex indexes the entity into the 'attackState'
  // archetype weaponSystem queries; swapping in place if a swing is already live.
  if (player.attackState) player.attackState = atk;
  else world.addComponent(player, 'attackState', atk);
  // Borrow the thrust clip for the renderer (Player.tsx reads comboAt(meleeCombo).clip), but
  // keep this OUT of the J-combo chain — no continue window, so it never advances the chain.
  const thrustIndex = COMBO_MOVES.findIndex((m) => m.clip === 'thrust');
  player.meleeCombo = thrustIndex >= 0 ? thrustIndex : 0;
  player.meleeStartedAt = now;
  player.attackAnimUntil = now + moveAnimMs(move);
  player.meleeReadyAt = now + chainReadyMs(move);
  player.meleeComboExpiresAt = 0;
  player.skill1ReadyAt = now + DASH_SLASH_COOLDOWN_MS;
  // I-frames span the committed dash (through the active window) — you phase in, then strike.
  player.iframeUntil = now + moveActiveWindow(move).end;
  // Break out of any hit reaction so the skill fires responsively.
  player.knockback = undefined;
  player.staggerUntil = 0;

  hooks.onSwing?.(player, 'heavy', moveTrailWindow(move).start);
  return true;
};

/** Spawn a projectile in the player's facing direction (snapped to `aimAt`) if off cooldown. */
export const fireRanged = (
  world: World<Entity>,
  player: Entity,
  now: number,
  aimAt?: [number, number],
): boolean => {
  if (now < (player.rangedReadyAt ?? 0)) return false;
  const t = player.transform;
  if (!t) return false;
  if (aimAt) faceToward(player, aimAt);
  const buff = player.relicBuff;
  player.rangedReadyAt = now + RANGED_COOLDOWN_MS / (buff?.attackRateMult ?? 1);

  const count = buff?.projectileCount ?? 1;
  const spreadRad = (6 * Math.PI) / 180;
  for (let i = 0; i < count; i += 1) {
    const yaw = t.rotationY + (i - (count - 1) / 2) * spreadRad;
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    world.add({
      transform: {
        position: [t.position[0] + dirX, t.position[1] + 1, t.position[2] + dirZ],
        rotationY: yaw,
      },
      velocity: { linear: [dirX * PROJECTILE_SPEED, 0, dirZ * PROJECTILE_SPEED] },
      projectile: true,
      projectileOwner: player,
      projectilePierce: buff?.pierce ?? false,
      projectileHitSet: new Set<Entity>(),
      projectileKnockback: buff?.knockback,
      projectileLifestealPct: buff?.lifestealPct ?? 0,
      faction: 'player',
      damage: computeDamage(RANGED_DAMAGE * (buff?.damageMult ?? 1)),
      spawnedAt: now,
    });
  }
  return true;
};

/**
 * THE PURE MELEE ARC TEST — the gameplay truth both solo play and the room server trust.
 * Broad-phase only (the client blade-socket refinement is presentation, never replicated).
 * `pad` widens reach + arc for the server's lag-compensated validation (NET_MELEE_PAD),
 * favoring the attacker. Returns the unit attacker→target direction on a hit (for the
 * contact point + knockback), or null if the target is outside reach or the swing cone.
 */
export const meleeArcHit = (
  attackerPos: Readonly<Vector3Tuple>,
  facingX: number,
  facingZ: number,
  cosHalfArc: number,
  range: number,
  targetPos: Readonly<Vector3Tuple>,
  targetRadius: number,
  pad = 0,
): { ux: number; uz: number } | null => {
  const dx = targetPos[0] - attackerPos[0];
  const dz = targetPos[2] - attackerPos[2];
  const distSq = dx * dx + dz * dz;
  const reach = range + targetRadius + pad;
  if (distSq > reach * reach) return null;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const dot = ux * facingX + uz * facingZ;
  // Pad the cone slightly too (converts a small reach pad into an angular one at contact).
  const cone = pad > 0 ? Math.max(-1, cosHalfArc - 0.12) : cosHalfArc;
  if (dot < cone) return null;
  return { ux, uz };
};

/**
 * Server lag-comp seam: resolve a melee swing's targets against REWOUND positions instead
 * of live ones. Given the target entity, returns the XZ+Y position to test the arc against
 * (what the attacker saw at their view time), or null to SKIP this target — a monster that
 * died more than one tick before the attacker's view can no longer be hit (plan Task 3).
 * Solo/default play passes no resolver and tests live positions.
 */
export type MeleeRewind = (target: Entity, attacker: Entity, now: number) => Vector3Tuple | null;

export interface MeleeResolveOptions {
  rewind?: MeleeRewind;
  /** Extra reach/arc tolerance for arc-only server validation, world units. */
  pad?: number;
}

/**
 * Resolve active melee swings: during the active window, damage monsters inside the
 * arc in front of the player, at most once per target per swing. On the room server,
 * `opts.rewind` rewinds each candidate to the attacker's view time (lag compensation).
 */
export const weaponSystem = (
  world: World<Entity>,
  now: number,
  hooks: SimHooks = NOOP_HOOKS,
  opts: MeleeResolveOptions = {},
): void => {
  const expired: Entity[] = [];

  for (const player of world.with('attackState', 'transform', 'playerControlled')) {
    const atk = player.attackState;
    // Some combat interrupts clear the component value before Miniplex updates its query.
    if (!atk) {
      expired.push(player);
      continue;
    }
    if (atk.kind !== 'melee') continue;
    // A dodge cancels the swing — kill the hitbox immediately (rooting/anim were already
    // cleared by applyPlayerIntent when the dash started).
    if (now < (player.dodgingUntil ?? 0)) {
      expired.push(player);
      continue;
    }
    const move = moveForAttack(atk);
    const age = now - atk.startedAt;
    // Click one is a held anticipation pose. Keep its attack state alive for networking and
    // animation selection, but never open a hitbox or add the target to the hit set.
    if (!move.damaging) {
      if (age > moveAnimMs(move)) expired.push(player);
      continue;
    }
    const { start, end } = moveActiveWindow(move);
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
    const range = MELEE_RANGE * (player.weaponReachMul ?? 1) * (move.rangeMul ?? 1);
    const pad = opts.pad ?? 0;

    for (const m of world.with('transform', 'health', 'faction')) {
      if (m.faction !== 'monster') continue;
      if (atk.hitSet.has(m)) continue;
      // Lag-comp: test against what the attacker SAW (rewound), or skip a too-dead target.
      const testPos = opts.rewind ? opts.rewind(m, player, now) : m.transform.position;
      if (!testPos) continue;
      const hit = meleeArcHit(t.position, fx, fz, cosHalfArc, range, testPos, m.radius ?? 0, pad);
      if (!hit) continue;
      const { ux, uz } = hit;

      // Contact point on the near edge of the target, chest height — where sparks land.
      // (Uses the target's LIVE position; the rewind only decides whether the hit lands.)
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
        {
          attacker: player,
          strength: move.weight,
          dir: [ux, uz],
          point,
          dashSlash: atk.dashSlash,
          // The "1" dash-slash sends what it hits flying — a much bigger shove than a swing.
          knockbackScale: atk.dashSlash ? DASH_SLASH_KNOCKBACK : 1,
        },
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
