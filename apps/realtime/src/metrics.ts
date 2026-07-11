/**
 * Tick-duration telemetry (Phase 6 Task 5). A ring of recent fixed-step wall-clock durations
 * (ms) the sim loop feeds; `summary()` reports mean / p50 / p99 / max so the /metrics endpoint
 * and the periodic log line surface the KPI (p99 < 15 ms — half the 33 ms tick budget) and
 * flag overruns before they cause visible drift. Pure + dependency-free.
 */
export class TickMetrics {
  private readonly ring: number[];
  private readonly cap: number;
  private idx = 0;
  private count = 0;
  private overruns = 0;
  private readonly budgetMs: number;

  constructor(capacity = 1800, budgetMs = 1000 / 30) {
    this.cap = capacity; // ~60 s of ticks at 30 Hz
    this.ring = new Array<number>(capacity).fill(0);
    this.budgetMs = budgetMs;
  }

  record(durationMs: number): void {
    this.ring[this.idx] = durationMs;
    this.idx = (this.idx + 1) % this.cap;
    if (this.count < this.cap) this.count += 1;
    if (durationMs > this.budgetMs) this.overruns += 1;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const rank = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[rank]!;
  }

  summary(): { p50: number; p99: number; max: number; mean: number; samples: number; overruns: number } {
    if (this.count === 0) return { p50: 0, p99: 0, max: 0, mean: 0, samples: 0, overruns: 0 };
    const vals = this.ring.slice(0, this.count).sort((a, b) => a - b);
    const sum = vals.reduce((s, v) => s + v, 0);
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      p50: round(this.percentile(vals, 50)),
      p99: round(this.percentile(vals, 99)),
      max: round(vals[vals.length - 1]!),
      mean: round(sum / vals.length),
      samples: this.count,
      overruns: this.overruns,
    };
  }
}
