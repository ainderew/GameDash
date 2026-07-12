import {
  RELIC_CORRUPTION_CRITICAL,
  RELIC_CORRUPTION_TUNING,
  RELIC_CORRUPTION_WARNING,
} from '@shared/balance';

export type CorruptionBand = 'stable' | 'warning' | 'critical';

/** Convert the authoritative Relic value to a clamped meter fraction. */
export const corruptionProgress = (corruption: number): number =>
  Math.max(0, Math.min(1, corruption / RELIC_CORRUPTION_TUNING.max));

export const corruptionBand = (progress: number): CorruptionBand => {
  if (progress >= RELIC_CORRUPTION_CRITICAL) return 'critical';
  if (progress >= RELIC_CORRUPTION_WARNING) return 'warning';
  return 'stable';
};
