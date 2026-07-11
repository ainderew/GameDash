import { useMemo } from 'react';
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three';

/** Golden-hour sun shared by the sky, foliage shaders, and shadow light. */
export const SUN_POSITION: [number, number, number] = [-30, 11, -56];

export const WORLD_PALETTE = {
  zenith: '#607bc2',
  upperSky: '#91a8d6',
  horizon: '#f4b39d',
  sunset: '#ff9c79',
  cloudLight: '#ffe5c8',
  cloudShadow: '#b989a8',
  sun: '#fff0bd',
  fog: '#dca99b',
};

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
    vec3 cloudP = vec3(dir.x * 2.6, dir.y * 7.0 + 1.8, dir.z * 2.6);
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
    col += uSunColor * pow(sunDot, 2600.0) * 5.5;
    col += uSunColor * pow(sunDot, 90.0) * 0.58;
    col += uSunColor * pow(sunDot, 9.0) * 0.11;

    // Warm haze below the skyline, hiding the terrain/dome join.
    col = mix(col, uHorizon * 0.82, smoothstep(0.02, -0.18, h));

    float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (dither - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SkyDome = () => {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uZenith: { value: new Color(WORLD_PALETTE.zenith) },
          uUpperSky: { value: new Color(WORLD_PALETTE.upperSky) },
          uHorizon: { value: new Color(WORLD_PALETTE.horizon) },
          uSunset: { value: new Color(WORLD_PALETTE.sunset) },
          uCloudLight: { value: new Color(WORLD_PALETTE.cloudLight) },
          uCloudShadow: { value: new Color(WORLD_PALETTE.cloudShadow) },
          uSunColor: { value: new Color(WORLD_PALETTE.sun) },
          uSunDir: { value: new Vector3(...SUN_POSITION).normalize() },
        },
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        side: BackSide,
        depthWrite: false,
        fog: false,
      }),
    [],
  );

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[900, 48, 32]} />
    </mesh>
  );
};

/** Sunset sky, aerial perspective, and a warm key/cool-bounce lighting rig. */
export const SkyAndLight = () => (
  <>
    <SkyDome />
    <fogExp2 attach="fog" args={[WORLD_PALETTE.fog, 0.0075]} />

    {/* Low ambient keeps the golden key directional and gives foliage real depth. */}
    <hemisphereLight args={['#b8c8ec', '#667846', 1.18]} />

    <directionalLight
      castShadow
      position={SUN_POSITION}
      intensity={3.8}
      color="#ffd59a"
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

    <directionalLight position={[24, 15, 30]} intensity={0.5} color="#a9c4ff" />
  </>
);
