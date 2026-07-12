import { describe, expect, it } from 'vitest';
import { CollisionField, CollisionLayer, type CircleObstacle } from './collisionField';

const obstacle = (x: number, z: number, radius: number, layer = CollisionLayer.OBSTACLE): CircleObstacle => ({
  x,
  z,
  radius,
  layer,
});

describe('CollisionField', () => {
  it('pushes a circle out to exactly touch a single obstacle', () => {
    const field = new CollisionField([obstacle(0, 0, 1)]);
    const [x, z] = field.resolveCircle(0.2, 0, 0.5); // deep inside
    // Ends on the surface: distance from centre === obstacle.radius + body.radius.
    expect(Math.hypot(x, z)).toBeCloseTo(1.5, 5);
  });

  it('leaves a circle clear of all obstacles untouched', () => {
    const field = new CollisionField([obstacle(0, 0, 1)]);
    const [x, z] = field.resolveCircle(10, 10, 0.5);
    expect([x, z]).toEqual([10, 10]);
  });

  it('resolves a body wedged between two rocks so it overlaps neither', () => {
    const field = new CollisionField([obstacle(-1, 0, 1), obstacle(1, 0, 1)]);
    const [x, z] = field.resolveCircle(0, 0.1, 0.5);
    expect(field.overlaps(x, z, 0.5)).toBe(false);
  });

  it('ignores obstacles outside the query mask', () => {
    const field = new CollisionField([obstacle(0, 0, 1, CollisionLayer.MONSTER)]);
    // A body that only collides with OBSTACLE passes straight through a MONSTER-layer collider.
    const [x, z] = field.resolveCircle(0.2, 0, 0.5, CollisionLayer.OBSTACLE);
    expect([x, z]).toEqual([0.2, 0]);
    // The same field DOES block a body whose mask includes MONSTER.
    const [mx, mz] = field.resolveCircle(0.2, 0, 0.5, CollisionLayer.MONSTER);
    expect(Math.hypot(mx, mz)).toBeCloseTo(1.5, 5);
  });

  it('handles an exact-centre overlap deterministically (no NaN)', () => {
    const field = new CollisionField([obstacle(0, 0, 1)]);
    const [x, z] = field.resolveCircle(0, 0, 0.5);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(z)).toBe(true);
    expect(Math.hypot(x, z)).toBeCloseTo(1.5, 5);
  });

  it('spatial hash agrees with brute force across many obstacles and cell sizes', () => {
    // Build a big grid of rocks; the hashed resolve must equal a naive O(n) resolve.
    const obstacles: CircleObstacle[] = [];
    for (let gx = -20; gx <= 20; gx++) {
      for (let gz = -20; gz <= 20; gz++) {
        obstacles.push(obstacle(gx * 3, gz * 3, 0.8));
      }
    }
    const bruteResolve = (px: number, pz: number, r: number): [number, number] => {
      let x = px;
      let z = pz;
      for (let pass = 0; pass < 3; pass++) {
        for (const o of obstacles) {
          const dx = x - o.x;
          const dz = z - o.z;
          const min = o.radius + r;
          const d2 = dx * dx + dz * dz;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 1e-6;
          x = o.x + (dx / d) * min;
          z = o.z + (dz / d) * min;
        }
      }
      return [x, z];
    };
    for (const cellSize of [1.5, 4, 9]) {
      const field = new CollisionField(obstacles, cellSize);
      for (const [px, pz] of [
        [0.3, 0.3],
        [3.1, -2.9],
        [-14.7, 5.2],
        [1.5, 1.5],
      ] as const) {
        const hashed = field.resolveCircle(px, pz, 0.45);
        const brute = bruteResolve(px, pz, 0.45);
        expect(hashed[0]).toBeCloseTo(brute[0], 6);
        expect(hashed[1]).toBeCloseTo(brute[1], 6);
      }
    }
  });
});
