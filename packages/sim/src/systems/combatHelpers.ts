import type { World } from 'miniplex';
import type { Entity } from '../components';
import type { Vector3Tuple } from '@shared/types';
import { isInIFrames, type HitStrength } from '@shared/combat';
import { HITSTUN_MS, KNOCKBACK_TUNING, PARRY_TUNING } from '@shared/balance';
import { NOOP_HOOKS, type HitContext, type SimHooks } from '../hooks';

const HIT_FLASH_MS = 120;
const DAMAGE_NUMBER_MS = 750;

/** Extra context a hit can carry so the feel layer knows who hit whom, how hard, and where. */
export interface HitOptions {
  /** The entity that dealt the hit — drives knockback direction. */
  attacker?: Entity;
  /** Light (jab) or heavy (committed) — scales every feedback system. Default 'light'. */
  strength?: HitStrength;
  /** World-space contact point for sparks + shockwave. Default: target chest height. */
  point?: Vector3Tuple;
  /** Explicit knockback direction in XZ (unit-ish). Default: derived from attacker→target. */
  dir?: [number, number];
  /** Scales gameplay knockback independently of visual hit strength (0 disables it). */
  knockbackScale?: number;
  /** Environmental/unstable effects that cannot be reflected with a weapon parry. */
  unblockable?: boolean;
  /** The hit came from the "1" dash-slash skill — forwarded to the feel layer for a bigger VFX. */
  dashSlash?: boolean;
}

/** Assemble the rich hit context the feel layer consumes. */
const buildHitContext = (
  world: World<Entity>,
  target: Entity,
  amount: number,
  now: number,
  crit: boolean,
  opts: HitOptions,
  lethal = false,
): HitContext => {
  const tp = target.transform?.position ?? [0, 0, 0];
  const point: Vector3Tuple = opts.point ?? [tp[0], tp[1] + 1.0, tp[2]];

  let dirX = 0;
  let dirZ = 0;
  if (opts.dir) {
    [dirX, dirZ] = opts.dir;
  } else if (opts.attacker?.transform) {
    const ap = opts.attacker.transform.position;
    dirX = tp[0] - ap[0];
    dirZ = tp[2] - ap[2];
  }
  const len = Math.hypot(dirX, dirZ);
  if (len > 1e-4) {
    dirX /= len;
    dirZ /= len;
  }

  return {
    world,
    attacker: opts.attacker,
    target,
    amount,
    strength: opts.strength ?? 'light',
    crit,
    lethal,
    point,
    dirX,
    dirZ,
    now,
    dashSlash: opts.dashSlash ?? false,
  };
};

/**
 * Apply damage to a target, respecting i-frames. Returns true if damage landed.
 * Pure over (entity, amount, now) apart from mutating the target — unit-testable.
 */
export const applyDamage = (target: Entity, amount: number, now: number): boolean => {
  if (!target.health) return false;
  // Death resolves at the end of the tick, so reject later same-tick hits on a zero-HP corpse.
  // This also guarantees exactly one lethal hit for kill credit.
  if (target.health.current <= 0) return false;
  if (isInIFrames(target, now)) return false;
  target.health.current = Math.max(0, target.health.current - amount);
  target.hitFlashUntil = now + HIT_FLASH_MS;
  target.lastDamagedAt = now;
  return true;
};

/**
 * Apply damage plus its GAMEPLAY consequences (knockback, launch, stagger, hit-reaction
 * stamps), then hand the rich context to the feel layer via `hooks.onHitLanded` — the
 * client fires hitstop/shake/audio/VFX/damage numbers there; the server passes no hooks
 * and the hit is silent. Use this from systems (which have world access); keep the pure
 * `applyDamage` for unit tests.
 *
 * Pass `opts` (attacker, strength, contact point) so the feel layer can shape the impact.
 * A player inside an open parry window negates the hit and punishes the attacker instead.
 */
export const dealDamage = (
  world: World<Entity>,
  target: Entity,
  amount: number,
  now: number,
  crit = false,
  opts: HitOptions = {},
  hooks: SimHooks = NOOP_HOOKS,
): boolean => {
  // Parry seam: an open block window on the player turns the hit back on the attacker.
  if (
    PARRY_TUNING.enabled &&
    !opts.unblockable &&
    target.playerControlled &&
    (target.blockingUntil ?? 0) > now &&
    !isInIFrames(target, now)
  ) {
    const ctx = buildHitContext(world, target, amount, now, crit, opts);
    // Stagger + shove the attacker back (dir points attacker→target, push the other way).
    const attacker = ctx.attacker;
    if (attacker && !attacker.playerControlled) {
      const speed = KNOCKBACK_TUNING.speed.heavy;
      attacker.knockback = [-ctx.dirX * speed, 0, -ctx.dirZ * speed];
      attacker.staggerUntil = now + PARRY_TUNING.attackerStunMs;
      attacker.hitReactionAt = now;
      attacker.hitReactionStrength = 'heavy';
    }
    hooks.onParry?.(ctx);
    return false;
  }

  const wasAlive = (target.health?.current ?? 0) > 0;
  const landed = applyDamage(target, amount, now);
  if (!landed) return false;

  // Practice targets immediately regenerate. The hit still produces damage/audio/VFX, but
  // the dummy remains available forever and can never leak kills or loot into hub sessions.
  if (target.trainingDummy && target.health) target.health.current = target.health.max;

  const ctx = buildHitContext(
    world,
    target,
    amount,
    now,
    crit,
    opts,
    !target.trainingDummy && wasAlive && (target.health?.current ?? 0) <= 0,
  );

  // KNOCKBACK + HITSTUN — everyone gets shoved away from the blow. Players take a SCALED
  // shove (playerScale) that plays under the hurt anim: knockbackSystem owns their
  // horizontal velocity until the impulse settles, then control returns. A dodge breaks
  // out of it early (see applyPlayerIntent) so it never feels like a cutscene.
  const kbScale = target.trainingDummy
    ? 0
    : (target.playerControlled ? KNOCKBACK_TUNING.playerScale : 1) * (opts.knockbackScale ?? 1);
  if (kbScale > 0) {
    const speed = KNOCKBACK_TUNING.speed[ctx.strength] * kbScale;
    const launch = KNOCKBACK_TUNING.launch[ctx.strength] * kbScale;
    const staggerMs = HITSTUN_MS[ctx.strength];
    if (target.playerControlled && hooks.onPlayerImpulse) {
      // Server networked path: defer the shove to the sequenced ServerImpulse pipeline so
      // the owning client replays it (contract #3) — apply nothing in-sim this tick.
      hooks.onPlayerImpulse(target, [ctx.dirX * speed, launch, ctx.dirZ * speed], staggerMs);
    } else {
      target.knockback = [ctx.dirX * speed, 0, ctx.dirZ * speed];
      if (target.velocity) target.velocity.linear[1] = launch;
      target.staggerUntil = now + staggerMs;
    }
  }

  // INTERRUPT-ON-HIT: a struck player's in-flight swing is CANCELLED (a flinch) — trades reward
  // not getting hit, so approaching and striking first actually wins. The hitbox drops, the root
  // releases, and the melee lockout clears so the player can act again the instant the stagger
  // ends. Solo / server-authoritative: cleared directly here. (A networked client predicting its
  // OWN swing won't see this cancel until the shove replays — folded in with the sequenced-impulse
  // netcode work, same timeline as the knockback above.)
  if (target.playerControlled && (target.attackState || (target.attackAnimUntil ?? 0) > now)) {
    target.attackState = undefined;
    target.attackAnimUntil = 0;
    target.meleeReadyAt = 0;
  }

  // Hit-reaction stamp: deterministic sim data (passControl gates pass interruption on the
  // strength) that the renderer also reads for squash & stretch timing.
  target.hitReactionAt = now;
  target.hitReactionStrength = ctx.strength;

  hooks.onHitLanded?.(ctx);
  return true;
};

/** Age out floating damage numbers past their lifetime. */
export const floatingNumberSystem = (world: World<Entity>, now: number): void => {
  const expired: Entity[] = [];
  for (const e of world.with('floatingNumber')) {
    if (now - e.floatingNumber.spawnedAt > DAMAGE_NUMBER_MS) expired.push(e);
  }
  for (const e of expired) world.remove(e);
};

export const DAMAGE_NUMBER_LIFETIME_MS = DAMAGE_NUMBER_MS;

/** Squared XZ distance between two entities (cheap; avoids sqrt). */
export const distSqXZ = (a: Entity, b: Entity): number => {
  const ap = a.transform?.position;
  const bp = b.transform?.position;
  if (!ap || !bp) return Infinity;
  const dx = ap[0] - bp[0];
  const dz = ap[2] - bp[2];
  return dx * dx + dz * dz;
};
