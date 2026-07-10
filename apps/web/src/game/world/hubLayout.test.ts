import { describe, expect, it } from 'vitest';
import type { Entity } from '@/game/ecs/components';
import { HUB_SPAWN, nearestHubStation, resolveHubCollisions } from '@/game/world/hubLayout';

const playerAt = (x: number, z: number): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  playerControlled: true,
  radius: 0.45,
});

describe('hub layout', () => {
  it('spawns outside every interaction radius', () => {
    expect(nearestHubStation(HUB_SPAWN[0], HUB_SPAWN[2])).toBeUndefined();
  });

  it('detects the three hub verbs at their approach points', () => {
    expect(nearestHubStation(-10.5, -5.8)?.id).toBe('roster');
    expect(nearestHubStation(10.5, -7.4)?.id).toBe('summoning');
    expect(nearestHubStation(0, -14.4)?.id).toBe('expedition');
  });

  it('pushes the player out of the shrine footprint', () => {
    const player = playerAt(10.5, -7.4);
    resolveHubCollisions(player);
    const position = player.transform!.position;
    expect(Math.hypot(position[0] - 10.5, position[2] + 7.4)).toBeGreaterThanOrEqual(2);
  });

  it('keeps the player inside the authored clearing', () => {
    const player = playerAt(100, 0);
    resolveHubCollisions(player);
    const position = player.transform!.position;
    expect(Math.hypot(position[0], position[2])).toBeCloseTo(28);
  });
});
