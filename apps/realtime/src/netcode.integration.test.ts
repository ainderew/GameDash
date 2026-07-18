import { describe, expect, it } from 'vitest';
import { MS_PER_TICK, RECONCILE_EPSILON_M } from '@shared/net/constants';
import { PLAYER_SPEED } from '@shared/balance';
import { NetHarness } from './netHarness';

/**
 * THE PHASE 3 KPI (no-rubberband contract, measured): the real server stack vs the real
 * prediction client over a simulated 150 ms ± 30 ms, 1 % loss wire, for two SIMULATED
 * minutes (virtual clock — runs in well under a second).
 *
 *   · reconciliation corrections MUST be < 1/min
 *   · every correction MUST be < 10 cm
 *   · server position and client predicted position MUST converge within epsilon
 *   · a clean link MUST produce exactly zero corrections
 *   · a speed-hacked client MUST be fully ignored (position is server-derived)
 */

const TWO_MIN = 120_000;

const dist3 = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('netcode KPI @ 150ms ± 30ms, 1% loss (2 simulated minutes)', () => {
  it('corrections < 1/min, every correction < 10 cm, prediction converges to the server', () => {
    const h = new NetHarness({
      conditions: { delayMs: 150, jitterMs: 30, loss: 0.01 },
      bots: [{ seed: 11 }],
      rngSeed: 0xa11ce,
    });
    h.run(TWO_MIN);
    // Let the last acks land, with the bot idle (stop generating new movement).
    const { bot, player } = h.bots[0]!;
    const stats = bot.stats;

    const minutes = TWO_MIN / 60_000;
    const perMin = stats.corrections.length / minutes;
    const maxCorrection = stats.corrections.reduce((m, c) => Math.max(m, c.magnitudeM), 0);

    // Machine-run KPI numbers — surfaced in the test output for the phase report.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        kpi: 'lossy_link',
        ticks: stats.ticks,
        acks: stats.acks,
        corrections: stats.corrections.length,
        correctionsPerMin: perMin,
        maxCorrectionM: maxCorrection,
        maxCleanErrorM: stats.maxCleanErrorM,
        lastAckErrorM: stats.lastAckErrorM,
        teleports: stats.teleports,
        queue: {
          starvations: player.input.starvations,
          gapsSkipped: player.input.gapsSkipped,
          overflowDropped: player.input.overflowDropped,
          targetDepth: player.input.targetDepth,
        },
      }),
    );

    expect(stats.ticks).toBeGreaterThan(3000); // the loop actually ran ≈ 2 min of ticks
    expect(stats.acks).toBeGreaterThan(1000);
    expect(perMin).toBeLessThan(1); // THE KPI
    expect(maxCorrection).toBeLessThan(0.1); // every correction sub-perceptual
    expect(stats.teleports).toBeLessThanOrEqual(1); // the spawn sync only
    // Convergence: the last ack agreed with prediction within epsilon.
    expect(stats.lastAckErrorM).toBeLessThanOrEqual(RECONCILE_EPSILON_M);
  });

  it('clean link ⇒ corrections are EXACTLY zero (contract #1, measured)', () => {
    const h = new NetHarness({
      conditions: { delayMs: 60, jitterMs: 0, loss: 0 },
      bots: [{ seed: 23 }],
      rngSeed: 0xbeef,
    });
    h.run(60_000);
    const stats = h.bots[0]!.bot.stats;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        kpi: 'clean_link',
        acks: stats.acks,
        corrections: stats.corrections.length,
        maxCleanErrorM: stats.maxCleanErrorM,
      }),
    );
    expect(stats.acks).toBeGreaterThan(500);
    expect(stats.corrections).toHaveLength(0);
    expect(stats.teleports).toBeLessThanOrEqual(1); // spawn sync
    // Bit-parity: clean acks carry only quantization noise — the wire quantizes the
    // ack pos to 0.5 cm/axis and the spawn snap bakes one such error in, so the bound
    // is 2 × √3 × 0.005 ≈ 1.73 cm, always below the correction epsilon.
    expect(stats.maxCleanErrorM).toBeLessThanOrEqual(RECONCILE_EPSILON_M);
  });

  it('impulse mid-strafe: the shove replays as one arc with zero correction spikes', () => {
    const h = new NetHarness({
      conditions: { delayMs: 150, jitterMs: 20, loss: 0 },
      bots: [
        {
          seed: 5,
          intentFn: () => ({ moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false }),
        },
      ],
      rngSeed: 0xd0d0,
    });
    h.run(8000);
    const { bot, player } = h.bots[0]!;
    const correctionsBefore = bot.stats.corrections.length;
    h.session.queueImpulse(player.id, [0, 0, 12]);
    h.run(16_000);

    expect(h.bots[0]!.impulses.length).toBeGreaterThan(0);
    expect(h.bots[0]!.impulses[0]!.seq).toBeGreaterThan(0); // owner copy carried the seq
    const corrections = bot.stats.corrections.length - correctionsBefore;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ kpi: 'impulse', corrections, lastAckErrorM: bot.stats.lastAckErrorM }));
    expect(corrections).toBe(0);
    expect(bot.stats.lastAckErrorM).toBeLessThanOrEqual(RECONCILE_EPSILON_M);
  });

  it('speed-hacked cmds (int8-maxed diagonals) are ignored: position is server-derived', () => {
    const h = new NetHarness({
      conditions: { delayMs: 40, jitterMs: 0, loss: 0 },
      bots: [
        {
          seed: 9,
          hacked: true,
          intentFn: () => ({ moveX: 1, moveZ: 1, jump: false, dodge: false, sprint: true }),
        },
      ],
      rngSeed: 0xfade,
    });
    const { player } = h.bots[0]!;
    const spawn = [...player.entity.transform!.position];

    // Track per-tick server displacement across the whole run.
    let prev = [...player.entity.transform!.position];
    let maxStep = 0;
    const origStep = h.session.step.bind(h.session);
    (h.session as { step: (dt: number) => void }).step = (dt: number) => {
      origStep(dt);
      const p = player.entity.transform!.position;
      // Horizontal step only: ground-following on uneven terrain adds server-derived Y motion
      // that says nothing about the input speed being clamped.
      maxStep = Math.max(maxStep, Math.hypot(p[0]! - prev[0]!, p[2]! - prev[2]!));
      prev = [...p];
    };

    const RUN_MS = 3000;
    h.run(RUN_MS);

    const travelled = dist3(player.entity.transform!.position, spawn);
    const maxLegit = PLAYER_SPEED * (RUN_MS / 1000);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ kpi: 'speed_hack', travelled, maxLegit, maxStepM: maxStep }));
    // The server moved the avatar at legit sprint speed — the 1.79× request is ignored.
    expect(travelled).toBeLessThanOrEqual(maxLegit + 0.1);
    expect(maxStep).toBeLessThanOrEqual(PLAYER_SPEED * (MS_PER_TICK / 1000) + 1e-6);
    // And the honest prediction (decoded clamped intent) still converges.
    expect(h.bots[0]!.bot.stats.lastAckErrorM).toBeLessThanOrEqual(RECONCILE_EPSILON_M);
  });
});
