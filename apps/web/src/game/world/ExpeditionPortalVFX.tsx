import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  MathUtils,
  MeshBasicMaterial,
  ShaderMaterial,
} from 'three';
import type { Group, PointLight, Points } from 'three';
import { players } from '@/game/ecs/world';

const TEAL = '#53f3e1';
const DEEP_TEAL = '#063b50';
const PURPLE = '#a879ff';

const PORTAL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PORTAL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform vec3 uTeal;
  uniform vec3 uDeep;
  uniform vec3 uPurple;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    value += noise(p) * 0.55;
    value += noise(p * 2.07 + 11.3) * 0.28;
    value += noise(p * 4.13 + 31.7) * 0.17;
    return value;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float radius = length(p);
    float angle = atan(p.y, p.x);
    float t = uTime;

    // GALAXY WINDING (per the reference): angle + log(r) makes true spiral arms that
    // wind tighter and tighter toward the eye, instead of flat turbulent streams.
    float lr = log(max(radius, 0.015));
    float spiral = angle + lr * 3.1 + t * 0.5;

    float drift = fbm(p * 2.6 + vec2(t * 0.12, -t * 0.09));
    float turb = fbm(p * 5.4 + vec2(-t * 0.18, t * 0.14));

    // Two broad teal arms, with magenta arms winding the gaps between them — kept
    // gauzy so the world shows through; the energy features carry the brightness.
    float tealArm = smoothstep(0.25, 0.95, sin(spiral * 2.0 + (drift - 0.5) * 1.8)) *
      (0.5 + turb * 0.6);
    float purpleArm = smoothstep(0.45, 0.98, sin(spiral * 2.0 + 3.14159 + (turb - 0.5) * 2.0)) *
      (0.4 + drift * 0.7);

    // LIGHTNING RIPPLES: ridged noise evaluated in swirl space — thin bright contour
    // filaments that FOLLOW the vortex flow, flickering like static discharge.
    vec2 q = vec2(spiral * 0.9, radius * 3.5 - t * 0.55);
    float ridge = 1.0 - abs(fbm(q * 2.2) * 2.0 - 1.0);
    float flicker = 0.55 + 0.45 * sin(t * 11.0 + radius * 9.0 + drift * 6.0);
    float bolts = pow(smoothstep(0.72, 1.0, ridge), 4.0) * flicker;
    // A finer, faster secondary web of ripples.
    float ridge2 = 1.0 - abs(fbm(q * 4.6 + 7.3) * 2.0 - 1.0);
    bolts += pow(smoothstep(0.8, 1.0, ridge2), 5.0) * 0.6 *
      (0.5 + 0.5 * sin(t * 17.0 + spiral * 2.0));
    bolts *= smoothstep(0.1, 0.3, radius) * (1.0 - smoothstep(0.88, 1.0, radius));

    // The bright eye: a tight, fast mini-swirl at the center of the vortex.
    float eye = 1.0 - smoothstep(0.0, 0.32, radius);
    float eyeSwirl = 0.5 + 0.5 * sin(angle * 3.0 + lr * 6.5 - t * 2.3);
    float core = eye * (0.5 + 0.85 * eyeSwirl);

    // Hot rim hugging the aperture, gently uneven so it feels alive.
    float rimGlow = smoothstep(0.8, 0.985, radius) * (0.75 + 0.25 * sin(angle * 2.0 + t * 1.3));
    float disc = 1.0 - smoothstep(0.985, 1.0, radius);

    vec3 color = uDeep * (0.35 + drift * 0.25);
    color += uTeal * (tealArm * 0.55 + bolts * 1.5 + core * 0.8 + rimGlow * 0.75);
    color += uPurple * (purpleArm * 0.6 + bolts * 0.35 + eye * eyeSwirl * 0.25);
    color *= 1.0 + uEnergy * 0.18;

    // TRANSLUCENT: gaps are mostly window; arms are gauze; the lightning, eye and rim
    // carry the opacity — the world behind stays readable through the surface.
    float alpha = disc *
      clamp(0.16 + tealArm * 0.28 + purpleArm * 0.2 + bolts * 0.85 + core * 0.5 +
        rimGlow * 0.45 + uEnergy * 0.08, 0.0, 0.92);
    gl_FragColor = vec4(color, alpha);
  }
`;

// Soft additive halo behind the disc — the portal's light bleeding onto the arch.
const HALO_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform vec3 uTeal;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float pulse = 0.85 + 0.15 * sin(uTime * 2.1);
    float a = pow(max(0.0, 1.0 - r), 2.4) * (0.4 + uEnergy * 0.25) * pulse;
    gl_FragColor = vec4(uTeal, a);
  }
`;

const buildRimMotes = () => {
  const count = 58;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.sin(i * 12.7) * 0.045;
    const radius = 1.06 + ((i * 13) % 9) * 0.023;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius;
    positions[i * 3 + 2] = ((i * 7) % 11) * 0.006;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
};

interface Props {
  /** Center of the circular opening in world space. */
  position: [number, number, number];
  radius?: number;
}

/** Layered, proximity-reactive VFX that stays independent from the portal arch GLB. */
export const ExpeditionPortalVFX = ({ position, radius = 1.22 }: Props) => {
  const portalMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: PORTAL_VERT,
        fragmentShader: PORTAL_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uEnergy: { value: 0 },
          uTeal: { value: new Color(TEAL) },
          uDeep: { value: new Color(DEEP_TEAL) },
          uPurple: { value: new Color(PURPLE) },
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    [],
  );
  const rimMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: TEAL,
        transparent: true,
        opacity: 0.62,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  const haloMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: PORTAL_VERT,
        fragmentShader: HALO_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uEnergy: { value: 0 },
          uTeal: { value: new Color(TEAL) },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    [],
  );
  const moteGeometry = useMemo(buildRimMotes, []);

  const swirl = useRef<Group>(null);
  const motes = useRef<Points>(null);
  const light = useRef<PointLight>(null);
  const proximity = useRef(0);

  useEffect(
    () => () => {
      portalMaterial.dispose();
      rimMaterial.dispose();
      haloMaterial.dispose();
      moteGeometry.dispose();
    },
    [moteGeometry, portalMaterial, rimMaterial, haloMaterial],
  );

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const player = players.first?.transform?.position;
    const distance = player ? Math.hypot(player[0] - position[0], player[2] - position[2]) : 99;
    proximity.current = MathUtils.damp(proximity.current, distance < 5 ? 1 : 0, 3.5, dt);
    const active = proximity.current;

    portalMaterial.uniforms.uTime!.value = t;
    portalMaterial.uniforms.uEnergy!.value = active;
    haloMaterial.uniforms.uTime!.value = t;
    haloMaterial.uniforms.uEnergy!.value = active;
    rimMaterial.opacity = 0.4 + Math.sin(t * 2.4) * 0.06 + active * 0.14;

    if (swirl.current) {
      swirl.current.rotation.z = t * (0.08 + active * 0.04);
      const pulse = 1 + Math.sin(t * 2.25) * (0.015 + active * 0.012);
      swirl.current.scale.setScalar(pulse);
    }
    if (motes.current) {
      motes.current.rotation.z = t * (0.18 + active * 0.16);
      const pulse = 1 + Math.sin(t * 3.1) * 0.025;
      motes.current.scale.setScalar(pulse);
    }
    if (light.current) light.current.intensity = 5.5 + active * 4 + Math.sin(t * 2.7) * 0.55;
  });

  return (
    <group position={position} scale={radius}>
      {/* Halo sits just behind the disc, oversized — light spilling onto the stone. */}
      <mesh material={haloMaterial} position={[0, 0, -0.015]} scale={1.65} renderOrder={1}>
        <planeGeometry args={[2, 2]} />
      </mesh>
      <group ref={swirl}>
        <mesh material={portalMaterial} renderOrder={2}>
          <circleGeometry args={[1, 64]} />
        </mesh>
        <mesh material={rimMaterial} position={[0, 0, 0.012]} renderOrder={3}>
          <torusGeometry args={[0.985, 0.014, 8, 80]} />
        </mesh>
      </group>

      <points ref={motes} geometry={moteGeometry} position={[0, 0, 0.035]} renderOrder={4}>
        <pointsMaterial
          color={TEAL}
          size={0.035}
          sizeAttenuation
          transparent
          opacity={0.86}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </points>

      {/* Scaled inversely so the physical light radius remains stable if the disc is retuned. */}
      <pointLight
        ref={light}
        position={[0, 0, 0.45]}
        color={TEAL}
        intensity={5.5}
        distance={5 / radius}
        decay={2}
      />
    </group>
  );
};
