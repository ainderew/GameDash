import { Color, ShaderChunk } from 'three';

/**
 * ATMOSPHERIC FOG — upgrades three's flat distance fog into height fog + directional
 * inscattering for the WHOLE scene by patching the global fog `ShaderChunk`s.
 *
 * Why global chunks instead of per-material: the terrain (MeshStandardMaterial +
 * onBeforeCompile), the spires/scatter/hub/characters (plain MeshStandardMaterial) and
 * the grass (custom ShaderMaterial) all funnel through the same `<fog_*>` includes. One
 * patch upgrades every fog-enabled surface at once and — critically — keeps the spires
 * BEHIND the terrain fogging identically to the terrain, so the horizon seam they share
 * stays seamless. Materials with `fog: false` (the sky dome) never define USE_FOG, so the
 * `#ifdef USE_FOG` guards leave them untouched.
 *
 * Two additions over stock fog:
 *  - Height fog: fog is full-strength in the low arena and thins with world height, so
 *    haze pools in the field/valleys while distant peaks keep a floor of atmosphere.
 *  - Directional inscattering (Mie): looking toward the sun the haze warms toward the
 *    sunset colour; looking away it stays the cool base fog. This is the big, cinematic
 *    "atmosphere" cue — the horizon glows into the sun and recedes cool away from it.
 *
 * All parameters are baked into the GLSL as constants (sun dir + sunset colour + the
 * tunables below), so there are zero new uniforms and nothing to update per frame.
 *
 * Colour space: with PostFX mounted the scene renders into a LINEAR render target, so
 * `<fog_fragment>` (which runs after `<colorspace_fragment>`) mixes in linear space and
 * three uploads `fogColor` in linear working space. `new Color(hex)` likewise stores
 * linear-srgb components, so the baked sunset tint lands in the same space as fogColor.
 */
export const ATMOSPHERE = {
  /** World-Y where fog is at full strength (the arena floor). */
  heightBase: 0.0,
  /** How fast fog thins going up, per world unit (bigger = peaks clear faster). */
  heightFalloff: 0.045,
  /** Minimum fraction of distance-fog retained high up, so far peaks still haze. */
  heightFloor: 0.6,
  /** Tightness of the warm sun-side glow (higher = a tighter halo around the sun). */
  inscatterPower: 2.5,
  /** How far fog shifts toward the sunset colour looking straight into the sun (0..1). */
  inscatterStrength: 0.7,
};

let installed = false;

/**
 * Patch the global fog chunks. Idempotent, and safe to call before any material compiles
 * (three resolves `<fog_*>` includes from ShaderChunk at program-build time).
 *
 * @param sunPosition world-space sun position (same one the sky/lighting use)
 * @param sunsetHex   the horizon-glow colour to inscatter toward (WORLD_PALETTE.sunset)
 */
export function installAtmosphericFog(
  sunPosition: readonly [number, number, number],
  sunsetHex: string,
): void {
  if (installed) return;
  installed = true;

  const [px, py, pz] = sunPosition;
  const len = Math.hypot(px, py, pz) || 1;
  const sun = [px / len, py / len, pz / len] as const;

  const sunset = new Color(sunsetHex); // .r/.g/.b are linear-srgb — matches fogColor
  const f = (n: number) => n.toFixed(6);

  const HB = f(ATMOSPHERE.heightBase);
  const HF = f(ATMOSPHERE.heightFalloff);
  const HFLOOR = f(ATMOSPHERE.heightFloor);
  const IPOW = f(ATMOSPHERE.inscatterPower);
  const ISTR = f(ATMOSPHERE.inscatterStrength);

  // Carry world position to the fragment. For standard materials we rebuild it from the
  // (skinned/morphed) `transformed` local vertex, honouring instancing; the grass shader
  // has no `transformed`, so it sets FOG_WORLDPOS_MANUAL and writes vFogWorldPosition itself.
  ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPosition;
#endif`;

  ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  #ifndef FOG_WORLDPOS_MANUAL
    vec4 fogWorldPos = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      fogWorldPos = instanceMatrix * fogWorldPos;
    #endif
    vFogWorldPosition = ( modelMatrix * fogWorldPos ).xyz;
  #endif
#endif`;

  ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPosition;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif

  // Height fog: dense low, thinning exponentially with world height. Keeps a floor of
  // haze up high so distant peaks/spires stay atmospheric instead of popping out sharp.
  float fogHeight = clamp( exp( -( vFogWorldPosition.y - ${HB} ) * ${HF} ), 0.0, 1.0 );
  fogFactor *= mix( ${HFLOOR}, 1.0, fogHeight );

  // Directional inscattering (Mie): warm toward the sun, cool away. Sun dir + sunset baked.
  vec3 fogViewDir = normalize( vFogWorldPosition - cameraPosition );
  float fogSun = pow( clamp( dot( fogViewDir, vec3( ${f(sun[0])}, ${f(sun[1])}, ${f(sun[2])} ) ), 0.0, 1.0 ), ${IPOW} );
  vec3 fogTinted = mix( fogColor, vec3( ${f(sunset.r)}, ${f(sunset.g)}, ${f(sunset.b)} ), fogSun * ${ISTR} );

  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTinted, fogFactor );
#endif`;
}
