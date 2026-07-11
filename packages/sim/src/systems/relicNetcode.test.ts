import { describe, expect, it } from 'vitest';
import { GameWorld } from '../world';
import type { Entity } from '../components';
import { EventQueue } from '../events';
import { stepSim, type PlayerIntent } from '../step';
import { passRelic, relicInvariantViolation, spawnRelic } from './relicSystem';
import {
  bezierControl,
  predictCatchPos,
  sampleRelicFlight,
  type RelicFlightParams,
} from '../combat/passTargeting';

/**
 * Phase 5 sim-level guarantees the netcode leans on:
 *  1. The relic flight is a PURE function of its launch params, so two independent
 *     reconstructions (two clients) sample the IDENTICAL path — "looks identical on both
 *     screens" holds by construction.
 *  2. The single-source-of-truth invariant (exactly one of carried / inFlight / grounded)
 *     holds every tick under the SERVER system order (stepSim, authority 'server').
 */

const DT = 1 / 30;

const makePlayer = (x: number, z: number): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  playerControlled: true,
});

describe('sampleRelicFlight — deterministic, pure', () => {
  it('two independent samplers of the same pass params trace bit-identical positions', () => {
    const params: RelicFlightParams = {
      mode: 'pass',
      from: [0, 1.2, 0],
      to: [8, 1.2, 3],
      control: bezierControl([0, 1.2, 0], [8, 1.2, 3]),
      arcHeight: 0,
      startedAt: 1000,
      flightMs: 420,
    };
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    for (let now = 1000; now <= 1420; now += 12) {
      sampleRelicFlight(params, now, a);
      sampleRelicFlight({ ...params }, now, b); // a fresh param object — no shared state
      expect(a).toEqual(b);
    }
    // Endpoints land exactly on from/to.
    sampleRelicFlight(params, 1000, a);
    expect(a).toEqual([0, 1.2, 0]);
    sampleRelicFlight(params, 1420, a);
    expect(a[0]).toBeCloseTo(8, 6);
    expect(a[2]).toBeCloseTo(3, 6);
  });

  it('clamps t outside [0,1] (a late sample never overshoots the endpoint)', () => {
    const params: RelicFlightParams = {
      mode: 'lob',
      from: [0, 0.6, 0],
      to: [2, 0.6, 0],
      control: [1, 0.6, 0],
      arcHeight: 1,
      startedAt: 0,
      flightMs: 300,
    };
    const out: [number, number, number] = [0, 0, 0];
    sampleRelicFlight(params, 9999, out); // long past arrival
    expect(out[0]).toBeCloseTo(2, 6);
    expect(out[1]).toBeCloseTo(0.6, 6); // parabola back to the chord at t=1
  });
});

describe('relic under the server system order (stepSim, authority server)', () => {
  it('runs a full pass → catch keeping the single-source-of-truth invariant every tick', () => {
    const world = new GameWorld();
    const thrower = world.add(makePlayer(0, 0));
    const receiver = world.add(makePlayer(6, 0));
    const relic = spawnRelic(world, [0, 0, 0]);
    // Hand the relic to the thrower (a legitimate walk-in would do the same).
    relic.relic!.phase = 'carried';
    relic.relic!.carrier = thrower;

    const events = new EventQueue();
    const intents = new Map<Entity, PlayerIntent>();
    let now = 0;
    // First tick: throw. `passTo` is the server-resolved receiver (validated upstream).
    const launchTo = predictCatchPos(receiver);
    intents.set(thrower, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false, passTo: receiver });
    intents.set(receiver, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false });

    let sawInFlight = false;
    let violation: string | null = null;
    for (let i = 0; i < 120 && violation === null; i += 1) {
      now += DT * 1000;
      stepSim(world, events, intents, DT, now, 'expedition', undefined, { authority: 'server' });
      // Strip the seeded wave so only the relay entities exist (keeps the probe clean).
      for (const m of [...world.with('monster')]) world.remove(m);
      violation = relicInvariantViolation(world);
      // Read through a widening alias — TS can't see stepSim mutate `phase`, so a direct
      // literal compare would narrow against the setup assignment.
      const phase: string = relic.relic!.phase;
      if (phase === 'inFlight') sawInFlight = true;
      // The throw is a one-shot — clear it after the first tick.
      intents.set(thrower, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false });
      if (phase === 'carried' && relic.relic!.carrier === receiver) break;
    }
    expect(violation).toBeNull();
    expect(sawInFlight).toBe(true);
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(receiver);
    // The thrower entered the rotation cooldown; the receiver is now the carrier.
    expect(thrower.relicRecatchUntil).toBeGreaterThan(0);
    expect(launchTo[0]).toBeGreaterThan(0); // predictCatchPos led the endpoint toward the receiver
  });

  it('relicInvariantViolation catches a duplicated relic', () => {
    const world = new GameWorld();
    spawnRelic(world, [0, 0, 0]);
    expect(relicInvariantViolation(world)).toBeNull();
    spawnRelic(world, [1, 0, 1]);
    expect(relicInvariantViolation(world)).toMatch(/exactly 1 relic/);
  });
});
