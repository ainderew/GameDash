/**
 * THE "ON HIT LANDED" SEAM — client half.
 *
 * One function that fires EVERY feedback system for a confirmed hit. Any attack in the
 * game — melee, projectile, a future new weapon — routes through the sim's `dealDamage`,
 * which invokes this through the injected SimHooks (see simHooks.ts). Change the feel of
 * the whole game in one place; add a new attack and it inherits all the juice for free.
 *
 * The GAMEPLAY consequences of a hit (knockback, launch, stagger, hit-reaction stamps)
 * moved INTO the sim (@sim/systems/combatHelpers) — the server must simulate them.
 * This file owns only what a server never runs:
 *   hitstop (freeze) → screen shake → audio → flash+squash timing → impact VFX → damage numbers
 */

import type { World } from 'miniplex';
import type { Entity } from '@sim/components';
import type { HitContext } from '@sim/hooks';
import type { Vector3Tuple } from '@shared/types';
import { feel, type HitStrength } from '@/game/feel/config';
import { requestHitstop, requestSlowmo } from '@/game/feel/time';
import { addTrauma } from '@/game/feel/screenShake';
import { playHit, playParry } from '@/game/feel/audio';
import { useUIStore } from '@/ui/store';

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

/** Large violet friendly-fire burst emitted by the corrupted carrier. */
export const spawnVolatileDischargeVfx = (
  world: World<Entity>,
  point: Vector3Tuple,
  radius: number,
  overload: boolean,
): void => {
  const spawnedAtReal = performance.now();
  const color = hexToRgb(overload ? '#fff0ff' : '#b026ff');
  world.add({
    transform: { position: [...point], rotationY: 0 },
    impactFx: {
      kind: 'spark',
      strength: 'heavy',
      spawnedAtReal,
      lifetimeMs: 680,
      color,
      count: 16,
      radius: radius * 0.92,
      dirX: 0,
      dirZ: 0,
    },
  });
  world.add({
    transform: { position: [...point], rotationY: 0 },
    impactFx: {
      kind: 'ring',
      strength: 'heavy',
      spawnedAtReal,
      lifetimeMs: 720,
      color,
      count: 0,
      radius,
      dirX: 0,
      dirZ: 0,
    },
  });
};

/**
 * Fire all client feedback for a landed hit. Modular by design — this is the reusable
 * event. Knockback/stagger already happened inside the sim before this fires.
 */
export const onHitLanded = (ctx: HitContext): void => {
  const { world, target, amount, strength, crit, point, dirX, dirZ, now } = ctx;

  // 1. HITSTOP — freeze the whole fight for a few frames. The primary impact read.
  requestHitstop(feel.hitstopMs[strength]);

  // 4. SCREEN SHAKE — add trauma scaled to hit strength (shake = trauma²).
  addTrauma(feel.screenShake.traumaPerHit[strength]);

  // 7. AUDIO — the layered punch (half the feel).
  playHit(strength, crit);

  // 5. HIT REACTION — flash (white light / red heavy); the squash timeline reads the
  //    hitReaction stamps the sim already wrote.
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

  // Floating damage number — a render-only entity, spawned client-side (never by the sim).
  if (target.transform) {
    world.add({
      transform: {
        position: [
          target.transform.position[0] + (((now % 7) - 3) / 6) * 0.4,
          target.transform.position[1] + 1.4,
          target.transform.position[2],
        ],
        rotationY: 0,
      },
      floatingNumber: { amount, spawnedAt: now, crit },
    });
  }

  // HUD juice: a player hit on an enemy feeds the combo counter.
  if (ctx.attacker?.playerControlled && !target.playerControlled) {
    useUIStore.getState().registerComboHit(now);
  }
};

/**
 * A successful parry: the incoming hit is negated and turned back on the attacker.
 * Bright spark, hard shake, a snap of slow-motion. (The attacker's stagger/shove and
 * hit-reaction stamps are sim consequences, applied in dealDamage before this fires.)
 */
export const onParry = (ctx: HitContext): void => {
  const { world, attacker, point, now } = ctx;

  playParry();
  addTrauma(feel.screenShake.traumaPerHit.heavy);
  requestSlowmo(feel.parry.slowmoScale, feel.parry.slowmoMs);
  // A bright spark at the clash — always heavy + white-hot.
  spawnImpactVfx(world, point, 'heavy', '#ffffff');

  // White flash on the punished attacker (its knockback/stagger came from the sim).
  if (attacker && !attacker.playerControlled) {
    attacker.hitFlashUntil = now + feel.flash.durationMs.heavy;
    attacker.hitFlashColor = hexToRgb('#ffffff');
  }
};
