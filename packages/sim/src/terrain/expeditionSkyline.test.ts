import { describe, expect, it } from 'vitest';
import {
  EXPEDITION_SKYLINE_MIN_RADIUS,
  EXPEDITION_SKYLINE_PLACEMENTS,
  inExpeditionSkylineKeepout,
} from './expeditionSkyline';

describe('expedition skyline layout', () => {
  it('keeps every skyline footprint beyond the playable arena', () => {
    for (const placement of EXPEDITION_SKYLINE_PLACEMENTS) {
      expect(Math.hypot(...placement.position), placement.id).toBeGreaterThanOrEqual(
        EXPEDITION_SKYLINE_MIN_RADIUS,
      );
    }
  });

  it('reuses every skyline source six times with unique placement ids', () => {
    const ids = new Set(EXPEDITION_SKYLINE_PLACEMENTS.map((placement) => placement.id));
    expect(ids.size).toBe(EXPEDITION_SKYLINE_PLACEMENTS.length);

    const counts = EXPEDITION_SKYLINE_PLACEMENTS.reduce<Record<string, number>>(
      (result, placement) => {
        result[placement.asset] = (result[placement.asset] ?? 0) + 1;
        return result;
      },
      {},
    );
    expect(counts).toEqual({ distantArch: 6, towerA: 6, towerB: 6 });
    expect(new Set(EXPEDITION_SKYLINE_PLACEMENTS.map((placement) => placement.depthBand))).toEqual(
      new Set(['mid', 'far']),
    );
  });

  it('reserves every authored footprint from random scenery', () => {
    for (const placement of EXPEDITION_SKYLINE_PLACEMENTS) {
      expect(inExpeditionSkylineKeepout(...placement.position), placement.id).toBe(true);
    }
    expect(inExpeditionSkylineKeepout(0, 0)).toBe(false);
  });
});
