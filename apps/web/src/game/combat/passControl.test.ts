import { afterEach, describe, expect, it } from 'vitest';
import { RELIC_QUICK_TAP_MS } from '@shared/balance';
import { createGameWorld } from '@sim/world';
import { passAim, resetPassAim } from './passAim';
import { updatePassControl } from './passControl';

afterEach(() => {
  resetPassAim();
});

describe('multiplayer held-pass control', () => {
  it('enters aim mode, publishes a ribbon curve, and throws on release', () => {
    const world = createGameWorld();
    const carrier = world.add({
      transform: { position: [0, 0, 0], rotationY: Math.PI },
      velocity: { linear: [0, 0, 0] },
      health: { current: 100, max: 100 },
      playerControlled: true,
      localPlayer: true,
    });
    const remote = world.add({
      transform: { position: [0, 0, -5], rotationY: 0 },
      health: { current: 100, max: 100 },
      remotePlayer: true,
      serverEntityId: 42,
    });
    const relicOrigin: [number, number, number] = [0, 1.2, 0];

    // Reset module-held state, then hold beyond the quick-tap threshold.
    updatePassControl(world, carrier, false, 0, null);
    expect(updatePassControl(world, carrier, true, 100, relicOrigin)).toBeNull();
    expect(
      updatePassControl(world, carrier, true, 100 + RELIC_QUICK_TAP_MS + 1, relicOrigin),
    ).toBeNull();
    expect(passAim.aiming).toBe(true);
    expect(passAim.target).toBe(remote);
    expect(passAim.curve.length).toBeGreaterThan(1);

    const target = updatePassControl(
      world,
      carrier,
      false,
      100 + RELIC_QUICK_TAP_MS + 2,
      relicOrigin,
    );
    expect(target).toBe(remote);
    expect(passAim.aiming).toBe(false);
  });
});
