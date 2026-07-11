import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Object3D,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { InstancedMesh, Mesh } from 'three';
import { passAim } from '@/game/combat/passAim';
import { relics } from '@/game/ecs/world';

/**
 * CORRUPTION DRAIN — while the Relic is carried, a single braided tether of sickly
 * violet strands runs from the carrier's shoulder into the crystal, siphoning glowing
 * essence motes INTO it: the Relic feeds on whoever holds it. This is the in-world
 * promise of the future corruption meter, so the effect BUILDS the longer one carrier
 * holds on (faint on pickup → full drain) and resets on every handoff — passing
 * literally sheds the corruption.
 *
 * Same visual language as the pass ribbon in PassAimUI (billboarded tapered strips,
 * shader-driven flow, additive, no depth write), but inverted: pass energy streams
 * away toward a receiver; the drain crawls out of the body into the core.
 */

const STRANDS = 3; // braid strands sharing one spine
const SEGS = 24; // curve samples per strand
const MOTES = 10;

/**
 * Single latch point on the carrier's left shoulder, local to facing — the carried
 * Relic rides the left shoulder (RELIC_CARRY_OFFSET), so one tether reads as one
 * connected wound instead of strings across the chest.
 */
const LATCH_OFFSET: readonly [number, number, number] = [-0.34, 1.4, 0.06];

/** Braid shape: how far strands wind from the spine, and how many full twists. */
const BRAID_R = 0.05;
const BRAID_TURNS = 3.5;
/** Twist travel speed — the braid visibly screws itself INTO the crystal. */
const BRAID_FLOW = 2.4;

/** Corruption violet — deliberately outside the relic's teal/gold pass palette. */
const VIOLET = '#7c3aed';
const MAGENTA = '#e879f9';
const MOTE_LILAC = '#c084fc';

/** Drain visuals ramp from faint to full over this many seconds of continuous carry. */
const RAMP_S = 12;
/** Intensity at the moment of pickup (never zero — the latch itself must read). */
const BASE_INTENSITY = 0.4;

/** Must match FOLLOW_RATE + bob in Relic.tsx so tendrils end on the DRAWN crystal. */
const RELIC_FOLLOW_RATE = 10;

// ── Tendril ribbon shader: transverse falloff + essence pulses flowing INTO the relic ──

const drainVert = /* glsl */ `
  attribute float aU;
  attribute float aV;
  attribute float aSeed;
  varying float vU;
  varying float vV;
  varying float vSeed;
  void main() {
    vU = aU;
    vV = aV;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const drainFrag = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying float vU;
  varying float vV;
  varying float vSeed;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p = p * 2.13 + 17.7;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // Flow-space: all detail drifts toward u = 1 (the crystal), per-strand offset.
    vec2 q = vec2(vU * 6.0 - uTime * 1.6, vV * 1.4 + vSeed * 9.0);
    float turb = fbm(q);
    // Ragged silhouette: turbulence gnaws at the edges instead of a clean fade.
    // Gentler than the old loose-tendril look — braid strands are slim, and too
    // much raggedness would dissolve the rope silhouette back into clutter.
    float edge = 1.0 - smoothstep(0.35, 1.0, abs(vV) + (turb - 0.5) * 0.4);
    // White-hot filament core wandering inside the ribbon with the turbulence.
    float wander = (turb - 0.5) * 0.7;
    float core = exp(-pow((vV - wander) * 3.4, 2.0));
    // Ridged secondary strand woven around the core (portal-lightning trick).
    float ridge = 1.0 - abs(fbm(vec2(vU * 9.0 - uTime * 2.6, vSeed * 7.0 + vV * 0.8)) * 2.0 - 1.0);
    ridge = pow(ridge, 3.0);
    // Two pulse trains streaming into the crystal: fast ripple + slow deep gulps.
    float flow = 0.45 + 0.55 * sin(vU * 24.0 - uTime * 9.0 + vSeed * 6.2832);
    float gulp = 0.7 + 0.3 * sin(vU * 7.0 - uTime * 3.4 + vSeed * 4.0);
    // Ease off the body and fade just before the crystal so neither end cuts hard.
    float ends = smoothstep(0.0, 0.1, vU) * (1.0 - smoothstep(0.88, 1.0, vU));
    // The stream runs hotter as it approaches the core — it's being consumed.
    float feed = 0.5 + 0.5 * vU;
    float energy = core * (0.5 + 0.5 * flow) + ridge * edge * 0.6;
    float body = edge * (0.25 + 0.45 * turb);
    float a = (body * 0.4 + energy) * ends * feed * gulp * uIntensity * 0.8;
    vec3 col = mix(uColorA, uColorB, clamp(vU * vU + core * 0.35, 0.0, 1.0));
    // Push the filament past the bloom threshold; the body stays gauzy violet.
    col = col * (0.9 + 1.7 * energy * feed) + vec3(0.95, 0.62, 1.15) * core * flow * feed;
    gl_FragColor = vec4(col, min(a, 0.9));
  }
`;

/** All braid strands share one geometry/draw call: SEGS×2 billboarded verts each. */
const makeTendrils = () => {
  const geo = new BufferGeometry();
  const positions = new Float32Array(STRANDS * SEGS * 2 * 3);
  const us = new Float32Array(STRANDS * SEGS * 2);
  const vs = new Float32Array(STRANDS * SEGS * 2);
  const seeds = new Float32Array(STRANDS * SEGS * 2);
  const index: number[] = [];
  for (let tn = 0; tn < STRANDS; tn++) {
    const base = tn * SEGS * 2;
    for (let i = 0; i < SEGS; i++) {
      const u = i / (SEGS - 1);
      us[base + i * 2] = u;
      us[base + i * 2 + 1] = u;
      vs[base + i * 2] = -1;
      vs[base + i * 2 + 1] = 1;
      seeds[base + i * 2] = tn / STRANDS;
      seeds[base + i * 2 + 1] = tn / STRANDS;
      if (i < SEGS - 1) {
        const a = base + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aU', new BufferAttribute(us, 1));
  geo.setAttribute('aV', new BufferAttribute(vs, 1));
  geo.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geo.setIndex(index);
  const mat = new ShaderMaterial({
    vertexShader: drainVert,
    fragmentShader: drainFrag,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColorA: { value: new Color(VIOLET) },
      uColorB: { value: new Color(MAGENTA) },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  return { geo, mat };
};

// Scratch space — no per-frame allocation.
const spine: Vector3[] = Array.from({ length: SEGS }, () => new Vector3());
const pts: Vector3[][] = Array.from({ length: STRANDS }, () =>
  Array.from({ length: SEGS }, () => new Vector3()),
);
const p0 = new Vector3();
const p1 = new Vector3();
const dir = new Vector3();
const perp = new Vector3();
const ctrl = new Vector3();
const tangent = new Vector3();
const norm1 = new Vector3();
const norm2 = new Vector3();
const toCam = new Vector3();
const side = new Vector3();
const UP = new Vector3(0, 1, 0);
const dummy = new Object3D();

/** Pseudo-random per-mote constants (stable across frames). */
const moteSeed = Array.from({ length: MOTES }, (_, k) => ({
  tendril: k % STRANDS,
  u: (k * 0.618034) % 1,
  speed: 0.2 + 0.12 * ((k * 0.377) % 1),
  jx: Math.sin(k * 12.9898) * 0.11,
  jy: Math.sin(k * 78.233) * 0.09,
  jz: Math.sin(k * 39.425) * 0.11,
  phase: (k * 2.399) % (Math.PI * 2),
}));

export const RelicDrainVFX = () => {
  const tendrilMesh = useRef<Mesh>(null);
  const motes = useRef<InstancedMesh>(null);
  const tendrils = useMemo(makeTendrils, []);

  // Corruption build state: which carrier, since when, and the smoothed intensity.
  const hold = useRef<{ carrier: unknown; since: number; intensity: number }>({
    carrier: undefined,
    since: 0,
    intensity: 0,
  });
  // Smoothed crystal position replicating Relic.tsx's visual chase (FOLLOW_RATE + bob),
  // so the tendrils terminate on the drawn crystal, not the logical anchor it lags.
  const relicVis = useRef<{ pos: Vector3; started: boolean }>({
    pos: new Vector3(),
    started: false,
  });

  useFrame((state, dt) => {
    const t = performance.now() * 0.001;
    const relic = relics.first;
    const s = relic?.relic;
    const carrier = s?.phase === 'carried' ? s.carrier : undefined;
    const h = hold.current;

    // Handoff (or drop) resets the build — passing sheds the corruption.
    if (carrier !== h.carrier) {
      h.carrier = carrier;
      h.since = t;
    }
    const target = carrier?.transform
      ? BASE_INTENSITY + (1 - BASE_INTENSITY) * Math.min(1, (t - h.since) / RAMP_S)
      : 0;
    // Latch on quickly, let go even faster (the throw should cut the strands clean).
    const rate = target > h.intensity ? 4 : 10;
    h.intensity += (target - h.intensity) * (1 - Math.exp(-rate * dt));
    const intensity = h.intensity;

    const show = intensity > 0.02 && carrier?.transform !== undefined && relic !== undefined;
    const tm = tendrilMesh.current;
    const mo = motes.current;
    if (tm) tm.visible = show;
    if (mo) mo.visible = show;
    if (!show || !carrier?.transform || !relic) {
      relicVis.current.started = false;
      if (mo) {
        mo.count = 0;
        mo.instanceMatrix.needsUpdate = true;
      }
      return;
    }

    // ── Drawn-crystal position: same chase + bob as Relic.tsx, phase-identical ──
    const [rx, ry, rz] = relic.transform.position;
    const rv = relicVis.current;
    const bobAmp = passAim.aiming ? 0.02 : 0.07;
    const bob = Math.sin(t * 2.2) * bobAmp;
    if (!rv.started) {
      rv.pos.set(rx, ry + bob, rz);
      rv.started = true;
    } else {
      const k = 1 - Math.exp(-RELIC_FOLLOW_RATE * dt);
      rv.pos.x += (rx - rv.pos.x) * k;
      rv.pos.y += (ry + bob - rv.pos.y) * k;
      rv.pos.z += (rz - rv.pos.z) * k;
    }

    // ── Spine: single latch point → wobbling Bézier → crystal ──
    const cp = carrier.transform.position;
    const cr = carrier.transform.rotationY;
    const cos = Math.cos(cr);
    const sin = Math.sin(cr);
    const [ox, oy, oz] = LATCH_OFFSET;
    p0.set(cp[0] + ox * cos + oz * sin, cp[1] + oy, cp[2] - ox * sin + oz * cos);
    p1.copy(rv.pos);
    dir.copy(p1).sub(p0);
    perp.crossVectors(dir, UP);
    const plen = perp.length();
    if (plen > 1e-5) perp.divideScalar(plen);
    else perp.set(1, 0, 0);
    // Slow drift of the whole tether + a faster ripple along it (zeroed at the
    // ends so the latch and the crystal contact never detach).
    const wob = Math.sin(t * 1.7) * 0.12;
    const lift = 0.1 + 0.05 * Math.sin(t * 1.3);
    ctrl
      .copy(p0)
      .addScaledVector(dir, 0.5)
      .addScaledVector(perp, wob)
      .addScaledVector(UP, lift);
    for (let i = 0; i < SEGS; i++) {
      const u = i / (SEGS - 1);
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      const ripple = Math.sin(u * 9 + t * 5) * 0.045 * Math.sin(u * Math.PI) * intensity;
      spine[i]!.set(
        p0.x * w0 + ctrl.x * w1 + p1.x * w2 + perp.x * ripple,
        p0.y * w0 + ctrl.y * w1 + p1.y * w2 + perp.y * ripple,
        p0.z * w0 + ctrl.z * w1 + p1.z * w2 + perp.z * ripple,
      );
    }

    // ── Braid: strands wind helically around the spine, merging at both ends,
    //    the twist screwing itself toward the crystal ──
    for (let i = 0; i < SEGS; i++) {
      const u = i / (SEGS - 1);
      // Local frame perpendicular to the spine at this sample.
      tangent.copy(spine[Math.min(i + 1, SEGS - 1)]!).sub(spine[Math.max(i - 1, 0)]!);
      norm1.crossVectors(tangent, UP);
      const n1len = norm1.length();
      if (n1len > 1e-5) norm1.divideScalar(n1len);
      else norm1.set(1, 0, 0);
      norm2.crossVectors(tangent, norm1).normalize();
      // Strands pinch together at the latch and the crystal, bellying between.
      const braidR = BRAID_R * Math.pow(Math.sin(u * Math.PI), 0.65) * (0.6 + 0.4 * intensity);
      const twist = u * BRAID_TURNS * Math.PI * 2 - t * BRAID_FLOW;
      for (let tn = 0; tn < STRANDS; tn++) {
        const theta = twist + (tn * Math.PI * 2) / STRANDS;
        pts[tn]![i]!
          .copy(spine[i]!)
          .addScaledVector(norm1, Math.cos(theta) * braidR)
          .addScaledVector(norm2, Math.sin(theta) * braidR);
      }
    }

    // ── Billboarded strip update (same technique as the pass ribbon) ──
    if (tm) {
      const pos = tendrils.geo.getAttribute('position') as BufferAttribute;
      const camPos = state.camera.position;
      for (let tn = 0; tn < STRANDS; tn++) {
        const line = pts[tn]!;
        const base = tn * SEGS * 2;
        for (let i = 0; i < SEGS; i++) {
          const p = line[i]!;
          tangent.copy(line[Math.min(i + 1, SEGS - 1)]!).sub(line[Math.max(i - 1, 0)]!);
          toCam.copy(camPos).sub(p);
          side.crossVectors(tangent, toCam);
          const len = side.length();
          if (len > 1e-5) side.divideScalar(len);
          const u = i / (SEGS - 1);
          // Slim braid strands — the rope's body comes from three of them overlapping,
          // widest at the body and converging on the crystal: draining IN.
          const halfW = (0.055 - 0.03 * u) * (0.5 + 0.5 * intensity);
          pos.setXYZ(base + i * 2, p.x + side.x * halfW, p.y + side.y * halfW, p.z + side.z * halfW);
          pos.setXYZ(base + i * 2 + 1, p.x - side.x * halfW, p.y - side.y * halfW, p.z - side.z * halfW);
        }
      }
      pos.needsUpdate = true;
      tendrils.mat.uniforms.uTime!.value = t;
      tendrils.mat.uniforms.uIntensity!.value = intensity;
    }

    // ── Essence motes: torn off the body, converging onto the crystal, shrinking ──
    if (mo) {
      let n = 0;
      for (const seed of moteSeed) {
        const u = (seed.u + t * seed.speed) % 1;
        const line = pts[seed.tendril]!;
        const f = u * (SEGS - 1);
        const i0 = Math.floor(f);
        const a = line[i0]!;
        const b = line[Math.min(SEGS - 1, i0 + 1)]!;
        const k = f - i0;
        // Scattered near the body, funnelling tight as the crystal swallows them.
        const scatter = 1 - u;
        const tw = 0.5 + 0.5 * Math.sin(t * 4.5 + seed.phase);
        dummy.position.set(
          a.x + (b.x - a.x) * k + seed.jx * scatter,
          a.y + (b.y - a.y) * k + seed.jy * scatter,
          a.z + (b.z - a.z) * k + seed.jz * scatter,
        );
        dummy.scale.setScalar((0.018 + 0.03 * tw) * (1 - 0.55 * u) * intensity);
        dummy.updateMatrix();
        mo.setMatrixAt(n, dummy.matrix);
        n++;
      }
      mo.count = n;
      mo.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <mesh
        ref={tendrilMesh}
        geometry={tendrils.geo}
        material={tendrils.mat}
        visible={false}
        frustumCulled={false}
      />
      <instancedMesh ref={motes} args={[undefined, undefined, MOTES]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial
          color={MOTE_LILAC}
          toneMapped={false}
          transparent
          opacity={0.85}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>
    </group>
  );
};
