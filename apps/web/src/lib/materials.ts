import type { MeshStandardMaterial, Object3D } from 'three';

/**
 * Tripo GLB exports bake `metallicFactor: 0.4` into every material (hero, druid, mutant).
 * These are cloth/skin/leather characters and the scene has no environment map, so that
 * metalness only blackens the diffuse response — metals reflect the environment, and with
 * none they reflect black. Zero it so characters take the full key + ambient lighting.
 */
export const deMetalize = (root: Object3D): void => {
  root.traverse((child) => {
    const mesh = child as { isMesh?: boolean; material?: unknown };
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as MeshStandardMaterial[]) {
      if (m?.isMeshStandardMaterial) m.metalness = 0;
    }
  });
};
