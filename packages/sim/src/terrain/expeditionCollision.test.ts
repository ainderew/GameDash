import { describe, expect, it } from 'vitest';
import type { Entity } from '../components';
import { resolveExpeditionRuinCollisions } from './expeditionCollision';
import { EXPEDITION_RUIN_COLLIDERS } from './expeditionRuins';

const actorAt = (x: number, z: number): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  radius: 0.45,
});

describe('resolveExpeditionRuinCollisions', () => {
  it('pushes actors out of the authored wall footprint', () => {
    const wall = EXPEDITION_RUIN_COLLIDERS.find((item) => item.id === 'west-wall-run')!;
    const actor = actorAt(wall.position[0], wall.position[1]);
    resolveExpeditionRuinCollisions(actor);
    expect(actor.transform!.position).not.toEqual([wall.position[0], 0, wall.position[1]]);
  });

  it('leaves the broken arch opening traversable', () => {
    const actor = actorAt(-8.25, -18.15);
    resolveExpeditionRuinCollisions(actor);
    expect(actor.transform!.position).toEqual([-8.25, 0, -18.15]);
  });

  it('leaves the central expedition combat lane clear', () => {
    const actor = actorAt(0, -10);
    resolveExpeditionRuinCollisions(actor);
    expect(actor.transform!.position).toEqual([0, 0, -10]);
  });
});
