import { describe, expect, it } from 'vitest';
import { createSimStepper } from './loop';

describe('createSimStepper', () => {
  it('runs fixed steps at the configured rate regardless of frame cadence', () => {
    // hz 32 → fixedDt 0.03125 is binary-exact, so the step count is deterministic.
    const stepper = createSimStepper({ hz: 32 });
    const fixedDt = 1 / 32;
    let steps = 0;
    let simulated = 0;
    // 20 jittery "frames" of 1.5 fixed steps each = exactly 30 steps of budget.
    for (let i = 0; i < 20; i++) {
      stepper.advance(fixedDt * 1.5, (dt) => {
        expect(dt).toBe(fixedDt);
        simulated += dt;
        steps += 1;
      });
    }
    expect(steps).toBe(30);
    expect(simulated).toBeCloseTo(30 * fixedDt);
  });

  it('exposes the interpolation remainder as alpha in [0, 1)', () => {
    const stepper = createSimStepper({ hz: 32 });
    stepper.advance(1 / 64, () => {});
    expect(stepper.alpha).toBeCloseTo(0.5);
    stepper.advance(1 / 64, () => {});
    expect(stepper.alpha).toBeCloseTo(0, 5);
  });

  it('caps catch-up steps after a stall instead of spiraling', () => {
    const stepper = createSimStepper({ hz: 30, maxStepsPerAdvance: 5 });
    let steps = 0;
    stepper.advance(10, () => (steps += 1)); // a 10 s stall
    expect(steps).toBe(5);
    expect(stepper.alpha).toBeLessThan(1); // backlog dropped, remainder is sane
  });
});
