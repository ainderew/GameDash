import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Color,
  LinearFilter,
  ShaderMaterial,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { Group, MeshBasicMaterial } from 'three';
import { installAtmosphericFog } from '@/game/world/atmosphericFog';
import { MOODS, dusk, moodForScene } from '@/game/world/worldLighting';
import type { SkyPalette } from '@/game/world/worldLighting';
import { useUIStore } from '@/ui/store';

/** Golden-hour sun shared by the sky, foliage shaders, and shadow light. Mirrors
 *  `dusk.key.position` (the hub key) — the shared direction foliage shading keys off. */
export const SUN_POSITION: [number, number, number] = [-30, 11, -56];
// The visible disc sits slightly below the lighting vector so it remains fully framed by
// the elevated gameplay camera while the key light still produces long moon shadows.
const EXPEDITION_MOON_POSITION: [number, number, number] = [12, 0, -58];

/** Back-compat re-export: the base sky palette now lives in the mood system (`dusk`). */
export const WORLD_PALETTE = dusk.sky;

// Upgrade the global fog chunks to height fog + sun-tinted inscattering. Runs at module
// eval (before any material compiles) so every fog-enabled surface picks it up. The four
// scalars + sunset tint are BAKED once from the expedition mood (the gameplay scene the
// inscatter is tuned for); per-mood density/colour still ride the live <fogExp2> below.
installAtmosphericFog(SUN_POSITION, MOODS.deepNight.sky.sunset, MOODS.deepNight.fog);

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragment = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uUpperSky;
  uniform vec3 uHorizon;
  uniform vec3 uSunset;
  uniform vec3 uCloudLight;
  uniform vec3 uCloudShadow;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uDiscStrength;
  varying vec3 vDir;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float value = 0.0;
    value += noise3(p) * 0.52;
    value += noise3(p * 2.03 + 7.1) * 0.28;
    value += noise3(p * 4.11 + 19.7) * 0.14;
    value += noise3(p * 8.07 + 43.2) * 0.06;
    return value;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;

    // Periwinkle zenith, dusty blue mid-sky, and the peach horizon from the reference.
    vec3 col = mix(uHorizon, uUpperSky, smoothstep(0.005, 0.18, h));
    col = mix(col, uZenith, smoothstep(0.22, 0.62, h));

    float sunDot = clamp(dot(dir, uSunDir), 0.0, 1.0);
    float sunsetWash = pow(sunDot, 3.0) * (1.0 - smoothstep(0.34, 0.7, h));
    col = mix(col, uSunset, sunsetWash * 0.56);

    // Puffy, painterly cloud banks. Sampling direction-space keeps the dome seamless.
    vec3 cloudP = vec3(dir.x * 2.6 + uTime * 0.0035, dir.y * 7.0 + 1.8, dir.z * 2.6 - uTime * 0.0022);
    float broad = fbm(cloudP);
    float billow = fbm(cloudP * 1.7 + vec3(5.2, 1.1, -3.7));
    float cloudShape = broad * 0.67 + billow * 0.33;
    float cloudBand = smoothstep(-0.04, 0.12, h) * (1.0 - smoothstep(0.68, 0.96, h));
    float clouds = smoothstep(0.46, 0.6, cloudShape) * cloudBand;
    // Break up the bottom edge so the banks form discrete soft towers.
    clouds *= smoothstep(0.38, 0.53, broad + h * 0.11);
    float litEdge = smoothstep(0.48, 0.68, billow + sunDot * 0.16);
    vec3 cloudColor = mix(uCloudShadow, uCloudLight, litEdge);
    cloudColor = mix(cloudColor, uSunset, (1.0 - litEdge) * sunsetWash * 0.45);
    col = mix(col, cloudColor, clouds * 0.88);

    // Compact HDR disc, creamy inner halo, and a broad warm atmospheric glow.
    col += uSunColor * pow(sunDot, 2600.0) * 5.5 * uDiscStrength;
    col += uSunColor * pow(sunDot, 90.0) * 0.58;
    col += uSunColor * pow(sunDot, 9.0) * 0.11;

    // Warm haze below the skyline, hiding the terrain/dome join.
    col = mix(col, uHorizon * 0.82, smoothstep(0.02, -0.18, h));

    float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (dither - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SkyDome = ({ sky, discStrength }: { sky: SkyPalette; discStrength: number }) => {
  // Rebuild on palette/disc change (mood switches are rare). uSunDir stays the hub sun so the
  // dome's sunset wash + disc sit where they always have, independent of the moon's position.
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uZenith: { value: new Color(sky.zenith) },
          uUpperSky: { value: new Color(sky.upperSky) },
          uHorizon: { value: new Color(sky.horizon) },
          uSunset: { value: new Color(sky.sunset) },
          uCloudLight: { value: new Color(sky.cloudLight) },
          uCloudShadow: { value: new Color(sky.cloudShadow) },
          uSunColor: { value: new Color(sky.sun) },
          uSunDir: { value: new Vector3(...SUN_POSITION).normalize() },
          uTime: { value: 0 },
          uDiscStrength: { value: discStrength },
        },
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        side: BackSide,
        depthWrite: false,
        fog: false,
      }),
    [sky, discStrength],
  );

  useFrame(({ clock }) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
  });

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[900, 48, 32]} />
    </mesh>
  );
};

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Deterministic lunar albedo: broad maria plus crisp crater rims on an equirectangular map. */
const createMoonTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#aaa9bd');
  gradient.addColorStop(0.5, '#d7d3dc');
  gradient.addColorStop(1, '#9998aa');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const rng = mulberry32(20260716);
  for (let i = 0; i < 72; i++) {
    const x = rng() * canvas.width;
    const y = 30 + rng() * (canvas.height - 60);
    const r = 8 + Math.pow(rng(), 2.1) * 74;
    const mare = ctx.createRadialGradient(x - r * 0.18, y - r * 0.2, r * 0.08, x, y, r);
    const shade = 74 + Math.floor(rng() * 32);
    mare.addColorStop(0, `rgba(${shade},${shade + 2},${shade + 12},0.34)`);
    mare.addColorStop(0.72, `rgba(${shade},${shade + 2},${shade + 10},0.18)`);
    mare.addColorStop(1, 'rgba(90,90,104,0)');
    ctx.fillStyle = mare;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.52 + rng() * 0.45), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 190; i++) {
    const x = rng() * canvas.width;
    const y = rng() * canvas.height;
    const r = 1.2 + Math.pow(rng(), 2.4) * 11;
    ctx.strokeStyle = `rgba(245,242,248,${0.12 + rng() * 0.2})`;
    ctx.lineWidth = Math.max(0.7, r * 0.12);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(55,55,69,${0.08 + rng() * 0.18})`;
    ctx.beginPath();
    ctx.arc(x + r * 0.2, y + r * 0.18, r * 0.72, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  return texture;
};

const createHaloTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const glow = ctx.createRadialGradient(128, 128, 7, 128, 128, 126);
  glow.addColorStop(0, 'rgba(255,250,255,0.94)');
  glow.addColorStop(0.16, 'rgba(210,198,255,0.42)');
  glow.addColorStop(0.5, 'rgba(157,132,241,0.13)');
  glow.addColorStop(1, 'rgba(118,92,210,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);
  return new CanvasTexture(canvas);
};

const cloudLayerVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const cloudLayerFragment = /* glsl */ `
  uniform float uTime;
  varying vec3 vDir;
  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float fbm(vec3 p) {
    return noise3(p)*0.55 + noise3(p*2.07+8.1)*0.28 + noise3(p*4.17+21.3)*0.17;
  }
  void main() {
    vec3 dir = normalize(vDir);
    vec3 p = vec3(dir.x * 3.8 - uTime * 0.007, dir.y * 10.0 + 2.1, dir.z * 3.8 + uTime * 0.004);
    float n = fbm(p);
    float detail = fbm(p * 1.8 + vec3(7.0, 2.0, -4.0));
    float band = smoothstep(-0.02, 0.11, dir.y) * (1.0 - smoothstep(0.7, 0.93, dir.y));
    float alpha = smoothstep(0.56, 0.7, n * 0.7 + detail * 0.3) * band * 0.5;
    vec3 color = mix(vec3(0.12,0.13,0.24), vec3(0.49,0.47,0.7), smoothstep(0.48,0.75,detail));
    gl_FragColor = vec4(color, alpha);
  }
`;

const ExpeditionMoonAndClouds = () => {
  const root = useRef<Group>(null);
  const cloudMaterial = useMemo(
    () => new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: cloudLayerVertex,
      fragmentShader: cloudLayerFragment,
      side: BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
    [],
  );
  const moonTexture = useMemo(createMoonTexture, []);
  const haloTexture = useMemo(createHaloTexture, []);
  const moonMaterial = useRef<MeshBasicMaterial>(null);
  const haloMaterial = useMemo(
    () => new SpriteMaterial({ map: haloTexture, color: '#b6a7ff', transparent: true, opacity: 0.62, depthWrite: false, blending: AdditiveBlending, fog: false }),
    [haloTexture],
  );
  const moonDir = useMemo(() => new Vector3(...EXPEDITION_MOON_POSITION).normalize(), []);
  const moonPosition = useMemo(() => moonDir.clone().multiplyScalar(720), [moonDir]);

  useFrame(({ camera, clock }) => {
    root.current?.position.copy(camera.position);
    cloudMaterial.uniforms.uTime!.value = clock.elapsedTime;
  });

  useEffect(
    () => () => {
      cloudMaterial.dispose();
      moonTexture.dispose();
      haloTexture.dispose();
      haloMaterial.dispose();
    },
    [cloudMaterial, haloMaterial, haloTexture, moonTexture],
  );

  return (
    <group ref={root}>
      <sprite position={moonPosition} scale={[132, 132, 1]} material={haloMaterial} renderOrder={-6} />
      <mesh position={moonPosition} renderOrder={-5}>
        <sphereGeometry args={[42, 48, 32]} />
        <meshBasicMaterial ref={moonMaterial} map={moonTexture} color="#d8d2ec" fog={false} />
      </mesh>
      <mesh material={cloudMaterial} frustumCulled={false} renderOrder={-4}>
        <sphereGeometry args={[680, 48, 32]} />
      </mesh>
    </group>
  );
};

/** Sunset sky, aerial perspective, and a warm key/cool-bounce lighting rig — all driven by
 *  the active `WorldMood` (see worldLighting.ts), so a scene re-lights coherently from data. */
export const SkyAndLight = () => {
  const scene = useUIStore((state) => state.scene);
  const mood = moodForScene(scene);

  return (
    <>
      <SkyDome sky={mood.sky} discStrength={mood.discStrength} />
      {scene === 'expedition' && <ExpeditionMoonAndClouds key="expedition-moon-v3" />}
      {/* Aerial perspective: colour + density come from the mood (the expedition's heavier
          haze vs the hub's clarity is just deepNight.fog.density vs dusk.fog.density). */}
      <fogExp2 attach="fog" args={[mood.sky.fog, mood.fog.density]} />

      {/* Low ambient keeps the key directional and gives foliage real depth. */}
      <hemisphereLight args={[mood.ambient.skyColor, mood.ambient.groundColor, mood.ambient.intensity]} />

      <directionalLight
        castShadow
        position={mood.key.position}
        intensity={mood.key.intensity}
        color={mood.key.color}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-42}
        shadow-camera-right={42}
        shadow-camera-top={42}
        shadow-camera-bottom={-42}
        shadow-camera-near={1}
        shadow-camera-far={170}
        shadow-bias={-0.00035}
        shadow-normalBias={0.035}
        shadow-radius={4}
      />

      <directionalLight
        position={mood.fill.position}
        intensity={mood.fill.intensity}
        color={mood.fill.color}
      />
    </>
  );
};
