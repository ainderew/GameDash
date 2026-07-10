import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { comboAt, lungeSpeed } from '@/game/combat/combo';
import { currentWeapon } from '@/game/combat/weaponStore';
import {
  DODGE_COOLDOWN_MS,
  DODGE_DISTANCE,
  DODGE_DURATION_MS,
  DODGE_IFRAME_MS,
  GRAVITY,
  JUMP_IMPULSE,
  PLAYER_SPEED,
  PLAYER_WALK_SPEED,
} from '@shared/balance';
import { heightAt } from '@/game/world/terrainHeight';

/** A per-frame snapshot of intent, produced by useInput and read here. Pure data — no React. */
export interface InputIntent {
  /** Desired horizontal move direction in world space, expected pre-normalized (or zero). */
  moveX: number;
  moveZ: number;
  jump: boolean;
  dodge: boolean;
  /** Shift held: move at run speed instead of the default walk. */
  sprint: boolean;
}

const dashSpeed = (DODGE_DISTANCE / DODGE_DURATION_MS) * 1000;

/** Terrain height under an entity — the ground it rests on (0 across the flat play area). */
const groundYAt = (e: Entity): number => {
  const p = e.transform?.position;
  return p ? heightAt(p[0], p[2]) : 0;
};

const isGrounded = (e: Entity): boolean => (e.transform?.position[1] ?? 0) <= groundYAt(e) + 1e-4;

/**
 * Translate a player's input intent into velocity + dodge/jump state.
 * Pure and time-injected (`now` in ms) so it can be unit-tested headless.
 */
export const applyPlayerIntent = (entity: Entity, intent: InputIntent, now: number): void => {
  const { velocity, transform } = entity;
  if (!velocity || !transform) return;

  const dodging = (entity.dodgingUntil ?? 0) > now;

  // Start a dodge: dash in the current move dir (or facing) with i-frames + cooldown.
  // The dodge is also THE animation cancel: it may start at any point during a swing.
  const canDodge = intent.dodge && !dodging && now >= (entity.dodgeReadyAt ?? 0);
  if (canDodge) {
    const len = Math.hypot(intent.moveX, intent.moveZ);
    const dirX = len > 0 ? intent.moveX / len : Math.sin(transform.rotationY);
    const dirZ = len > 0 ? intent.moveZ / len : Math.cos(transform.rotationY);
    entity.dodgeDir = [dirX, 0, dirZ];
    entity.dodgingUntil = now + DODGE_DURATION_MS;
    entity.iframeUntil = now + DODGE_IFRAME_MS;
    entity.dodgeReadyAt = now + DODGE_COOLDOWN_MS;
    // Break the current swing instantly: un-root, drop the remaining melee lockout, and
    // let weaponSystem expire the hitbox this same tick (it checks dodgingUntil).
    entity.attackAnimUntil = 0;
    entity.meleeReadyAt = 0;
    // Also break out of hit knockback — the dodge is the universal escape.
    entity.knockback = undefined;
    entity.staggerUntil = 0;
  }

  // Attacking LOCKS the player into the animation: move/turn/jump input is ignored until
  // the swing finishes. But it's ROOT MOTION, not a dead stop — the swing itself strides
  // forward along facing (lungeSpeed), so heavy moves close gaps instead of feeling stuck.
  // Only the dodge above breaks out early.
  const rooted = now < (entity.attackAnimUntil ?? 0);

  const stillDodging = (entity.dodgingUntil ?? 0) > now;
  if (stillDodging && entity.dodgeDir) {
    velocity.linear[0] = entity.dodgeDir[0] * dashSpeed;
    velocity.linear[2] = entity.dodgeDir[2] * dashSpeed;
  } else if (rooted) {
    const move = comboAt(entity.meleeCombo ?? 0);
    const age = now - (entity.meleeStartedAt ?? now);
    // Longer weapons stride further (greatsword lunges past a dagger's shuffle).
    const v = lungeSpeed(move, age, currentWeapon().reachMul);
    velocity.linear[0] = Math.sin(transform.rotationY) * v;
    velocity.linear[2] = Math.cos(transform.rotationY) * v;
  } else {
    // Plain WASD walks; Shift sprints.
    const speed = intent.sprint ? PLAYER_SPEED : PLAYER_WALK_SPEED;
    velocity.linear[0] = intent.moveX * speed;
    velocity.linear[2] = intent.moveZ * speed;
    // Face the movement direction when actually moving.
    if (intent.moveX !== 0 || intent.moveZ !== 0) {
      transform.rotationY = Math.atan2(intent.moveX, intent.moveZ);
    }
  }

  const grounded = isGrounded(entity);
  // Landing restores both jumps. Keep this here (before input is consumed) so a jump
  // pressed on the landing frame starts the next two-jump sequence correctly.
  if (grounded) entity.jumpsUsed = 0;

  if (intent.jump && !rooted && (entity.jumpsUsed ?? 0) < 2) {
    velocity.linear[1] = JUMP_IMPULSE;
    entity.jumpsUsed = (entity.jumpsUsed ?? 0) + 1;
  }
};

/**
 * Integrate all movable entities by `dt` seconds. Applies gravity and clamps to the ground.
 * Pure over (world, dt) — no renderer, no globals — so it is unit-testable.
 */
export const movementSystem = (world: World<Entity>, dt: number): void => {
  for (const e of world.with('transform', 'velocity')) {
    if (e.projectile) continue; // projectiles are integrated by projectileSystem

    const { transform, velocity } = e;

    // Gravity while airborne.
    if (!isGrounded(e) || velocity.linear[1] > 0) {
      velocity.linear[1] += GRAVITY * dt;
    }

    transform.position[0] += velocity.linear[0] * dt;
    transform.position[1] += velocity.linear[1] * dt;
    transform.position[2] += velocity.linear[2] * dt;

    // Ground clamp to the terrain height under the entity's new xz, so it walks
    // up the perimeter hills instead of phasing through the rising ground.
    const groundY = heightAt(transform.position[0], transform.position[2]);
    if (transform.position[1] < groundY) {
      transform.position[1] = groundY;
      if (velocity.linear[1] < 0) velocity.linear[1] = 0;
    }
  }
};
