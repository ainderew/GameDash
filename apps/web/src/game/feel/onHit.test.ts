import { describe, expect, it } from 'vitest';
import { World } from 'miniplex';
import type { Entity } from '@sim/components';
import { spawnRelicEruptionVfx } from '@/game/feel/onHit';

describe('spawnRelicEruptionVfx', () => {
  it('creates a two-stage crystal burst and three staggered shock fronts', () => {
    const world = new World<Entity>();
    spawnRelicEruptionVfx(world, [2, 3, 4]);

    const effects = [...world.with('impactFx')].map((entity) => entity.impactFx);
    const sparks = effects.filter((effect) => effect.kind === 'spark');
    const rings = effects.filter((effect) => effect.kind === 'ring');

    expect(sparks).toHaveLength(2);
    expect(rings).toHaveLength(3);
    expect(sparks.map((effect) => effect.radius)).toEqual([2.8, 5.4]);
    expect(rings.map((effect) => effect.radius)).toEqual([3.2, 5.2, 7.4]);
    expect(rings[1]!.spawnedAtReal).toBeGreaterThan(rings[0]!.spawnedAtReal);
    expect(rings[2]!.spawnedAtReal).toBeGreaterThan(rings[1]!.spawnedAtReal);
    expect([...world.with('impactFx', 'transform')][0]!.transform.position).toEqual([2, 3.85, 4]);
  });
});
