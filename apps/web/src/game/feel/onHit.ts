/**
 * THE "ON HIT LANDED" SEAM.
 *
 * One function that fires EVERY feedback system for a confirmed hit. Any attack in the
 * game — melee, projectile, a future new weapon — routes through `dealDamage`, which calls
 * this. Change the feel of the whole game in one place; add a new attack and it inherits
 * all the juice for free.
 *
 * Order of operations on a hit:
 *   hitstop (freeze) → screen shake → audio → knockback+stagger → flash+squash → impact VFX
 */

import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import type { Vector3Tuple } from '@shared/types';
import { feel, type HitStrength } from '@/game/feel/config';
import { requestHitstop, requestSlowmo } from '@/game/feel/time';
import { addTrauma } from '@/game/feel/screenShake';
import { playHit, playParry } from '@/game/feel/audio';
import { useUIStore } from '@/ui/store';

export interface HitContext {
  world: World<Entity>;
  /** Who dealt the hit (for knockback direction). Optional (e.g. a stray projectile). */
  attacker?: Entity;
  target: Entity;
  amount: number;
  strength: HitStrength;
  crit: boolean;
  /** Contact point in world space — where sparks + shockwave spawn. */
  point: Vector3Tuple;
  /** Unit knockback direction in XZ (away from the attacker). */
  dirX: number;
  dirZ: number;
  /** gameNow() of the hit. */
  now: number;
}

/** hex `#rrggbb` → linear-ish RGB tuple in 0..1. */
export const hexToRgb = (hex: string): Vector3Tuple => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Spawn a spark burst + expanding shockwave ring at a contact point (real-time FX). */
export const spawnImpactVfx = (
  world: World<Entity>,
  point: Vector3Tuple,
  strength: HitStrength,
  colorHex: string,
  dirX = 0,
  dirZ = 0,
): void => {
  const spawnedAtReal = performance.now();
  const color = hexToRgb(colorHex);
  world.add({
    transform: { position: [...point], rotationY: 0 },
    impactFx: {
      kind: 'spark',
      strength,
      spawnedAtReal,
      lifetimeMs: feel.vfx.sparkLifetimeMs[strength],
      color,
      count: feel.vfx.sparkCount[strength],
      radius: feel.vfx.sparkRadius[strength],
      dirX,
      dirZ,
    },
  });
  world.add({
    transform: { position: [...point], rotationY: 0 },
    impactFx: {
      kind: 'ring',
      strength,
      spawnedAtReal,
      lifetimeMs: feel.vfx.ringLifetimeMs,
      color,
      count: 0,
      radius: feel.vfx.ringRadius[strength],
      dirX,
      dirZ,
    },
  });
};

/**
 * Fire all feedback for a landed hit. Modular by design — this is the reusable event.
 */
export const onHitLanded = (ctx: HitContext): void => {
  const { world, target, strength, crit, point, dirX, dirZ, now } = ctx;

  // 1. HITSTOP — freeze the whole fight for a few frames. The primary impact read.
  requestHitstop(feel.hitstopMs[strength]);

  // 4. SCREEN SHAKE — add trauma scaled to hit strength (shake = trauma²).
  addTrauma(feel.screenShake.traumaPerHit[strength]);

  // 7. AUDIO — the layered punch (half the feel).
  playHit(strength, crit);

  // 3. KNOCKBACK + 5. HITSTUN — everyone gets shoved away from the blow. The player takes a
  //    SCALED shove (playerScale) that plays under the hurt anim: knockbackSystem owns their
  //    horizontal velocity until the impulse settles, then control returns. A dodge breaks
  //    out of it early (see applyPlayerIntent) so it never feels like a cutscene.
  const kbScale = target.playerControlled ? feel.knockback.playerScale : 1;
  if (kbScale > 0) {
    const speed = feel.knockback.speed[strength] * kbScale;
    target.knockback = [dirX * speed, 0, dirZ * speed];
    if (target.velocity) {
      target.velocity.linear[1] = feel.knockback.launch[strength] * kbScale;
    }
    target.staggerUntil = now + feel.hitstunMs[strength];
  }

  // 5. HIT REACTION — flash (white light / red heavy) + squash & stretch timeline.
  target.hitReactionAt = now;
  target.hitReactionStrength = strength;
  target.hitFlashUntil = now + feel.flash.durationMs[strength];
  // The player always flashes red (damage-taken readout); enemies stay white/red by strength.
  const flashHex =
    target.playerControlled || strength === 'heavy' ? feel.flash.colorHeavy : feel.flash.colorLight;
  target.hitFlashColor = hexToRgb(flashHex);

  // 6. IMPACT VFX — spark burst + shockwave ring exactly at the contact point.
  spawnImpactVfx(
    world,
    point,
    strength,
    strength === 'heavy' ? feel.vfx.colorHeavy : feel.vfx.colorLight,
    dirX,
    dirZ,
  );

  // HUD juice: a player hit on an enemy feeds the combo counter.
  if (ctx.attacker?.playerControlled && !target.playerControlled) {
    useUIStore.getState().registerComboHit(now);
  }
};

/**
 * A successful parry: the incoming hit is negated and turned back on the attacker.
 * Bright spark, hard shake, a snap of slow-motion, and the attacker is staggered.
 */
export const onParry = (ctx: HitContext): void => {
  const { world, attacker, point, dirX, dirZ, now } = ctx;

  playParry();
  addTrauma(feel.screenShake.traumaPerHit.heavy);
  requestSlowmo(feel.parry.slowmoScale, feel.parry.slowmoMs);
  // A bright spark at the clash — always heavy + white-hot.
  spawnImpactVfx(world, point, 'heavy', '#ffffff');

  // Stagger + shove the attacker back (dir points attacker→target, so push them the other way).
  if (attacker && !attacker.playerControlled) {
    const speed = feel.knockback.speed.heavy;
    attacker.knockback = [-dirX * speed, 0, -dirZ * speed];
    attacker.staggerUntil = now + feel.parry.attackerStunMs;
    attacker.hitReactionAt = now;
    attacker.hitReactionStrength = 'heavy';
    attacker.hitFlashUntil = now + feel.flash.durationMs.heavy;
    attacker.hitFlashColor = hexToRgb('#ffffff');
  }
};
