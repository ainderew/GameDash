/**
 * Live netcode telemetry — a plain mutable object written by the transport/client/
 * prediction layers on the hot path (never React state) and polled at low rate by
 * NetDebugOverlay. Corrections/min is THE phase KPI (no-rubberband contract:
 * ≈ 0 on a clean link, < 1/min at 1 % loss, every one sub-perceptual).
 */

export interface CorrectionSample {
  atMs: number; // performance.now()
  magnitudeM: number;
}

export const netStats = {
  /** EWMA RTT echoed by the server heartbeat, ms. */
  pingMs: null as number | null,
  /** serverTickTime − performance.now() offset estimate, ms. */
  clockOffsetMs: null as number | null,
  /** Current adaptive interpolation delay, ms. */
  interpDelayMs: 0,
  /** Measured snapshot arrival rate, Hz (EWMA). */
  snapshotRateHz: 0,
  snapshotsReceived: 0,
  /** Delta snapshots referencing a baseline we never got (harness loss / reconnects). */
  unknownBaselines: 0,

  bytesIn: 0,
  bytesOut: 0,
  /** Rolling per-second rates, updated by the overlay's sampler. */
  bytesInPerSec: 0,
  bytesOutPerSec: 0,

  /** Input acks: the server's lastProcessedSeq vs our head seq (cmd pipeline health). */
  lastAckSeq: 0,
  headSeq: 0,

  corrections: [] as CorrectionSample[],
  teleports: 0,
  lastCorrectionM: 0,
  maxCorrectionM: 0,

  noteCorrection(magnitudeM: number): void {
    const now = performance.now();
    this.corrections.push({ atMs: now, magnitudeM });
    this.lastCorrectionM = magnitudeM;
    this.maxCorrectionM = Math.max(this.maxCorrectionM, magnitudeM);
    // Keep a 5-minute window.
    while (this.corrections.length > 0 && now - this.corrections[0]!.atMs > 300_000) {
      this.corrections.shift();
    }
  },

  correctionsPerMin(): number {
    const now = performance.now();
    const windowMs = 60_000;
    const recent = this.corrections.filter((c) => now - c.atMs <= windowMs);
    return recent.length;
  },

  reset(): void {
    this.snapshotRateHz = 0;
    this.snapshotsReceived = 0;
    this.unknownBaselines = 0;
    this.corrections = [];
    this.teleports = 0;
    this.lastCorrectionM = 0;
    this.maxCorrectionM = 0;
    this.lastAckSeq = 0;
    this.headSeq = 0;
  },
};
