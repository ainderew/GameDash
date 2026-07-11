import type { World } from 'miniplex';
import type { Entity } from '../components';
import { BODY_TUNING } from '@shared/balance';

/**
 * SOLID BODY COLLISION — resolve circle overlaps in the XZ plane so the player and monsters
 * push each other apart and NEVER interpenetrate, and cancel the velocity component pushing
 * them together so contact feels solid instead of jittery/mushy.
 *
 * The player is authoritative — monsters are pushed fully out of the player; monster-vs-
 * monster overlaps split the correction. After each positional fix we kill the *closing*
 * velocity along the contact normal (the part driving them into each other), leaving any
 * separating motion (e.g. knockback) untouched.
 *
 * Pure over (world) apart from mutating positions/velocities; O(n²) over monsters (n ≤ cap).
 */

/** Remove the inward (closing) component of `e`'s XZ velocity along outward normal (nx,nz). */
const cancelClosing = (e: Entity, nx: number, nz: number): void => {
  const v = e.velocity;
  if (!v) return;
  const vn = v.linear[0] * nx + v.linear[2] * nz;
  if (vn < 0) {
    v.linear[0] -= vn * nx;
    v.linear[2] -= vn * nz;
  }
};

export const separationSystem = (world: World<Entity>): void => {
  const scale = BODY_TUNING.radiusScale;
  const monsters = [...world.with('monster', 'transform')];

  // Monster vs player: push the monster out and stop it grinding into the player.
  // Every player-controlled entity is authoritative over monsters, not just ours.
  for (const player of world.with('playerControlled', 'transform')) {
    const pr = (player.radius ?? 0.4) * scale;
    const pp = player.transform.position;
    for (const m of monsters) {
      const mr = (m.radius ?? 0.5) * scale;
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
      // Normal points from player → monster; cancel the monster's motion back into it.
      cancelClosing(m, dx / dist, dz / dist);
    }
  }

  // Monster vs monster: split the correction and kill both closing components.
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i];
    if (!a?.transform) continue;
    const ar = (a.radius ?? 0.5) * scale;
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j];
      if (!b?.transform) continue;
      const br = (b.radius ?? 0.5) * scale;
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
      const nx = dx / dist;
      const nz = dz / dist;
      cancelClosing(b, nx, nz); // b's outward normal is +n
      cancelClosing(a, -nx, -nz); // a's outward normal is −n
    }
  }
};
