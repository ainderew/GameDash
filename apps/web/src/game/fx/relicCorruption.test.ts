import { describe, expect, it } from 'vitest';
import { corruptionBand, corruptionProgress } from './relicCorruption';

describe('relic corruption presentation', () => {
  it('clamps authoritative corruption to a normalized meter value', () => {
    expect(corruptionProgress(-100)).toBe(0);
    expect(corruptionProgress(50)).toBe(0.5);
    expect(corruptionProgress(125)).toBe(1);
  });

  it('moves through stable, warning, and critical bands', () => {
    expect(corruptionBand(0.69)).toBe('stable');
    expect(corruptionBand(0.7)).toBe('warning');
    expect(corruptionBand(0.9)).toBe('critical');
  });
});
