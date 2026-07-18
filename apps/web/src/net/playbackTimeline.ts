/**
 * Monotonic server-playback cursor for snapshot-rendered entities.
 *
 * Network conditions can change the desired interpolation delay abruptly. Applying that
 * delay directly to `serverNow` moves render time backwards (a visible freeze/jitter). This
 * cursor instead converges at a bounded rate, so playback gently slows down or speeds up
 * without ever reversing.
 */
export class PlaybackTimeline {
  private cursor: number | null = null;
  private lastLocalNow: number | null = null;

  constructor(
    private readonly maxSlewFraction = 0.1,
    private readonly resetThresholdMs = 1000,
  ) {}

  sample(desiredServerTimeMs: number, localNowMs: number): number {
    if (this.cursor === null || this.lastLocalNow === null) {
      this.cursor = desiredServerTimeMs;
      this.lastLocalNow = localNowMs;
      return this.cursor;
    }

    const dt = Math.max(0, localNowMs - this.lastLocalNow);
    this.lastLocalNow = localNowMs;
    const nominal = this.cursor + dt;
    const error = desiredServerTimeMs - nominal;

    if (Math.abs(error) >= this.resetThresholdMs) {
      this.cursor = desiredServerTimeMs;
      return this.cursor;
    }

    const maxCorrection = dt * this.maxSlewFraction;
    const correction = Math.max(-maxCorrection, Math.min(maxCorrection, error));
    this.cursor = nominal + correction;
    return this.cursor;
  }

  reset(): void {
    this.cursor = null;
    this.lastLocalNow = null;
  }
}
