import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';

/**
 * RELIC CLAIM — POWER ABSORBED INTO THE BODY
 *
 * When a pass is caught, a LARGE field of energy collapses inward and is drawn INTO the
 * hero's body. Two coordinated reads carry the "absorption":
 *
 *   A. AURA COLLAPSE   a big teal energy shell starts wide around the hero and shrinks down
 *                      into the torso, fading as it reaches the body — the "starts large,
 *                      goes in" motion.
 *   B. IN-STREAMS      spiral streams funnel from a wide 3D volume toward the torso and
 *                      DISSOLVE as they reach it (they fade out before the center, so the
 *                      energy sinks INTO the body instead of piling into a bright flash).
 *
 * The body itself lights up (a teal emissive pulse driven through the hit-flash channel in
 * simHooks.onRelicCaught) so you see the character actually take the power in. There is no
 * free-floating white flash — the payoff is the glowing body.
 *
 * Distributing streams over a real 3D shell (some pass in front of the hero, some behind) +
 * depthTest (terrain/hero occlude what's behind them) is what makes it read as 3D and as
 * energy entering a body rather than a decal pasted on the screen. The hot values cross the
 * Bloom threshold (1.08, see PostFX); aged on REAL time so it plays through the catch hitstop.
 */

const LIFETIME_MS = 350;
const MAX_BURSTS = 3;
const RIBBONS = 130;
const SEGS = 16; // trail resolution
const START_R = 2.9; // how wide the field / streams begin — "large"
const TORSO_DROP = 0.15; // pull the convergence point down into the torso, not the neck

const COLOR_FAR = new Color(0.22, 0.9, 0.82); // teal energy at the rim
const COLOR_NEAR = new Color(0.9, 1.6, 1.5); // brighter cyan as it sinks in (not white-hot)
const AURA_COLOR = new Color(0.3, 0.95, 0.9);

const easeIn = (t: number): number => t * t;
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** Deterministic pseudo-random in [0,1). */
const hash = (n: number): number => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Instanced ribbon geometry: one spiral stream per instance. Base verts carry (t, side); the
 * vertex shader samples the spiral for each vert's world position. Shared across burst slots.
 */
const makeRibbonGeometry = (): InstancedBufferGeometry => {
  const geo = new InstancedBufferGeometry();
  const verts: number[] = [];
  const index: number[] = [];
  for (let s = 0; s <= SEGS; s++) {
    const t = s / SEGS; // 0 = tail, 1 = head
    verts.push(t, -1, 0, t, 1, 0); // position.x = t, position.y = side
  }
  for (let s = 0; s < SEGS; s++) {
    const a = s * 2;
    index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array((SEGS + 1) * 2 * 2), 2));
  geo.setIndex(index);
  geo.instanceCount = RIBBONS;

  const aA = new Float32Array(RIBBONS * 4); // theta0, R0, y0, swirl
  const aB = new Float32Array(RIBBONS * 4); // delay, radiusPow, widthScale, turbulence
  for (let i = 0; i < RIBBONS; i++) {
    aA[i * 4] = hash(i * 0.7) * Math.PI * 2;
    aA[i * 4 + 1] = START_R * (0.85 + hash(i * 3.1) * 0.75); // R0 spread around START_R
    aA[i * 4 + 2] = (hash(i * 1.3) * 2 - 1) * 1.8 + 0.5; // y0 (from around & above the torso)
    aA[i * 4 + 3] = 2.4 + hash(i * 2.2) * 3.0; // swirl (coherent whirlpool)
    aB[i * 4] = hash(i * 5.7) * 0.34; // staggered arrival
    aB[i * 4 + 1] = 1.5 + hash(i * 4.1) * 0.9; // radius exponent (inward acceleration)
    aB[i * 4 + 2] = 0.6 + hash(i * 6.6) * 1.2; // width scale
    aB[i * 4 + 3] = 0.16 + hash(i * 8.1) * 0.5; // turbulence
  }
  geo.setAttribute('aA', new InstancedBufferAttribute(aA, 4));
  geo.setAttribute('aB', new InstancedBufferAttribute(aB, 4));
  return geo;
};

const RIBBON_VERTEX = /* glsl */ `
  uniform float uProgress;
  uniform float uTrail;
  uniform float uWidth;
  attribute vec4 aA; // theta0, R0, y0, swirl
  attribute vec4 aB; // delay, radiusPow, widthScale, turbulence
  varying float vT;
  varying float vU;
  varying float vHead;
  varying float vSide;

  vec3 spiral(float u) {
    float om = 1.0 - u;                        // u clamped to [0, 0.999]
    float r = aA.y * pow(om, aB.y);            // radius collapses inward, accelerating
    float ang = aA.x + aA.w * (u / (om + 0.16));
    float y = aA.z * om;                       // converge to the torso plane
    float amp = aB.w * om;                     // turbulence, fading toward the body
    float x = cos(ang) * r + sin(u * 21.0 + aA.x * 3.0) * amp;
    float z = sin(ang) * r + cos(u * 18.0 + aA.x * 2.0) * amp;
    return vec3(x, y, z);
  }

  void main() {
    float t = position.x;     // 0 tail .. 1 head
    float side = position.y;  // -1 / +1
    float headU = clamp((uProgress - aB.x) / max(0.0001, 1.0 - aB.x), 0.0, 0.999);
    float u = clamp(headU - uTrail * (1.0 - t), 0.0, 0.999);

    vec3 wp = spiral(u);
    vec3 wp2 = spiral(min(u + 0.012, 0.999));
    vec4 mv = modelViewMatrix * vec4(wp, 1.0);
    vec4 mv2 = modelViewMatrix * vec4(wp2, 1.0);
    vec2 dir2 = normalize((mv2.xy - mv.xy) + vec2(1e-5, 1e-5));
    vec2 perp = vec2(-dir2.y, dir2.x);

    float grow = 0.4 + 0.6 * headU;
    float taper = 0.12 + 0.88 * t;
    float width = uWidth * aB.z * taper * grow;
    mv.xy += perp * side * width;

    gl_Position = projectionMatrix * mv;
    vT = t; vU = u; vHead = headU; vSide = side;
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  uniform vec3 uColorFar;
  uniform vec3 uColorNear;
  varying float vT;
  varying float vU;
  varying float vHead;
  varying float vSide;
  void main() {
    float across = smoothstep(1.0, 0.0, abs(vSide));
    float prog = vU * vU;
    vec3 col = mix(uColorFar, uColorNear, prog);
    float env = smoothstep(0.0, 0.06, vHead) * (1.0 - smoothstep(0.86, 1.0, vHead));
    // DISSOLVE as the head reaches the body: energy sinks IN rather than piling into a flash.
    float sink = 1.0 - smoothstep(0.74, 0.97, vU);
    float a = across * env * sink * (0.18 + 0.82 * vT);
    float bright = 0.55 + prog * 1.6;
    gl_FragColor = vec4(col * bright, a);
  }
`;

const makeRibbonMaterial = (): ShaderMaterial =>
  new ShaderMaterial({
    uniforms: {
      uProgress: { value: 0 },
      uTrail: { value: 0.3 },
      uWidth: { value: 0.05 },
      uColorFar: { value: COLOR_FAR.clone() },
      uColorNear: { value: COLOR_NEAR.clone() },
    },
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });

const AURA_VERTEX = /* glsl */ `
  varying float vRim;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vec3 viewDir = normalize(-mv.xyz);
    vRim = 1.0 - abs(dot(n, viewDir));
    gl_Position = projectionMatrix * mv;
  }
`;

const AURA_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vRim;
  void main() {
    float rim = pow(vRim, 2.0);
    gl_FragColor = vec4(uColor * (0.05 + rim * 1.9), (0.03 + rim) * uOpacity);
  }
`;

const makeAuraMaterial = (): ShaderMaterial =>
  new ShaderMaterial({
    uniforms: { uColor: { value: AURA_COLOR.clone() }, uOpacity: { value: 0 } },
    vertexShader: AURA_VERTEX,
    fragmentShader: AURA_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
  });

interface Slot {
  ribbons: Mesh;
  ribbonMat: ShaderMaterial;
  aura: Mesh;
  auraMat: ShaderMaterial;
}

/** Orchestrated relic-claim absorption bursts. Bounded pool; ≤ MAX_BURSTS on screen. */
export const RelicCatchFX = () => {
  const ribbonGeo = useMemo(makeRibbonGeometry, []);
  const auraGeo = useMemo(() => new SphereGeometry(1, 32, 24), []);
  const slots = useMemo<Slot[]>(() => {
    return Array.from({ length: MAX_BURSTS }, () => {
      const ribbonMat = makeRibbonMaterial();
      const ribbons = new Mesh(ribbonGeo, ribbonMat);
      ribbons.frustumCulled = false;
      ribbons.visible = false;
      const auraMat = makeAuraMaterial();
      const aura = new Mesh(auraGeo, auraMat);
      aura.frustumCulled = false;
      aura.visible = false;
      return { ribbons, ribbonMat, aura, auraMat };
    });
  }, [ribbonGeo, auraGeo]);

  const slotOf = useRef(new Map<Entity, number>());
  const free = useRef<number[]>(Array.from({ length: MAX_BURSTS }, (_, i) => i));
  const marks = useRef(new Uint8Array(MAX_BURSTS));

  useFrame(() => {
    const now = performance.now();
    const mark = marks.current;
    mark.fill(0);
    const finished: Entity[] = [];

    for (const e of world.with('catchBurstFx', 'transform')) {
      const age = (now - e.catchBurstFx.spawnedAtReal) / LIFETIME_MS;
      if (age > 1) {
        finished.push(e);
        continue;
      }
      if (age < 0) continue;

      let slot = slotOf.current.get(e);
      if (slot === undefined) {
        const next = free.current.pop();
        if (next === undefined) continue; // cosmetic cap
        slot = next;
        slotOf.current.set(e, slot);
      }
      mark[slot] = 1;
      const s = slots[slot]!;
      const [x, y, z] = e.transform.position;
      const cy = y - TORSO_DROP;

      // In-streams: the GPU does the whole spiral funnel from one progress uniform.
      s.ribbons.position.set(x, cy, z);
      s.ribbonMat.uniforms.uProgress!.value = age;
      s.ribbons.visible = true;

      // Aura: a wide energy shell that collapses down INTO the torso and fades as it lands.
      const collapse = easeIn(age); // accelerate inward
      const auraScale = 0.32 + (START_R - 0.32) * (1 - collapse);
      const auraOp = Math.min(1, age * 6) * (1 - smoothstep((age - 0.68) / 0.32));
      s.aura.position.set(x, cy, z);
      s.aura.scale.setScalar(auraScale);
      s.auraMat.uniforms.uOpacity!.value = auraOp;
      s.aura.visible = auraOp > 0.01;
    }

    for (const [e, slot] of slotOf.current) {
      if (mark[slot]) continue;
      slotOf.current.delete(e);
      free.current.push(slot);
      slots[slot]!.ribbons.visible = false;
      slots[slot]!.aura.visible = false;
    }
    for (const e of finished) world.remove(e);
  });

  return (
    <>
      {slots.map((s, i) => (
        <group key={i}>
          <primitive object={s.ribbons} />
          <primitive object={s.aura} />
        </group>
      ))}
    </>
  );
};
