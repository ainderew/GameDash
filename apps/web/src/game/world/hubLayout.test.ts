import { describe, expect, it } from 'vitest';
import { HUB_SPAWN, nearestHubStation } from '@/game/world/hubLayout';
import { HUB_LANDMARK_POSITIONS } from '@sim/terrain/hubGeometry';

// The collision half of the hub layout moved into the sim — its tests live in
// packages/sim/src/terrain/hubCollision.test.ts. This suite keeps the UX layout.

describe('hub layout', () => {
  it('places the lodge and shrine on opposite sides of the expedition axis', () => {
    const { lodge, shrine, gate } = HUB_LANDMARK_POSITIONS;
    expect(lodge[0]).toBeLessThan(0);
    expect(shrine[0]).toBeGreaterThan(0);
    expect(lodge[1]).toBeGreaterThan(gate[1]);
    expect(shrine[1]).toBeGreaterThan(gate[1]);
    expect(gate[0]).toBe(0);
  });

  it('spawns outside every interaction radius', () => {
    expect(nearestHubStation(HUB_SPAWN[0], HUB_SPAWN[2])).toBeUndefined();
  });

  it('detects the three hub verbs at their approach points', () => {
    expect(nearestHubStation(-15, -5.8)?.id).toBe('roster');
    expect(nearestHubStation(...HUB_LANDMARK_POSITIONS.shrine)?.id).toBe('summoning');
    // The player is walled off at 2.4 from the gate center by hubCollision, so this
    // is where they actually come to rest against the portal — the trigger must catch it.
    expect(nearestHubStation(0, HUB_LANDMARK_POSITIONS.gate[1] + 2.4)?.id).toBe('expedition');
  });

  it('only triggers the expedition gate at the portal, not on approach', () => {
    // Departure is proximity-triggered, so the gate ring stays snug around the portal
    // standing just beyond the 3-unit trigger must NOT be inside it.
    expect(nearestHubStation(0, HUB_LANDMARK_POSITIONS.gate[1] + 3.1)?.id).not.toBe('expedition');
  });
});
