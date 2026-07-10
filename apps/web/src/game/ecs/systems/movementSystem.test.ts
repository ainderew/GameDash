import { describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { applyPlayerIntent, movementSystem } from '@/game/ecs/systems/movementSystem';
import { DODGE_IFRAME_MS, JUMP_IMPULSE, PLAYER_SPEED, PLAYER_WALK_SPEED } from '@shared/balance';

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
  it('walks by default and sprints when sprint is held', () => {
    const e = makePlayer();
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false }, 1000);
    expect(e.velocity!.linear[0]).toBeCloseTo(PLAYER_WALK_SPEED);
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: true }, 1000);
    expect(e.velocity!.linear[0]).toBeCloseTo(PLAYER_SPEED);
  });

  it('allows exactly one mid-air double jump and resets both jumps on landing', () => {
    const e = makePlayer();
    applyPlayerIntent(e, { moveX: 0, moveZ: 0, jump: true, dodge: false, sprint: false }, 1000);
    expect(e.velocity!.linear[1]).toBeCloseTo(JUMP_IMPULSE);
    expect(e.jumpsUsed).toBe(1);

    e.transform!.position[1] = 5; // airborne
    e.velocity!.linear[1] = 0;
    applyPlayerIntent(e, { moveX: 0, moveZ: 0, jump: true, dodge: false, sprint: false }, 1000);
    expect(e.velocity!.linear[1]).toBeCloseTo(JUMP_IMPULSE);
    expect(e.jumpsUsed).toBe(2);

    e.velocity!.linear[1] = 0;
    applyPlayerIntent(e, { moveX: 0, moveZ: 0, jump: true, dodge: false, sprint: false }, 1000);
    expect(e.velocity!.linear[1]).toBe(0);

    e.transform!.position[1] = 0; // landed
    applyPlayerIntent(e, { moveX: 0, moveZ: 0, jump: true, dodge: false, sprint: false }, 1000);
    expect(e.velocity!.linear[1]).toBeCloseTo(JUMP_IMPULSE);
    expect(e.jumpsUsed).toBe(1);
  });

  it('dodge grants i-frames for the configured window', () => {
    const e = makePlayer();
    const now = 1000;
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true, sprint: false }, now);
    expect(e.iframeUntil).toBe(now + DODGE_IFRAME_MS);
    // Dash velocity is faster than normal run speed.
    expect(Math.abs(e.velocity!.linear[0])).toBeGreaterThan(PLAYER_SPEED);
  });

  it('locks out input during a swing but strides forward via root motion', () => {
    const e = makePlayer(); // rotationY 0 -> facing +Z
    e.meleeCombo = 0;
    e.meleeStartedAt = 950;
    e.attackAnimUntil = 1900; // mid-swing, inside the motion window
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: true, dodge: false, sprint: false }, 1000);
    expect(e.velocity!.linear[0]).toBe(0); // sideways input ignored (facing is +Z)
    expect(e.velocity!.linear[1]).toBe(0); // jump ignored
    expect(e.velocity!.linear[2]).toBeGreaterThan(0); // the lunge, along facing
    expect(e.transform!.rotationY).toBe(0); // no turning
  });

  it('holds ground through the recovery tail (lunge only through the active window)', () => {
    const e = makePlayer();
    e.meleeCombo = 0;
    e.meleeStartedAt = 1000;
    e.attackAnimUntil = 2000;
    // Well past windup+active for a light move, still mid-anim.
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false }, 1600);
    expect(e.velocity!.linear[0]).toBe(0);
    expect(e.velocity!.linear[2]).toBe(0);
  });

  it('unroots once the swing window lapses', () => {
    const e = makePlayer();
    e.attackAnimUntil = 1500;
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false }, 1600);
    expect(e.velocity!.linear[0]).toBeCloseTo(PLAYER_WALK_SPEED);
  });

  it('dodge cancels the swing instantly: un-roots, clears lockout, dashes', () => {
    const e = makePlayer();
    e.attackAnimUntil = 2000; // mid-swing
    e.meleeReadyAt = 1600; // still locked out of the next melee
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true, sprint: false }, 1000);
    expect(e.attackAnimUntil).toBe(0);
    expect(e.meleeReadyAt).toBe(0);
    expect(Math.abs(e.velocity!.linear[0])).toBeGreaterThan(PLAYER_SPEED);
  });

  it('dodge breaks hit knockback (the universal escape)', () => {
    const e = makePlayer();
    e.knockback = [-5, 0, 0];
    e.staggerUntil = 2000;
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true, sprint: false }, 1000);
    expect(e.knockback).toBeUndefined();
    expect(e.staggerUntil).toBe(0);
  });

  it('dodge respects cooldown (no re-trigger mid-cooldown)', () => {
    const e = makePlayer();
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true, sprint: false }, 1000);
    const firstIframe = e.iframeUntil;
    // Immediately after the dash window but before cooldown clears.
    applyPlayerIntent(e, { moveX: 1, moveZ: 0, jump: false, dodge: true, sprint: false }, 1300);
    expect(e.iframeUntil).toBe(firstIframe);
  });
});
