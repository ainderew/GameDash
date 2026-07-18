import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../world';
import { impactFxSystem } from './impactFxSystem';

describe('impactFxSystem', () => {
  it('removes expired procedural and Blender flipbook markers', () => {
    const world = createGameWorld();
    const procedural = world.add({
      impactFx: {
        kind: 'spark' as const,
        strength: 'light' as const,
        spawnedAtReal: 100,
        lifetimeMs: 50,
        color: [1, 1, 1] as [number, number, number],
        count: 1,
        radius: 1,
        dirX: 0,
        dirZ: 1,
      },
    });
    const blender = world.add({
      blenderImpactFx: {
        spawnedAtReal: 100,
        lifetimeMs: 50,
        size: 2,
        dirX: 0,
        dirZ: 1,
      },
    });
    const stillPlaying = world.add({
      blenderImpactFx: {
        spawnedAtReal: 180,
        lifetimeMs: 50,
        size: 2,
        dirX: 0,
        dirZ: 1,
      },
    });

    impactFxSystem(world, 200);

    expect(world.entities).not.toContain(procedural);
    expect(world.entities).not.toContain(blender);
    expect(world.entities).toContain(stillPlaying);
  });
});
