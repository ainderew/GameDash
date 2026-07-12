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
import type { Group, InstancedMesh, Mesh, MeshBasicMaterial } from 'three';
import { passAim } from '@/game/combat/passAim';
import { sampleBezier } from '@sim/combat/passTargeting';
import { localPlayers, relics, world } from '@/game/ecs/world';
import { gameNow } from '@/game/feel/time';
import { relicNet } from '@/net/relicNet';
import { netClient } from '@/net/client';
import type { Entity } from '@sim/components';
import {
  RELIC_CATCH_SOCKET_Y,
  RELIC_FAIL_HOT_MS,
  RELIC_GROUND_HOVER,
} from '@shared/balance';

/**
 * World-space pass readout:
 *  1. TRAJECTORY RIBBON — a billboarded, tapered light ribbon along the Bézier (aim
 *     preview AND live flight), turquoise fading to amber with energy flowing toward
 *     the receiver, plus gold-dust sparkles drifting along it. A predicted throw, not
 *     a beam that's already damaging someone (spec §7).
 *  2. RECEIVER MARKERS — the locked receiver gets the full set (per Andrew's ref):
 *     a turquoise ground circle at their FEET, a camera-facing broken-circle of arcs
 *     around the body, and a gold diamond floating overhead. Other candidates get a
 *     faint ground ring; the incoming receiver gets an AMBER ground ring contracting
 *     with time-to-impact. Everything ground/marker lives at the feet, never the neck.
 *  3. GROUNDED HOLO — a holographic beacon over a resting relic: vertical-faded beam
 *     with spiralling scanlines and an expanding base pulse, running hot after a
 *     failed pass (spec §13's "bright world marker").
 */

const RIBBON_N = 32;
const SPARKLES = 18;
const MAX_RINGS = 6;
/** Ribbon fades in over this window after launch so the release doesn't pop. */
const FLIGHT_FADE_MS = 80;

const TURQUOISE = '#2dd4bf';
const AMBER = '#fbbf24';
const GOLD = '#ffd27a';

// ── Trajectory ribbon: camera-facing tapered strip, shader-driven flow ──────

const ribbonVert = /* glsl */ `
  attribute float aU;
  attribute float aV;
  varying float vU;
  varying float vV;
  void main() {
    vU = aU;
    vV = aV;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ribbonFrag = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying float vU;
  varying float vV;
  void main() {
    // Soft transverse falloff (bright core, feathered edges).
    float edge = 1.0 - vV * vV;
    edge *= edge;
    // Energy pulses streaming toward the receiver.
    float flow = 0.62 + 0.38 * sin(vU * 21.0 - uTime * 8.0);
    // Ease both ends so the ribbon never cuts off hard.
    float ends = smoothstep(0.0, 0.05, vU) * (1.0 - smoothstep(0.85, 1.0, vU));
    vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 1.0, vU));
    float a = edge * ends * flow * uOpacity;
    gl_FragColor = vec4(col * (1.15 + 0.85 * flow), a);
  }
`;

const makeRibbon = () => {
  const geo = new BufferGeometry();
  const positions = new Float32Array(RIBBON_N * 2 * 3);
  const us = new Float32Array(RIBBON_N * 2);
  const vs = new Float32Array(RIBBON_N * 2);
  const index: number[] = [];
  for (let i = 0; i < RIBBON_N; i++) {
    const u = i / (RIBBON_N - 1);
    us[i * 2] = u;
    us[i * 2 + 1] = u;
    vs[i * 2] = -1;
    vs[i * 2 + 1] = 1;
    if (i < RIBBON_N - 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aU', new BufferAttribute(us, 1));
  geo.setAttribute('aV', new BufferAttribute(vs, 1));
  geo.setIndex(index);
  const mat = new ShaderMaterial({
    vertexShader: ribbonVert,
    fragmentShader: ribbonFrag,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uColorA: { value: new Color(TURQUOISE) },
      uColorB: { value: new Color(AMBER) },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  return { geo, mat };
};

// ── Grounded holo beam: vertical fade + spiralling scanlines ───────────────

const beamVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const beamFrag = /* glsl */ `
  uniform float uTime;
  uniform float uHot;
  varying vec2 vUv;
  void main() {
    // Fade out with height — a light pillar, not a painted cylinder.
    float vert = pow(1.0 - vUv.y, 1.7);
    // Spiralling holo scanlines drifting upward.
    float bands = 0.72 + 0.28 * sin(vUv.y * 26.0 + vUv.x * 12.566 - uTime * 3.2);
    // Gentle breathing; urgent flicker while hot (just-failed pass).
    float pulse = mix(0.82 + 0.18 * sin(uTime * 2.4), 0.6 + 0.4 * sin(uTime * 16.0), uHot);
    vec3 gold = vec3(1.0, 0.82, 0.45);
    float a = vert * bands * pulse * mix(0.30, 0.55, uHot);
    gl_FragColor = vec4(gold * (1.0 + 0.6 * vert), a);
  }
`;

const makeBeamMaterial = () =>
  new ShaderMaterial({
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    uniforms: { uTime: { value: 0 }, uHot: { value: 0 } },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

// ── Targeting marker shaders ────────────────────────────────────────────────

const quadVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Ground selection disc: a bright main ring, a rotating dashed inner ring, slow
 * sweeping highlight ticks, and a soft interior glow — drawn as SDF bands on a quad.
 * Additive + no depth write so it reads through tall grass instead of sinking into it.
 */
const groundDiscFrag = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;            // 0 center → 1 at quad edge
    float ang = atan(p.y, p.x);
    // Main ring with a crisp core and a soft skirt.
    float main1 = smoothstep(0.05, 0.005, abs(r - 0.84));
    float skirt = smoothstep(0.16, 0.0, abs(r - 0.84)) * 0.25;
    // Inner dashed ring, rotating against the sweep.
    float dashes = smoothstep(0.035, 0.0, abs(r - 0.58)) *
      (0.30 + 0.70 * smoothstep(0.15, 0.75, sin(ang * 16.0 + uTime * 2.4)));
    // Four bright ticks sweeping slowly around the main ring.
    float ticks = smoothstep(0.09, 0.0, abs(r - 0.84)) *
      pow(max(0.0, sin(ang * 2.0 - uTime * 0.9)), 12.0);
    // Faint interior wash so the circle reads as a zone, not a line.
    float wash = (1.0 - smoothstep(0.0, 0.85, r)) * 0.07;
    float a = (main1 * 0.95 + skirt + dashes * 0.55 + ticks * 1.3 + wash) * uOpacity;
    gl_FragColor = vec4(uColor * (1.0 + ticks * 1.2 + main1 * 0.35), a);
  }
`;

/** Body-bracket arc: tapered ends (comet, not a pipe) with a brighter leading edge. */
const arcFrag = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float along = vUv.x;
    float taper = sin(along * 3.14159);   // fade in and out along the arc
    taper *= taper;
    float head = 0.55 + 0.45 * along;      // leading tip runs hotter
    float shimmer = 0.85 + 0.15 * sin(along * 9.0 - uTime * 5.0);
    float a = taper * head * shimmer * uOpacity;
    gl_FragColor = vec4(uColor * (1.0 + 0.8 * head * taper), a);
  }
`;

/** Fresnel rim shell for the overhead diamond — edges glow, faces stay glassy. */
const rimVert = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalMatrix * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const rimFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 1.6);
    gl_FragColor = vec4(uColor * 1.5, (0.12 + rim) * uOpacity);
  }
`;

/** Soft radial halo sprite behind the diamond. */
const haloFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - r), 2.6) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

const markerMaterial = (frag: string, hex: string, vert = quadVert): ShaderMaterial =>
  new ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new Color(hex) },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

// Scratch space — no per-frame allocation.
const pts: Vector3[] = Array.from({ length: RIBBON_N }, () => new Vector3());
const tangent = new Vector3();
const toCam = new Vector3();
const side = new Vector3();
const flightPoint: [number, number, number] = [0, 0, 0];
const dummy = new Object3D();

/** Pseudo-random per-sparkle constants (stable across frames). */
const sparkleSeed = Array.from({ length: SPARKLES }, (_, k) => ({
  u: (k + 0.5) / SPARKLES,
  jx: Math.sin(k * 12.9898) * 0.16,
  jy: Math.sin(k * 78.233) * 0.14,
  jz: Math.sin(k * 39.425) * 0.16,
  phase: (k * 2.399) % (Math.PI * 2),
}));

export const PassAimUI = () => {
  const ribbonMesh = useRef<Mesh>(null);
  const sparkles = useRef<InstancedMesh>(null);
  const selGround = useRef<Mesh>(null);
  const selArcs = useRef<Group>(null);
  const selArcSpin = useRef<Group>(null);
  const selDiamond = useRef<Group>(null);
  const selDiamondSpin = useRef<Group>(null);
  const halo = useRef<Mesh>(null);
  const incoming = useRef<Mesh>(null);
  const beam = useRef<Mesh>(null);
  const groundRing = useRef<Mesh>(null);
  const pulseRing = useRef<Mesh>(null);
  const rings = useRef<(Mesh | null)[]>([]);
  const ringRefs = useMemo(
    () => Array.from({ length: MAX_RINGS }, (_, k) => (el: Mesh | null) => (rings.current[k] = el)),
    [],
  );

  const ribbon = useMemo(makeRibbon, []);
  const beamMat = useMemo(makeBeamMaterial, []);
  const selGroundMat = useMemo(() => markerMaterial(groundDiscFrag, TURQUOISE), []);
  const incomingMat = useMemo(() => markerMaterial(groundDiscFrag, AMBER), []);
  const arcMat = useMemo(() => markerMaterial(arcFrag, TURQUOISE), []);
  const rimMat = useMemo(() => markerMaterial(rimFrag, AMBER, rimVert), []);
  const haloMat = useMemo(() => markerMaterial(haloFrag, GOLD), []);
  const candMats = useMemo(
    () => Array.from({ length: MAX_RINGS }, () => markerMaterial(groundDiscFrag, TURQUOISE)),
    [],
  );

  useFrame((state) => {
    const t = performance.now() * 0.001;
    const relic = relics.first;
    const s = relic?.relic;
    const netRelic = relicNet.state;
    const networked = netRelic.phase !== 'absent';
    const netFlight = networked && netRelic.phase === 'inFlight' ? netRelic.flight : null;
    const inFlightPass = networked
      ? netFlight?.mode === 'pass'
      : s?.phase === 'inFlight' && s.mode === 'pass';
    const grounded = networked ? netRelic.phase === 'grounded' : s?.phase === 'grounded';

    // ── Ribbon source: aim preview OR live remaining flight path ───────────
    let count = 0;
    let opacity = 0;
    if (passAim.aiming && passAim.curve.length > 1) {
      const src = passAim.curve;
      // Resample the stored curve onto the ribbon's fixed segment count.
      for (let i = 0; i < RIBBON_N; i++) {
        const f = (i / (RIBBON_N - 1)) * (src.length - 1);
        const i0 = Math.floor(f);
        const i1 = Math.min(src.length - 1, i0 + 1);
        const k = f - i0;
        const a = src[i0]!;
        const b = src[i1]!;
        pts[i]!.set(
          a[0] + (b[0] - a[0]) * k,
          a[1] + (b[1] - a[1]) * k,
          a[2] + (b[2] - a[2]) * k,
        );
      }
      count = RIBBON_N;
      opacity = passAim.valid ? 0.85 : 0.28; // low until locked, solid when it would fly
    } else if (networked && netFlight?.mode === 'pass') {
      const now = netClient.serverNow();
      const ft = Math.min(1, (now - netFlight.startedAt) / netFlight.flightMs);
      const fade = Math.min(1, (now - netFlight.startedAt) / FLIGHT_FADE_MS);
      for (let i = 0; i < RIBBON_N; i++) {
        const tt = ft + (1 - ft) * (i / (RIBBON_N - 1));
        sampleBezier(netFlight.from, netFlight.control, netFlight.to, tt, flightPoint);
        pts[i]!.set(flightPoint[0], flightPoint[1], flightPoint[2]);
      }
      count = RIBBON_N;
      opacity = 0.95 * fade;
    } else if (inFlightPass && s?.from && s.control && s.to) {
      const now = gameNow();
      const ft = Math.min(1, (now - (s.startedAt ?? now)) / (s.flightMs ?? 1));
      const fade = Math.min(1, (now - (s.startedAt ?? now)) / FLIGHT_FADE_MS);
      for (let i = 0; i < RIBBON_N; i++) {
        const tt = ft + (1 - ft) * (i / (RIBBON_N - 1));
        sampleBezier(s.from, s.control, s.to, tt, flightPoint);
        pts[i]!.set(flightPoint[0], flightPoint[1], flightPoint[2]);
      }
      count = RIBBON_N;
      opacity = 0.95 * fade;
    }

    // ── Ribbon mesh update: billboarded tapered strip along the samples ────
    const rm = ribbonMesh.current;
    if (rm) {
      rm.visible = count > 1;
      if (count > 1) {
        const pos = ribbon.geo.getAttribute('position') as BufferAttribute;
        const camPos = state.camera.position;
        for (let i = 0; i < RIBBON_N; i++) {
          const p = pts[i]!;
          tangent.copy(pts[Math.min(i + 1, RIBBON_N - 1)]!).sub(pts[Math.max(i - 1, 0)]!);
          toCam.copy(camPos).sub(p);
          side.crossVectors(tangent, toCam);
          const len = side.length();
          if (len > 1e-5) side.divideScalar(len);
          const u = i / (RIBBON_N - 1);
          const halfW = 0.24 - 0.17 * u; // thick at the relic, narrowing to the receiver
          pos.setXYZ(i * 2, p.x + side.x * halfW, p.y + side.y * halfW, p.z + side.z * halfW);
          pos.setXYZ(i * 2 + 1, p.x - side.x * halfW, p.y - side.y * halfW, p.z - side.z * halfW);
        }
        pos.needsUpdate = true;
        ribbon.mat.uniforms.uTime!.value = t;
        ribbon.mat.uniforms.uOpacity!.value = opacity;
      }
    }

    // ── Gold-dust sparkles drifting along the ribbon ───────────────────────
    const sp = sparkles.current;
    if (sp) {
      let n = 0;
      if (count > 1) {
        for (const seed of sparkleSeed) {
          // Each mote drifts toward the receiver, wrapping; twinkles on its own phase.
          const u = (seed.u + t * 0.22) % 1;
          const f = u * (RIBBON_N - 1);
          const i0 = Math.floor(f);
          const p0 = pts[i0]!;
          const p1 = pts[Math.min(RIBBON_N - 1, i0 + 1)]!;
          const k = f - i0;
          const tw = 0.5 + 0.5 * Math.sin(t * 5.0 + seed.phase);
          dummy.position.set(
            p0.x + (p1.x - p0.x) * k + seed.jx,
            p0.y + (p1.y - p0.y) * k + seed.jy,
            p0.z + (p1.z - p0.z) * k + seed.jz,
          );
          dummy.scale.setScalar(0.016 + 0.03 * tw * opacity);
          dummy.updateMatrix();
          sp.setMatrixAt(n, dummy.matrix);
          n++;
        }
      }
      sp.count = n;
      sp.instanceMatrix.needsUpdate = true;
    }

    // ── Aim: locked receiver marker set (ground disc + body arcs + diamond) ──
    {
      const target = passAim.aiming ? passAim.target : null;
      const show = target?.transform !== undefined;
      const g1 = selGround.current;
      const g2 = selArcs.current;
      const g3 = selDiamond.current;
      if (g1) g1.visible = show;
      if (g2) g2.visible = show;
      if (g3) g3.visible = show;
      if (show && target?.transform && g1 && g2 && g3) {
        const [x, y, z] = target.transform.position;
        // Ground disc at the FEET — the primary "you're passing to them" read.
        g1.position.set(x, y + 0.05, z);
        g1.rotation.x = -Math.PI / 2;
        g1.scale.setScalar(1 + Math.sin(t * 3.2) * 0.03);
        selGroundMat.uniforms.uTime!.value = t;
        // Broken-circle arcs around the body, always facing the camera, slowly turning.
        g2.position.set(x, y + 1.05, z);
        g2.lookAt(state.camera.position);
        if (selArcSpin.current) selArcSpin.current.rotation.z = t * 0.9;
        arcMat.uniforms.uTime!.value = t;
        // Gold diamond overhead: rim-lit shell + hot core spinning, halo billboarded.
        g3.position.set(x, y + 2.15 + Math.sin(t * 2.6) * 0.07, z);
        if (selDiamondSpin.current) selDiamondSpin.current.rotation.y = t * 2.2;
        if (halo.current) halo.current.quaternion.copy(state.camera.quaternion);
        haloMat.uniforms.uOpacity!.value = 0.5 + 0.18 * Math.sin(t * 4.2);
      }
    }
    let r = 0;
    if (passAim.aiming) {
      for (const c of passAim.candidates) {
        if (c.entity === passAim.target || r >= MAX_RINGS) continue;
        const ring = rings.current[r];
        const tf = c.entity.transform;
        if (!ring || !tf) continue;
        ring.visible = true;
        // Candidates: faint ground disc at the feet (hollow-dim while on cooldown).
        ring.position.set(tf.position[0], tf.position[1] + 0.05, tf.position[2]);
        ring.rotation.x = -Math.PI / 2;
        const m = candMats[r]!;
        m.uniforms.uTime!.value = t;
        m.uniforms.uOpacity!.value = c.eligible ? 0.45 : 0.14;
        r++;
      }
    }
    for (; r < MAX_RINGS; r++) {
      const ring = rings.current[r];
      if (ring) ring.visible = false;
    }

    // ── In-flight: amber catch ring contracting with time-to-impact ────────
    const inc = incoming.current;
    if (inc) {
      let target: Entity | undefined;
      if (inFlightPass && networked && netFlight?.targetId !== undefined) {
        if (netFlight.targetId === netClient.localEntityId()) target = localPlayers.first;
        else {
          for (const entity of world.with('transform')) {
            if (entity.serverEntityId === netFlight.targetId) {
              target = entity;
              break;
            }
          }
        }
      } else if (inFlightPass) target = s?.target;
      inc.visible = target?.transform !== undefined;
      if (target?.transform) {
        const now = networked ? netClient.serverNow() : gameNow();
        const startedAt = networked ? (netFlight?.startedAt ?? now) : (s?.startedAt ?? now);
        const flightMs = networked ? (netFlight?.flightMs ?? 1) : (s?.flightMs ?? 1);
        const ft = Math.min(1, (now - startedAt) / flightMs);
        const [x, y, z] = target.transform.position;
        inc.position.set(x, y + 0.05, z); // ground disc at the feet, like all markers
        inc.rotation.x = -Math.PI / 2;
        inc.scale.setScalar(1 + 1.2 * (1 - ft)); // 2.2× → 1× as the relic arrives
        incomingMat.uniforms.uTime!.value = t;
      }
    }

    // ── Grounded holo: scanline beam + breathing ring + expanding pulse ────
    const bm = beam.current;
    const gr = groundRing.current;
    const pr = pulseRing.current;
    if (bm && gr && pr) {
      bm.visible = grounded === true;
      gr.visible = grounded === true;
      pr.visible = grounded === true;
      if (grounded && (networked || relic)) {
        const now = gameNow();
        const hot = !networked && s?.failedAt !== undefined && now - s.failedAt < RELIC_FAIL_HOT_MS;
        const [x, y, z] = networked ? netRelic.pos : relic!.transform.position;
        const groundY = y - RELIC_GROUND_HOVER;
        bm.position.set(x, groundY + 2.5, z);
        beamMat.uniforms.uTime!.value = t;
        beamMat.uniforms.uHot!.value = hot ? 1 : 0;
        gr.position.set(x, groundY + 0.05, z);
        gr.rotation.x = Math.PI / 2;
        gr.scale.setScalar(1 + (hot ? 0.2 * Math.sin(t * 16) : 0.08 * Math.sin(t * 2.4)));
        (gr.material as MeshBasicMaterial).opacity = hot ? 0.85 : 0.5;
        // Beacon pulse: a ring blooming outward and fading, looping.
        const cycle = ((t % 1.6) / 1.6) * (hot ? 2 : 1) % 1;
        pr.position.set(x, groundY + 0.08, z);
        pr.rotation.x = Math.PI / 2;
        pr.scale.setScalar(0.7 + cycle * 1.6);
        (pr.material as MeshBasicMaterial).opacity = (1 - cycle) * (hot ? 0.6 : 0.35);
      }
    }
  });

  return (
    <group>
      <mesh ref={ribbonMesh} geometry={ribbon.geo} material={ribbon.mat} visible={false} frustumCulled={false} />
      <instancedMesh ref={sparkles} args={[undefined, undefined, SPARKLES]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial color={GOLD} toneMapped={false} transparent opacity={0.9} blending={AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      {/* Locked receiver marker set (per the reference image): detailed ground disc at
          the feet, camera-facing tapered arc brackets, composite gold diamond overhead. */}
      <mesh ref={selGround} material={selGroundMat} visible={false}>
        <planeGeometry args={[1.7, 1.7]} />
      </mesh>
      <group ref={selArcs} visible={false}>
        <group ref={selArcSpin}>
          {/* Two ~115° comet arcs with gaps — tapered ends, hot leading edge. */}
          <mesh rotation={[0, 0, 0.45]} material={arcMat}>
            <torusGeometry args={[0.78, 0.032, 8, 48, 2.0]} />
          </mesh>
          <mesh rotation={[0, 0, 0.45 + Math.PI]} material={arcMat}>
            <torusGeometry args={[0.78, 0.032, 8, 48, 2.0]} />
          </mesh>
        </group>
      </group>
      <group ref={selDiamond} visible={false}>
        {/* Soft halo (billboarded), fresnel shell, and a hot core spinning inside. */}
        <mesh ref={halo} material={haloMat}>
          <planeGeometry args={[0.85, 0.85]} />
        </mesh>
        <group ref={selDiamondSpin}>
          <mesh material={rimMat} scale={[0.16, 0.235, 0.16]}>
            <octahedronGeometry args={[1, 0]} />
          </mesh>
          <mesh scale={[0.075, 0.115, 0.075]}>
            <octahedronGeometry args={[1, 0]} />
            <meshBasicMaterial color={AMBER} toneMapped={false} transparent opacity={0.95} blending={AdditiveBlending} depthWrite={false} />
          </mesh>
        </group>
      </group>
      {/* Incoming-pass warning: amber, contracts — reads differently from the aim lock
          by both color AND motion (spec: never color alone). */}
      <mesh ref={incoming} material={incomingMat} visible={false}>
        <planeGeometry args={[1.7, 1.7]} />
      </mesh>
      {ringRefs.map((setRef, k) => (
        <mesh key={k} ref={setRef} material={candMats[k]} visible={false}>
          <planeGeometry args={[1.3, 1.3]} />
        </mesh>
      ))}
      {/* Grounded holo beacon: shader beam (vertical fade + scanlines), breathing ring,
          and an expanding pulse ring. Additive + no depth write so it reads through
          grass without ever occluding the relic. */}
      <mesh ref={beam} material={beamMat} visible={false}>
        <cylinderGeometry args={[0.34, 0.42, 5, 24, 1, true]} />
      </mesh>
      <mesh ref={groundRing} visible={false}>
        <torusGeometry args={[0.7, 0.03, 8, 40]} />
        <meshBasicMaterial color={AMBER} toneMapped={false} transparent opacity={0.5} />
      </mesh>
      <mesh ref={pulseRing} visible={false}>
        <torusGeometry args={[0.7, 0.02, 8, 40]} />
        <meshBasicMaterial color={GOLD} toneMapped={false} transparent opacity={0.35} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
};
