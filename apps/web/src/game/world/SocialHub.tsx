import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Box3,
  CanvasTexture,
  CircleGeometry,
  Color,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { BufferGeometry, Group, Mesh, Object3D as Object3DType, PointLight, Sprite } from 'three';
import { players } from '@/game/ecs/world';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { useGameModel } from '@/lib/loaders';
import { useUIStore } from '@/ui/store';
import { HUB_LANDMARK_POSITIONS, HUB_SPAWN, nearestHubStation, type HubStationId } from '@/game/world/hubLayout';
import { Terrain } from '@/game/world/Terrain';
import { GrassField } from '@/game/world/GrassField';
import { Trees } from '@/game/world/Trees';
import { Scatter } from '@/game/world/Scatter';
import { HUB_SCATTER_CLEAR } from '@sim/terrain/hubObstacles';
import { SpireBackdrop } from '@/game/world/SpireBackdrop';
import { SummoningShrineRelic } from '@/game/world/SummoningShrineRelic';
import { ExpeditionPortalVFX } from '@/game/world/ExpeditionPortalVFX';
import { CampfireVFX } from '@/game/world/CampfireVFX';
import { HubCrystalClusters } from '@/game/world/CrystalClusters';

interface Props {
  obstacles: React.MutableRefObject<Object3DType[]>;
}

const MODEL_PATHS = {
  lodge: '/models/hub/rest_house.glb',
  shrine: '/models/hub/summoning-shrine.glb',
  gate: '/models/hub/expedition-gate.glb',
  curvedLamp: '/models/hub/lamp_1.glb',
  straightLamp: '/models/hub/lamp_2.glb',
  campfire: '/models/hub/campfire.glb',
  bench: '/models/hub/bench.glb',
  banner: '/models/hub/banner.glb',
} as const;

const createLanternHaloTexture = () => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.38, 'rgba(255,255,255,0.34)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.08)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
};

/** A visible HDR flame/core plus a soft additive halo and localized inverse-square light. */
const VioletLanternGlow = ({
  position,
  size = 1,
  intensity = 3.5,
  phase = 0,
}: {
  position: [number, number, number];
  size?: number;
  intensity?: number;
  phase?: number;
}) => {
  const light = useRef<PointLight>(null);
  const halo = useRef<Sprite>(null);
  const { haloTexture, haloMaterial, coreMaterial } = useMemo(() => {
    const haloTexture = createLanternHaloTexture();
    const haloMaterial = new SpriteMaterial({
      map: haloTexture,
      color: new Color('#a84dff').multiplyScalar(2.35),
      transparent: true,
      opacity: 0.58,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const coreMaterial = new MeshBasicMaterial({
      color: new Color('#d9a0ff').multiplyScalar(4.2),
      toneMapped: false,
    });
    return { haloTexture, haloMaterial, coreMaterial };
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    const flicker = 0.96 + Math.sin(t * 7.1) * 0.025 + Math.sin(t * 13.7 + 1.3) * 0.014;
    if (light.current) light.current.intensity = intensity * flicker;
    if (halo.current) halo.current.scale.set(size * flicker, size * flicker, 1);
    haloMaterial.opacity = 0.54 + Math.sin(t * 5.3) * 0.035;
  });

  useEffect(
    () => () => {
      haloTexture.dispose();
      haloMaterial.dispose();
      coreMaterial.dispose();
    },
    [coreMaterial, haloMaterial, haloTexture],
  );

  return (
    <group position={position}>
      <sprite ref={halo} material={haloMaterial} scale={[size, size, 1]} renderOrder={3} />
      <mesh material={coreMaterial}>
        <sphereGeometry args={[size * 0.055, 12, 8]} />
      </mesh>
      <pointLight ref={light} color="#a95cff" intensity={intensity} distance={size * 5.2} decay={2} />
    </group>
  );
};

interface HubModelProps {
  path: string;
  targetHeight?: number;
  targetWidth?: number;
  /** Normalize by the model's longest horizontal axis; ideal for props whose authored
   * long axis may be X or Z (benches, tables, fences). */
  targetSpan?: number;
  position: [number, number, number];
  rotationY?: number;
  /** Corrects a model's authored front axis after applying gameplay-facing rotation. */
  faceOffset?: number;
  /** Flow the mesh like wind-blown cloth (banners): top-anchored GPU vertex displacement. */
  wind?: boolean;
}

/**
 * Injects a cloth-wind displacement into a MeshStandardMaterial's vertex stage (keeps the
 * banner's own texture/lighting). The cloth is pinned at the top edge and billows freest at
 * the bottom; a slow two-tone gust envelope makes wind surge through "from time to time"
 * over a steady breeze. Driven by `userData.shader.uniforms.uTime`, ticked in HubModel.
 */
const applyBannerWind = (material: MeshStandardMaterial, geometry: BufferGeometry) => {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const [minY, maxY, minZ, maxZ] = [bb.min.y, bb.max.y, bb.min.z, bb.max.z];
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uMinY = { value: minY };
    shader.uniforms.uMaxY = { value: maxY };
    shader.uniforms.uMinZ = { value: minZ };
    shader.uniforms.uMaxZ = { value: maxZ };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uMinY;
        uniform float uMaxY;
        uniform float uMinZ;
        uniform float uMaxZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float hy = clamp((uMaxY - transformed.y) / max(uMaxY - uMinY, 1e-4), 0.0, 1.0); // 0 top → 1 bottom
          float hz = clamp((transformed.z - uMinZ) / max(uMaxZ - uMinZ, 1e-4), 0.0, 1.0); // 0..1 across width
          // The cloth is a membrane suspended inside a RIGID frame: a top bar (hy < ~0.16), a
          // ground-planted base (hy > ~0.9) and two vertical side rails near the Z edges. Pin
          // all four frame edges to zero displacement and only billow the interior membrane, so
          // the pole/frame stays dead straight and planted while the cloth breathes.
          float vert  = smoothstep(0.16, 0.34, hy) * (1.0 - smoothstep(0.80, 0.92, hy));
          float horiz = smoothstep(0.14, 0.30, hz) * (1.0 - smoothstep(0.70, 0.86, hz));
          float amp = vert * horiz;
          // Two detuned oscillators: a steady breeze with occasional aligned surges (gusts).
          float g = sin(uTime * 0.53) + sin(uTime * 0.27 + 2.1);
          float gust = 0.55 + smoothstep(0.55, 1.85, g) * 1.7;
          // Layered ripples travelling across the membrane.
          float p = uTime * 2.4;
          float wave = sin(p + transformed.z * 9.0 + transformed.y * 3.5) * 0.6
                     + sin(p * 1.7 + transformed.z * 17.0 - transformed.y * 6.0) * 0.28
                     + sin(p * 2.9 + hz * 22.0) * 0.14;
          float disp = wave * amp * gust * 0.16;
          transformed.x += disp;              // billow perpendicular to the cloth face
          transformed.z += disp * 0.06;
        }`,
      );
    material.userData.shader = shader;
  };
  // Distinct cache key so these share one compiled program without colliding with plain
  // MeshStandardMaterials; per-material uniforms keep each banner independent.
  material.customProgramCacheKey = () => 'banner-wind';
  material.needsUpdate = true;
};

/** Normalizes arbitrary Tripo export scale/pivot while preserving the authored proportions. */
const HubModel = ({ path, targetHeight, targetWidth, targetSpan, position, rotationY = 0, faceOffset = 0, wind = false }: HubModelProps) => {
  const gltf = useGameModel(path);
  const { object, scale, offset, windMaterials } = useMemo(() => {
    const clone = gltf.scene.clone(true);
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const s = targetSpan
      ? targetSpan / Math.max(size.x, size.z, 0.001)
      : targetWidth
        ? targetWidth / Math.max(size.x, 0.001)
        : (targetHeight ?? 1) / Math.max(size.y, 0.001);

    const windMaterials: MeshStandardMaterial[] = [];
    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const multipleMaterials = Array.isArray(mesh.material);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const clonedMaterials = materials.map((source) => {
        const material = source.clone() as MeshStandardMaterial;
        if (material.isMeshStandardMaterial) {
          material.roughness = Math.max(0.55, material.roughness);
          material.envMapIntensity = 0.35;
        }
        if (wind && material.isMeshStandardMaterial) {
          applyBannerWind(material, mesh.geometry as BufferGeometry);
          windMaterials.push(material);
        }
        return material;
      });
      mesh.material = multipleMaterials ? clonedMaterials : clonedMaterials[0]!;
    });

    return {
      object: clone,
      scale: s,
      offset: [-center.x * s, -box.min.y * s, -center.z * s] as [number, number, number],
      windMaterials,
    };
  }, [gltf.scene, targetHeight, targetSpan, targetWidth, wind]);

  // Per-instance phase so multiple banners don't ripple in lockstep. Cheap, position is stable.
  const windPhase = position[0] * 1.3 + position[2] * 0.7;
  useFrame(({ clock }) => {
    if (windMaterials.length === 0) return;
    const t = clock.elapsedTime + windPhase;
    for (const material of windMaterials) {
      const shader = (material.userData as { shader?: { uniforms: { uTime: { value: number } } } }).shader;
      if (shader) shader.uniforms.uTime.value = t;
    }
  });

  return (
    <group position={position} rotation={[0, rotationY + faceOffset, 0]}>
      <primitive object={object} scale={scale} position={offset} />
    </group>
  );
};

/** Deterministic PRNG so the plaza paving is identical every session. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Converts a blurred height canvas into a tangent-space normal map via central differences. */
const heightToNormal = (heightCanvas: HTMLCanvasElement, strength: number) => {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d')!.getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const outCtx = out.getContext('2d')!;
  const img = outCtx.createImageData(size, size);
  const heightAt = (x: number, y: number) => src[(((y + size) % size) * size + ((x + size) % size)) * 4]! / 255;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
      const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  outCtx.putImageData(img, 0, 0);
  return out;
};

/**
 * Paints concentric rings of cobblestones — albedo plus a height-derived normal map so the
 * stones catch light like real rock. Irregular silhouettes, per-stone shading, mottled noise
 * and grout moss keep it from reading as a uniform pattern.
 */
const createCobblestoneMaps = () => {
  const size = 2048;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const a = albedo.getContext('2d')!;
  const heightCanvas = document.createElement('canvas');
  heightCanvas.width = size;
  heightCanvas.height = size;
  const h = heightCanvas.getContext('2d')!;
  const roughnessCanvas = document.createElement('canvas');
  roughnessCanvas.width = size;
  roughnessCanvas.height = size;
  const rough = roughnessCanvas.getContext('2d')!;
  const aoCanvas = document.createElement('canvas');
  aoCanvas.width = size;
  aoCanvas.height = size;
  const ao = aoCanvas.getContext('2d')!;
  const rand = mulberry32(20260711);
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size / 2;
  const grout = 9;

  // Grout base — recessed dark mortar in color, low in the height field.
  a.fillStyle = '#211c31';
  a.fillRect(0, 0, size, size);
  h.fillStyle = '#333333';
  h.fillRect(0, 0, size, size);
  rough.fillStyle = '#eeeeee';
  rough.fillRect(0, 0, size, size);
  ao.fillStyle = '#5c5c5c';
  ao.fillRect(0, 0, size, size);

  // Slightly irregular ring boundaries so the pattern doesn't feel machined.
  const rings = 8;
  const radii = [0];
  for (let i = 1; i < rings; i += 1) radii.push((i / rings) * maxRadius * (1 + (rand() - 0.5) * 0.03));
  radii.push(maxRadius);

  const stones: { path: Path2D; px: number; py: number; r: number }[] = [];
  const corners: { x: number; y: number; ring: number }[] = [];

  const buildStone = (ring: number, a0: number, a1: number, r0: number, r1: number) => {
    const path = new Path2D();
    const jitter = grout * 0.55;
    const steps = 5;
    if (ring === 0) {
      // Hearthstone: irregular round slab under the campfire.
      const blob = Array.from({ length: 16 }, () => (rand() - 0.5) * jitter * 2);
      for (let i = 0; i <= 16; i += 1) {
        const angle = (i / 16) * Math.PI * 2;
        const radius = r1 - grout + blob[i % 16]!;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      return path;
    }
    const gapInner = (grout * 0.5) / Math.max(r0, 1);
    const gapOuter = (grout * 0.5) / Math.max(r1, 1);
    for (let i = 0; i <= steps; i += 1) {
      const angle = a0 + gapOuter + ((a1 - a0 - gapOuter * 2) * i) / steps + ((rand() - 0.5) * jitter) / r1;
      const radius = r1 - grout * 0.5 + (rand() - 0.5) * jitter;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i -= 1) {
      const angle = a0 + gapInner + ((a1 - a0 - gapInner * 2) * i) / steps + ((rand() - 0.5) * jitter) / Math.max(r0, 40);
      const radius = r0 + grout * 0.5 + (rand() - 0.5) * jitter;
      path.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
    path.closePath();
    return path;
  };

  for (let ring = 0; ring < rings; ring += 1) {
    const r0 = radii[ring]!;
    const r1 = radii[ring + 1]!;
    const rMid = (r0 + r1) / 2;
    const segments = ring === 0 ? 1 : Math.max(7, Math.round((Math.PI * 2 * rMid) / ((r1 - r0) * 1.25)));
    const angleStep = (Math.PI * 2) / segments;
    const startOffset = rand() * Math.PI * 2;

    for (let s = 0; s < segments; s += 1) {
      const a0 = startOffset + s * angleStep;
      const a1 = a0 + angleStep;
      const path = buildStone(ring, a0, a1, r0, r1);
      const aMid = (a0 + a1) / 2;
      const px = ring === 0 ? cx : cx + Math.cos(aMid) * rMid;
      const py = ring === 0 ? cy : cy + Math.sin(aMid) * rMid;
      const stoneR = ring === 0 ? r1 : Math.max((r1 - r0) / 2, (rMid * angleStep) / 2);
      stones.push({ path, px, py, r: stoneR });
      if (ring > 0) corners.push({ x: cx + Math.cos(a0) * r0, y: cy + Math.sin(a0) * r0, ring });

      // Four related slate families create coherent variance without rainbow patchwork.
      const family = Math.floor(rand() * 4);
      const hue = [220, 228, 239, 252][family]! + (rand() - 0.5) * 7;
      const sat = [10, 13, 16, 18][family]! + rand() * 5;
      const lit = [34, 39, 43, 36][family]! + (rand() - 0.5) * 8;
      // Centered wear gradient contains no baked light direction; scene lights relight it.
      const grad = a.createRadialGradient(px, py, stoneR * 0.08, px, py, stoneR * 1.45);
      grad.addColorStop(0, `hsl(${hue} ${sat}% ${lit + 5}%)`);
      grad.addColorStop(0.68, `hsl(${hue} ${sat}% ${lit}%)`);
      grad.addColorStop(1, `hsl(${hue} ${sat}% ${lit - 8}%)`);
      a.fillStyle = grad;
      a.fill(path);

      // Worn centers are smoother; chipped edges and grout remain rough. AO darkens the
      // slab perimeter independently of albedo so crevices survive different lighting.
      const roughBase = 164 + rand() * 42;
      const roughGrad = rough.createRadialGradient(px, py, 0, px, py, stoneR * 1.25);
      roughGrad.addColorStop(0, `rgb(${Math.max(125, roughBase - 24)},${Math.max(125, roughBase - 24)},${Math.max(125, roughBase - 24)})`);
      roughGrad.addColorStop(0.7, `rgb(${roughBase},${roughBase},${roughBase})`);
      roughGrad.addColorStop(1, `rgb(${Math.min(245, roughBase + 38)},${Math.min(245, roughBase + 38)},${Math.min(245, roughBase + 38)})`);
      rough.fillStyle = roughGrad;
      rough.fill(path);
      const aoValue = 218 + rand() * 26;
      ao.fillStyle = `rgb(${aoValue},${aoValue},${aoValue})`;
      ao.fill(path);
      ao.strokeStyle = 'rgba(35,35,35,0.72)';
      ao.lineWidth = 13;
      ao.stroke(path);

      // Bevel: offset strokes clipped to the stone read as a lit top edge + shadowed base.
      a.save();
      a.clip(path);
      a.lineWidth = 7;
      a.strokeStyle = 'rgba(10,9,20,0.44)';
      a.translate(-3, -3);
      a.stroke(path);
      a.strokeStyle = 'rgba(195,185,235,0.14)';
      a.translate(6, 6);
      a.stroke(path);
      a.translate(-3, -3);
      // Weathering blotches so no two stones share a surface.
      for (let b = 0; b < 3; b += 1) {
        const bx = px + (rand() - 0.5) * stoneR * 1.4;
        const by = py + (rand() - 0.5) * stoneR * 1.4;
        a.fillStyle = rand() > 0.45 ? `rgba(17,14,30,${0.05 + rand() * 0.08})` : `rgba(196,184,231,${0.04 + rand() * 0.06})`;
        a.beginPath();
        a.ellipse(bx, by, stoneR * (0.2 + rand() * 0.4), stoneR * (0.15 + rand() * 0.3), rand() * Math.PI, 0, Math.PI * 2);
        a.fill();
      }
      a.restore();

      // A few coherent chips affect color, height, roughness and cavity together.
      const chips = 2 + Math.floor(rand() * 5);
      for (const ctx of [a, h, rough, ao]) {
        ctx.save();
        ctx.clip(path);
      }
      for (let chip = 0; chip < chips; chip += 1) {
        const angle = rand() * Math.PI * 2;
        const radius = stoneR * (0.25 + rand() * 0.68);
        const chipX = px + Math.cos(angle) * radius;
        const chipY = py + Math.sin(angle) * radius;
        const chipR = 2.5 + rand() * 8;
        const chipRx = chipR * (1.1 + rand() * 0.7);
        const chipRot = rand() * Math.PI;
        a.fillStyle = `rgba(9,10,20,${0.16 + rand() * 0.18})`;
        h.fillStyle = `rgba(0,0,0,${0.18 + rand() * 0.2})`;
        rough.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.25})`;
        ao.fillStyle = `rgba(25,25,25,${0.22 + rand() * 0.26})`;
        for (const ctx of [a, h, rough, ao]) {
          ctx.beginPath();
          ctx.ellipse(chipX, chipY, chipRx, chipR, chipRot, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const ctx of [a, h, rough, ao]) ctx.restore();

      // Height: each stone is a raised, gently domed slab with its own elevation.
      const elevation = 150 + rand() * 72;
      h.fillStyle = `rgb(${elevation},${elevation},${elevation})`;
      h.fill(path);
      const dome = h.createRadialGradient(px, py, 0, px, py, stoneR * 1.35);
      dome.addColorStop(0, 'rgba(255,255,255,0.30)');
      dome.addColorStop(1, 'rgba(0,0,0,0.22)');
      h.save();
      h.clip(path);
      h.fillStyle = dome;
      h.fill(path);
      h.restore();
    }
  }

  // Cracks across a handful of stones — into both color and height so they relight.
  for (let i = 0; i < 16; i += 1) {
    const stone = stones[Math.floor(rand() * stones.length)]!;
    const angle = rand() * Math.PI * 2;
    for (const [ctx2, style, width] of [
      [a, 'rgba(9,8,18,0.48)', 2.5],
      [h, 'rgba(0,0,0,0.5)', 3],
      [rough, 'rgba(255,255,255,0.42)', 3.5],
      [ao, 'rgba(20,20,20,0.55)', 4],
    ] as const) {
      ctx2.save();
      ctx2.clip(stone.path);
      ctx2.strokeStyle = style;
      ctx2.lineWidth = width;
      ctx2.beginPath();
      let x = stone.px - Math.cos(angle) * stone.r;
      let y = stone.py - Math.sin(angle) * stone.r;
      ctx2.moveTo(x, y);
      for (let seg = 0; seg < 4; seg += 1) {
        x += Math.cos(angle) * stone.r * 0.55 + (rand() - 0.5) * stone.r * 0.4;
        y += Math.sin(angle) * stone.r * 0.55 + (rand() - 0.5) * stone.r * 0.4;
        ctx2.lineTo(x, y);
      }
      ctx2.stroke();
      ctx2.restore();
    }
  }

  // Mottle: layered value noise breaks up every flat fill (stones and grout alike).
  const noisePass = (cells: number, alpha: number, mode: GlobalCompositeOperation, target: CanvasRenderingContext2D) => {
    const n = document.createElement('canvas');
    n.width = cells;
    n.height = cells;
    const nCtx = n.getContext('2d')!;
    const img = nCtx.createImageData(cells, cells);
    for (let i = 0; i < cells * cells; i += 1) {
      const v = Math.floor(rand() * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    nCtx.putImageData(img, 0, 0);
    target.globalAlpha = alpha;
    target.globalCompositeOperation = mode;
    target.imageSmoothingEnabled = true;
    target.drawImage(n, 0, 0, size, size);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
  };
  noisePass(48, 0.16, 'overlay', a);
  noisePass(200, 0.13, 'overlay', a);
  noisePass(900, 0.1, 'soft-light', a);
  noisePass(700, 0.12, 'overlay', h);
  noisePass(170, 0.08, 'soft-light', rough);
  noisePass(90, 0.06, 'soft-light', ao);

  // Moss: clustered growth out of grout junctions, denser toward the rim.
  const mossClump = (x: number, y: number, scale: number) => {
    const blobs = 5 + Math.floor(rand() * 8);
    for (let b = 0; b < blobs; b += 1) {
      const bx = x + (rand() - 0.5) * 26 * scale;
      const by = y + (rand() - 0.5) * 26 * scale;
      const hue = 262 + rand() * 34;
      const rx = (3 + rand() * 9) * scale;
      const ry = (2 + rand() * 6) * scale;
      const rot = rand() * Math.PI;
      a.fillStyle = `hsla(${hue}, ${42 + rand() * 24}%, ${30 + rand() * 16}%, ${0.24 + rand() * 0.32})`;
      a.beginPath();
      a.ellipse(bx, by, rx, ry, rot, 0, Math.PI * 2);
      a.fill();
      rough.fillStyle = 'rgba(90,90,90,0.38)';
      rough.beginPath();
      rough.ellipse(bx, by, rx, ry, rot, 0, Math.PI * 2);
      rough.fill();
      ao.fillStyle = 'rgba(35,35,35,0.25)';
      ao.beginPath();
      ao.ellipse(bx, by, rx, ry, rot, 0, Math.PI * 2);
      ao.fill();
    }
  };
  for (const corner of corners) {
    if (rand() < 0.07 + 0.16 * (corner.ring / rings)) mossClump(corner.x, corner.y, 0.8 + rand() * 0.9);
  }
  for (let i = 0; i < 18; i += 1) {
    const angle = rand() * Math.PI * 2;
    const radius = maxRadius * (0.9 + rand() * 0.08);
    mossClump(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0.9 + rand() * 1.1);
  }

  // Rim vignette anchors the circle into the dirt.
  const vignette = a.createRadialGradient(cx, cy, maxRadius * 0.72, cx, cy, maxRadius);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(8,8,20,0.3)');
  a.fillStyle = vignette;
  a.fillRect(0, 0, size, size);

  // Soften the height field before differentiation so bevels are rounded, not aliased.
  const blurred = document.createElement('canvas');
  blurred.width = size;
  blurred.height = size;
  const bCtx = blurred.getContext('2d')!;
  bCtx.filter = 'blur(2.5px)';
  bCtx.drawImage(heightCanvas, 0, 0);

  const map = new CanvasTexture(albedo);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  const normalMap = new CanvasTexture(heightToNormal(blurred, 2.6));
  normalMap.anisotropy = 8;

  // Pack AO into red and roughness into green so one GPU texture feeds both channels.
  const ormCanvas = document.createElement('canvas');
  ormCanvas.width = size;
  ormCanvas.height = size;
  const ormCtx = ormCanvas.getContext('2d')!;
  const orm = ormCtx.createImageData(size, size);
  const aoPixels = ao.getImageData(0, 0, size, size).data;
  const roughPixels = rough.getImageData(0, 0, size, size).data;
  for (let i = 0; i < orm.data.length; i += 4) {
    orm.data[i] = aoPixels[i]!;
    orm.data[i + 1] = roughPixels[i]!;
    orm.data[i + 2] = 0;
    orm.data[i + 3] = 255;
  }
  ormCtx.putImageData(orm, 0, 0);
  const ormMap = new CanvasTexture(ormCanvas);
  ormMap.anisotropy = 8;
  return { map, normalMap, ormMap };
};

/** The cobbled heart of the plaza, matching the concentric stonework in the concept art. */
const CobblestoneCircle = ({ radius = 5.85 }: { radius?: number }) => {
  const { map, normalMap, ormMap } = useMemo(createCobblestoneMaps, []);
  const geometry = useMemo(() => {
    const circle = new CircleGeometry(radius, 96);
    circle.setAttribute('uv1', circle.attributes.uv!.clone());
    return circle;
  }, [radius]);
  useEffect(
    () => () => {
      map.dispose();
      normalMap.dispose();
      ormMap.dispose();
      geometry.dispose();
    },
    [geometry, map, normalMap, ormMap],
  );
  return (
    <mesh geometry={geometry} position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial
        map={map}
        normalMap={normalMap}
        normalScale={[0.72, 0.72]}
        roughness={1}
        roughnessMap={ormMap}
        aoMap={ormMap}
        aoMapIntensity={0.72}
      />
    </mesh>
  );
};

/**
 * The plaza is now just the cobbled hearth ring sitting directly in the grass — the
 * old brown dirt disk and stone paving are gone; green terrain, grass fill and the
 * shader-baked dirt roads (Terrain.tsx / terrainHeight.ts) carry the ground instead.
 */
const HavenPlaza = () => (
  <group>
    <CobblestoneCircle radius={6.35} />
  </group>
);

/** Purposeful mid-ground dressing based on the concept's gathering-place silhouette. */
const HavenDressing = () => (
  <group>
    <HubModel path={MODEL_PATHS.bench} targetSpan={2.15} position={[-6.5, 0, 5.8]} rotationY={0.73} />
    <HubModel path={MODEL_PATHS.bench} targetSpan={2.15} position={[6.5, 0, 5.8]} rotationY={Math.PI - 0.73} />
    <HubModel path={MODEL_PATHS.banner} targetHeight={3.35} position={[-5.2, 0, -18.1]} rotationY={-Math.PI / 2} wind />
    <HubModel path={MODEL_PATHS.banner} targetHeight={3.35} position={[5.2, 0, -18.1]} rotationY={-Math.PI / 2} wind />
    <HubCrystalClusters />
  </group>
);

const StationRing = ({ position, color, radius = 1.75 }: { position: [number, number, number]; color: string; radius?: number }) => {
  const ref = useRef<Mesh>(null);
  const material = useMemo(
    () => new MeshStandardMaterial({ color, emissive: new Color(color), emissiveIntensity: 0.42, roughness: 0.72 }),
    [color],
  );
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 1.8) * 0.025;
    ref.current.scale.setScalar(pulse);
    material.emissiveIntensity = 0.34 + Math.sin(clock.elapsedTime * 1.8) * 0.08;
  });
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh ref={ref} position={position} rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <ringGeometry args={[radius - 0.1, radius, 48]} />
    </mesh>
  );
};

const HubInteractions = () => {
  const initialized = useRef(false);
  const activeStation = useRef<HubStationId | undefined>(undefined);
  const setHubStation = useUIStore((s) => s.setHubStation);
  const setScene = useUIStore((s) => s.setScene);

  useFrame(() => {
    const player = players.first;
    if (!player?.transform) return;
    if (!initialized.current) {
      player.transform.position = [...HUB_SPAWN];
      player.transform.rotationY = Math.PI;
      initialized.current = true;
    }
    const station = nearestHubStation(player.transform.position[0], player.transform.position[2]);
    if (station?.id !== activeStation.current) {
      activeStation.current = station?.id;
      setHubStation(station?.id);
      // The Expedition Gate departs on PROXIMITY, not a key press: crossing into the gate
      // ring begins the run. Solo → setScene teleports straight in. Networked → setScene is
      // a no-op behind the session guard and NetGateInteraction opens the shared countdown
      // off this same hubStation edge. Fires once per entry (edge-triggered on station change).
      if (station?.id === 'expedition' && player.velocity) {
        player.transform.position = [0, 0, 0];
        player.transform.rotationY = Math.PI;
        player.velocity.linear = [0, 0, 0];
        setScene('expedition');
      }
    }
  });

  useEffect(() => {
    // The Roster Lodge still cycles the active adventurer on E — a repeatable menu action
    // where a deliberate key press (not proximity) is the right verb.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat) return;
      if (activeStation.current !== 'roster') return;
      const store = useUIStore.getState();
      const ids = Object.keys(PLAYER_CHARACTERS) as PlayerCharacterId[];
      const next = ids[(ids.indexOf(store.playerCharacter) + 1) % ids.length];
      if (next) store.setPlayerCharacter(next);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
};

/** Heartwood Haven: a compact social hub built from the first production asset set. */
export const SocialHub = ({ obstacles }: Props) => {
  const landmarks = useRef<Group>(null);
  const [lodgeX, lodgeZ] = HUB_LANDMARK_POSITIONS.lodge;
  const [shrineX, shrineZ] = HUB_LANDMARK_POSITIONS.shrine;
  const [gateX, gateZ] = HUB_LANDMARK_POSITIONS.gate;

  useEffect(() => {
    const meshes: Mesh[] = [];
    landmarks.current?.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
    obstacles.current = meshes;
    return () => {
      obstacles.current = [];
    };
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <GrassField clearRadius={24.5} plazaFill />
      <Scatter clearRadius={HUB_SCATTER_CLEAR.boulder} groundClearRadius={HUB_SCATTER_CLEAR.ground} plazaFill />
      <Trees clearRadius={25.5} />
      <SpireBackdrop />
      <HavenPlaza />
      <HavenDressing />
      <group ref={landmarks}>
        <HubModel path={MODEL_PATHS.lodge} targetWidth={9.4} position={[lodgeX, 0, lodgeZ]} rotationY={Math.PI / 4} />
        <HubModel path={MODEL_PATHS.shrine} targetHeight={3.65} position={[shrineX, 0.08, shrineZ]} rotationY={Math.PI - 0.25} />
        <HubModel
          path={MODEL_PATHS.gate}
          targetHeight={5.65}
          position={[gateX, 0.08, gateZ]}
          rotationY={0}
          faceOffset={-Math.PI / 2}
        />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.55} position={[-7.8, 0.04, 8]} rotationY={0.45} />
        <HubModel path={MODEL_PATHS.straightLamp} targetHeight={3.05} position={[7.8, 0.04, 8]} rotationY={-0.45} />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.3} position={[-18, 0.04, -1.5]} rotationY={0.9} />
        <HubModel path={MODEL_PATHS.straightLamp} targetHeight={2.7} position={[18, 0.04, -1.5]} rotationY={-0.9} />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.25} position={[-7.2, 0.04, -17.1]} rotationY={0.25} />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.25} position={[7.2, 0.04, -17.1]} rotationY={-0.25} />
        <HubModel path={MODEL_PATHS.campfire} targetWidth={1.7} position={[0, 0.06, 0]} rotationY={0.6} />
      </group>
      <CampfireVFX />

      <StationRing position={[gateX, 0.105, gateZ]} color="#8f63ff" radius={2.5} />
      <ExpeditionPortalVFX position={[gateX, 2.5, gateZ - 0.03]} radius={1.96} />
      <SummoningShrineRelic position={[shrineX, 2, shrineZ]} rotationY={Math.PI - 0.25} />

      <VioletLanternGlow position={[-7.8, 2.1, 8]} size={1.15} intensity={4.1} phase={0.2} />
      <VioletLanternGlow position={[7.8, 2.5, 8]} size={1.15} intensity={4.1} phase={1.7} />
      <VioletLanternGlow position={[-18, 1.9, -1.5]} size={1.02} intensity={3.5} phase={2.8} />
      <VioletLanternGlow position={[18, 2.25, -1.5]} size={1.02} intensity={3.5} phase={4.1} />
      <VioletLanternGlow position={[-7.2, 1.85, -17.1]} size={0.9} intensity={2.7} phase={5.3} />
      <VioletLanternGlow position={[7.2, 1.85, -17.1]} size={0.9} intensity={2.7} phase={6.6} />
      <pointLight position={[gateX, 2.5, gateZ]} color="#66e1dc" intensity={11} distance={8.5} decay={2} />
      <directionalLight position={[2, 9, 12]} color="#c4c1c9" intensity={0.85} />

      <Html position={[lodgeX, 3.55, lodgeZ + 0.75]} center distanceFactor={13} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-full border border-amber-100/20 bg-[#21170f]/75 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.24em] text-amber-100 shadow-lg backdrop-blur-sm">
          Roster Lodge
        </div>
      </Html>
      <HubInteractions />
    </>
  );
};

Object.values(MODEL_PATHS).forEach((path) => useGameModel.preload(path));
