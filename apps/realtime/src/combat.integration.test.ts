import { describe, expect, it } from 'vitest';
import { RECONCILE_EPSILON_M } from '@shared/net/constants';
import { NetHarness } from './netHarness';

/**
 * PHASE 4 COMBAT INTEGRATION (plan Task 7): two bots fight the expedition at a simulated
 * 150 ms link. The real server stack (authoritative combat + lag-comp melee + snapshot codec
 * + reliable events) drives two real prediction clients whose combat brains seek and melee
 * monsters. Asserted after the run:
 *   · both bots' SNAPSHOT-derived monster view matches the server EXACTLY (replication);
 *   · both bots' SHARED-POOL material tally matches the server EXACTLY;
 *   · combat actually happened (monsters killed, loot pooled);
 *   · the no-rubberband KPI still holds with combat active (< 1 correction / min).
 */

const RUN_MS = 60_000;

const monsterHpFromWorld = (session: NetHarness['session']): Map<number, number> => {
  const out = new Map<number, number>();
  for (const m of session.world.with('monster')) out.set(m.id!, m.health?.current ?? 0);
  return out;
};

describe('two-bot expedition combat @ 150 ms', () => {
  it('replicates monsters + shared loot identically to the server, no rubberbanding', () => {
    const h = new NetHarness({
      conditions: { delayMs: 150, jitterMs: 30, loss: 0.01 },
      zone: 'expedition',
      bots: [
        { seed: 101, mode: 'expedition', combat: true },
        { seed: 202, mode: 'expedition', combat: true },
      ],
      rngSeed: 0xc0ffee,
    });
    // This test measures COMBAT replication, not the relay (that has its own integration test).
    // The expedition now spawns a relic (Phase 5); keep it un-catchable so a wandering combat
    // bot can't walk-in-grab it — a walk-in catch's server-side plant (a movement lock that is
    // presentation-only client-side in Phase 6) would inject an unrelated correction fold.
    const relic = h.session.world.with('relic').first;
    if (relic?.relic) relic.relic.noCatchUntil = Number.POSITIVE_INFINITY;
    h.run(RUN_MS);
    // Let the last snapshots (incl. a trailing keyframe) land so views converge on the server.
    h.run(RUN_MS + 2500);

    const server = monsterHpFromWorld(h.session);
    const b0 = h.bots[0]!.bot;
    const b1 = h.bots[1]!.bot;

    // Combat progressed: the server killed monsters and pooled their loot.
    const materials = h.session.materials;
    const report = {
      kpi: 'combat_2bot',
      serverMaterials: materials,
      serverMonstersAlive: server.size,
      wave: h.session.world.spawn.wave,
      b0: { materials: b0.materials, corrections: b0.stats.corrections.length, teleports: b0.stats.teleports, lastAckErrorM: b0.stats.lastAckErrorM },
      b1: { materials: b1.materials, corrections: b1.stats.corrections.length, teleports: b1.stats.teleports, lastAckErrorM: b1.stats.lastAckErrorM },
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report));

    expect(materials).toBeGreaterThan(0); // loot dropped + collected → shared pool rose

    // SHARED-POOL tally: both bots agree with the server exactly.
    expect(b0.materials).toBe(materials);
    expect(b1.materials).toBe(materials);

    // Monster replication: each bot's snapshot-derived view equals the server's live set,
    // id-for-id and HP-for-HP (HP is quantized to an integer on the wire, so exact).
    for (const bot of [b0, b1]) {
      const view = bot.monsterHp();
      expect([...view.keys()].sort()).toEqual([...server.keys()].sort());
      for (const [id, hp] of server) expect(view.get(id)).toBe(hp);
    }

    // No-rubberband KPI with combat active (the Phase 3 dual criterion): corrections stay at
    // the ≤ 1/min ceiling AND every correction is sub-perceptual (< 10 cm, folds over 100 ms
    // so nothing is ever SEEN to rubberband), and prediction converged to the server.
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
