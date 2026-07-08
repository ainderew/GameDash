import { beforeEach, describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { startMelee, weaponSystem } from '@/game/ecs/systems/weaponSystem';
import { aiSystem } from '@/game/ecs/systems/aiSystem';
import { healthSystem } from '@/game/ecs/systems/healthSystem';
import { applyDamage } from '@/game/ecs/systems/combatHelpers';
import { createMonster } from '@/game/ecs/systems/spawnSystem';
import { drainEvents, resetEvents } from '@/game/events';
import { MELEE_DAMAGE } from '@shared/balance';

const addPlayer = (world: World<Entity>): Entity =>
  world.add({
    transform: { position: [0, 0, 0], rotationY: 0 }, // facing +Z
    velocity: { linear: [0, 0, 0] },
    health: { current: 100, max: 100 },
    faction: 'player',
    playerControlled: true,
  });

beforeEach(() => resetEvents());

describe('weaponSystem melee', () => {
  it('damages a monster in the arc at most once per swing', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, 1.5])); // directly in front (+Z)
    const hpStart = monster.health!.current;

    startMelee(player, 1000);
    weaponSystem(world, 1000); // active frame 1
    weaponSystem(world, 1050); // active frame 2 (same swing)

    expect(monster.health!.current).toBe(hpStart - MELEE_DAMAGE);
  });

  it('misses a monster behind the player', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, -1.5])); // behind (-Z)
    const hpStart = monster.health!.current;

    startMelee(player, 1000);
    weaponSystem(world, 1000);

    expect(monster.health!.current).toBe(hpStart);
  });
});

describe('applyDamage + i-frames', () => {
  it('nullifies damage while the player is in i-frames', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    player.iframeUntil = 2000;
    const landed = applyDamage(player, 40, 1500);
    expect(landed).toBe(false);
    expect(player.health!.current).toBe(100);
  });
});

describe('aiSystem FSM', () => {
  it('chases when the player is out of range but within aggro', () => {
    const world = new World<Entity>();
    addPlayer(world);
    const m = world.add(createMonster('chaser', [0, 0, 10]));
    aiSystem(world, 0.016, 1000);
    expect(m.aiBrain!.state).toBe('chase');
    // velocity should point toward the player (−Z, since player is at origin).
    expect(m.velocity!.linear[2]).toBeLessThan(0);
  });

  it('attacks the player when in range and off cooldown', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const m = world.add(createMonster('chaser', [0, 0, 1]));
    aiSystem(world, 0.016, 5000);
    // chaser is melee → player took damage, monster went on cooldown.
    expect(player.health!.current).toBeLessThan(100);
    expect(m.aiBrain!.state).toBe('cooldown');
  });
});

describe('healthSystem death + loot', () => {
  it('removes a dead monster and emits exactly one LootDropped', () => {
    const world = new World<Entity>();
    addPlayer(world);
    const m = world.add(createMonster('brute', [3, 0, 0]));
    m.health!.current = 0;

    healthSystem(world);

    const events = drainEvents();
    const loot = events.filter((e) => e.type === 'LootDropped');
    expect(loot).toHaveLength(1);
    expect(loot[0]).toMatchObject({ tableId: 'rare' });
    expect(world.with('monster').entities).toHaveLength(0);
  });

  it('emits PlayerDowned but keeps the player entity', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    player.health!.current = 0;

    healthSystem(world);

    const events = drainEvents();
    expect(events.some((e) => e.type === 'PlayerDowned')).toBe(true);
    expect(world.with('playerControlled').entities).toHaveLength(1);
  });
});
