import { beforeEach, describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '../components';
import { startMelee, weaponSystem } from './weaponSystem';
import { comboAt, moveActiveWindow, moveAnimMs } from '../combat/combo';
import { aiSystem } from './aiSystem';
import { knockbackSystem } from './knockbackSystem';
import { healthSystem } from './healthSystem';
import { applyDamage } from './combatHelpers';
import { createMonster } from './spawnSystem';
import { EventQueue } from '../events';
import { MELEE_DAMAGE } from '@shared/balance';
import { MONSTER_ARCHETYPES } from '@shared/monsters';

const addPlayer = (world: World<Entity>): Entity =>
  world.add({
    transform: { position: [0, 0, 0], rotationY: 0 }, // facing +Z
    velocity: { linear: [0, 0, 0] },
    health: { current: 100, max: 100 },
    faction: 'player',
    playerControlled: true,
  });

let events = new EventQueue();
beforeEach(() => {
  events = new EventQueue();
});

describe('weaponSystem melee', () => {
  it('damages a monster in the arc at most once per swing', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, 1.5])); // directly in front (+Z)
    const hpStart = monster.health!.current;

    // Prime the archetype query BEFORE any attack exists — in the real game weaponSystem
    // runs every frame from boot, so a stale query must still see a later addComponent.
    weaponSystem(world, 999);

    // The hitbox is live only during the active window (derived from the clip via
    // moveActiveWindow — a light's contact lands ~200ms in, so 30ms is still windup).
    startMelee(world, player, 1000);
    weaponSystem(world, 1030); // still winding up — no hit yet
    expect(monster.health!.current).toBe(hpStart);

    weaponSystem(world, 1100); // active frame 1
    weaponSystem(world, 1130); // active frame 2 (same swing → no double hit)

    const { start } = moveActiveWindow(comboAt(0));
    weaponSystem(world, 1000 + start + 1);
    weaponSystem(world, 1000 + start + 30);
    expect(monster.health!.current).toBe(hpStart - MELEE_DAMAGE);
  });

  it('stamps a swing window equal to the animation length', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    startMelee(world, player, 1000);
    expect(player.meleeStartedAt).toBe(1000);
    expect(player.attackAnimUntil).toBeCloseTo(1000 + moveAnimMs(comboAt(0)));
  });

  it('snaps facing toward the cursor aim point when the swing starts', () => {
    const world = new World<Entity>();
    const player = addPlayer(world); // at origin, facing +Z
    startMelee(world, player, 1000, [5, 0]); // cursor ground point at +X
    expect(player.transform!.rotationY).toBeCloseTo(Math.PI / 2);
  });

  it('does not let a monster behind the player steal the swing', () => {
    const world = new World<Entity>();
    const player = addPlayer(world); // facing +Z
    world.add(createMonster('chaser', [0, 0, -1.5]));

    startMelee(world, player, 1000);

    expect(player.transform!.rotationY).toBeCloseTo(0);
  });

  it('a dodge mid-swing kills the hitbox before it can land', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, 1.5]));
    const hpStart = monster.health!.current;
    weaponSystem(world, 999);

    startMelee(world, player, 1000);
    // The dodge starts during the windup (applyPlayerIntent stamps these on cancel).
    player.dodgingUntil = 1230;
    player.attackAnimUntil = 0;

    weaponSystem(world, 1100); // would have been the active window
    expect(monster.health!.current).toBe(hpStart);
    expect(player.attackState).toBeUndefined();
  });

  it('refuses to start a swing mid-dodge (press stays buffered by the caller)', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    player.dodgingUntil = 1200;
    expect(startMelee(world, player, 1000)).toBe(false);
    expect(startMelee(world, player, 1250)).toBe(true);
  });

  it('misses a monster behind the player', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, -1.5])); // behind (-Z)
    const hpStart = monster.health!.current;

    startMelee(world, player, 1000);
    weaponSystem(world, 1100); // during the active window

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

  it('telegraphs then lands the hit after the windup (no instant damage)', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const m = world.add(createMonster('chaser', [0, 0, 1]));
    const windup = MONSTER_ARCHETYPES.chaser.attackWindupMs;

    // First tick in range: the attack is TELEGRAPHED — windup begins, no damage yet.
    aiSystem(world, 0.016, 5000);
    expect(m.aiBrain!.state).toBe('attack');
    expect(m.aiBrain!.strikeAt).toBe(5000 + windup);
    expect(player.health!.current).toBe(100);

    // After the windup elapses the blow lands and the monster drops to cooldown.
    aiSystem(world, 0.016, 5000 + windup);
    expect(player.health!.current).toBeLessThan(100);
    expect(m.aiBrain!.state).toBe('cooldown');
    expect(m.aiBrain!.strikeAt).toBeUndefined();
  });

  it('whiffs the strike if the player dodges out of range during the windup', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const m = world.add(createMonster('chaser', [0, 0, 1]));
    const windup = MONSTER_ARCHETYPES.chaser.attackWindupMs;

    aiSystem(world, 0.016, 5000); // windup begins
    // Player dashes well clear of attackRange before the blow lands.
    player.transform!.position[2] = 12;
    aiSystem(world, 0.016, 5000 + windup);

    expect(player.health!.current).toBe(100); // whiffed — no damage
    expect(m.aiBrain!.strikeAt).toBeUndefined();
  });

  it('cancels the pending strike when the monster is staggered mid-windup', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const m = world.add(createMonster('chaser', [0, 0, 1]));
    const windup = MONSTER_ARCHETYPES.chaser.attackWindupMs;

    aiSystem(world, 0.016, 5000); // windup begins
    expect(m.aiBrain!.strikeAt).toBe(5000 + windup);

    // A hit lands on the monster during its tell → staggered → strike is cancelled.
    m.staggerUntil = 5000 + windup + 100;
    aiSystem(world, 0.016, 5000 + windup);
    expect(m.aiBrain!.strikeAt).toBeUndefined();
    expect(player.health!.current).toBe(100);
  });

  it('a landed monster hit interrupts the player mid-swing (flinch cancels the attack)', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const m = world.add(createMonster('chaser', [0, 0, 1]));
    const windup = MONSTER_ARCHETYPES.chaser.attackWindupMs;

    // Player is mid-swing when the blow lands.
    startMelee(world, player, 5000);
    expect(player.attackState).toBeDefined();

    aiSystem(world, 0.016, 5000); // windup begins
    aiSystem(world, 0.016, 5000 + windup); // strike lands → interrupt

    expect(player.health!.current).toBeLessThan(100);
    expect(player.attackState).toBeUndefined(); // swing cancelled
    expect(player.attackAnimUntil ?? 0).toBe(0); // un-rooted
  });

  it('a landed monster hit shoves the player away (scaled knockback + stagger)', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    world.add(createMonster('chaser', [0, 0, 1])); // attacker at +Z
    const windup = MONSTER_ARCHETYPES.chaser.attackWindupMs;
    aiSystem(world, 0.016, 5000); // windup begins
    aiSystem(world, 0.016, 5000 + windup); // strike lands

    // Shove points away from the attacker (−Z), scaled by playerScale.
    expect(player.knockback).toBeDefined();
    expect(player.knockback![2]).toBeLessThan(0);
    expect(player.staggerUntil).toBeGreaterThan(5000 + windup);

    // The knockback system then owns the player's horizontal velocity for the shove.
    knockbackSystem(world, 0.016, 5000 + windup + 1);
    expect(player.velocity!.linear[2]).toBeLessThan(0);
  });
});

describe('healthSystem death + loot', () => {
  it('removes a dead monster and emits exactly one LootDropped', () => {
    const world = new World<Entity>();
    addPlayer(world);
    const m = world.add(createMonster('brute', [3, 0, 0]));
    m.health!.current = 0;

    healthSystem(world, events);

    const drained = events.drain();
    const loot = drained.filter((e) => e.type === 'LootDropped');
    expect(loot).toHaveLength(1);
    expect(loot[0]).toMatchObject({ tableId: 'rare' });
    expect(world.with('monster').entities).toHaveLength(0);
  });

  it('emits PlayerDowned but keeps the player entity', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    player.health!.current = 0;

    healthSystem(world, events);

    const drained = events.drain();
    expect(drained.some((e) => e.type === 'PlayerDowned')).toBe(true);
    expect(world.with('playerControlled').entities).toHaveLength(1);
  });
});
