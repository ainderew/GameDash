import { describe, expect, it } from 'vitest';
import { corruptionPowerVisual } from './corruptionPower';

describe('corruption power visual mapping', () => {
  it.each([
    [0, 0, 0],
    [20, 1, 16],
    [45, 2, 24],
    [70, 3, 32],
    [90, 4, 40],
    [100, 4, 40],
  ])('maps corruption %s to tier %s and %s motes', (corruption, tier, motes) => {
    const visual = corruptionPowerVisual(corruption);
    expect(visual.tierIndex).toBe(tier);
    expect(visual.particleCount).toBe(motes);
  });

  it('clamps values and increases intensity monotonically across tiers', () => {
    expect(corruptionPowerVisual(-10).tierIndex).toBe(0);
    expect(corruptionPowerVisual(150).tierIndex).toBe(4);
    const intensities = [20, 45, 70, 90].map((value) => corruptionPowerVisual(value).intensity);
    expect(intensities).toEqual([...intensities].sort((a, b) => a - b));
  });
});
