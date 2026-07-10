import { describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { dropRelic, passRelic, relicSystem } from '@/game/ecs/systems/relicSystem';
import { drainEvents, resetEvents } from '@/game/events';
import {
  RELIC_CATCH_RADIUS,
  RELIC_FAIL_BOUNCE_DIST,
  RELIC_HANDOFF_SHIELD_MS,
  RELIC_PASS_RECATCH_MS,
  RELIC_RECATCH_DELAY_MS,
  RELIC_THROW_MIN,
} from '@shared/balance';

const DT = 0.016;

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
  relic: { phase: 'carried', carrier },
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
    relicSystem(world, DT, now);
  }
  return now;
};

describe('passRelic', () => {
  it('flies a targeted pass and auto-catches at the receiver', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(8, 0));
    const relic = world.add(makeCarriedRelic(player));

    resetEvents();
    expect(passRelic(world, player, mate, 1000)).toBe(true);
    expect(relic.relic!.phase).toBe('inFlight');
    expect(relic.relic!.mode).toBe('pass');
    expect(player.relicRecatchUntil).toBe(1000 + RELIC_PASS_RECATCH_MS);

    const landedAt = settleFlight(world, relic, 1000);
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(mate);
    // Handoff shield: the catch frame can't be sniped by a stray hit.
    expect(mate.iframeUntil).toBeGreaterThanOrEqual(landedAt);
    expect(mate.iframeUntil).toBeLessThanOrEqual(landedAt + RELIC_HANDOFF_SHIELD_MS + 20);
    // Lifecycle events: launch then catch, no failure.
    const types = drainEvents().map((e) => e.type);
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

    passRelic(world, player, mate, 0);
    settleFlight(world, relic, 0);
    expect(relic.relic!.carrier).toBe(mate);
  });

  it('fails into a bounce-once drop when the receiver escapes the correction budget', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(12, 0));
    const relic = world.add(makeCarriedRelic(player));

    resetEvents();
    passRelic(world, player, mate, 0);
    // Teleport far beyond the max endpoint correction mid-flight.
    relicSystem(world, DT, 100);
    mate.transform!.position = [12, 0, 20];

    // Tick until the pass leg ends: it must convert into a lob (the single bounce)…
    let now = 100;
    while (relic.relic!.mode === 'pass' && now < 5000) {
      now += DT * 1000;
      relicSystem(world, DT, now);
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
    const types = drainEvents().map((e) => e.type);
    expect(types).toContain('RelicPassLaunched');
    expect(types).toContain('RelicPassFailed');
    expect(types).not.toContain('RelicCaught');
  });

  it('fails into a drop when the receiver dies mid-flight', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const mate = world.add(makeTeammate(12, 0));
    const relic = world.add(makeCarriedRelic(player));

    passRelic(world, player, mate, 0);
    relicSystem(world, DT, 100);
    mate.health!.current = 0;
    settleFlight(world, relic, 100);
    expect(relic.relic!.phase).toBe('grounded');
  });

  it('only the carrier can pass', () => {
    const world = new World<Entity>();
    const carrier = world.add(makePlayer());
    const other = world.add(makeTeammate(3, 3));
    const relic = world.add(makeCarriedRelic(carrier));

    expect(passRelic(world, other, carrier, 0)).toBe(false);
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
    relicSystem(world, DT, 1000 + RELIC_RECATCH_DELAY_MS - 20);
    expect(relic.relic!.phase).toBe('grounded');

    relicSystem(world, DT, 1000 + RELIC_RECATCH_DELAY_MS + 32);
    expect(relic.relic!.phase).toBe('carried');
  });
});

describe('relicSystem', () => {
  it('carried relic tracks its carrier', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer());
    const relic = world.add(makeCarriedRelic(player));

    player.transform!.position = [4, 0, -2];
    relicSystem(world, DT, 0);

    const [x, , z] = relic.transform!.position;
    expect(Math.hypot(x - 4, z + 2)).toBeLessThan(1.5); // beside, not on top of
  });

  it('a grounded relic is caught by a player inside the catch radius, not outside it', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(RELIC_CATCH_RADIUS + 1, 0));
    const relic = world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const },
    });

    relicSystem(world, DT, 0);
    expect(relic.relic!.phase).toBe('grounded');

    player.transform!.position = [0.5, 0, 0];
    relicSystem(world, DT, 16);
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(player);
  });

  it('post-pass rotation cooldown blocks the thrower from walk-in recatching', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(0.5, 0));
    player.relicRecatchUntil = 5000;
    world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const },
    });

    relicSystem(world, DT, 4000);
    expect(world.with('relic').first!.relic!.phase).toBe('grounded');
    relicSystem(world, DT, 5016);
    expect(world.with('relic').first!.relic!.phase).toBe('carried');
  });

  it('catch shockwave staggers and shoves nearby monsters', () => {
    const world = new World<Entity>();
    world.add(makePlayer(0.5, 0));
    world.add({
      transform: { position: [0, 0.6, 0] as [number, number, number], rotationY: 0 },
      relic: { phase: 'grounded' as const, noCatchUntil: 0 },
    });
    const monster = world.add({
      transform: { position: [2, 0, 0] as [number, number, number], rotationY: 0 },
      health: { current: 50, max: 50 },
      monster: 'crawler' as never,
    });

    relicSystem(world, DT, 5000);
    expect(monster.staggerUntil).toBeGreaterThan(5000);
    expect(monster.knockback![0]).toBeGreaterThan(0); // shoved away from the catch point
  });

  it('drops to grounded where the carrier died', () => {
    const world = new World<Entity>();
    const player = world.add(makePlayer(3, 3));
    const relic = world.add(makeCarriedRelic(player));
    relicSystem(world, DT, 0); // attach beside the living carrier

    player.health!.current = 0;
    relicSystem(world, DT, 16);
    expect(relic.relic!.phase).toBe('grounded');
    expect(relic.relic!.carrier).toBeUndefined();
  });
});
