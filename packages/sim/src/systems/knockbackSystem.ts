import type { World } from 'miniplex';
import type { Entity } from '../components';
import { KNOCKBACK_TUNING } from '@shared/balance';

/**
 * KNOCKBACK — an impulse away from the attacker that decays with friction.
 *
 * dealDamage seeds `entity.knockback` (a velocity, world units/sec) and a `staggerUntil`
 * window. This system, run AFTER the AI/weapon systems and BEFORE movement, drives the
 * entity's horizontal velocity from that decaying impulse — overriding normal AI steering
 * while the stagger plays, so a hit target snaps back instead of walking through the blow.
 *
 * The upward "launch" is applied once at hit time (onHitLanded sets velocity.y); gravity in
 * movementSystem brings it back down. Runs on the SCALED (game) dt, so knockback pauses
 * during hitstop and erupts the instant the freeze releases — that's the snap-back.
 */
export const knockbackSystem = (world: World<Entity>, dt: number, now: number): void => {
  for (const e of world.with('velocity')) {
    const k = e.knockback;
    if (!k) continue;

    const mag = Math.hypot(k[0], k[2]);
    const staggered = (e.staggerUntil ?? 0) > now;

    // Settled and no longer staggered → hand control back to the AI/movement.
    if (mag < 0.05 && !staggered) {
      e.knockback = undefined;
      continue;
    }

    // Knockback owns horizontal velocity while it's live.
    e.velocity.linear[0] = k[0];
    e.velocity.linear[2] = k[2];

    // Friction decay (frame-rate independent). dt=0 during hitstop → no decay, no motion.
    const decay = Math.max(0, 1 - KNOCKBACK_TUNING.friction * dt);
    k[0] *= decay;
    k[2] *= decay;
  }
};
