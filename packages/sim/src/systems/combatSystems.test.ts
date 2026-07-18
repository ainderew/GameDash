import { beforeEach, describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '../components';
import { DASH_SLASH_COOLDOWN_MS, startDashSlash, startMelee, weaponSystem } from './weaponSystem';
import { applyPlayerIntent, movementSystem } from './movementSystem';
import {
  comboAt,
  COMBO_MOVES,
  DASH_SLASH_MOVE,
  moveActiveWindow,
  moveAnimMs,
  moveContactMs,
  moveTrailWindow,
} from '../combat/combo';
import { aiSystem } from './aiSystem';
import { knockbackSystem } from './knockbackSystem';
import { healthSystem } from './healthSystem';
import { applyDamage } from './combatHelpers';
import { createMonster } from './spawnSystem';
import { EventQueue } from '../events';
import { computeDamage } from '@shared/combat';
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
  it('keeps the Blender-authored combo inside the snappy combat cadence', () => {
    const [horizontal, , , thrust] = COMBO_MOVES;

    // Every swing plays out inside a snappy character-action cadence (sliced mocap clips run
    // hot via ATTACK_TIMESCALE). Band, not exact ms, so feel-tuning the speeds doesn't break this.
    for (const move of COMBO_MOVES) {
      expect(moveAnimMs(move)).toBeGreaterThan(300);
      expect(moveAnimMs(move)).toBeLessThan(700);
    }
    expect(COMBO_MOVES.every((move) => move.damaging)).toBe(true);
    // Contact opens fast on both the opener and the heavy finisher (time-to-hitbox from press).
    expect(moveActiveWindow(horizontal!).start).toBeLessThan(220);
    expect(moveActiveWindow(thrust!).start).toBeLessThan(250);
  });

  it('keeps contact inside both the gameplay and presentation delivery windows', () => {
    for (const move of [...COMBO_MOVES, DASH_SLASH_MOVE].filter((m) => m.damaging)) {
      const contact = moveContactMs(move);
      const active = moveActiveWindow(move);
      const trail = moveTrailWindow(move);
      expect(contact).toBeGreaterThan(active.start);
      expect(contact).toBeLessThan(active.end);
      expect(trail.start).toBeLessThanOrEqual(active.start);
      expect(trail.end).toBeGreaterThanOrEqual(active.end);
    }
  });

  it('uses click one as a complete horizontal attack and damages at most once', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, 1.5])); // directly in front (+Z)
    const hpStart = monster.health!.current;

    // Prime the archetype query BEFORE any attack exists — in the real game weaponSystem
    // runs every frame from boot, so a stale query must still see a later addComponent.
    weaponSystem(world, 999);

    startMelee(world, player, 1000);
    const horizontal = comboAt(0);
    const { start } = moveActiveWindow(horizontal);
    weaponSystem(world, 1000 + start + 1);
    weaponSystem(world, 1000 + start + 30);
    expect(monster.health!.current).toBe(hpStart - MELEE_DAMAGE);
  });

  it('advances one authored combo stage per successive melee click', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const expected = ['horizontal', 'reverse', 'overhead', 'thrust'] as const;
    let now = 1000;

    for (let index = 0; index < expected.length; index += 1) {
      expect(startMelee(world, player, now)).toBe(true);
      expect(player.meleeCombo).toBe(index);
      expect(comboAt(player.meleeCombo!).clip).toBe(expected[index]);
      now = Math.ceil(player.meleeReadyAt!) + 1;
    }

    // A fifth click begins the authored pattern again.
    expect(startMelee(world, player, now)).toBe(true);
    expect(player.meleeCombo).toBe(0);
    expect(comboAt(player.meleeCombo!).clip).toBe('horizontal');
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
    // The dodge starts during the attack anticipation (applyPlayerIntent stamps these on cancel).
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
    weaponSystem(world, 1000 + moveActiveWindow(comboAt(0)).start + 1);

    expect(monster.health!.current).toBe(hpStart);
  });
});

describe('dash-slash skill (1)', () => {
  it('starts a dash-slash: borrows the thrust clip, sets i-frames + cooldown', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);

    expect(startDashSlash(world, player, 1000)).toBe(true);
    expect(player.attackState?.dashSlash).toBe(true);
    // Renderer plays the thrust clip → meleeCombo points at the thrust move.
    const thrustIndex = COMBO_MOVES.findIndex((m) => m.clip === 'thrust');
    expect(player.meleeCombo).toBe(thrustIndex);
    expect(player.attackAnimUntil).toBeCloseTo(1000 + moveAnimMs(DASH_SLASH_MOVE));
    // I-frames cover the committed dash (through the active window).
    expect(player.iframeUntil).toBeCloseTo(1000 + moveActiveWindow(DASH_SLASH_MOVE).end);
    expect(player.skill1ReadyAt).toBe(1000 + DASH_SLASH_COOLDOWN_MS);
    // Not part of the J-combo chain — no continue window.
    expect(player.meleeComboExpiresAt).toBe(0);
  });

  it('is gated by its cooldown', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    expect(startDashSlash(world, player, 1000)).toBe(true);
    expect(startDashSlash(world, player, 1000 + DASH_SLASH_COOLDOWN_MS - 1)).toBe(false);
    expect(startDashSlash(world, player, 1000 + DASH_SLASH_COOLDOWN_MS)).toBe(true);
  });

  it('lands its heavy multiplier on a monster in the arc', () => {
    const world = new World<Entity>();
    const player = addPlayer(world);
    const monster = world.add(createMonster('chaser', [0, 0, 1.5])); // in front (+Z)
    // Beefy HP so the exact heavy multiplier is visible (a 2.4× hit one-shots a chaser).
    monster.health = { current: 500, max: 500 };
    const hpStart = monster.health.current;
    weaponSystem(world, 999); // prime the archetype query

    startDashSlash(world, player, 1000);
    const { start } = moveActiveWindow(DASH_SLASH_MOVE);
    weaponSystem(world, 1000 + start + 1);
    weaponSystem(world, 1000 + start + 30); // same swing → no double hit

    expect(monster.health.current).toBe(
      hpStart - computeDamage(MELEE_DAMAGE * DASH_SLASH_MOVE.damageMul),
    );
  });

  it('has a wide, forgiving arc — sweeps a side enemy a light swing would miss', () => {
    const world = new World<Entity>();
    const player = addPlayer(world); // facing +Z
    const side = world.add(createMonster('chaser', [1.3, 0, -0.25])); // ~101° off facing
    side.health = { current: 500, max: 500 };
    weaponSystem(world, 999);

    // A normal horizontal swing whiffs the side target.
    startMelee(world, player, 1000);
    weaponSystem(world, 1000 + moveActiveWindow(comboAt(0)).start + 5);
    expect(side.health.current).toBe(500);
    world.removeComponent(player, 'attackState');
    player.attackAnimUntil = 0;
    player.meleeReadyAt = 0;

    // The wide dash-slash (±108°, longer reach) sweeps it.
    startDashSlash(world, player, 5000);
    weaponSystem(world, 5000 + moveActiveWindow(DASH_SLASH_MOVE).start + 5);
    expect(side.health.current).toBeLessThan(500);
  });

  it('carries the hero forward its full dash distance via root motion', () => {
    const world = new World<Entity>();
    const player = addPlayer(world); // at origin, facing +Z
    const zero = { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false };

    startDashSlash(world, player, 1000);
    // Integrate the lunge across the whole motion window in small steps.
    const end = moveActiveWindow(DASH_SLASH_MOVE).end;
    const stepMs = 10;
    for (let t = 0; t < end; t += stepMs) {
      applyPlayerIntent(player, zero, 1000 + t, stepMs / 1000);
      movementSystem(world, stepMs / 1000);
    }
    // Root motion integrates to lungeDist over the motion window (ease-out, ±integration slop).
    expect(player.transform!.position[2]).toBeCloseTo(DASH_SLASH_MOVE.lungeDist, 0);
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
