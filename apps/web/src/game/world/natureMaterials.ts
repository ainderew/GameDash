import { Color, MeshStandardMaterial } from 'three';
import type { Material, Texture } from 'three';

const cache = new WeakMap<Material, Material>();
const wastelandTint = new Color('#d0d0cf');

const tuneTexture = (texture: Texture | null) => {
  if (!texture) return;
  texture.anisotropy = Math.max(texture.anisotropy, 4);
  texture.needsUpdate = true;
};

const tuneOne = (source: Material): Material => {
  const cached = cache.get(source);
  if (cached) return cached;

  const material = source.clone();
  if (material instanceof MeshStandardMaterial) {
    material.roughness = Math.max(0.76, material.roughness);
    material.metalness = Math.min(0.04, material.metalness);
    material.envMapIntensity = 0.7;
    material.color.multiply(wastelandTint);
    material.emissive.set('#151515');
    material.emissiveIntensity = 0.04;
    tuneTexture(material.map);
    tuneTexture(material.normalMap);
    tuneTexture(material.roughnessMap);
  }
  cache.set(source, material);
  return material;
};

/** Shared, non-destructive material pass for the nature pack's textured meshes. */
export const enhanceNatureMaterial = (source: Material | Material[]): Material | Material[] =>
  Array.isArray(source) ? source.map(tuneOne) : tuneOne(source);
