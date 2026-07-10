import type { Object3D } from 'three';

/** Runtime sockets attached to the currently mounted weapon. Render-only consumers (trail,
 * contact visuals) read these without putting scene objects into ECS state. */
export const weaponSockets: { base: Object3D | null; tip: Object3D | null } = {
  base: null,
  tip: null,
};
