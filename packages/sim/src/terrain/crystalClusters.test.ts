import { describe, expect, it } from 'vitest';
import {
  EXPEDITION_CRYSTAL_PLACEMENTS,
  HUB_CRYSTAL_PLACEMENTS,
  inExpeditionCrystalKeepout,
} from './crystalClusters';

describe('authored crystal cluster placement', () => {
  it('uses unique ids and all three source assets', () => {
    const placements = [...HUB_CRYSTAL_PLACEMENTS, ...EXPEDITION_CRYSTAL_PLACEMENTS];
    expect(new Set(placements.map((placement) => placement.id)).size).toBe(placements.length);
    expect(new Set(placements.map((placement) => placement.asset))).toEqual(
      new Set(['smallA', 'smallB', 'large']),
    );
  });

  it('keeps the expedition combat center clear', () => {
    for (const placement of EXPEDITION_CRYSTAL_PLACEMENTS) {
      expect(Math.hypot(...placement.position), placement.id).toBeGreaterThanOrEqual(9);
      expect(placement.scale).toBeGreaterThan(0);
    }
  });

  it('reserves each expedition cluster from random scenery', () => {
    for (const placement of EXPEDITION_CRYSTAL_PLACEMENTS) {
      expect(inExpeditionCrystalKeepout(...placement.position), placement.id).toBe(true);
    }
    expect(inExpeditionCrystalKeepout(0, 0)).toBe(false);
  });
});
