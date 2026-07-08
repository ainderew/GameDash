import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  Object3D,
  IcosahedronGeometry,
  DodecahedronGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  DoubleSide,
} from 'three';
import type { InstancedMesh } from 'three';
import { heightAt } from '@/game/world/Terrain';

/** Deterministic PRNG so the world looks identical every load. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Item {
  x: number;
  z: number;
  y: number;
  rotY: number;
  scale: number;
  color: Color;
}

const dummy = new Object3D();

const applyInstances = (mesh: InstancedMesh | null, items: Item[], withColor: boolean) => {
  if (!mesh) return;
  items.forEach((it, i) => {
    dummy.position.set(it.x, it.y, it.z);
    dummy.rotation.set(0, it.rotY, 0);
    dummy.scale.setScalar(it.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (withColor) mesh.setColorAt(i, it.color);
  });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (withColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
};

/** Scatter a field of `count` items in an annulus [rMin, rMax], avoiding tall hills. */
const scatter = (
  rng: () => number,
  count: number,
  rMin: number,
  rMax: number,
  scaleMin: number,
  scaleMax: number,
  palette: Color[],
  maxHeight = 4,
): Item[] => {
  const items: Item[] = [];
  let guard = 0;
  while (items.length < count && guard < count * 6) {
    guard++;
    const r = rMin + rng() * (rMax - rMin);
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y > maxHeight) continue; // keep off the steep peaks
    items.push({
      x,
      z,
      y,
      rotY: rng() * Math.PI * 2,
      scale: scaleMin + rng() * (scaleMax - scaleMin),
      color: palette[Math.floor(rng() * palette.length)]!.clone(),
    });
  }
  return items;
};

const grassGreens = ['#5c9138', '#6fa843', '#4d7d2f', '#7cb850'].map((c) => new Color(c));
const flowerColors = ['#f4d03f', '#ec7063', '#af7ac5', '#f5f5f5', '#5dade2'].map((c) => new Color(c));
const rockGreys = ['#8d857a', '#9a9186', '#7a7167'].map((c) => new Color(c));

/**
 * A small fan of curved, tapered blades — the unit grass clump (base at y=0).
 * Vertex colours run a grayscale base→tip gradient; each instance's palette
 * colour supplies the hue, so tips read brighter than the shaded base.
 */
const buildGrassTuft = (): BufferGeometry => {
  const H = 0.62;
  const baseHalf = 0.032;
  const SEG = 4;
  const bend = 0.15;
  const BLADES = 3;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vbase = 0;
  for (let b = 0; b < BLADES; b++) {
    const yaw = (b / BLADES) * Math.PI * 2 + b * 0.4;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const y = t * H;
      const z = bend * t * t; // curve the blade forward toward the tip
      const halfW = baseHalf * (1 - t) + 0.002; // taper to a point
      const g = 0.4 + t * 0.72; // grayscale base→tip
      for (const sx of [-halfW, halfW]) {
        positions.push(sx * cos - z * sin, y, sx * sin + z * cos);
        normals.push(0, 1, 0); // up-normals → soft, uniform stylized lighting
        colors.push(g, g, g);
      }
    }
    for (let i = 0; i < SEG; i++) {
      const a = vbase + i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    vbase += (SEG + 1) * 2;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
};

type UniformBag = { uniforms: Record<string, { value: number }> };

/**
 * Grass material that bends each blade toward its tip on a wind loop — a vertex
 * shader injection, so all instances animate on the GPU (no per-frame matrices).
 * Returns a `getShader` handle so the caller can drive `uTime` from useFrame.
 */
const makeGrassMaterial = (): { material: MeshStandardMaterial; getShader: () => UniformBag | null } => {
  let captured: UniformBag | null = null;
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, side: DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.vertexShader =
      'uniform float uTime;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float bladeH = position.y;
         float phase = instanceMatrix[3][0] * 0.6 + instanceMatrix[3][2] * 0.55;
         transformed.x += sin(uTime * 1.6 + phase) * 0.13 * bladeH;
         transformed.z += cos(uTime * 1.25 + phase) * 0.07 * bladeH;`,
      );
    captured = shader as unknown as UniformBag;
  };
  return { material, getShader: () => captured };
};

/** Ground vegetation + rocks, instanced (a handful of draw calls total). Trees live in Trees.tsx. */
export const Scatter = () => {
  const grassRef = useRef<InstancedMesh>(null);
  const flowerRef = useRef<InstancedMesh>(null);
  const rockRef = useRef<InstancedMesh>(null);

  const { grass, flowers, rocks } = useMemo(() => {
    const rng = mulberry32(20260708);
    return {
      grass: scatter(rng, 2000, 3, 68, 0.5, 1.3, grassGreens, 5),
      flowers: scatter(rng, 300, 4, 45, 0.5, 1.0, flowerColors, 3),
      rocks: scatter(rng, 70, 6, 80, 0.4, 2.6, rockGreys, 6),
    };
  }, []);

  const grassGeo = useMemo(buildGrassTuft, []);
  const grassMat = useMemo(makeGrassMaterial, []);

  // Geometries with baked vertical offsets so bases sit on the ground.
  const geos = useMemo(() => {
    const flowerGeo = new IcosahedronGeometry(0.13, 0);
    flowerGeo.translate(0, 0.4, 0);
    const rockGeo = new DodecahedronGeometry(0.6, 0);
    return { flowerGeo, rockGeo };
  }, []);

  useLayoutEffect(() => {
    applyInstances(grassRef.current, grass, true);
    applyInstances(flowerRef.current, flowers, true);
    applyInstances(rockRef.current, rocks, true);
  }, [grass, flowers, rocks]);

  // Drive the wind loop.
  useFrame((state) => {
    const uTime = grassMat.getShader()?.uniforms.uTime;
    if (uTime) uTime.value = state.clock.elapsedTime;
  });

  return (
    <group>
      {/* Grass does NOT cast shadows — 2k shadow-casters tanks the shadow pass. */}
      <instancedMesh ref={grassRef} args={[grassGeo, grassMat.material, grass.length]} />

      <instancedMesh ref={flowerRef} args={[geos.flowerGeo, undefined, flowers.length]}>
        <meshStandardMaterial roughness={0.6} />
      </instancedMesh>

      <instancedMesh
        ref={rockRef}
        args={[geos.rockGeo, undefined, rocks.length]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial roughness={0.9} flatShading />
      </instancedMesh>
    </group>
  );
};
