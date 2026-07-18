import { useTexture } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  LinearFilter,
  NormalBlending,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Group,
  type Mesh,
  type Texture,
} from 'three';
import { moveForAttack, moveTrailWindow, type ComboKey } from '@sim/combat/combo';
import { currentWeapon } from '@/game/combat/weaponStore';
import { weaponSockets } from '@/game/combat/weaponSockets';
import { world } from '@/game/ecs/world';
import { gameNow } from '@/game/feel/time';

const TEXTURE_URL = '/fx/sword_slash_flow.webp';
const RING_POINTS = 96;

const players = world.with('playerControlled', 'transform');

/** Max committed blade samples per swing; ~3cm of tip travel apart, so a full sweep fits. */
const MAX_SAMPLES = 160;
/** Squared tip travel (m²) required before the live sample is committed to history. */
const MIN_STEP_SQ = 0.03 * 0.03;

const TRAIL_MS: Readonly<Record<ComboKey, number>> = {
  horizontal: 300,
  reverse: 300,
  overhead: 300,
  thrust: 300,
};

const OPACITY: Readonly<Record<ComboKey, number>> = {
  horizontal: 0.98,
  reverse: 0.98,
  overhead: 1,
  thrust: 0.9,
};

const VERT = /* glsl */ `
  attribute float aArc;
  varying vec2 vUv;
  varying float vArc;

  void main() {
    vUv = uv;
    vArc = aArc;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uTint;
  uniform float uOpacity;
  uniform float uReveal;
  uniform float uErase;
  uniform float uLayer;
  uniform float uTime;
  varying vec2 vUv;
  varying float vArc;

  float energyMax(vec3 value) {
    return max(max(value.r, value.g), value.b);
  }

  void main() {
    float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
    float edgeCoord = abs(vUv.y * 2.0 - 1.0);
    float edgeFeather = smoothstep(0.02, 0.18, across);

    // The ring is always complete geometry. A triangular, shader-driven window reveals it from
    // the live sword end, matching the authored-mesh workflow used by the visual references.
    float revealedArc = clamp(0.055 + uReveal * 1.08, 0.0, 1.0);
    float revealMask = 1.0 - smoothstep(revealedArc, revealedArc + 0.055, vArc);
    float wakeFade = pow(clamp(1.0 - vArc, 0.0, 1.0), 0.62);

    // Death sweep: an erase front travels from the tail (vArc = 1) to the live blade end
    // (vArc = 0), so the crescent dies where the swing started first — never all at once.
    float eraseFront = 1.25 - uErase * 1.5;
    float eraseMask = 1.0 - smoothstep(eraseFront - 0.25, eraseFront, vArc);

    vec3 painted = max(texture2D(uMap, clamp(vUv, 0.01, 0.99)).rgb, vec3(0.0));
    float energy = energyMax(painted);
    float coverage = smoothstep(0.015, 0.34, energy);
    float flicker = 0.96 + sin(uTime * 24.0 + vArc * 31.0) * 0.04;

    if (uLayer < 0.5) {
      // Dark translucent body: it gives the bright rails a readable silhouette against snow,
      // sky and bloom instead of making the whole slash one clipped-white sheet.
      float alpha = uOpacity * revealMask * eraseMask * wakeFade * edgeFeather *
        mix(0.28, 0.88, coverage);
      if (alpha < 0.006) discard;
      vec3 darkBody = mix(uTint * 0.07, uTint * 0.48, coverage);
      vec3 textureColour = painted * mix(uTint * 0.16, vec3(0.34), 0.3);
      gl_FragColor = vec4((darkBody + textureColour * 0.42) * flicker, alpha);
    } else {
      // Separate additive pass: a hot texture layer plus two thin concentric edge rails. This is
      // the same bright-layer / second-layer separation used by the Niagara reference.
      float hotTexture = smoothstep(0.24, 0.86, energy);
      float edgeRail = smoothstep(0.70, 0.88, edgeCoord) *
        (1.0 - smoothstep(0.975, 1.0, edgeCoord));
      float coreRail = smoothstep(0.58, 0.82, across) *
        (1.0 - smoothstep(0.88, 0.98, across));
      float lightMask = max(hotTexture, max(edgeRail * 0.82, coreRail * 0.28));
      float alpha = uOpacity * revealMask * eraseMask * wakeFade * edgeFeather * lightMask * 0.82;
      if (alpha < 0.008) discard;
      vec3 hotColour = mix(uTint * 1.25, vec3(1.0), 0.72);
      gl_FragColor = vec4(hotColour * (1.35 + hotTexture * 0.85) * flicker, alpha);
    }
  }
`;

/** Catmull-Rom through a packed xyz sample array; `s` is in [0, count - 1]. */
const sampleCurve = (pts: Float32Array, count: number, s: number, out: Vector3): Vector3 => {
  const clamped = Math.min(count - 1, Math.max(0, s));
  const i1 = Math.min(count - 2, Math.floor(clamped));
  const t = clamped - i1;
  const i0 = Math.max(0, i1 - 1);
  const i2 = i1 + 1;
  const i3 = Math.min(count - 1, i2 + 1);
  const t2 = t * t;
  const t3 = t2 * t;
  const w0 = -0.5 * t3 + t2 - 0.5 * t;
  const w1 = 1.5 * t3 - 2.5 * t2 + 1;
  const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
  const w3 = 0.5 * t3 - 0.5 * t2;
  return out.set(
    pts[i0 * 3]! * w0 + pts[i1 * 3]! * w1 + pts[i2 * 3]! * w2 + pts[i3 * 3]! * w3,
    pts[i0 * 3 + 1]! * w0 + pts[i1 * 3 + 1]! * w1 + pts[i2 * 3 + 1]! * w2 + pts[i3 * 3 + 1]! * w3,
    pts[i0 * 3 + 2]! * w0 + pts[i1 * 3 + 2]! * w1 + pts[i2 * 3 + 2]! * w2 + pts[i3 * 3 + 2]! * w3,
  );
};

interface Swing {
  startedAt: number;
  activeStart: number;
  activeEnd: number;
  key: ComboKey;
  captureEndedAt: number | null;
}

/**
 * Fixed-topology slash ribbon threaded through the real blade path. Base and tip socket positions
 * are sampled while the authored delivery runs; the ribbon's outer edge passes through the actual
 * tip path and its inner edge reaches toward the actual base path, so the crescent renders exactly
 * where the sword body swept. No circle fitting — an earlier version fitted a circle to the
 * accumulated samples and the fit moved as history grew, detaching the effect from the weapon.
 */
const makeGeometry = (): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(new Float32Array(RING_POINTS * 2 * 3), 3),
  );

  const uvs = new Float32Array(RING_POINTS * 2 * 2);
  const arcs = new Float32Array(RING_POINTS * 2);
  for (let i = 0; i < RING_POINTS; i += 1) {
    const arc = i / (RING_POINTS - 1);
    // The painted texture's crisp leading rail is on its right side.
    const u = 0.04 + (1 - arc) * 0.92;
    const uvAt = i * 4;
    uvs[uvAt] = u;
    uvs[uvAt + 1] = 0;
    uvs[uvAt + 2] = u;
    uvs[uvAt + 3] = 1;
    arcs[i * 2] = arc;
    arcs[i * 2 + 1] = arc;
  }
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aArc', new Float32BufferAttribute(arcs, 1));

  const index: number[] = [];
  for (let i = 0; i < RING_POINTS - 1; i += 1) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  geometry.setIndex(index);
  geometry.setDrawRange(0, 0);
  return geometry;
};

const makeMaterial = (texture: Texture, glow: boolean): ShaderMaterial =>
  new ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uTint: { value: new Color('#bfe9ff') },
      uOpacity: { value: 0 },
      uReveal: { value: 0 },
      uErase: { value: 0 },
      uLayer: { value: glow ? 1 : 0 },
      uTime: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: glow ? AdditiveBlending : NormalBlending,
    side: DoubleSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });

export const SwordSwingFX = () => {
  const texture = useTexture(TEXTURE_URL);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  const geometry = useMemo(makeGeometry, []);
  const bodyMaterial = useMemo(() => makeMaterial(texture, false), [texture]);
  const glowMaterial = useMemo(() => makeMaterial(texture, true), [texture]);

  useEffect(
    () => () => {
      geometry.dispose();
      bodyMaterial.dispose();
      glowMaterial.dispose();
    },
    [bodyMaterial, geometry, glowMaterial],
  );

  const groupRef = useRef<Group>(null);
  const bodyMeshRef = useRef<Mesh>(null);
  const glowMeshRef = useRef<Mesh>(null);
  const swing = useRef<Swing | null>(null);
  const lastAttackStart = useRef(Number.NEGATIVE_INFINITY);

  const base = useRef(new Vector3());
  const tip = useRef(new Vector3());
  const anchor = useRef(new Vector3());
  const baseHist = useRef(new Float32Array(MAX_SAMPLES * 3));
  const tipHist = useRef(new Float32Array(MAX_SAMPLES * 3));
  const histCount = useRef(0);
  const pathBase = useRef(new Vector3());
  const pathTip = useRef(new Vector3());
  const inner = useRef(new Vector3());

  useFrame(() => {
    const bodyMesh = bodyMeshRef.current;
    const glowMesh = glowMeshRef.current;
    const player = players.first;
    if (!bodyMesh || !glowMesh || !player?.transform) return;

    const attack = player.attackState;
    if (attack && attack.startedAt !== lastAttackStart.current) {
      lastAttackStart.current = attack.startedAt;
      histCount.current = 0;
      groupRef.current?.position.set(0, 0, 0);
      geometry.setDrawRange(0, 0);

      if (attack.dashSlash) {
        // The dash skill keeps its bespoke Blender trail and socket ribbon.
        swing.current = null;
      } else {
        const move = moveForAttack(attack);
        if (!move.damaging) {
          swing.current = null;
          bodyMesh.visible = false;
          glowMesh.visible = false;
          return;
        }
        const active = moveTrailWindow(move);
        swing.current = {
          startedAt: attack.startedAt,
          activeStart: active.start,
          activeEnd: active.end,
          key: move.key,
          captureEndedAt: null,
        };
      }
    }

    const current = swing.current;
    if (!current) {
      bodyMesh.visible = false;
      glowMesh.visible = false;
      return;
    }

    const now = gameNow();
    const age = now - current.startedAt;
    const inDelivery = age >= current.activeStart && age <= current.activeEnd;
    const baseSocket = weaponSockets.base;
    const tipSocket = weaponSockets.tip;

    if (inDelivery && baseSocket && tipSocket) {
      baseSocket.getWorldPosition(base.current);
      tipSocket.getWorldPosition(tip.current);
      const baseArr = baseHist.current;
      const tipArr = tipHist.current;

      // Samples 0..count-2 are committed; the last one is "live" and stays glued to the blade.
      // A live sample is committed once the tip travels far enough, so the history is spaced by
      // arc length rather than framerate.
      if (histCount.current === 0) {
        for (const at of [0, 3]) {
          baseArr[at] = base.current.x;
          baseArr[at + 1] = base.current.y;
          baseArr[at + 2] = base.current.z;
          tipArr[at] = tip.current.x;
          tipArr[at + 1] = tip.current.y;
          tipArr[at + 2] = tip.current.z;
        }
        histCount.current = 2;
      } else {
        const live = (histCount.current - 1) * 3;
        baseArr[live] = base.current.x;
        baseArr[live + 1] = base.current.y;
        baseArr[live + 2] = base.current.z;
        tipArr[live] = tip.current.x;
        tipArr[live + 1] = tip.current.y;
        tipArr[live + 2] = tip.current.z;
        const fixed = live - 3;
        const dx = tipArr[live]! - tipArr[fixed]!;
        const dy = tipArr[live + 1]! - tipArr[fixed + 1]!;
        const dz = tipArr[live + 2]! - tipArr[fixed + 2]!;
        if (dx * dx + dy * dy + dz * dz > MIN_STEP_SQ && histCount.current < MAX_SAMPLES) {
          const next = live + 3;
          baseArr[next] = base.current.x;
          baseArr[next + 1] = base.current.y;
          baseArr[next + 2] = base.current.z;
          tipArr[next] = tip.current.x;
          tipArr[next + 1] = tip.current.y;
          tipArr[next + 2] = tip.current.z;
          histCount.current += 1;
        }
      }

      // Thread the ribbon through the sampled paths: outer edge on the true tip path, inner edge
      // reaching toward the true base path, tapering off toward the tail like the authored look.
      const count = histCount.current;
      const maxS = count - 1;
      const positions = geometry.getAttribute('position') as Float32BufferAttribute;
      const positionArray = positions.array as Float32Array;
      for (let i = 0; i < RING_POINTS; i += 1) {
        const arc = i / (RING_POINTS - 1);
        const s = (1 - arc) * maxS;
        sampleCurve(tipArr, count, s, pathTip.current);
        sampleCurve(baseArr, count, s, pathBase.current);

        const tailT = Math.min(1, Math.max(0, (arc - 0.52) / 0.48));
        const tailTaper = 1 - tailT * tailT * (3 - 2 * tailT);
        const middleBulge = 0.9 + 0.1 * Math.sin(Math.PI * arc);
        const bandFrac = Math.max(0.14, tailTaper * middleBulge);
        inner.current
          .copy(pathBase.current)
          .sub(pathTip.current)
          .multiplyScalar(bandFrac)
          .add(pathTip.current);

        const at = i * 6;
        positionArray[at] = inner.current.x;
        positionArray[at + 1] = inner.current.y;
        positionArray[at + 2] = inner.current.z;
        positionArray[at + 3] = pathTip.current.x;
        positionArray[at + 4] = pathTip.current.y;
        positionArray[at + 5] = pathTip.current.z;
      }
      positions.needsUpdate = true;
      geometry.setDrawRange(0, (RING_POINTS - 1) * 6);
    }

    if (current.captureEndedAt === null && age > current.activeEnd) {
      current.captureEndedAt = now;
      const [px, py, pz] = player.transform.position;
      anchor.current.set(px, py, pz);
    }

    if (current.captureEndedAt !== null && groupRef.current) {
      // Root motion keeps carrying the character through the follow-through; drag the frozen
      // crescent along with them so it stays hugging the body instead of being left behind.
      const [px, py, pz] = player.transform.position;
      groupRef.current.position.set(
        px - anchor.current.x,
        py - anchor.current.y,
        pz - anchor.current.z,
      );
    }

    const trailMs = TRAIL_MS[current.key];
    const endProgress =
      current.captureEndedAt === null
        ? 0
        : Math.min(1, Math.max(0, (now - current.captureEndedAt) / trailMs));
    if (endProgress >= 1) {
      geometry.setDrawRange(0, 0);
      bodyMesh.visible = false;
      glowMesh.visible = false;
      swing.current = null;
      return;
    }

    const attackProgress = Math.min(
      1,
      Math.max(
        0,
        (age - current.activeStart) / Math.max(1, current.activeEnd - current.activeStart),
      ),
    );
    // Fast ease-out grows the slash with the blade delivery; the mesh itself never changes its
    // circular topology, only its attached transform and shader window.
    const reveal = 1 - Math.pow(1 - attackProgress, 2.35);
    const trailColor = currentWeapon().trailColor;
    for (const material of [bodyMaterial, glowMaterial]) {
      material.uniforms.uTint!.value.set(trailColor);
      material.uniforms.uOpacity!.value = OPACITY[current.key];
      material.uniforms.uReveal!.value = reveal;
      material.uniforms.uErase!.value = endProgress;
      material.uniforms.uTime!.value = now * 0.001;
    }
    const visible = histCount.current >= 2 && geometry.drawRange.count > 0;
    bodyMesh.visible = visible;
    glowMesh.visible = visible;
  });

  return (
    <group ref={groupRef} name="authored-ring-sword-slash">
      <mesh
        ref={bodyMeshRef}
        name="sword-slash-dark-body"
        geometry={geometry}
        material={bodyMaterial}
        frustumCulled={false}
        renderOrder={4}
        visible={false}
      />
      <mesh
        ref={glowMeshRef}
        name="sword-slash-bright-layer"
        geometry={geometry}
        material={glowMaterial}
        frustumCulled={false}
        renderOrder={5}
        visible={false}
      />
    </group>
  );
};
