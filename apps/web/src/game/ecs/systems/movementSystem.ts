import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import {
  DODGE_COOLDOWN_MS,
  DODGE_DISTANCE,
  DODGE_DURATION_MS,
  DODGE_IFRAME_MS,
  GRAVITY,
  JUMP_IMPULSE,
  PLAYER_SPEED,
} from '@shared/balance';
import { heightAt } from '@/game/world/terrainHeight';

/** A per-frame snapshot of intent, produced by useInput and read here. Pure data — no React. */
export interface InputIntent {
  /** Desired horizontal move direction in world space, expected pre-normalized (or zero). */
  moveX: number;
  moveZ: number;
  jump: boolean;
  dodge: boolean;
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
  const canDodge = intent.dodge && !dodging && now >= (entity.dodgeReadyAt ?? 0);
  if (canDodge) {
    const len = Math.hypot(intent.moveX, intent.moveZ);
    const dirX = len > 0 ? intent.moveX / len : Math.sin(transform.rotationY);
    const dirZ = len > 0 ? intent.moveZ / len : Math.cos(transform.rotationY);
    entity.dodgeDir = [dirX, 0, dirZ];
    entity.dodgingUntil = now + DODGE_DURATION_MS;
    entity.iframeUntil = now + DODGE_IFRAME_MS;
    entity.dodgeReadyAt = now + DODGE_COOLDOWN_MS;
  }

  const stillDodging = (entity.dodgingUntil ?? 0) > now;
  if (stillDodging && entity.dodgeDir) {
    velocity.linear[0] = entity.dodgeDir[0] * dashSpeed;
    velocity.linear[2] = entity.dodgeDir[2] * dashSpeed;
  } else {
    velocity.linear[0] = intent.moveX * PLAYER_SPEED;
    velocity.linear[2] = intent.moveZ * PLAYER_SPEED;
    // Face the movement direction when actually moving.
    if (intent.moveX !== 0 || intent.moveZ !== 0) {
      transform.rotationY = Math.atan2(intent.moveX, intent.moveZ);
    }
  }

  if (intent.jump && isGrounded(entity)) {
    velocity.linear[1] = JUMP_IMPULSE;
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
