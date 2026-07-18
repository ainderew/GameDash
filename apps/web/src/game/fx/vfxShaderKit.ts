import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  type Texture,
} from 'three';

/**
 * REAL-TIME VFX SHADER KIT
 *
 * The shared foundation for GameDash's skill VFX. This is the professional
 * (Unreal / Godot / LeLu) real-time approach: instead of baking sprite sheets in
 * Blender, we drive the look at runtime from a small library of tiling noise,
 * gradient and flare textures — panning their UVs, distorting one map by another,
 * remapping intensity through a colour ramp, and dissolving edges with an erosion
 * mask. Every skill composes the same handful of GLSL helpers below, so they read
 * as one system and a new effect is a few uniforms, not a new bake.
 *
 * Authoring source: LeLu's Noise Pack (public/fx/lib). All maps are single-channel
 * intensity used additively, so they're loaded as raw (NoColorSpace) — the colour
 * comes from the ramp in-shader, which keeps every effect re-tintable per skill.
 */

// The curated slice of the pack we actually use. Keep this list tight — each entry
// is a texture the browser downloads.
export const VFX_TEX = {
  /** Seamless fractal noise — the workhorse UV-distortion / flow map. */
  noise: '/fx/lib/T_Noise1_tiled.png',
  /** Vertical flame licks, cylinder-mapped — panning energy fill for trails/auras. */
  fire: '/fx/lib/T_FirePanningCyl45.png',
  /** Cloudy noise with bright specks — erosion/dissolve mask + ember detail. */
  cloud: '/fx/lib/T_CloudNoise_Tiled.png',
  /** Anamorphic X lens-flare — hot core flash for launches and impacts. */
  flare: '/fx/lib/T_flare8_vfx.png',
  /** Electric arc filaments — lightning/energy accent. */
  spark: '/fx/lib/T_VFX_spark44.jpg',
  /** Soft capsule gradient — a cheap soft glow / body mask. */
  gradient: '/fx/lib/T_Gradient_circle22.jpg',
  /** Four-point star sparkle — small additive pops. */
  star: '/fx/lib/T_trail12.png',
  /** 8×8 (64-frame) turbulent smoke flipbook on black — wispy dust; alpha from luminance. */
  smoke: '/fx/lib/T_smoke41_flipbook.png',
} as const;

export type VfxTexKey = keyof typeof VFX_TEX;
/** Which maps tile seamlessly and therefore want RepeatWrapping (the rest clamp). */
const TILING: Record<VfxTexKey, boolean> = {
  noise: true,
  fire: true,
  cloud: true,
  flare: false,
  spark: false,
  gradient: false,
  star: false,
  smoke: false,
};

const KEYS = Object.keys(VFX_TEX) as VfxTexKey[];

/**
 * Load and configure the whole VFX texture library once. Returns a keyed record so
 * a shader can grab exactly the maps it needs. Tiling maps repeat + mipmap (they're
 * minified hard when a trail recedes); sprites clamp. All raw colour space so the
 * in-shader ramp math is predictable.
 */
export const useVfxTextures = (): Record<VfxTexKey, Texture> => {
  const list = useTexture(KEYS.map((k) => VFX_TEX[k])) as Texture[];
  return useMemo(() => {
    const out = {} as Record<VfxTexKey, Texture>;
    KEYS.forEach((k, i) => {
      const t = list[i]!;
      const tiling = TILING[k];
      t.wrapS = t.wrapT = tiling ? RepeatWrapping : ClampToEdgeWrapping;
      t.colorSpace = NoColorSpace;
      t.magFilter = LinearFilter;
      t.minFilter = tiling ? LinearMipmapLinearFilter : LinearFilter;
      t.generateMipmaps = tiling;
      t.anisotropy = 4;
      t.needsUpdate = true;
      out[k] = t;
    });
    return out;
  }, [list]);
};

/**
 * Shared GLSL prepended to every VFX fragment shader. Pure functions only — no
 * uniforms — so a shader can `#include` this by string concat and then use the
 * helpers freely. These are the primitives the whole kit is built on:
 *
 *  - vfxRamp3   : 3-stop colour ramp (core → mid → edge), the re-tint knob
 *  - vfxRemap   : rescale a range, clamped
 *  - vfxDissolve: eroded soft-edge alpha from a noise sample (the "professional" crumble)
 *  - vfxFeather : soft falloff across a 0..1 coordinate
 *  - vfxFlow    : distort a UV by a noise sample (flow-map style)
 */
export const VFX_COMMON_GLSL = /* glsl */ `
  float vfxLum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

  float vfxRemap(float v, float inA, float inB, float outA, float outB){
    return outA + (clamp(v, inA, inB) - inA) * (outB - outA) / max(inB - inA, 1e-5);
  }

  // 3-stop ramp: t=0 -> a, t=0.5 -> b, t=1 -> c. Smooth across both halves.
  vec3 vfxRamp3(float t, vec3 a, vec3 b, vec3 c){
    t = clamp(t, 0.0, 1.0);
    vec3 lo = mix(a, b, smoothstep(0.0, 0.5, t));
    vec3 hi = mix(b, c, smoothstep(0.5, 1.0, t));
    return t < 0.5 ? lo : hi;
  }

  // Eroded alpha: a noise sample burned away below a moving threshold, with a soft
  // rim of width 'edge'. Raise 'threshold' toward 1 to dissolve more of the effect.
  float vfxDissolve(float noise, float threshold, float edge){
    return smoothstep(threshold, threshold + edge, noise);
  }

  // Soft symmetric feather across a 0..1 coordinate (1 at centre, 0 at both ends),
  // shaped by 'power' (higher = tighter core).
  float vfxFeather(float t, float power){
    float f = 1.0 - abs(t * 2.0 - 1.0);
    return pow(clamp(f, 0.0, 1.0), power);
  }

  // Flow-style UV distortion: push 'uv' by a signed noise sample scaled by 'amount'.
  vec2 vfxFlow(vec2 uv, vec2 noise, float amount){
    return uv + (noise - 0.5) * 2.0 * amount;
  }
`;
