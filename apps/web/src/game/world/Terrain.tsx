import { useMemo } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { PlaneGeometry, Color, MeshStandardMaterial } from 'three';
import { heightAt, PLAY_RADIUS } from '@/game/world/terrainHeight';

// Re-exported so existing world modules keep importing these from Terrain.
export { heightAt, PLAY_RADIUS };

const SIZE = 220;
const SEG = 128;

/**
 * Ground colours, sampled from the nature pack's Grass.png gradient stripe so
 * ground, grass tufts, and clover read as one surface. grassLow/High bracket the
 * tufts' root melt colour (uRootColor in GrassField.tsx) — keep them in sync.
 */
const COLORS = {
  grassLow: '#5da30f',
  grassHigh: '#9cc63e',
  grassDry: '#a3a832', // sun-scorched patches
  dirt: '#b99c5f', // walking trail (pathMask, terrainHeight.ts)
  dirtDark: '#96794a',
  rock: '#8a8172',
};

/**
 * Per-pixel procedural splat, the stylized cousin of AAA terrain texturing
 * (Frostbite-style procedural shader splatting): material weights are computed
 * per-FRAGMENT from world position — macro patches, mid mottling, detail grain,
 * a ragged dirt trail, and a noisy height-based rock blend. Vertex colours were
 * the old approach and banded visibly at the mesh's ~1.7m vertex spacing.
 *
 * NOTE: the GLSL trail here and `pathMask` in terrainHeight.ts must stay in
 * sync — vegetation placement uses the JS twin to keep plants off the dirt.
 * smoothstep edges are ALWAYS ascending (repo rule — reversed edges are GLSL UB).
 */
const TERRAIN_GLSL = /* glsl */ `
  varying vec3 vWorldPos;
  uniform vec3 uGrassLow;
  uniform vec3 uGrassHigh;
  uniform vec3 uGrassDry;
  uniform vec3 uDirt;
  uniform vec3 uDirtDark;
  uniform vec3 uRock;

  float thash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float tnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = thash(i);
    float b = thash(i + vec2(1.0, 0.0));
    float c = thash(i + vec2(0.0, 1.0));
    float d = thash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float tfbm(vec2 p) {
    return tnoise(p) * 0.5 + tnoise(p * 2.73 + 13.7) * 0.3 + tnoise(p * 7.1 + 41.3) * 0.2;
  }

  // GLSL twin of pathMask() in terrainHeight.ts, plus a noisy ragged edge.
  float tpath(vec2 p) {
    float cx = 10.0 * sin(p.y * 0.042) + 5.0 * sin(p.y * 0.019 + 1.7);
    float d = abs(p.x - cx) + (tfbm(p * 0.35) - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(1.8, 3.4, d);
    float fade = 1.0 - smoothstep(66.0, 76.0, length(p));
    return edge * fade;
  }
`;

const TERRAIN_SPLAT = /* glsl */ `
  {
    vec2 p = vWorldPos.xz;
    float h = vWorldPos.y;

    // Macro patches (~20m) contrast-stretched, mid mottling (~4m) on top.
    float macro = tfbm(p * 0.05);
    float t = clamp((macro - 0.5) * 1.9 + 0.5, 0.0, 1.0);
    t = clamp(t * 0.75 + tnoise(p * 0.28 + 31.4) * 0.35 + h * 0.06 - 0.05, 0.0, 1.0);
    vec3 ground = mix(uGrassLow, uGrassHigh, t);

    // Sun-scorched dry sweeps.
    float dry = smoothstep(0.55, 0.8, tfbm(p * 0.06 + vec2(53.7, -31.2)));
    ground = mix(ground, uGrassDry, dry * 0.7);

    // High-frequency detail grain — the stylized stand-in for a detail map.
    ground *= 0.93 + 0.14 * tnoise(p * 1.9);

    // Dirt trail: mottled packed earth, cracks hinted by darker cells.
    float path = tpath(p);
    vec3 dirtCol = mix(uDirtDark, uDirt, 0.45 + 0.55 * tnoise(p * 0.9 + 7.7));
    dirtCol *= 0.92 + 0.16 * tnoise(p * 3.1);
    ground = mix(ground, dirtCol, smoothstep(0.05, 0.85, path));

    // Rocky tint climbing the perimeter hills, noisy threshold so it creeps.
    float rocky = smoothstep(3.5, 7.0, h + (tfbm(p * 0.11) - 0.5) * 3.0);
    ground = mix(ground, uRock, rocky);

    diffuseColor.rgb = ground;
  }
`;

/**
 * The stylized ground. Visual terrain undulates and rings the arena with hills;
 * a flat physics collider at y=0 keeps gameplay on level ground.
 */
export const Terrain = () => {
  const geometry = useMemo(() => {
    const geo = new PlaneGeometry(SIZE, SIZE, SEG, SEG);
    // Rotate flat FIRST, then displace by world x/z — sampling heightAt on the
    // pre-rotated plane mirrors the field in z (plane-y maps to world -z), which
    // made the visual hills disagree with the sim's ground clamp.
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    return geo;
  }, []);

  const material = useMemo(() => {
    const mat = new MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrassLow = { value: new Color(COLORS.grassLow) };
      shader.uniforms.uGrassHigh = { value: new Color(COLORS.grassHigh) };
      shader.uniforms.uGrassDry = { value: new Color(COLORS.grassDry) };
      shader.uniforms.uDirt = { value: new Color(COLORS.dirt) };
      shader.uniforms.uDirtDark = { value: new Color(COLORS.dirtDark) };
      shader.uniforms.uRock = { value: new Color(COLORS.rock) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_GLSL}`)
        .replace('#include <color_fragment>', TERRAIN_SPLAT);
    };
    return mat;
  }, []);

  return (
    <>
      <mesh geometry={geometry} material={material} receiveShadow />
      {/* Flat gameplay ground. */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[SIZE / 2, 0.1, SIZE / 2]} position={[0, -0.1, 0]} />
      </RigidBody>
    </>
  );
};
