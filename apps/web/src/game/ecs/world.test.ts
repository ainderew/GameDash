import { afterEach, describe, expect, it } from 'vitest';
import { monsters, projectiles, world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';

const added: Entity[] = [];

afterEach(() => {
  for (const entity of added.splice(0)) world.remove(entity);
});

describe('client render queries', () => {
  it('include snapshot-driven monsters and projectiles without local simulation components', () => {
    const monster = world.add({
      transform: { position: [0, 0, 0], rotationY: 0 },
      health: { current: 10, max: 10 },
      monster: 'chaser',
      faction: 'monster',
    });
    const projectile = world.add({
      transform: { position: [1, 0, 0], rotationY: 0 },
      projectile: true,
      faction: 'monster',
    });
    added.push(monster, projectile);

    expect([...monsters]).toContain(monster);
    expect([...projectiles]).toContain(projectile);
    expect(monster.aiBrain).toBeUndefined();
    expect(projectile.velocity).toBeUndefined();
  });
});
