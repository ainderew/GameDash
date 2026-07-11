/**
 * Fixed-timestep driver. The server ticks the sim at a FIXED rate (30 Hz) regardless of
 * wall-clock jitter; the client (Phase 3) uses the same stepper and renders with `alpha`
 * interpolation between the last two states. Phase 1 ships and tests it; the single-player
 * client keeps its current per-frame variable-dt stepping so feel is byte-identical.
 */

export interface SimStepperOptions {
  /** Fixed simulation rate, steps per second. */
  hz?: number;
  /**
   * Max fixed steps consumed per advance() — the spiral-of-death guard. A long stall
   * (breakpoint, tab sleep) drops time instead of simulating a burst of catch-up ticks.
   */
  maxStepsPerAdvance?: number;
}

export interface SimStepper {
  /** Seconds per fixed step (1/hz). */
  readonly fixedDt: number;
  /**
   * Fraction [0, 1) of a fixed step accumulated but not yet simulated — the render
   * interpolation factor between the previous and current sim states.
   */
  readonly alpha: number;
  /**
   * Feed real elapsed seconds; invokes `step(fixedDt)` 0..n times.
   * Returns how many fixed steps ran.
   */
  advance(realDtSec: number, step: (fixedDt: number) => void): number;
  /** Drop any accumulated remainder (zone change, world reset). */
  reset(): void;
}

export const createSimStepper = ({ hz = 30, maxStepsPerAdvance = 8 }: SimStepperOptions = {}): SimStepper => {
  const fixedDt = 1 / hz;
  let accumulator = 0;

  return {
    fixedDt,
    get alpha() {
      return accumulator / fixedDt;
    },
    advance(realDtSec, step) {
      accumulator += Math.max(0, realDtSec);
      let steps = 0;
      while (accumulator >= fixedDt && steps < maxStepsPerAdvance) {
        step(fixedDt);
        accumulator -= fixedDt;
        steps += 1;
      }
      // Hit the guard? Discard the backlog — never simulate a catch-up burst.
      if (accumulator >= fixedDt) accumulator = accumulator % fixedDt;
      return steps;
    },
    reset() {
      accumulator = 0;
    },
  };
};
