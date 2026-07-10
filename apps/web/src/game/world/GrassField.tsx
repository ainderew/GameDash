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
import { heightAt, pathMask } from '@/game/world/terrainHeight';
import { SUN_POSITION } from '@/game/world/SkyAndLight';

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
const TINT_CELL = 6; // world-units per patch of coherent colour variation

// Root ≈ the average terrain colour at play level (the grassLow→grassHigh splat,
// Terrain.tsx) — THE trick that melts the tufts into the ground.
const ROOT_COLOR = '#4d7223';
const SSS_COLOR = '#f1c875';

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
    count: 4400,
    ringFraction: 0.14,
    scale: [0.65, 1.05],
    yScale: [0.8, 1.25],
  },
  {
    path: '/models/grass/Grass_Common_Tall.gltf', // 326 tris — mid-height fill
    count: 860,
    ringFraction: 0.25,
    scale: [0.55, 0.85],
    yScale: [0.8, 1.15],
  },
  {
    path: '/models/grass/Grass_Wispy_Short.gltf', // 494 tris — feathery accents
    count: 310,
    ringFraction: 0.1,
    scale: [0.6, 1.0],
    yScale: [0.85, 1.2],
  },
  {
    path: '/models/grass/Grass_Wispy_Tall.gltf', // 622 tris — tall silhouette accents
    count: 190,
    ringFraction: 0.35,
    scale: [0.5, 0.8],
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
  #include <fog_pars_vertex>

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
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

    float phase  = dot(root.xz, uWindDir) * uWindScale;
    float jitter = hash12(root.xz) * 6.2831;
    float wave =
        sin(phase + uTime * uWindSpeed)                       * 0.60
      + sin(phase * 2.7 + uTime * uWindSpeed * 1.45 + jitter) * 0.30
      + sin(phase * 6.3 + uTime * uWindSpeed * 3.10 + jitter) * 0.10;
    // Slow gust envelope so the field breathes instead of metronoming.
    float gust = 0.6 + 0.4 * sin(phase * 0.15 + uTime * uWindSpeed * 0.30);

    // CRUCIAL: scaled by the height fraction — roots pinned at 0, tips fly.
    float sway = wave * gust * uWindStrength * pow(aT, 1.5);
    world.xz += uWindDir * sway;
    world.y  -= sway * sway * 0.5 * aT; // bent blades shorten, they don't stretch

    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
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
  #include <fog_pars_fragment>

  void main() {
    // The pack's gradient atlas gives each blade its root→tip colour.
    vec3 col = texture2D(uMap, vUv).rgb;
    // Melt the lowest part of each tuft into the terrain colour.
    col = mix(uRootColor, col, smoothstep(0.0, 0.45, vT));
    // Pack's baked occlusion separates the blades inside a tuft (kept subtle).
    col *= mix(0.67, 1.03, vAO);
    vec3 n = normalize(vWorldNormal);
    float wrappedSun = clamp((dot(n, normalize(uSunDir)) + 0.48) / 1.48, 0.0, 1.0);
    float skyFacing = 0.72 + 0.28 * clamp(n.y, 0.0, 1.0);
    col *= uAmbientLight * skyFacing + uSunLight * wrappedSun * 0.76;
    // Restrained warm translucency on sun-facing tips.
    col += uSSSColor * pow(vT, 3.0) * wrappedSun * 0.075;
    col *= vTint;

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

/** Low-frequency deterministic patch noise — coherent colour variation across the field. */
const patchNoise = (x: number, z: number) => {
  const cx = Math.floor(x / TINT_CELL);
  const cz = Math.floor(z / TINT_CELL);
  const s = Math.sin(cx * 127.1 + cz * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const buildField = (geometries: BufferGeometry[], map: Texture, clearRadius: number) => {
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
      uAmbientLight: { value: new Color('#c2cbae') },
      uSunLight: { value: new Color('#e7bd82') },
    },
    side: DoubleSide,
    fog: true,
  });

  const rng = mulberry32(20260709);
  const dummy = new Object3D();
  const tint = new Color();
  const tintFresh = new Color('#cbd9a7');
  const tintDry = new Color('#9c8f58');

  const meshes = VARIANTS.map((variant, vi) => {
    const mesh = new InstancedMesh(geometries[vi]!, material, variant.count);
    mesh.instanceMatrix.setUsage(StaticDrawUsage);

    let placed = 0;
    let guard = 0;
    while (placed < variant.count && guard < variant.count * 6) {
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

      const s = variant.scale[0] + rng() * (variant.scale[1] - variant.scale[0]);
      const sy = s * (variant.yScale[0] + rng() * (variant.yScale[1] - variant.yScale[0]));
      dummy.position.set(x, heightAt(x, z) - 0.02, z);
      dummy.rotation.set((rng() - 0.5) * 0.12, rng() * Math.PI * 2, (rng() - 0.5) * 0.12);
      dummy.scale.set(s, sy, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);

      // Patch-coherent tint with per-tuft noise on top — patchy, not confetti.
      tint.lerpColors(tintFresh, tintDry, patchNoise(x, z) * 0.7 + rng() * 0.3);
      mesh.setColorAt(placed, tint);
      placed++;
    }
    mesh.count = placed;
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
export const GrassField = ({ clearRadius = 0 }: { clearRadius?: number }) => {
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
    () => buildField(geometries, map, clearRadius),
    [geometries, map, clearRadius],
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
