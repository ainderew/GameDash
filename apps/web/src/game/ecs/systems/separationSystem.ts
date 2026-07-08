import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';

/**
 * Resolve circle overlaps in the XZ plane so monsters don't stack on the player
 * or merge into each other. The player is authoritative — monsters are pushed out
 * of the player fully; monster-vs-monster overlaps split the correction in half.
 *
 * Pure over (world) apart from mutating positions; O(n²) over monsters (n ≤ cap).
 */
export const separationSystem = (world: World<Entity>): void => {
  const player = world.with('playerControlled', 'transform').first;
  const monsters = [...world.with('monster', 'transform')];

  // Monster vs player: push the monster out.
  if (player?.transform) {
    const pr = player.radius ?? 0.4;
    const pp = player.transform.position;
    for (const m of monsters) {
      const mr = m.radius ?? 0.5;
      const mp = m.transform.position;
      const dx = mp[0] - pp[0];
      const dz = mp[2] - pp[2];
      const minDist = pr + mr;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist || distSq === 0) continue;
      const dist = Math.sqrt(distSq) || 1e-4;
      const push = (minDist - dist) / dist;
      mp[0] += dx * push;
      mp[2] += dz * push;
    }
  }

  // Monster vs monster: split the correction.
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i];
    if (!a?.transform) continue;
    const ar = a.radius ?? 0.5;
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j];
      if (!b?.transform) continue;
      const br = b.radius ?? 0.5;
      const dx = b.transform.position[0] - a.transform.position[0];
      const dz = b.transform.position[2] - a.transform.position[2];
      const minDist = ar + br;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist || distSq === 0) continue;
      const dist = Math.sqrt(distSq) || 1e-4;
      const half = ((minDist - dist) / dist) * 0.5;
      a.transform.position[0] -= dx * half;
      a.transform.position[2] -= dz * half;
      b.transform.position[0] += dx * half;
      b.transform.position[2] += dz * half;
    }
  }
};
