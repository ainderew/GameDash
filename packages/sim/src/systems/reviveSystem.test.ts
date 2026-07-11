import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../world';
import { EventQueue } from '../events';
import { reviveSystem } from './reviveSystem';
import { healthSystem } from './healthSystem';
import { REVIVE_MS, REVIVE_RANGE } from '@shared/balance';
import type { Entity } from '../components';

/** Co-op revive (Phase 4, new mechanic): hold near a downed teammate for REVIVE_MS. */

const DT = 1 / 30;

const player = (pos: [number, number, number]): Entity => ({
  transform: { position: pos, rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  playerControlled: true,
});

describe('reviveSystem', () => {
  it('brings a downed teammate back after REVIVE_MS of contiguous hold, emitting PlayerRevived', () => {
    const world = createGameWorld();
    const events = new EventQueue();
    const downed = world.add(player([0, 0, 0]));
    const rescuer = world.add(player([0, 0, REVIVE_RANGE - 0.5]));
    downed.health!.current = 0;
    healthSystem(world, events); // transitions to downed + emits PlayerDowned
    expect(downed.downed).toBe(true);
    events.drain();

    rescuer.reviving = true;
    const ticks = Math.ceil(REVIVE_MS / (DT * 1000)) + 1;
    for (let k = 0; k < ticks; k += 1) reviveSystem(world, DT, events);

    expect(downed.downed).toBe(false);
    expect(downed.health!.current).toBeGreaterThan(0);
    const revived = events.drain().filter((e) => e.type === 'PlayerRevived');
    expect(revived).toHaveLength(1);
    expect((revived[0] as { id?: number }).id).toBe(downed.id);
  });

  it('resets progress the instant the rescuer stops holding or leaves range', () => {
    const world = createGameWorld();
    const events = new EventQueue();
    const downed = world.add(player([0, 0, 0]));
    const rescuer = world.add(player([0, 0, 1]));
    downed.downed = true;
    downed.health!.current = 0;

    rescuer.reviving = true;
    for (let k = 0; k < 20; k += 1) reviveSystem(world, DT, events);
    expect(downed.reviveProgressMs).toBeGreaterThan(0);

    // Let go → progress lapses.
    rescuer.reviving = false;
    reviveSystem(world, DT, events);
    expect(downed.reviveProgressMs).toBe(0);
    expect(downed.downed).toBe(true);

    // Hold again but out of range → no progress.
    rescuer.reviving = true;
    rescuer.transform!.position = [0, 0, REVIVE_RANGE + 3];
    for (let k = 0; k < 20; k += 1) reviveSystem(world, DT, events);
    expect(downed.reviveProgressMs).toBe(0);
    expect(downed.downed).toBe(true);
  });

  it('a downed player cannot revive another downed player', () => {
    const world = createGameWorld();
    const events = new EventQueue();
    const a = world.add(player([0, 0, 0]));
    const b = world.add(player([0, 0, 1]));
    a.downed = true;
    a.health!.current = 0;
    b.downed = true;
    b.health!.current = 0;
    b.reviving = true; // downed players are inert; this must not count
    for (let k = 0; k < 200; k += 1) reviveSystem(world, DT, events);
    expect(a.downed).toBe(true);
  });
});
