import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Object3D,
  ShaderMaterial,
  StaticDrawUsage,
  UniformsLib,
  Vector2,
  Vector3,
} from 'three';
import type { Mesh, MeshStandardMaterial, Texture } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt, pathMask, hubRoadMask } from '@sim/terrain/terrainHeight';
import { SUN_POSITION } from '@/game/world/SkyAndLight';
import { PLAZA_DRESSING, inPlazaKeepout } from '@/game/world/hubLayout';

/**
 * GRASS FIELD v3 — instanced tuft models from the Stylized Nature MegaKit,
 * driven by the same custom wind ShaderMaterial as the old procedural blades.
 *
 * Architecture rules learned the hard way in this repo:
 * - Placement rides the STANDARD `instanceMatrix` (never custom instance attributes):
 *   shadow/AO override materials understand instanceMatrix, so PostFX pre-passes see the
 *   tufts in the right places instead of exploding them (the old flicker bug).
 * - Wind is entirely GPU-side; the matrix buffer is StaticDrawUsage, uploaded once.
 * - smoothstep edges are ALWAYS ascending — reversed edges are GLSL UB and genuinely
 *   break on this machine's AMD/ANGLE driver.
 * - No transparency: the pack tufts are modeled blade geometry, not alpha cards,
 *   so no sorting or blending cost.
 * - Kept out of the shadow pass entirely (cast+receive false) — the fragment shader fakes
 *   AO and SSS with a root→tip gradient plus the pack's baked per-vertex occlusion.
 *
 * Colour comes from the pack's Grass.png gradient atlas (sampled with the model UVs —
 * this IS the pack look), with the lowest part of each tuft blended toward the terrain
 * colour so roots melt into the ground. The pack's baked COLOR_0 (grayscale occlusion
 * between blades inside a tuft) is kept as `aAO`.
 */

/** Deterministic PRNG so the field looks identical every load. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── Tunables ────────────────────────────────────────────────────────────────
const DENSE_RADIUS = 58; // matches the playfield (same as the old field)
const RING_RADIUS = 84; // sparse horizon ring beyond the dense disk
const MAX_TERRAIN_Y = 4; // keep tufts off the steep perimeter peaks
const TINT_CELL = 7; // world-units per patch of coherent colour variation

// Root ≈ the average terrain colour at play level (the grassLow→grassHigh splat,
// Terrain.tsx) — THE trick that melts the tufts into the ground.
const ROOT_COLOR = '#282c33';
const SSS_COLOR = '#9698a0';

interface Variant {
  path: string;
  count: number;
  /** Share of instances pushed out to the horizon ring. */
  ringFraction: number;
  /** Uniform footprint scale range [min, max]. */
  scale: [number, number];
  /** Extra multiplier range on Y so height varies independently of footprint. */
  yScale: [number, number];
}

// Model natural heights: Common_Short 1.31, Common_Tall 1.84, Wispy_Short 0.99,
// Wispy_Tall 1.64 — scales below bring them to roughly knee/waist height.
const VARIANTS: Variant[] = [
  {
    path: '/models/grass/Grass_Common_Short.gltf', // 155 tris — the dense base layer
    count: 1100,
    ringFraction: 0.14,
    scale: [0.52, 0.94],
    yScale: [0.72, 1.18],
  },
  {
    path: '/models/grass/Grass_Common_Tall.gltf', // 326 tris — mid-height fill
    count: 220,
    ringFraction: 0.25,
    scale: [0.48, 0.82],
    yScale: [0.76, 1.16],
  },
  {
    path: '/models/grass/Grass_Wispy_Short.gltf', // 494 tris — feathery accents
    count: 95,
    ringFraction: 0.1,
    scale: [0.52, 0.92],
    yScale: [0.85, 1.2],
  },
  {
    path: '/models/grass/Grass_Wispy_Tall.gltf', // 622 tris — tall silhouette accents
    count: 45,
    ringFraction: 0.35,
    scale: [0.46, 0.76],
    yScale: [0.85, 1.15],
  },
];

// three auto-declares `instanceMatrix`/`instanceColor` for a (non-raw) ShaderMaterial
// rendered through an InstancedMesh, and injects the fog defines when material.fog=true.
const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uWindStrength;
  uniform float uWindSpeed;
  uniform float uWindScale;
  uniform vec2  uWindDir;

  attribute float aT;  // 0 root → 1 tip (per-vertex height fraction of the tuft)
  attribute float aAO; // pack's baked occlusion between blades inside the tuft

  varying float vT;
  varying float vAO;
  varying vec2  vUv;
  varying vec3  vTint;
  varying vec3  vWorldNormal;
  varying vec2  vNoise; // x = dry↔lush hue drift, y = value patch — both coherent in world space
  #include <fog_pars_vertex>

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Smooth (bilinear) value noise so colour drifts in coherent patches instead of confetti.
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    vT = aT;
    vAO = aAO;
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif

    // Tuft root world position = the instance translation; the wind phase keys off it
    // so waves ROLL across the field instead of every tuft pulsing in place.
    vec3 root = (modelMatrix * instanceMatrix[3]).xyz;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);

    // Coherent world-space colour variation: two octaves for the hue drift, a finer
    // one for value patches. Sampled at the root so a whole tuft shares one tone.
    vNoise.x = vnoise(root.xz * 0.045 + 3.1) * 0.65 + vnoise(root.xz * 0.13 + 19.7) * 0.35;
    vNoise.y = vnoise(root.xz * 0.11 + 41.3) * 0.6 + vnoise(root.xz * 0.34 + 7.9) * 0.4;

    // Taller tufts sway further: the instance Y-scale (world height) amplifies the bend
    // so a knee-high blade doesn't whip as hard as a waist-high one.
    float instH = length(instanceMatrix[1].xyz);

    float phase  = dot(root.xz, uWindDir) * uWindScale;
    float jitter = hash12(root.xz) * 6.2831;
    float wave =
        sin(phase + uTime * uWindSpeed)                       * 0.60
      + sin(phase * 2.7 + uTime * uWindSpeed * 1.45 + jitter) * 0.30
      + sin(phase * 6.3 + uTime * uWindSpeed * 3.10 + jitter) * 0.10;
    // Slow gust envelope so the field breathes instead of metronoming.
    float gust = 0.6 + 0.4 * sin(phase * 0.15 + uTime * uWindSpeed * 0.30);

    // CRUCIAL: scaled by the height fraction — roots pinned at 0, tips fly. The instance
    // height factor makes tall grass sway more than short so motion varies across the field.
    float sway = wave * gust * uWindStrength * pow(aT, 1.5) * (0.55 + instH * 0.5);
    world.xz += uWindDir * sway;
    world.y  -= sway * sway * 0.5 * aT; // bent blades shorten, they don't stretch

    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    // This shader builds world position itself (instancing + wind), so hand it straight
    // to the atmospheric fog instead of letting the chunk rebuild it from a transformed
    // local vertex we do not have (see FOG_WORLDPOS_MANUAL in atmosphericFog.ts).
    vFogWorldPosition = world.xyz;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uRootColor;
  uniform vec3 uSSSColor;
  uniform vec3 uSunDir;
  uniform vec3 uAmbientLight;
  uniform vec3 uSunLight;

  varying float vT;
  varying float vAO;
  varying vec2  vUv;
  varying vec3  vTint;
  varying vec3  vWorldNormal;
  varying vec2  vNoise; // x = dry↔lush hue drift, y = value patch
  #include <fog_pars_fragment>

  void main() {
    vec3 atlas = texture2D(uMap, vUv).rgb;
    float atlasValue = dot(atlas, vec3(0.2126, 0.7152, 0.0722));
    // Slightly wider value band than before so blade tips read against the ground.
    vec3 col = mix(vec3(0.038, 0.043, 0.05), vec3(0.175, 0.188, 0.205), smoothstep(0.06, 0.8, atlasValue));

    // Coherent dry↔lush drift: some drifts of the field skew warm/parched, others cool.
    // Kept subtle (±~8%) to stay inside the achromatic wasteland palette.
    vec3 dryTint  = vec3(1.08, 1.00, 0.86);
    vec3 lushTint = vec3(0.90, 1.00, 1.07);
    col *= mix(dryTint, lushTint, vNoise.x);
    // Large-scale value patches — lighter clearings, darker thickets.
    col *= mix(0.80, 1.16, vNoise.y);

    // Melt the lowest part of each tuft into the terrain colour, with a touch more
    // root→tip contrast so individual blades have depth.
    col = mix(uRootColor, col, smoothstep(0.03, 0.60, vT));
    // Pack's baked occlusion separates blades without turning clump interiors black.
    col *= mix(0.72, 1.03, vAO);
    vec3 n = normalize(vWorldNormal);
    float wrappedSun = clamp((dot(n, normalize(uSunDir)) + 0.48) / 1.48, 0.0, 1.0);
    float skyFacing = 0.72 + 0.28 * clamp(n.y, 0.0, 1.0);
    col *= uAmbientLight * skyFacing + uSunLight * wrappedSun * 0.76;
    // Faint tip highlight so silhouettes catch the light, strongest in the lush drifts.
    col += vec3(0.018, 0.020, 0.022) * pow(vT, 2.5) * (0.4 + vNoise.x * 0.6);
    // Restrained warm translucency on sun-facing tips.
    col += uSSSColor * pow(vT, 3.0) * wrappedSun * 0.01;
    col *= mix(vec3(1.0), vTint, 0.7);

    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
    #include <colorspace_fragment>
  }
`;

const findMesh = (scene: { traverse: (cb: (o: unknown) => void) => void }) => {
  let source: Mesh | undefined;
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh && !source) source = mesh;
  });
  if (!source) throw new Error('grass model has no mesh');
  return source;
};

/**
 * Extract the tuft geometry from a pack glTF and augment its attributes for our shader:
 * `aT` height fraction for the wind, `aAO` from the baked grayscale COLOR_0. UVs are
 * kept (they sample the pack's gradient atlas); unused normals/colors are dropped.
 */
const prepareGeometry = (scene: { traverse: (cb: (o: unknown) => void) => void }) => {
  const source = findMesh(scene);

  const geo = source.geometry.clone() as BufferGeometry;
  const pos = geo.attributes.position!;
  geo.computeBoundingBox();
  const minY = geo.boundingBox!.min.y;
  const maxY = geo.boundingBox!.max.y;
  const span = Math.max(1e-5, maxY - minY);

  const aT = new Float32Array(pos.count);
  const aAO = new Float32Array(pos.count);
  const color = geo.attributes.color; // grayscale baked occlusion (vec4 in the pack)
  for (let i = 0; i < pos.count; i++) {
    aT[i] = Math.min(1, Math.max(0, (pos.getY(i) - minY) / span));
    aAO[i] = color ? color.getX(i) : 1;
  }
  geo.setAttribute('aT', new Float32BufferAttribute(aT, 1));
  geo.setAttribute('aAO', new Float32BufferAttribute(aAO, 1));
  geo.deleteAttribute('color');
  return geo;
};

/** Smooth deterministic patch noise — coherent tint drifts without square colour cells. */
const patchNoise = (x: number, z: number) => {
  const gx = x / TINT_CELL;
  const gz = z / TINT_CELL;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  let fx = gx - ix;
  let fz = gz - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const hash = (hx: number, hz: number) => {
    const s = Math.sin(hx * 127.1 + hz * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
};

/** Smooth (bilinear) value noise for MEADOW DENSITY — thickets and clearings instead of
 * an even carpet. Cell size ~9u so patches read at gameplay scale. */
const MEADOW_CELL = 9;
const cellHash = (ix: number, iz: number) => {
  const s = Math.sin(ix * 157.31 + iz * 271.9) * 43758.5453;
  return s - Math.floor(s);
};
const meadowNoise = (x: number, z: number) => {
  const gx = x / MEADOW_CELL;
  const gz = z / MEADOW_CELL;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  let fx = gx - ix;
  let fz = gz - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = cellHash(ix, iz);
  const b = cellHash(ix + 1, iz);
  const c = cellHash(ix, iz + 1);
  const d = cellHash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
};

/** Coherent large-scale HEIGHT field — independent of density so tall and short grass
 *  form their own rolling regions (a short-cropped hollow, a tall overgrown drift) rather
 *  than height tracking density one-to-one. Larger cell than the meadow so the bands read
 *  at a bigger scale. Decorrelated hash from cellHash so the two fields don't line up. */
const HEIGHT_CELL = 21;
const heightCellHash = (ix: number, iz: number) => {
  const s = Math.sin(ix * 269.5 + iz * 183.31) * 43758.5453;
  return s - Math.floor(s);
};
const heightField = (x: number, z: number) => {
  const gx = x / HEIGHT_CELL;
  const gz = z / HEIGHT_CELL;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  let fx = gx - ix;
  let fz = gz - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = heightCellHash(ix, iz);
  const b = heightCellHash(ix + 1, iz);
  const c = heightCellHash(ix, iz + 1);
  const d = heightCellHash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
};

/** Extra plaza tufts as a share of each variant's meadow count — heavily weighted to
 *  the short base grass so the plaza reads as low, trodden ground cover, not a meadow. */
const PLAZA_GRASS_SHARE = [0.035, 0.012, 0.01, 0.006];

const buildField = (
  geometries: BufferGeometry[],
  map: Texture,
  clearRadius: number,
  plazaFill: boolean,
) => {
  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      ...UniformsLib.fog, // renderer keeps these synced to scene.fog (fog: true below)
      uTime: { value: 0 },
      uWindStrength: { value: 0.25 },
      uWindSpeed: { value: 1.6 },
      uWindScale: { value: 0.35 },
      uWindDir: { value: new Vector2(1, 0.35).normalize() },
      uMap: { value: map },
      uRootColor: { value: new Color(ROOT_COLOR) },
      uSSSColor: { value: new Color(SSS_COLOR) },
      uSunDir: { value: new Vector3(...SUN_POSITION).normalize() },
      uAmbientLight: { value: new Color('#a9adb7') },
      uSunLight: { value: new Color('#c9cad0') },
    },
    side: DoubleSide,
    fog: true,
    // The custom vertex shader assigns vFogWorldPosition directly, so tell the patched
    // fog_vertex chunk not to rebuild it from `transformed` (which this shader lacks).
    defines: { FOG_WORLDPOS_MANUAL: '' },
  });

  const rng = mulberry32(20260709);
  const dummy = new Object3D();
  const tint = new Color();
  const tintFresh = new Color('#ccd0d7');
  const tintDry = new Color('#a8a9ad');

  const meshes = VARIANTS.map((variant, vi) => {
    const plazaTarget = plazaFill ? Math.round(variant.count * PLAZA_GRASS_SHARE[vi]!) : 0;
    const mesh = new InstancedMesh(geometries[vi]!, material, variant.count + plazaTarget);
    mesh.instanceMatrix.setUsage(StaticDrawUsage);

    let placed = 0;
    let guard = 0;
    while (placed < variant.count && guard < variant.count * 14) {
      guard++;
      // Dense disk, with a share pushed out to the horizon ring.
      const ring = rng() < variant.ringFraction;
      const r = ring
        ? DENSE_RADIUS + Math.sqrt(rng()) * (RING_RADIUS - DENSE_RADIUS)
        : Math.sqrt(rng()) * DENSE_RADIUS;
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x, z) < clearRadius) continue;
      if (heightAt(x, z) > MAX_TERRAIN_Y) continue; // stay off the steep peaks
      if (pathMask(x, z) > 0.35) continue; // and off the dirt trail

      // CLUMPED CONCENTRATION: meadow noise gates placement — thick drifts of grass
      // with genuinely thin clearings between them, not one even carpet. The remap
      // pushes low noise to a true floor so clearings actually clear out.
      const raw = meadowNoise(x + vi * 37.3, z - vi * 21.7);
      const ms = Math.min(1, Math.max(0, (raw - 0.28) / 0.44));
      const meadow = ms * ms * (3 - 2 * ms);
      if (rng() > 0.07 + meadow * 0.96) continue;

      const s = variant.scale[0] + rng() * (variant.scale[1] - variant.scale[0]);
      // Height comes from three decoupled sources so the silhouette varies richly:
      // a coherent large-scale height field (tall drifts vs cropped hollows), the local
      // meadow concentration (lush = a bit taller), and per-tuft randomness.
      const hfield = heightField(x + vi * 12.7, z - vi * 8.3);
      const sy =
        s *
        (variant.yScale[0] + rng() * (variant.yScale[1] - variant.yScale[0])) *
        (0.6 + hfield * 0.75 + meadow * 0.28);
      dummy.position.set(x, heightAt(x, z) - 0.02, z);
      dummy.rotation.set((rng() - 0.5) * 0.22, rng() * Math.PI * 2, (rng() - 0.5) * 0.22);
      dummy.scale.set(s * (0.72 + rng() * 0.56), sy, s * (0.72 + rng() * 0.56));
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);

      // Patch-coherent tint with per-tuft noise on top — patchy, not confetti.
      tint.lerpColors(tintFresh, tintDry, patchNoise(x, z) * 0.7 + rng() * 0.3);
      mesh.setColorAt(placed, tint);
      placed++;
    }

    // PLAZA DIRT FILL: shorter, drier tufts growing out of the trodden haven plaza,
    // concentrated toward the hub (pow>1 on radius biases inward) and dodging the
    // cobbles/buildings/lamps. Appended after the meadow instances in the same buffer.
    // Generate persistent family anchors first; individual tufts then gather around
    // them instead of appearing as evenly spaced, unrelated model stamps.
    const plazaAnchors: [number, number][] = [];
    const anchorTarget = plazaFill ? Math.max(1, Math.ceil(plazaTarget / (vi === 0 ? 7 : 3))) : 0;
    let anchorGuard = 0;
    while (plazaAnchors.length < anchorTarget && anchorGuard < anchorTarget * 40) {
      anchorGuard++;
      const r = PLAZA_DRESSING.inner + Math.pow(rng(), 1.8) * (PLAZA_DRESSING.outer - PLAZA_DRESSING.inner);
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (inPlazaKeepout(x, z) || hubRoadMask(x, z) > 0.66) continue;
      const raw = meadowNoise(x + 91.7, z - 63.1);
      const ps = Math.min(1, Math.max(0, (raw - 0.34) / 0.42));
      const patch = ps * ps * (3 - 2 * ps);
      if (rng() > 0.25 + patch * 0.85) continue;
      plazaAnchors.push([x, z]);
    }

    let plazaPlaced = 0;
    let plazaGuard = 0;
    while (plazaFill && plazaPlaced < plazaTarget && plazaGuard < plazaTarget * 40) {
      plazaGuard++;
      const anchor = plazaAnchors[Math.floor(rng() * plazaAnchors.length)];
      if (!anchor) break;
      const spread = vi === 0 ? 1.35 : 0.9;
      const r = Math.sqrt(rng()) * spread;
      const a = rng() * Math.PI * 2;
      const x = anchor[0] + Math.cos(a) * r;
      const z = anchor[1] + Math.sin(a) * r;
      if (inPlazaKeepout(x, z)) continue;
      // Probabilistic verge: the packed core stays clear while irregular tufts survive
      // progressively farther into the soft dirt/grass blend instead of ending in a line.
      const road = hubRoadMask(x, z);
      if (road > 0.78 || (road > 0.22 && rng() < road * 0.82)) continue;

      // The anchor already establishes the clump; local patch value drives its height.
      const raw = meadowNoise(x + 91.7, z - 63.1);
      const ps = Math.min(1, Math.max(0, (raw - 0.34) / 0.42));
      const patch = ps * ps * (3 - 2 * ps);

      const s = variant.scale[0] * 0.6 + rng() * (variant.scale[1] - variant.scale[0]) * 0.7;
      // Short and varied — plaza grass tops out well below the meadow.
      const sy =
        s * (variant.yScale[0] + rng() * (variant.yScale[1] - variant.yScale[0])) * (0.62 + patch * 0.45);
      const idx = placed + plazaPlaced;
      dummy.position.set(x, heightAt(x, z) - 0.02, z);
      dummy.rotation.set((rng() - 0.5) * 0.26, rng() * Math.PI * 2, (rng() - 0.5) * 0.26);
      dummy.scale.set(s * (0.7 + rng() * 0.62), sy, s * (0.7 + rng() * 0.62));
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      // Drier, earthier tint to sit against the dirt.
      tint.lerpColors(tintFresh, tintDry, 0.4 + patchNoise(x, z) * 0.45 + rng() * 0.15);
      mesh.setColorAt(idx, tint);
      plazaPlaced++;
    }

    mesh.count = placed + plazaPlaced;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Wind moves vertices in the shader — three's culling sphere would be stale anyway.
    mesh.frustumCulled = false;
    mesh.castShadow = false; // thousands of tufts through the shadow pass erase the perf win
    mesh.receiveShadow = false;
    return mesh;
  });

  return { meshes, material };
};

/** Stylized wind-swept grass tufts from the nature pack. Mounted once in Zone.tsx. */
export const GrassField = ({
  clearRadius = 0,
  plazaFill = false,
}: {
  clearRadius?: number;
  /** Also grow short, patchy tufts across the inner haven plaza dirt (inside the
   * clear radius), dodging the cobbles/buildings/lamps. */
  plazaFill?: boolean;
}) => {
  const commonShort = useGameModel(VARIANTS[0]!.path);
  const commonTall = useGameModel(VARIANTS[1]!.path);
  const wispyShort = useGameModel(VARIANTS[2]!.path);
  const wispyTall = useGameModel(VARIANTS[3]!.path);

  const geometries = useMemo(
    () => [commonShort, commonTall, wispyShort, wispyTall].map((g) => prepareGeometry(g.scene)),
    [commonShort, commonTall, wispyShort, wispyTall],
  );

  // All four models share the same Grass.png gradient atlas — grab it once.
  const map = useMemo(() => {
    const mat = findMesh(commonShort.scene).material as MeshStandardMaterial;
    if (!mat.map) throw new Error('grass model has no gradient texture');
    return mat.map;
  }, [commonShort.scene]);

  const { meshes, material } = useMemo(
    () => buildField(geometries, map, clearRadius, plazaFill),
    [geometries, map, clearRadius, plazaFill],
  );

  useEffect(
    () => () => {
      geometries.forEach((g) => g.dispose());
      material.dispose();
      meshes.forEach((m) => m.dispose());
    },
    [geometries, meshes, material],
  );

  // Real clock, not game time — the wind keeps blowing during hitstop freezes.
  useFrame(({ clock }) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
  });

  return (
    <group>
      {meshes.map((mesh, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </group>
  );
};

VARIANTS.forEach((v) => useGameModel.preload(v.path));
