import { beforeEach, describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '../components';
import { dropRelic, getRelicTier, onRelicAttackUsed, passRelic, relicSystem } from './relicSystem';
import { fireRanged } from './weaponSystem';
import { projectileSystem } from './projectileSystem';
import { applyPlayerIntent } from './movementSystem';
import { EventQueue } from '../events';
import {
  RELIC_CATCH_RADIUS,
  RELIC_CATCH_ROOT_MS,
  RELIC_CORRUPTION_TUNING,
  RELIC_FAIL_BOUNCE_DIST,
  RELIC_HANDOFF_SHIELD_MS,
  RELIC_PASS_RECATCH_MS,
  RELIC_RECATCH_DELAY_MS,
  RELIC_THROW_MIN,
  RANGED_COOLDOWN_MS,
  RANGED_DAMAGE,
  PLAYER_WALK_SPEED,
} from '@shared/balance';

const DT = 0.016;

// Per-world event queue — recreated per test so events can't bleed between cases.
let events = new EventQueue();
beforeEach(() => {
  events = new EventQueue();
});

const makePlayer = (x = 0, z = 0): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  playerControlled: true,
});

const makeTeammate = (x: number, z: number): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  teammate: true,
});

const makeCarriedRelic = (carrier: Entity): Entity => ({
  transform: { position: [...carrier.transform!.position], rotationY: 0 },
  relic: { phase: 'carried', carrier, corruption: 0 },
});

/** Tick the sim until the flight resolves, moving entities via their velocity like the
 * real movement system would. Returns the time the flight ended. */
const settleFlight = (world: World<Entity>, relic: Entity, from: number): number => {
  let now = from;
  while (relic.relic!.phase === 'inFlight' && now < from + 10_000) {
    now += DT * 1000;
    for (const e of world.with('transform', 'velocity')) {
      e.transform.position[0] += e.velocity.linear[0] * DT;
      e.transform.position[2] += e.velocity.linear[2] * DT;
    }
    relicSystem(world, DT, now, events);
  }
  return now;
};

describe('passRelic', () => {
  it('flies a targeted pass and auto-catches at the receiver', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(8, 0));
    const relic = world.add(makeCarriedRelic(player));
    relic.relic!.corruption = 74;

    expect(passRelic(world, player, mate, 1000, events)).toBe(true);
    expect(relic.relic!.phase).toBe('inFlight');
    expect(relic.relic!.mode).toBe('pass');
    expect(player.relicRecatchUntil).toBe(1000 + RELIC_PASS_RECATCH_MS);

    const landedAt = settleFlight(world, relic, 1000);
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(mate);
    expect(relic.relic!.corruption).toBe(RELIC_CORRUPTION_TUNING.catchResetValue);
    // Handoff shield: the catch frame can't be sniped by a stray hit.
    expect(mate.iframeUntil).toBeGreaterThanOrEqual(landedAt);
    expect(mate.iframeUntil).toBeLessThanOrEqual(landedAt + RELIC_HANDOFF_SHIELD_MS + 20);
    // Lifecycle events: launch then catch, no failure.
    const types = events.drain().map((e) => e.type);
    expect(types).toContain('RelicPassLaunched');
    expect(types).toContain('RelicCaught');
    expect(types).not.toContain('RelicPassFailed');
  });

  it('homes onto a receiver who keeps moving during flight', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(10, 0));
    mate.velocity!.linear = [2.2, 0, 0]; // walking away, like a patrolling teammate
    const relic = world.add(makeCarriedRelic(player));

    passRelic(world, player, mate, 0, events);
    settleFlight(world, relic, 0);
    expect(relic.relic!.carrier).toBe(mate);
  });

  it('fails into a bounce-once drop when the receiver escapes the correction budget', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(12, 0));
    const relic = world.add(makeCarriedRelic(player));

    passRelic(world, player, mate, 0, events);
    // Teleport far beyond the max endpoint correction mid-flight.
    relicSystem(world, DT, 100, events);
    mate.transform!.position = [12, 0, 20];

    // Tick until the pass leg ends: it must convert into a lob (the single bounce)…
    let now = 100;
    while (relic.relic!.mode === 'pass' && now < 5000) {
      now += DT * 1000;
      relicSystem(world, DT, now, events);
    }
    expect(relic.relic!.phase).toBe('inFlight');
    expect(relic.relic!.mode).toBe('lob');
    const bounceFrom = [...relic.relic!.from!];

    // …then settle grounded roughly one bounce past where the pass ended, not rolling on.
    settleFlight(world, relic, now);
    expect(relic.relic!.phase).toBe('grounded');
    expect(relic.relic!.carrier).toBeUndefined();
    const [gx, , gz] = relic.transform!.position;
    expect(Math.hypot(gx - bounceFrom[0]!, gz - bounceFrom[2]!)).toBeCloseTo(
      RELIC_FAIL_BOUNCE_DIST,
      1,
    );

    // Failure refunds the thrower's rotation cooldown and emits the failure event.
    expect(player.relicRecatchUntil).toBe(0);
    const types = events.drain().map((e) => e.type);
    expect(types).toContain('RelicPassLaunched');
    expect(types).toContain('RelicPassFailed');
    expect(types).not.toContain('RelicCaught');
  });

  it('fails into a drop when the receiver dies mid-flight', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(12, 0));
    const relic = world.add(makeCarriedRelic(player));

    passRelic(world, player, mate, 0, events);
    relicSystem(world, DT, 100, events);
    mate.health!.current = 0;
    settleFlight(world, relic, 100);
    expect(relic.relic!.phase).toBe('grounded');
  });

  it('only the carrier can pass', () => {
    const world = new World<Entity>();
    const carrier = world.add(makePlayer());
    const other = world.add(makeTeammate(3, 3));
    const relic = world.add(makeCarriedRelic(carrier));

    expect(passRelic(world, other, carrier, 0, events)).toBe(false);
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(carrier);
  });
});

describe('dropRelic', () => {
  it('lobs a short toss forward and lands grounded', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    player.transform!.rotationY = 0; // facing +Z
    const relic = world.add(makeCarriedRelic(player));

    dropRelic(world, player, 1000);
    expect(relic.relic!.mode).toBe('lob');
    // Walk away so the lob isn't re-caught mid-flight.
    player.transform!.position = [20, 0, -20];
    settleFlight(world, relic, 1000);
    expect(relic.relic!.phase).toBe('grounded');
    expect(relic.transform!.position[2]).toBeCloseTo(RELIC_THROW_MIN, 1);
  });

  it('recatch delay blocks an instant self-recatch after a drop', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));

    dropRelic(world, player, 1000);
    settleFlight(world, relic, 1000);
    player.transform!.position = [...relic.transform!.position];
    relicSystem(world, DT, 1000 + RELIC_RECATCH_DELAY_MS - 20, events);
    expect(relic.relic!.phase).toBe('grounded');

    relicSystem(world, DT, 1000 + RELIC_RECATCH_DELAY_MS + 32, events);
    expect(relic.relic!.phase).toBe('carried');
  });
});

describe('relicSystem', () => {
  it('derives every tier and applies its exact attack and movement stats idempotently', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));

    for (const [tierIndex, tier] of RELIC_CORRUPTION_TUNING.tiers.entries()) {
      relic.relic!.corruption = tier.minCorruption;
      relicSystem(world, 0, tierIndex * 1000, events);
      expect(getRelicTier(relic.relic!.corruption)).toBe(tier);
      expect(player.relicBuff).toEqual({
        tierIndex,
        tierName: tier.name,
        damageMult: tier.damageMult,
        projectileCount: tier.projectileCount,
        attackRateMult: tier.attackRateMult,
        pierce: tier.pierce,
        knockback: tier.knockback,
        lifestealPct: tier.lifestealPct,
        moveSpeedMult: tier.moveSpeedMult,
      });

      player.rangedReadyAt = 0;
      expect(fireRanged(world, player, tierIndex * 1000 + 1)).toBe(true);
      const shots = [...world.with('projectile')];
      expect(shots).toHaveLength(tier.projectileCount);
      for (const shot of shots) {
        expect(shot.damage).toBe(Math.round(RANGED_DAMAGE * tier.damageMult));
        expect(shot.projectilePierce).toBe(tier.pierce);
        expect(shot.projectileKnockback).toBe(tier.knockback);
        expect(shot.projectileLifestealPct).toBe(tier.lifestealPct);
        world.remove(shot);
      }
      expect(player.rangedReadyAt).toBe(
        tierIndex * 1000 + 1 + RANGED_COOLDOWN_MS / tier.attackRateMult,
      );
    }
  });

  it('drips faster in high tiers and charges once per successful attack use', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));

    relic.relic!.corruption = 10;
    relicSystem(world, 1, 0, events);
    expect(relic.relic!.corruption).toBe(15);

    relic.relic!.corruption = 70;
    relicSystem(world, 1, 1000, events);
    expect(relic.relic!.corruption).toBe(80);
    expect(onRelicAttackUsed(world, player, 1001, events)).toBe(true);
    expect(relic.relic!.corruption).toBe(88);
  });

  it('applies tier movement speed and heals the holder from Relic projectile damage', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    player.faction = 'player';
    player.health!.current = 50;
    const relic = world.add(makeCarriedRelic(player));

    relic.relic!.corruption = 70;
    relicSystem(world, 0, 0, events);
    applyPlayerIntent(player, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false }, 1);
    expect(player.velocity!.linear[0]).toBeCloseTo(PLAYER_WALK_SPEED * 1.2);

    relic.relic!.corruption = 45;
    relicSystem(world, 0, 2, events);
    player.transform!.rotationY = 0;
    world.add({
      transform: { position: [0, 0, 1], rotationY: 0 },
      health: { current: 100, max: 100 },
      faction: 'monster',
      radius: 0.5,
    });
    fireRanged(world, player, 10);
    projectileSystem(world, 0, 10);
    expect(player.health!.current).toBeGreaterThan(50);
  });

  it('Overload attack adds its extra cost and erupts immediately at maximum', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));
    relic.relic!.corruption = 90;

    onRelicAttackUsed(world, player, 10, events);

    expect(player.health!.current).toBe(0);
    expect(player.relicBuff).toBeUndefined();
    expect(relic.relic!.phase).toBe('grounded');
    expect(relic.relic!.corruption).toBe(0);
    expect([...world.with('monster')]).toHaveLength(1);
    const types = events.drain().map((event) => event.type);
    expect(types).toContain('RelicErupted');
    expect(types).toContain('RelicGrounded');
  });

  it('Volatile Discharge damages and disrupts nearby enemies and allies but not its carrier', () => {
    const world = new World<Entity>();
    const holder = world.add(makePlayer());
    holder.faction = 'player';
    const ally = world.add(makePlayer(2, 0));
    ally.faction = 'player';
    ally.blockingUntil = 2000;
    const enemy = world.add({
      transform: { position: [-2, 0, 0] as [number, number, number], rotationY: 0 },
      health: { current: 100, max: 100 },
      faction: 'monster' as const,
      radius: 0.5,
    });
    const farEnemy = world.add({
      transform: { position: [8, 0, 0] as [number, number, number], rotationY: 0 },
      health: { current: 100, max: 100 },
      faction: 'monster' as const,
    });
    const relic = world.add(makeCarriedRelic(holder));
    relic.relic!.corruption = 70;
    relic.relic!.nextVolatileDischargeAt = 1000;

    relicSystem(world, 0, 1000, events);

    expect(holder.health!.current).toBe(100);
    expect(ally.health!.current).toBe(88);
    expect(enemy.health.current).toBe(88);
    expect(farEnemy.health.current).toBe(100);
    expect(ally.knockback?.[0]).toBeGreaterThan(0);
    expect(enemy.knockback?.[0]).toBeLessThan(0);
    expect(events.drain().map((event) => event.type)).toContain('RelicVolatileDischarge');
    expect(relic.relic!.nextVolatileDischargeAt).toBeGreaterThan(1000);
  });

  it('retains corruption on a missed throw and grounded pickup', () => {
    const world = new World<Entity>();
    const thrower = world.add(makePlayer());
    const picker = world.add(makePlayer(20, 20));
    const relic = world.add(makeCarriedRelic(thrower));
    relic.relic!.corruption = 63;
    relicSystem(world, 0, 0, events);

    dropRelic(world, thrower, 100);
    expect(thrower.relicBuff).toBeUndefined();
    thrower.transform!.position = [-20, 0, -20];
    settleFlight(world, relic, 100);
    expect(relic.relic!.corruption).toBe(63);

    picker.transform!.position = [...relic.transform!.position];
    relicSystem(world, 0, 4000, events);
    expect(relic.relic!.carrier).toBe(picker);
    expect(relic.relic!.corruption).toBe(63);
    expect(events.drain().map((event) => event.type)).toContain('RelicPickedUp');
  });

  it('assigns a contested catch to the player nearest the projectile path', () => {
    const world = new World<Entity>();
    const farther = world.add(makePlayer(1.5, 0));
    const nearer = world.add(makePlayer(0.25, 0));
    const relic = world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const, corruption: 40 },
    });

    relicSystem(world, 0, 0, events);
    expect(relic.relic!.carrier).toBe(nearer);
    expect(relic.relic!.carrier).not.toBe(farther);
  });

  it('downs the carrier and spawns one relic boss exactly at maximum corruption', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));

    relic.relic!.corruption = RELIC_CORRUPTION_TUNING.max - 0.1;
    relicSystem(world, 0.009, 0, events);
    expect(player.health!.current).toBe(100);
    expect([...world.with('monster')]).toHaveLength(0);

    relicSystem(world, 0.02, 20, events);
    expect(player.health!.current).toBe(0);
    expect(relic.relic!.phase).toBe('grounded');
    expect([...world.with('monster')].map((m) => m.monster)).toEqual(['relicBoss']);

    relicSystem(world, DT, 120, events);
    expect([...world.with('monster')]).toHaveLength(1);
  });

  it('carried relic tracks its carrier', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));

    player.transform!.position = [4, 0, -2];
    relicSystem(world, DT, 0, events);

    const [x, , z] = relic.transform!.position;
    expect(Math.hypot(x - 4, z + 2)).toBeLessThan(1.5); // beside, not on top of
  });

  it('a grounded relic is caught by a player inside the catch radius, not outside it', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(RELIC_CATCH_RADIUS + 1, 0));
    const relic = world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const, corruption: 0 },
    });

    relicSystem(world, DT, 0, events);
    expect(relic.relic!.phase).toBe('grounded');

    player.transform!.position = [0.5, 0, 0];
    relicSystem(world, DT, 16, events);
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(player);
  });

  it('post-pass rotation cooldown blocks the thrower from walk-in recatching', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(0.5, 0));
    player.relicRecatchUntil = 5000;
    world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const, corruption: 0 },
    });

    relicSystem(world, DT, 4000, events);
    expect(world.with('relic').first!.relic!.phase).toBe('grounded');
    relicSystem(world, DT, 5016, events);
    expect(world.with('relic').first!.relic!.phase).toBe('carried');
  });

  it('catch shockwave staggers and shoves nearby monsters', () => {
    const world = new World<Entity>();
    world.add(makePlayer(0.5, 0));
    world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const, noCatchUntil: 0, corruption: 0 },
    });
    const monster = world.add({
      transform: { position: [2, 0, 0] as [number, number, number], rotationY: 0 },
      health: { current: 50, max: 50 },
      monster: 'crawler' as never,
    });

    relicSystem(world, DT, 5000, events);
    expect(monster.staggerUntil).toBeGreaterThan(5000);
    expect(monster.knockback![0]).toBeGreaterThan(0); // shoved away from the catch point
  });

  it('plants the player on catch so the catch clip does not glide', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(0.5, 0));
    player.velocity!.linear = [6, 0, 0]; // caught mid-run — would otherwise slide
    world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const, noCatchUntil: 0, corruption: 0 },
    });

    relicSystem(world, DT, 5000, events);
    expect(world.with('relic').first!.relic!.phase).toBe('carried');
    expect(player.catchRootUntil).toBe(5000 + RELIC_CATCH_ROOT_MS);
  });

  it('drops to grounded where the carrier died', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(3, 3));
    const relic = world.add(makeCarriedRelic(player));
    relicSystem(world, DT, 0, events); // attach beside the living carrier

    player.health!.current = 0;
    relicSystem(world, DT, 16, events);
    expect(relic.relic!.phase).toBe('grounded');
    expect(relic.relic!.carrier).toBeUndefined();
  });
});
