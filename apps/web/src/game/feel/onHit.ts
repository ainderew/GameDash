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
import { playHit, playParry, playSwordHit } from '@/game/feel/audio';
import { useUIStore } from '@/ui/store';

/** hex `#rrggbb` → linear-ish RGB tuple in 0..1. */
export const hexToRgb = (hex: string): Vector3Tuple => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// ── Dash-slash ("1") impact: violet MODEL glow + knockback afterimages, no spark clutter ──
const DASH_FLASH_MS = 520; // enemies hold the violet glow well past a normal hit
const DASH_HITSTOP_MUL = 2.2; // freeze harder on the committed skill
const DASH_TRAUMA_MUL = 1.7; // and shake harder
/** HDR violet emissive ADDED to the struck enemy's materials — bright enough to visibly GLOW
 *  (and bloom), not merely tint. Values >1 on purpose. */
const DASH_GLOW_RGB: Vector3Tuple = [1.3, 0.12, 2.6];

/**
 * Client-only marker set when the dash-slash lands on an enemy, so the enemy renderer
 * (MutantModels) can fling violet afterimages of the model — even if the hit kills it.
 * Keyed by the struck entity; the renderer edge-detects on `at`.
 */
export const dashHitMarks = new Map<Entity, { at: number; dirX: number; dirZ: number }>();

/** Spawn a spark burst + expanding shockwave ring at a contact point (real-time FX). */
export const spawnImpactVfx = (
  world: World<Entity>,
  point: Vector3Tuple,
  strength: HitStrength,
  colorHex: string,
  dirX = 0,
  dirZ = 0,
  variant: 'impact' | 'dashSlash' = 'impact',
): void => {
  const spawnedAtReal = performance.now();

  // Blender-authored flipbook: one billboard replaces the procedural spark+ring burst. The
  // dash-slash skill plays its own bigger, more dramatic baked sheet ('dashSlash' variant).
  if (feel.vfx.blenderFlipbook) {
    const dash = variant === 'dashSlash';
    world.add({
      transform: { position: [...point], rotationY: 0 },
      blenderImpactFx: {
        spawnedAtReal,
        lifetimeMs: feel.vfx.flipbookLifetimeMs[strength],
        size: dash ? feel.vfx.flipbookDashSlashSize : feel.vfx.flipbookSize[strength],
        dirX,
        dirZ,
        variant,
      },
    });
    return;
  }

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
 * Maximum-corruption detonation: a white-hot core tears into a broader violet crystal
 * burst, followed by three delayed shock fronts. Real-time timestamps keep the whole
 * sequence playing while the brief presentation slow-motion emphasizes the collapse.
 */
export const spawnRelicEruptionVfx = (world: World<Entity>, point: Vector3Tuple): void => {
  const spawnedAtReal = performance.now();
  const corePoint: Vector3Tuple = [point[0], point[1] + 0.85, point[2]];

  for (const burst of [
    { color: '#fff0ff', count: 12, radius: 2.8, lifetimeMs: 460 },
    { color: '#c026ff', count: 16, radius: 5.4, lifetimeMs: 920 },
  ] as const) {
    world.add({
      transform: { position: [...corePoint], rotationY: 0 },
      impactFx: {
        kind: 'spark',
        strength: 'heavy',
        spawnedAtReal,
        lifetimeMs: burst.lifetimeMs,
        color: hexToRgb(burst.color),
        count: burst.count,
        radius: burst.radius,
        dirX: 0,
        dirZ: 0,
      },
    });
  }

  for (const wave of [
    { delayMs: 0, color: '#fff0ff', radius: 3.2, lifetimeMs: 480 },
    { delayMs: 85, color: '#d946ef', radius: 5.2, lifetimeMs: 650 },
    { delayMs: 175, color: '#7c3aed', radius: 7.4, lifetimeMs: 820 },
  ] as const) {
    world.add({
      transform: { position: [...corePoint], rotationY: 0 },
      impactFx: {
        kind: 'ring',
        strength: 'heavy',
        spawnedAtReal: spawnedAtReal + wave.delayMs,
        lifetimeMs: wave.lifetimeMs,
        color: hexToRgb(wave.color),
        count: 0,
        radius: wave.radius,
        dirX: 0,
        dirZ: 0,
      },
    });
  }

  addTrauma(0.92);
  requestSlowmo(0.48, 190);
};

/**
 * Fire all client feedback for a landed hit. Modular by design — this is the reusable
 * event. Knockback/stagger already happened inside the sim before this fires.
 */
export const onHitLanded = (ctx: HitContext): void => {
  const { world, target, amount, strength, crit, point, dirX, dirZ, now } = ctx;
  const dash = ctx.dashSlash === true;
  const dashOnEnemy = dash && !target.playerControlled;

  // 1. HITSTOP — freeze the whole fight for a few frames. The primary impact read.
  //    The dash-slash freezes much harder — a committed skill should HIT.
  requestHitstop(dash ? Math.round(feel.hitstopMs.heavy * DASH_HITSTOP_MUL) : feel.hitstopMs[strength]);

  // 4. SCREEN SHAKE — add trauma scaled to hit strength (shake = trauma²).
  addTrauma(dash ? feel.screenShake.traumaPerHit.heavy * DASH_TRAUMA_MUL : feel.screenShake.traumaPerHit[strength]);

  // 7. AUDIO — recorded player-sword impact; keep a distinct punch for incoming damage.
  if (ctx.attacker?.playerControlled && !target.playerControlled) {
    playSwordHit(strength, crit);
  } else {
    playHit(strength, crit);
  }

  // 5. HIT REACTION — flash (white light / red heavy); the squash timeline reads the
  //    hitReaction stamps the sim already wrote.
  if (dashOnEnemy) {
    // Enemies struck by the dash-slash GLOW violet (HDR emissive) and hold it past a normal flash.
    target.hitFlashUntil = now + DASH_FLASH_MS;
    target.hitFlashColor = DASH_GLOW_RGB;
  } else {
    target.hitFlashUntil = now + feel.flash.durationMs[strength];
    // The player always flashes red (damage-taken readout); enemies stay white/red by strength.
    const flashHex =
      target.playerControlled || strength === 'heavy' ? feel.flash.colorHeavy : feel.flash.colorLight;
    target.hitFlashColor = hexToRgb(flashHex);
  }

  // 6. IMPACT VFX — normal hits get the spark burst + shockwave ring. The dash-slash SKIPS
  //    all spark/ring clutter: its impact read is the violet model glow + the knockback
  //    afterimages (marked here, flung in MutantModels — and they fire even on a lethal hit).
  if (dash) {
    if (dashOnEnemy) dashHitMarks.set(target, { at: performance.now(), dirX, dirZ });
  } else {
    spawnImpactVfx(
      world,
      point,
      strength,
      strength === 'heavy' ? feel.vfx.colorHeavy : feel.vfx.colorLight,
      dirX,
      dirZ,
      'impact',
    );
  }

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
