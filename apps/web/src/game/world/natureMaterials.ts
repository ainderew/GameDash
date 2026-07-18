import { Color, MeshStandardMaterial } from 'three';
import type { Material, Texture } from 'three';

const cache = new WeakMap<Material, Material>();
const rockCache = new WeakMap<Material, Material>();
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

const tuneRock = (source: Material): Material => {
  const cached = rockCache.get(source);
  if (cached) return cached;
  const material = source.clone();
  if (material instanceof MeshStandardMaterial) {
    material.roughness = Math.min(0.82, Math.max(0.68, material.roughness));
    material.metalness = 0;
    material.envMapIntensity = 1.15;
    material.color.multiply(new Color('#c3c7d2'));
    // A restrained cool lift keeps the foreground stone readable under moonlight
    // without making it appear self-lit.
    material.emissive.set('#20212a');
    material.emissiveIntensity = 0.07;
    tuneTexture(material.map);
    tuneTexture(material.normalMap);
    tuneTexture(material.roughnessMap);
  }
  rockCache.set(source, material);
  return material;
};

/** Slightly brighter, more reflective stone response than bark/foliage materials. */
export const enhanceRockMaterial = (source: Material | Material[]): Material | Material[] =>
  Array.isArray(source) ? source.map(tuneRock) : tuneRock(source);
