import { useMemo } from 'react';
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three';

/**
 * Sun direction shared by the sky dome and the shadow-casting directional light.
 * Elevation ~16° — low enough that the sun disc is actually visible in-frame (the orbit
 * camera never pitches above ~19° over the horizon), Enshrouded-style long warm light.
 */
export const SUN_POSITION: [number, number, number] = [38, 12, 18];

/**
 * BotW-style stylized sky dome: a three-stop zenith→horizon gradient with the blue
 * compressed toward the horizon (the camera only ever sees the lowest ~20° of sky, where
 * a physically-based model is washed-out white), plus an HDR sun disc + Mie-style halo
 * that the bloom pass picks up. Screen-space dither kills gradient banding.
 *
 * Colors are authored in sRGB and converted to linear by THREE.Color; the ACES pass in
 * PostFX desaturates slightly, so they're kept a touch more saturated than the target.
 */
const SKY_UNIFORMS = {
  uZenith: '#2a66bd',
  uSky: '#4e8fd4',
  uHorizon: '#cde5f2',
  uSunColor: '#fff2d0',
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
  uniform vec3 uSky;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  varying vec3 vDir;

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;

    // Compressed ramp: horizon white → sky blue by ~0.16, deep zenith by ~0.5, so the
    // blue actually shows in the low band the gameplay camera can see.
    vec3 col = mix(uHorizon, uSky, smoothstep(0.02, 0.16, h));
    col = mix(col, uZenith, smoothstep(0.16, 0.5, h));
    // Below the horizon (rarely visible past terrain): dim ground haze, no hard line.
    col = mix(col, uHorizon * 0.85, smoothstep(0.0, -0.15, h));

    // Sun: small hot disc (HDR > bloom threshold) + tight glow + wide warm haze.
    float s = clamp(dot(dir, uSunDir), 0.0, 1.0);
    col += uSunColor * pow(s, 2200.0) * 3.5;
    col += uSunColor * pow(s, 48.0) * 0.4;
    col += uSunColor * pow(s, 6.0) * 0.12;

    // Screen-space dither so the smooth gradient doesn't band in 8-bit.
    float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (dither - 0.5) / 255.0;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const SkyDome = () => {
  const material = useMemo(() => {
    return new ShaderMaterial({
      uniforms: {
        uZenith: { value: new Color(SKY_UNIFORMS.uZenith) },
        uSky: { value: new Color(SKY_UNIFORMS.uSky) },
        uHorizon: { value: new Color(SKY_UNIFORMS.uHorizon) },
        uSunColor: { value: new Color(SKY_UNIFORMS.uSunColor) },
        uSunDir: { value: new Vector3(...SUN_POSITION).normalize() },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
  }, []);

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1}>
      {/* Radius must stay inside the camera far plane (2000) or the dome gets clipped. */}
      <sphereGeometry args={[900, 32, 24]} />
    </mesh>
  );
};

/**
 * Stylized-fantasy sky + lighting: gradient blue sky with a visible low sun, sky/ground
 * hemisphere bounce, and distance fog tinted to the sky's horizon color so terrain
 * dissolves into the sky with no seam (the BotW aerial-perspective trick).
 */
export const SkyAndLight = () => {
  return (
    <>
      <SkyDome />
      {/* Fog color === dome horizon color; density low enough that mid-range hills stay
          readable instead of becoming a flat wall (BotW's near/mid/far layering). */}
      <fogExp2 attach="fog" args={[SKY_UNIFORMS.uHorizon, 0.006]} />

      {/* Bright sky key from above, lush bounce from the grass below. */}
      <hemisphereLight args={['#bcd9f7', '#8a9a4a', 1.15]} />

      {/* Warm sun. */}
      <directionalLight
        castShadow
        position={SUN_POSITION}
        intensity={3.1}
        color="#ffedbc"
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-38}
        shadow-camera-right={38}
        shadow-camera-top={38}
        shadow-camera-bottom={-38}
        shadow-camera-near={1}
        shadow-camera-far={140}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {/* Subtle cool fill from the opposite side to open up shadows. */}
      <directionalLight position={[-20, 12, -16]} intensity={0.42} color="#cfe0ff" />
    </>
  );
};
