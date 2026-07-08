import { describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { applyPlayerIntent, movementSystem } from '@/game/ecs/systems/movementSystem';
import { DODGE_IFRAME_MS, JUMP_IMPULSE, PLAYER_SPEED } from '@shared/balance';

const makePlayer = (): Entity => ({
  transform: { position: [0, 0, 0], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  playerControlled: true,
});

describe('movementSystem', () => {
  it('advances position by velocity * dt', () => {
    const world = new World<Entity>();
    const e = makePlayer();
    e.velocity!.linear = [PLAYER_SPEED, 0, 0];
    world.add(e);

    movementSystem(world, 0.5);

    expect(e.transform!.position[0]).toBeCloseTo(PLAYER_SPEED * 0.5);
  });

  it('clamps to the ground and zeroes downward velocity', () => {
    const world = new World<Entity>();
    const e = makePlayer();
    e.transform!.position = [0, 0, 0];
    e.velocity!.linear = [0, -5, 0];
    world.add(e);

    movementSystem(world, 0.1);

    expect(e.transform!.position[1]).toBe(0);
    expect(e.velocity!.linear[1]).toBe(0);
  });
});

describe('applyPlayerIntent', () => {
  it('sets horizontal velocity from move intent', () => {
    const e = makePlayer();
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: false }, 1000);
    expect(e.velocity!.linear[0]).toBeCloseTo(PLAYER_SPEED);
  });

  it('applies jump impulse only when grounded', () => {
    const e = makePlayer();
    applyPlayerIntent(e, { moveX: 0, moveZ: 0, jump: true, dodge: false }, 1000);
    expect(e.velocity!.linear[1]).toBeCloseTo(JUMP_IMPULSE);

    e.transform!.position[1] = 5; // airborne
    e.velocity!.linear[1] = 0;
    applyPlayerIntent(e, { moveX: 0, moveZ: 0, jump: true, dodge: false }, 1000);
    expect(e.velocity!.linear[1]).toBe(0);
  });

  it('dodge grants i-frames for the configured window', () => {
    const e = makePlayer();
    const now = 1000;
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true }, now);
    expect(e.iframeUntil).toBe(now + DODGE_IFRAME_MS);
    // Dash velocity is faster than normal run speed.
    expect(Math.abs(e.velocity!.linear[0])).toBeGreaterThan(PLAYER_SPEED);
  });

  it('dodge respects cooldown (no re-trigger mid-cooldown)', () => {
    const e = makePlayer();
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true }, 1000);
    const firstIframe = e.iframeUntil;
    // Immediately after the dash window but before cooldown clears.
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true }, 1300);
    expect(e.iframeUntil).toBe(firstIframe);
  });
});
