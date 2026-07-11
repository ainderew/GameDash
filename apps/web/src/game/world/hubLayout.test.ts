import { describe, expect, it } from 'vitest';
import { HUB_SPAWN, nearestHubStation } from '@/game/world/hubLayout';

// The collision half of the hub layout moved into the sim — its tests live in
// packages/sim/src/terrain/hubCollision.test.ts. This suite keeps the UX layout.

describe('hub layout', () => {
  it('spawns outside every interaction radius', () => {
    expect(nearestHubStation(HUB_SPAWN[0], HUB_SPAWN[2])).toBeUndefined();
  });

  it('detects the three hub verbs at their approach points', () => {
    expect(nearestHubStation(-10.5, -5.8)?.id).toBe('roster');
    expect(nearestHubStation(10.5, -7.4)?.id).toBe('summoning');
    expect(nearestHubStation(0, -14.4)?.id).toBe('expedition');
  });
});
