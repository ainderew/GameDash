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
    // The player is walled off at 2.0 from the gate center (0, -17) by hubCollision, so this
    // is where they actually come to rest against the portal — the trigger must catch it.
    expect(nearestHubStation(0, -15)?.id).toBe('expedition');
  });

  it('only triggers the expedition gate at the portal, not on approach', () => {
    // Departure is proximity-triggered, so the gate ring stays snug around the portal
    // (z = -17): standing ~3 units short must NOT be inside it.
    expect(nearestHubStation(0, -14)?.id).not.toBe('expedition');
  });
});
