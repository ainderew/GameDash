import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Mesh } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { world } from '@/game/ecs/world';
import { netGame } from '@/net/netGame';
import { useVfxTextures, VFX_COMMON_GLSL } from '@/game/fx/vfxShaderKit';

/**
 * DASH-SLASH VFX — flagship of the real-time shader kit.
 *
 * A layered effect (not a single surface), matching the production reference:
 *   1. SPARKS — GPU-instanced stretched streaks, fanned up-and-back into an umbrella comet.
 *   2. VIOLET WHIRL — a spinning energy vortex that tracks the hero THROUGH the dash.
 *   3. CORE + FLARE — a white-hot pop at the dash origin.
 *   4. SETTLE SMOKE — dust released when the dash STOPS (it doesn't billow during the run).
 * The ghost/afterimages (GhostTrail) layer over this during the dash.
 *
 * These are emitted along the hero's dash path off the sim flag
 * `player.attackState.dashSlash`. Particles live in world space and are advanced
 * entirely on the GPU (position/velocity/gravity in the vertex shader from a per-
 * instance spawn time), so the CPU only writes a handful of attributes on emit —
 * hundreds of particles cost almost nothing per frame. Emissive-on-black + additive
 * lets PostFX bloom light the hot cores for free (same contract as FlipbookImpactFX).
 */

const SPARK_COUNT = 240;
const SMOKE_COUNT = 80;
const GRAVITY = 16.0;

// Per-dash emission budget. Smoke no longer trails the dash — it's a settle burst at the stop.
const BURST_SPARKS = 70;
const TRAIL_SPARKS = 5; // per frame while dashing
const SETTLE_SMOKE = 24; // dust puffs released when the dash stops

const SPARK_HOT = new Color(2.0, 1.4, 0.55);
const SPARK_COOL = new Color(1.4, 0.38, 0.06);
// Cool grey dust, kept below 1 so it reads as lit smoke (not a glowing emitter).
const SMOKE_COLOR = new Color(0.58, 0.61, 0.7);

// Core flare.
const FLARE_MS = 300;
const FLARE_SIZE = 3.2;

// Violet whirl spun around the hero DURING the dash (layers with sparks + afterimages).
const WHIRL_SIZE = 1.45;
const WHIRL_FADE_OUT_MS = 240;
const WHIRL_EDGE = new Color(0.5, 0.14, 1.5);
const WHIRL_MID = new Color(1.25, 0.32, 1.15);
const WHIRL_CORE = new Color(1.7, 1.25, 1.85);

const players = world.with('playerControlled', 'transform');

// ── Spark system ────────────────────────────────────────────────────────────
const SPARK_VERT = /* glsl */ `
  attribute vec3 aSpawn;
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aLife;
  uniform float uTime;
  uniform float uGravity;
  varying vec2 vUv;
  varying float vT;
  void main() {
    float age = uTime - aBirth;
    float t = age / aLife;
    vUv = uv;
    vT = t;
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 wpos = aSpawn + aVel * age + vec3(0.0, -0.5 * uGravity * age * age, 0.0);
    vec3 vel = aVel + vec3(0.0, -uGravity * age, 0.0);
    float speed = length(vel);
    vec3 vdir = speed > 1e-3 ? vel / speed : vec3(0.0, 1.0, 0.0);
    vec3 toCam = normalize(cameraPosition - wpos);
    vec3 waxis = normalize(cross(vdir, toCam));
    // Faster sparks stretch longer and thinner (motion streak).
    float streak = mix(0.12, 0.55, clamp(speed / 10.0, 0.0, 1.0)) * (1.0 - t * 0.25);
    float wid = mix(0.05, 0.018, clamp(speed / 10.0, 0.0, 1.0));
    vec3 offset = vdir * (position.y * streak) + waxis * (position.x * wid);
    gl_Position = projectionMatrix * viewMatrix * vec4(wpos + offset, 1.0);
  }
`;

const SPARK_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uHot;
  uniform vec3 uCool;
  varying vec2 vUv;
  varying float vT;
  void main() {
    // Comet shape: bright leading head (uv.y→1), fading tail (uv.y→0).
    float along = smoothstep(0.0, 0.55, vUv.y);
    float across = pow(1.0 - abs(vUv.x * 2.0 - 1.0), 1.4);
    float life = 1.0 - vT;
    float a = along * across * life;
    if (a < 0.01) discard;
    vec3 col = mix(uHot, uCool, vT);
    col += uHot * smoothstep(0.6, 1.0, vUv.y) * 0.5;
    gl_FragColor = vec4(col, a);
  }
`;

// ── Smoke system ────────────────────────────────────────────────────────────
const SMOKE_VERT = /* glsl */ `
  attribute vec3 aSpawn;
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSeed;
  attribute float aScale;
  uniform float uTime;
  varying vec2 vUv;
  varying float vT;
  void main() {
    float age = uTime - aBirth;
    float t = age / aLife;
    vUv = uv;
    vT = t;
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 center = aSpawn + aVel * age;
    float size = aScale * mix(0.6, 2.2, t);
    float ang = aSeed * 6.2831 + t * 0.5;
    float c = cos(ang), s = sin(ang);
    vec2 p = mat2(c, -s, s, c) * position.xy;
    vec4 mv = viewMatrix * vec4(center, 1.0);
    mv.xy += p * size;
    gl_Position = projectionMatrix * mv;
  }
`;

const SMOKE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uSmoke;
  uniform vec3 uColor;
  uniform float uDensity;
  varying vec2 vUv;
  varying float vT;
  void main() {
    // 8×8 turbulent sheet on black → derive alpha from luminance so thin wisps stay
    // translucent (the sheet has no alpha channel). This is what kills the "solid circle".
    const float FRAMES = 64.0, COLS = 8.0, ROWS = 8.0;
    float fi = min(floor(vT * FRAMES), FRAMES - 1.0);
    float cx = mod(fi, COLS);
    float cy = floor(fi / COLS);
    vec2 cell = vec2((cx + vUv.x) / COLS, 1.0 - (cy + (1.0 - vUv.y)) / ROWS);
    vec3 tx = texture2D(uSmoke, cell).rgb;
    float lum = dot(tx, vec3(0.299, 0.587, 0.114));
    float fade = smoothstep(0.0, 0.1, vT) * smoothstep(1.0, 0.45, vT);
    float a = lum * fade * uDensity;
    if (a < 0.008) discard;
    vec3 col = uColor * (0.55 + 0.7 * lum);
    gl_FragColor = vec4(col, a);
  }
`;

// ── Core flare ──────────────────────────────────────────────────────────────
const FLARE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FLARE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uFlare;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float m = texture2D(uFlare, vUv).r;
    if (m * uOpacity < 0.003) discard;
    gl_FragColor = vec4(uColor, m * uOpacity);
  }
`;

const flareEnvelope = (age01: number): number => {
  if (age01 < 0 || age01 > 1) return 0;
  const attack = Math.min(1, age01 / 0.1);
  const release = 1 - Math.max(0, (age01 - 0.2) / 0.8);
  return attack * Math.max(0, release);
};

// ── Volumetric core ─────────────────────────────────────────────────────────
// Three intersecting vertical planes (an "asterisk") carrying a radially-masked,
// flow-distorted energy shader — gives the launch a 3D volume instead of a flat card.
const CORE_MS = 420;
const CORE_SIZE = 2.5;
const CORE_EDGE = new Color(0.14, 0.5, 1.7);
const CORE_MID = new Color(1.55, 1.05, 0.45);
const CORE_CORE = new Color(2.0, 1.85, 1.6);

const CORE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const CORE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uNoise;
  uniform sampler2D uFire;
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uEdge;
  uniform vec3 uMid;
  uniform vec3 uCore;
  varying vec2 vUv;

  ${VFX_COMMON_GLSL}

  void main() {
    // Radial mask → soft round blob, never a rectangle.
    float r = length(vUv - 0.5) * 2.0;
    float radial = smoothstep(1.0, 0.05, r);

    // Two noise fields panned opposite ways, multiplied → boiling energy (per the brief).
    float n = texture2D(uNoise, vUv * 1.5 + vec2(uTime * 0.2, -uTime * 0.15)).r;
    vec2 fUv = vfxFlow(vUv * 1.4 + vec2(-uTime * 0.5, uTime * 0.3), vec2(n), 0.25);
    float fire = texture2D(uFire, fUv).r;

    float intensity = radial * (0.45 + 0.55 * fire);
    float heat = clamp(intensity * 1.9, 0.0, 1.0);
    vec3 col = vfxRamp3(heat, uEdge, uMid, uCore);
    float alpha = intensity * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Fast attack, eased release for the core pop. */
const coreEnvelope = (age01: number): number => {
  if (age01 < 0 || age01 > 1) return 0;
  const attack = Math.min(1, age01 / 0.08);
  const release = 1 - Math.max(0, (age01 - 0.25) / 0.75);
  return attack * Math.max(0, release);
};
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** Build an InstancedBufferGeometry from a unit quad + a set of per-instance attributes. */
const makeInstanced = (count: number, attrs: Record<string, number>) => {
  const geo = new InstancedBufferGeometry();
  const base = new PlaneGeometry(1, 1);
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position!);
  geo.setAttribute('uv', base.attributes.uv!);
  geo.instanceCount = count;
  const attributes: Record<string, InstancedBufferAttribute> = {};
  for (const [name, size] of Object.entries(attrs)) {
    const arr = new Float32Array(count * size);
    // Park every instance far in the past so t > 1 (culled) until first emitted.
    if (name === 'aBirth') arr.fill(-1000);
    if (name === 'aLife') arr.fill(1);
    const a = new InstancedBufferAttribute(arr, size);
    a.setUsage(DynamicDrawUsage);
    geo.setAttribute(name, a);
    attributes[name] = a;
  }
  return { geo, attributes };
};

export const DashSlashVFX = () => {
  const tex = useVfxTextures();

  const spark = useMemo(
    () => makeInstanced(SPARK_COUNT, { aSpawn: 3, aVel: 3, aBirth: 1, aLife: 1 }),
    [],
  );
  const smoke = useMemo(
    () => makeInstanced(SMOKE_COUNT, { aSpawn: 3, aVel: 3, aBirth: 1, aLife: 1, aSeed: 1, aScale: 1 }),
    [],
  );

  const sparkMat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uGravity: { value: GRAVITY },
          uHot: { value: SPARK_HOT },
          uCool: { value: SPARK_COOL },
        },
        vertexShader: SPARK_VERT,
        fragmentShader: SPARK_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }),
    [],
  );
  const smokeMat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uSmoke: { value: tex.smoke },
          uColor: { value: SMOKE_COLOR },
          uDensity: { value: 1.35 },
        },
        vertexShader: SMOKE_VERT,
        fragmentShader: SMOKE_FRAG,
        transparent: true,
        blending: NormalBlending,
        depthWrite: false,
        depthTest: true,
      }),
    [tex],
  );

  const sparkMesh = useRef<Mesh>(null);
  const smokeMesh = useRef<Mesh>(null);

  // ── Core flare ──
  const flareMesh = useRef<Mesh>(null);
  const flareGeo = useMemo(() => new PlaneGeometry(1, 1), []);
  const flareMat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uFlare: { value: tex.flare },
          uOpacity: { value: 0 },
          uColor: { value: new Color(1.9, 1.5, 1.05) },
        },
        vertexShader: FLARE_VERT,
        fragmentShader: FLARE_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }),
    [tex],
  );
  const flareOrigin = useRef(new Vector3());

  // ── Volumetric core: 3 intersecting vertical planes fanned around the vertical axis ──
  const coreMesh = useRef<Mesh>(null);
  const coreGeo = useMemo(
    () =>
      mergeGeometries([
        new PlaneGeometry(1, 1),
        new PlaneGeometry(1, 1).rotateY(Math.PI / 3),
        new PlaneGeometry(1, 1).rotateY((2 * Math.PI) / 3),
      ])!,
    [],
  );
  const coreMat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uNoise: { value: tex.noise },
          uFire: { value: tex.fire },
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uEdge: { value: CORE_EDGE },
          uMid: { value: CORE_MID },
          uCore: { value: CORE_CORE },
        },
        vertexShader: CORE_VERT,
        fragmentShader: CORE_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }),
    [tex],
  );

  // ── Violet whirl: two crossed vertical planes spun fast, tracking the hero mid-dash ──
  const whirlMesh = useRef<Mesh>(null);
  const whirlGeo = useMemo(
    () => mergeGeometries([new PlaneGeometry(1, 1), new PlaneGeometry(1, 1).rotateY(Math.PI / 2)])!,
    [],
  );
  const whirlMat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uNoise: { value: tex.noise },
          uFire: { value: tex.fire },
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uEdge: { value: WHIRL_EDGE },
          uMid: { value: WHIRL_MID },
          uCore: { value: WHIRL_CORE },
        },
        vertexShader: CORE_VERT,
        fragmentShader: CORE_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }),
    [tex],
  );

  // Emission bookkeeping.
  const sparkHead = useRef(0);
  const smokeHead = useRef(0);
  const dashStamp = useRef<number | undefined>(undefined);
  const dashStartReal = useRef(0);
  const frameOfDash = useRef(0);
  const wasActive = useRef(false);
  const whirlFade = useRef(0);
  const whirlPos = useRef(new Vector3());
  const heroP = useRef(new Vector3());
  const dashDir = useRef(new Vector3(0, 0, 1));

  const readHero = (): boolean => {
    const player = players.first;
    if (!player?.transform) return false;
    const [x, y, z] = player.transform.position;
    if (netGame.active) {
      const o = netGame.presentationOffset();
      heroP.current.set(x + o[0], y + o[1], z + o[2]);
    } else {
      heroP.current.set(x, y, z);
    }
    const v = player.velocity?.linear;
    if (v && (v[0] !== 0 || v[2] !== 0)) dashDir.current.set(v[0], 0, v[2]).normalize();
    return true;
  };

  const emitSpark = (nowSec: number): void => {
    const i = sparkHead.current++ % SPARK_COUNT;
    const sp = spark.attributes.aSpawn!.array as Float32Array;
    const ve = spark.attributes.aVel!.array as Float32Array;
    sp[i * 3] = heroP.current.x + (Math.random() - 0.5) * 0.3;
    sp[i * 3 + 1] = heroP.current.y + 0.4 + Math.random() * 0.5;
    sp[i * 3 + 2] = heroP.current.z + (Math.random() - 0.5) * 0.3;
    // Umbrella comet: fan wide and strongly UP, biased slightly BACK along the dash so the
    // spray canopies behind the hero rather than shooting forward.
    const vx = (Math.random() - 0.5) * 2.4 - dashDir.current.x * 0.45;
    const vz = (Math.random() - 0.5) * 2.4 - dashDir.current.z * 0.45;
    const vy = 1.3 + Math.random() * 1.7;
    const len = Math.hypot(vx, vy, vz) || 1;
    const speed = 4 + Math.random() * 6.5;
    ve[i * 3] = (vx / len) * speed;
    ve[i * 3 + 1] = (vy / len) * speed;
    ve[i * 3 + 2] = (vz / len) * speed;
    (spark.attributes.aBirth!.array as Float32Array)[i] = nowSec;
    (spark.attributes.aLife!.array as Float32Array)[i] = 0.35 + Math.random() * 0.45;
  };

  // Settle smoke: a wide, low, slow dust bank that spreads and dissipates where the hero
  // stops — the "dust settling" beat. (No non-settle path any more; smoke only fires here.)
  const emitSmoke = (nowSec: number): void => {
    const i = smokeHead.current++ % SMOKE_COUNT;
    const sp = smoke.attributes.aSpawn!.array as Float32Array;
    const ve = smoke.attributes.aVel!.array as Float32Array;
    sp[i * 3] = heroP.current.x + (Math.random() - 0.5) * 1.8;
    sp[i * 3 + 1] = heroP.current.y + 0.02 + Math.random() * 0.2;
    sp[i * 3 + 2] = heroP.current.z + (Math.random() - 0.5) * 1.8;
    // Low outward drift so it spreads along the ground and settles, not rises.
    ve[i * 3] = dashDir.current.x * 0.35 + (Math.random() - 0.5) * 0.8;
    ve[i * 3 + 1] = 0.1 + Math.random() * 0.28;
    ve[i * 3 + 2] = dashDir.current.z * 0.35 + (Math.random() - 0.5) * 0.8;
    (smoke.attributes.aBirth!.array as Float32Array)[i] = nowSec;
    (smoke.attributes.aLife!.array as Float32Array)[i] = 0.8 + Math.random() * 0.7;
    (smoke.attributes.aSeed!.array as Float32Array)[i] = Math.random();
    (smoke.attributes.aScale!.array as Float32Array)[i] = 0.75 + Math.random() * 0.75;
  };

  useFrame((state, dt) => {
    const now = performance.now();
    const nowSec = now / 1000;
    sparkMat.uniforms.uTime!.value = nowSec;
    smokeMat.uniforms.uTime!.value = nowSec;
    coreMat.uniforms.uTime!.value = nowSec;
    whirlMat.uniforms.uTime!.value = nowSec;

    const player = players.first;
    const active = player?.attackState?.dashSlash === true;
    const stamp = player?.attackState?.startedAt;
    let sparkDirty = false;
    let smokeDirty = false;

    // New dash: opening burst (sparks + core/flare; smoke is held for the stop).
    if (active && stamp !== dashStamp.current && readHero()) {
      dashStamp.current = stamp;
      dashStartReal.current = now;
      frameOfDash.current = 0;
      flareOrigin.current.copy(heroP.current);
      for (let k = 0; k < BURST_SPARKS; k++) emitSpark(nowSec);
      sparkDirty = true;
    }

    // During the dash: trailing sparks + the violet whirl tracks the hero. NO smoke yet.
    if (active && readHero()) {
      for (let k = 0; k < TRAIL_SPARKS; k++) emitSpark(nowSec);
      sparkDirty = true;
      whirlFade.current = 1;
      whirlPos.current.copy(heroP.current);
      frameOfDash.current++;
    } else if (whirlFade.current > 0) {
      whirlFade.current = Math.max(0, whirlFade.current - (dt * 1000) / WHIRL_FADE_OUT_MS);
    }

    // Dash just STOPPED → release the settling dust cloud at the stop point.
    if (wasActive.current && !active && readHero()) {
      for (let k = 0; k < SETTLE_SMOKE; k++) emitSmoke(nowSec);
      smokeDirty = true;
    }
    wasActive.current = active;

    if (sparkDirty) {
      spark.attributes.aSpawn!.needsUpdate = true;
      spark.attributes.aVel!.needsUpdate = true;
      spark.attributes.aBirth!.needsUpdate = true;
      spark.attributes.aLife!.needsUpdate = true;
    }
    if (smokeDirty) {
      for (const a of Object.values(smoke.attributes)) a.needsUpdate = true;
    }

    if (sparkMesh.current) sparkMesh.current.visible = true;
    if (smokeMesh.current) smokeMesh.current.visible = true;

    // ── Core flare (camera-facing billboard) ──
    const fm = flareMesh.current;
    if (fm) {
      const age01 = (now - dashStartReal.current) / FLARE_MS;
      const env = dashStamp.current !== undefined ? flareEnvelope(age01) : 0;
      if (env > 0.003) {
        fm.position.set(flareOrigin.current.x, flareOrigin.current.y + 1.05, flareOrigin.current.z);
        fm.quaternion.copy(state.camera.quaternion);
        const s = FLARE_SIZE * (0.6 + age01 * 0.9);
        fm.scale.set(s, s, s);
        flareMat.uniforms.uOpacity!.value = env;
        fm.visible = true;
      } else {
        fm.visible = false;
      }
    }

    // ── Volumetric core (spinning asterisk of energy planes) ──
    const cm = coreMesh.current;
    if (cm) {
      const age01 = (now - dashStartReal.current) / CORE_MS;
      const env = dashStamp.current !== undefined ? coreEnvelope(age01) : 0;
      if (env > 0.003) {
        cm.position.set(flareOrigin.current.x, flareOrigin.current.y + 1.0, flareOrigin.current.z);
        const s = CORE_SIZE * (0.35 + easeOut(Math.min(1, age01)) * 0.9);
        cm.scale.set(s, s * 1.15, s);
        cm.rotation.y = nowSec * 2.2;
        coreMat.uniforms.uOpacity!.value = env;
        cm.visible = true;
      } else {
        cm.visible = false;
      }
    }

    // ── Violet whirl (fast-spinning vortex tracking the hero through the dash) ──
    const ww = whirlMesh.current;
    if (ww) {
      if (whirlFade.current > 0.003) {
        ww.position.set(whirlPos.current.x, whirlPos.current.y + 1.0, whirlPos.current.z);
        ww.scale.set(WHIRL_SIZE, WHIRL_SIZE * 1.7, WHIRL_SIZE);
        ww.rotation.y = nowSec * 7.0;
        whirlMat.uniforms.uOpacity!.value = Math.min(1, whirlFade.current) * 0.9;
        ww.visible = true;
      } else {
        ww.visible = false;
      }
    }
  });

  return (
    <>
      <mesh ref={coreMesh} geometry={coreGeo} material={coreMat} frustumCulled={false} visible={false} />
      <mesh ref={whirlMesh} geometry={whirlGeo} material={whirlMat} frustumCulled={false} visible={false} />
      <mesh ref={sparkMesh} geometry={spark.geo} material={sparkMat} frustumCulled={false} />
      <mesh ref={smokeMesh} geometry={smoke.geo} material={smokeMat} frustumCulled={false} renderOrder={1} />
      <mesh ref={flareMesh} geometry={flareGeo} material={flareMat} frustumCulled={false} visible={false} />
    </>
  );
};
