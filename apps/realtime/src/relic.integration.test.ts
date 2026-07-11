import { describe, expect, it } from 'vitest';
import { RECONCILE_EPSILON_M } from '@shared/net/constants';
import { sampleRelicFlight, type RelicFlightParams } from '@sim/combat/passTargeting';
import { relicInvariantViolation } from '@sim/systems/relicSystem';
import { NetHarness } from './netHarness';

/**
 * PHASE 5 RELIC INTEGRATION (plan acceptance): two bots at a simulated 150 ms ± 30 ms link
 * complete a multi-pass relay through the real server stack (authoritative relic state machine
 * + validation + reliable relic events + snapshot codec). Asserted after the run:
 *   · every flight is IDENTICAL on both bot views (record + compare sampled positions);
 *   · every catch fires RelicCaught on both bots;
 *   · zero relic duplication / limbo — the single-source-of-truth invariant holds every tick;
 *   · the no-rubberband KPI still holds with the relic active (< 1 correction / min).
 */

const RUN_MS = 60_000;

const toParams = (f: {
  mode: 'pass' | 'lob';
  from: [number, number, number];
  control: [number, number, number];
  to: [number, number, number];
  arcHeight: number;
  startedAt: number;
  flightMs: number;
}): RelicFlightParams => ({
  mode: f.mode,
  from: [...f.from],
  control: [...f.control],
  to: [...f.to],
  arcHeight: f.arcHeight,
  startedAt: f.startedAt,
  flightMs: f.flightMs,
});

describe('two-bot relic relay @ 150 ms', () => {
  it('identical flights on both views, catches on both, invariant holds, no rubberbanding', () => {
    const h = new NetHarness({
      conditions: { delayMs: 150, jitterMs: 30, loss: 0.01 },
      zone: 'expedition',
      bots: [
        { seed: 301, mode: 'expedition', relay: true },
        { seed: 302, mode: 'expedition', relay: true },
      ],
      rngSeed: 0xbadbeef,
    });
    // Focus the run on the relay: suppress wave spawns so the stationary relay bots aren't
    // ground down by monsters (the combat path is covered by combat.integration.test.ts).
    h.session.world.spawn.started = true;
    h.session.world.spawn.nextSpawnAt = Number.POSITIVE_INFINITY;

    // Probe the single-source-of-truth invariant on EVERY server tick.
    let violation: string | null = null;
    const origStep = h.session.step.bind(h.session);
    (h.session as { step: (dt: number) => void }).step = (dt: number) => {
      origStep(dt);
      const v = relicInvariantViolation(h.session.world);
      if (v && !violation) violation = v;
    };

    h.run(RUN_MS);
    h.run(RUN_MS + 2000); // let the last events/acks land

    const b0 = h.bots[0]!.bot;
    const b1 = h.bots[1]!.bot;

    const report = {
      kpi: 'relic_relay_2bot',
      launchesB0: b0.launches.length,
      launchesB1: b1.launches.length,
      catchesB0: b0.catches,
      catchesB1: b1.catches,
      invariant: violation ?? 'ok',
      b0: { corrections: b0.stats.corrections.length, teleports: b0.stats.teleports, lastAckErrorM: b0.stats.lastAckErrorM },
      b1: { corrections: b1.stats.corrections.length, teleports: b1.stats.teleports, lastAckErrorM: b1.stats.lastAckErrorM },
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report));

    // Invariant held every tick — the relic was never duplicated or in limbo.
    expect(violation).toBeNull();

    // A real relay happened: ≥ 10 passes, and both bots observed every launch identically.
    expect(b0.launches.length).toBeGreaterThanOrEqual(10);
    expect(b1.launches.length).toBe(b0.launches.length);

    // Every flight path is IDENTICAL on both bot views — sample positions across each flight.
    for (let i = 0; i < b0.launches.length; i += 1) {
      const f0 = b0.launches[i]!;
      const f1 = b1.launches[i]!;
      expect(f0.startedAt).toBe(f1.startedAt);
      expect(f0.flightMs).toBe(f1.flightMs);
      const p0: [number, number, number] = [0, 0, 0];
      const p1: [number, number, number] = [0, 0, 0];
      for (let k = 0; k <= 8; k += 1) {
        const now = f0.startedAt + f0.flightMs * (k / 8);
        sampleRelicFlight(toParams(f0), now, p0);
        sampleRelicFlight(toParams(f1), now, p1);
        expect(p0).toEqual(p1);
      }
    }

    // Every catch fired on both bots (RelicCaught is a reliable broadcast).
    expect(b0.catches).toBe(b1.catches);
    expect(b0.catches).toBeGreaterThanOrEqual(10);

    // No-rubberband KPI with the relic active: corrections ≤ 1/min, each sub-perceptual, and
    // prediction converged to the server for both bots.
    const minutes = RUN_MS / 60_000;
    for (const bot of [b0, b1]) {
      const perMin = bot.stats.corrections.length / minutes;
      const maxCorrection = bot.stats.corrections.reduce((m, c) => Math.max(m, c.magnitudeM), 0);
      expect(perMin).toBeLessThanOrEqual(1);
      expect(maxCorrection).toBeLessThan(0.1);
      expect(bot.stats.lastAckErrorM).toBeLessThanOrEqual(RECONCILE_EPSILON_M);
    }
  });
});
