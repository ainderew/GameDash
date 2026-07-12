import { useEffect, useMemo } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { useTexture } from '@react-three/drei';
import { PlaneGeometry, Color, MeshStandardMaterial, MirroredRepeatWrapping } from 'three';
import { heightAt, PLAY_RADIUS, HUB_ROADS } from '@sim/terrain/terrainHeight';
import {
  createWastelandSplatTexture,
  WASTELAND_SPLAT_TILE,
} from '@/game/world/groundTextures';

// Re-exported so existing world modules keep importing these from Terrain.
export { heightAt, PLAY_RADIUS };

const SIZE = 220;
const SEG = 128;
const SLATE_TILE = 12;
const BASALT_TILE = 14;
const VIOLET_TILE = 10;
const WASTELAND_TEXTURES = [
  '/textures/terrain/wasteland-slate-albedo.png',
  '/textures/terrain/wasteland-basalt-albedo.png',
  '/textures/terrain/wasteland-violet-moss-albedo.png',
] as const;

/**
 * Ground colours, sampled from the nature pack's Grass.png gradient stripe so
 * ground, grass tufts, and clover read as one surface. grassMid ≈ the tufts' root
 * melt colour (uRootColor in GrassField.tsx) — keep them roughly in sync. The deep/
 * high/dry/moss spread gives the flat play area real large-scale colour variance
 * instead of one flat green.
 */
const COLORS = {
  slateDeep: '#bec6da',
  slate: '#d3d9e8',
  ash: '#c8cedc',
  violet: '#beb2cd',
  rock: '#4b5265',
  path: '#c6cad8',
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
  uniform vec3 uSlateDeep;
  uniform vec3 uSlate;
  uniform vec3 uAsh;
  uniform vec3 uViolet;
  uniform vec3 uRock;
  uniform vec3 uPath;
  uniform sampler2D uSlateMap;
  uniform sampler2D uBasaltMap;
  uniform sampler2D uVioletMap;
  uniform sampler2D uSplatMap;
  uniform float uSlateTile;
  uniform float uBasaltTile;
  uniform float uVioletTile;
  uniform float uSplatTile;

  float thash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  vec2 thash2(vec2 p) {
    return vec2(thash(p), thash(p + vec2(37.17, 91.43)));
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

  // Four randomized phase samples blend continuously across texture cells. This is a
  // lightweight stochastic tiler: organic detail remains sharp without a visible grid.
  vec3 tstochastic(sampler2D map, vec2 uv) {
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    f = f * f * (3.0 - 2.0 * f);
    vec3 a = texture2D(map, uv + thash2(cell)).rgb;
    vec3 b = texture2D(map, uv + thash2(cell + vec2(1.0, 0.0))).rgb;
    vec3 c = texture2D(map, uv + thash2(cell + vec2(0.0, 1.0))).rgb;
    vec3 d = texture2D(map, uv + thash2(cell + vec2(1.0, 1.0))).rgb;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // GLSL twin of pathMask() in terrainHeight.ts, plus a noisy ragged edge.
  float tpath(vec2 p) {
    float cx = 10.0 * sin(p.y * 0.042) + 5.0 * sin(p.y * 0.019 + 1.7);
    float d = abs(p.x - cx) + (tfbm(p * 0.35) - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(1.8, 3.4, d);
    float fade = 1.0 - smoothstep(66.0, 76.0, length(p));
    return edge * fade;
  }

  float tsegDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a; vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
`;

/** GLSL twin of hubRoadMask(), segments inlined from HUB_ROADS so the two never drift. */
const ROADS_GLSL = /* glsl */ `
  float troad(vec2 p) {
    // Higher-frequency, small-amplitude ragged edge → an irregular but crisp boundary
    // (grass bites into the dirt) instead of a soft blurred halo.
    float ragged = (tfbm(p * 1.15) - 0.5) * 0.92 + (tnoise(p * 3.3) - 0.5) * 0.34;
    float m = 0.0;
${HUB_ROADS.map(
  ([ax, az, bx, bz, hw]) =>
    `    m = max(m, 1.0 - smoothstep(${hw.toFixed(2)}, ${(hw + 0.6).toFixed(
      2,
    )}, tsegDist(p, vec2(${ax.toFixed(2)}, ${az.toFixed(2)}), vec2(${bx.toFixed(2)}, ${bz.toFixed(2)})) + ragged));`,
).join('\n')}
    return m;
  }
`;

const TERRAIN_SPLAT = /* glsl */ `
  {
    vec2 p = vWorldPos.xz;
    float h = vWorldPos.y;

    vec3 splat = texture2D(uSplatMap, p / uSplatTile).rgb;
    float macro = tfbm(p * 0.045);
    float slope = 1.0 - smoothstep(0.48, 0.88, abs(normalize(vWorldNormal).y));
    float basaltWeight = clamp(smoothstep(0.13, 0.65, splat.r) + slope * 0.55 + smoothstep(8.0, 13.0, h) * 0.45, 0.0, 1.0);
    float mossWeight = smoothstep(0.12, 0.62, splat.g) * (1.0 - slope * 0.7);
    float corruption = smoothstep(0.1, 0.5, splat.b) * mossWeight;
    vec3 slateA = pow(tstochastic(uSlateMap, p / uSlateTile).rgb, vec3(2.2));
    vec3 basaltA = pow(tstochastic(uBasaltMap, p / uBasaltTile + vec2(0.31, 0.17)).rgb, vec3(2.2));
    vec3 violetRaw = tstochastic(uVioletMap, p / uVioletTile + vec2(0.57, 0.83));
    vec3 violetA = pow(violetRaw, vec3(2.2));
    slateA *= 4.8;
    basaltA *= 6.0;
    violetA *= 6.5;
    vec3 ground = slateA * mix(uSlateDeep, uSlate, 0.45 + macro * 0.55);
    ground = mix(ground, basaltA * uAsh, basaltWeight * 0.82);
    ground = mix(ground, violetA * uViolet, mossWeight * 0.18);
    // Broad mineral beds, mid-scale mottling, and fine grit keep the open field from
    // reading as one uniformly rolled clay surface. Each frequency has a restrained
    // range so the variation stays geological rather than noisy/confetti-like.
    float mineralBed = tfbm(p * 0.032 + vec2(31.0, 17.0));
    float surfaceMottle = tfbm(p * 0.24 + vec2(7.0, 43.0));
    float fineGrit = tnoise(p * 1.85 + 91.0);
    ground *= 0.78 + mineralBed * 0.34 + surfaceMottle * 0.12 + fineGrit * 0.055;
    ground = mix(ground, ground * vec3(0.78, 0.87, 1.08), smoothstep(0.58, 0.82, mineralBed) * 0.32);
    float vein = smoothstep(0.34, 0.72, violetRaw.r) * smoothstep(0.3, 0.8, violetRaw.b);
    terrainGlow = vec3(0.38, 0.035, 1.2) * vein * corruption * 2.4;

    float trail = tpath(p) * smoothstep(21.0, 33.0, length(p));
    float road = max(trail, troad(p));
    vec3 pathSlate = pow(tstochastic(uSlateMap, p / (uSlateTile * 1.25) + 0.43).rgb, vec3(2.2));
    vec3 pathAggregate = pow(tstochastic(uBasaltMap, p / (uBasaltTile * 0.55) + vec2(0.73, 0.19)).rgb, vec3(2.2));
    float pathWear = tfbm(vec2(p.x * 0.31, p.y * 0.72) + vec2(18.0, 6.0));
    vec3 pathCol = mix(pathSlate * 4.9, pathAggregate * 5.5, 0.24 + pathWear * 0.18);
    pathCol *= uPath * (1.06 + pathWear * 0.18);
    float pathLuma = dot(pathCol, vec3(0.2126, 0.7152, 0.0722));
    pathCol = mix(pathCol, vec3(pathLuma) * vec3(1.02, 1.0, 0.94), 0.42);
    float roadOuter = smoothstep(0.08, 0.54, road);
    float roadCore = smoothstep(0.46, 0.76, road);
    float roadShoulder = roadOuter * (1.0 - smoothstep(0.34, 0.68, road));
    vec3 verge = mix(ground, pathCol, 0.32) * vec3(0.72, 0.76, 0.84);
    ground *= 1.0 - roadShoulder * 0.2;
    ground = mix(ground, verge, roadOuter);
    ground = mix(ground, pathCol, roadCore);
    terrainGlow *= 1.0 - roadCore;

    // Rocky tint creeping up the hill crests. Thresholds sit just under HILL_MAX
    // (terrainHeight.ts caps ridges ~14) so slopes stay grassy and only tops rock over.
    float rocky = smoothstep(9.0, 13.5, h + (tfbm(p * 0.11) - 0.5) * 3.0);
    rocky = max(rocky, slope * smoothstep(0.4, 0.72, tfbm(p * 0.18 + 83.0)));
    ground = mix(ground, uRock * (0.8 + 0.4 * tnoise(p * 0.7 + 55.0)), rocky);
    // Keep the soil itself nearly achromatic. Local violet lights and fog provide the
    // wasteland mood; baking that hue into every ground texel made the field neon-blue.
    float groundLuma = dot(ground, vec3(0.2126, 0.7152, 0.0722));
    ground = mix(vec3(groundLuma), ground, 0.38) * vec3(0.94, 0.97, 1.02);
    terrainGlow += ground * 0.01;

    diffuseColor.rgb = ground;
  }
`;

/**
 * The stylized ground. Visual terrain undulates and rings the arena with hills;
 * a flat physics collider at y=0 keeps gameplay on level ground.
 */
export const Terrain = () => {
  const textures = useTexture([...WASTELAND_TEXTURES]);
  const slateTexture = textures[0]!;
  const basaltTexture = textures[1]!;
  const violetTexture = textures[2]!;
  useMemo(() => {
    for (const texture of [slateTexture, basaltTexture, violetTexture]) {
      texture.wrapS = MirroredRepeatWrapping;
      texture.wrapT = MirroredRepeatWrapping;
      texture.anisotropy = Math.max(texture.anisotropy, 8);
      texture.needsUpdate = true;
    }
  }, [slateTexture, basaltTexture, violetTexture]);

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

  const { material, splatTexture } = useMemo(() => {
    const splatTexture = createWastelandSplatTexture();
    const mat = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSlateDeep = { value: new Color(COLORS.slateDeep) };
      shader.uniforms.uSlate = { value: new Color(COLORS.slate) };
      shader.uniforms.uAsh = { value: new Color(COLORS.ash) };
      shader.uniforms.uViolet = { value: new Color(COLORS.violet) };
      shader.uniforms.uRock = { value: new Color(COLORS.rock) };
      shader.uniforms.uPath = { value: new Color(COLORS.path) };
      shader.uniforms.uSlateMap = { value: slateTexture };
      shader.uniforms.uBasaltMap = { value: basaltTexture };
      shader.uniforms.uVioletMap = { value: violetTexture };
      shader.uniforms.uSplatMap = { value: splatTexture };
      shader.uniforms.uSlateTile = { value: SLATE_TILE };
      shader.uniforms.uBasaltTile = { value: BASALT_TILE };
      shader.uniforms.uVioletTile = { value: VIOLET_TILE };
      shader.uniforms.uSplatTile = { value: WASTELAND_SPLAT_TILE };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;')
        .replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\nvWorldNormal = normalize(mat3(modelMatrix) * objectNormal);',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying vec3 vWorldNormal;\nvec3 terrainGlow;\n${TERRAIN_GLSL}\n${ROADS_GLSL}`,
        )
        .replace('#include <color_fragment>', TERRAIN_SPLAT)
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            vec3 nSplat = texture2D(uSplatMap, vWorldPos.xz / uSplatTile).rgb;
            float nBasalt = smoothstep(0.13, 0.65, nSplat.r);
            float nMoss = smoothstep(0.12, 0.62, nSplat.g);
            vec2 nUv = vWorldPos.xz / uBasaltTile;
            vec2 nVioletUv = vWorldPos.xz / uVioletTile + vec2(0.57, 0.83);
            float nStep = 0.00125;
            vec3 luma = vec3(0.2126, 0.7152, 0.0722);
            vec2 nSlateUv = vWorldPos.xz / uSlateTile;
            float hL = dot(texture2D(uSlateMap, nSlateUv - vec2(nStep, 0.0)).rgb, luma) * 0.72 + dot(texture2D(uBasaltMap, nUv - vec2(nStep, 0.0)).rgb, luma) * nBasalt + dot(texture2D(uVioletMap, nVioletUv - vec2(nStep, 0.0)).rgb, luma) * nMoss * 0.32;
            float hR = dot(texture2D(uSlateMap, nSlateUv + vec2(nStep, 0.0)).rgb, luma) * 0.72 + dot(texture2D(uBasaltMap, nUv + vec2(nStep, 0.0)).rgb, luma) * nBasalt + dot(texture2D(uVioletMap, nVioletUv + vec2(nStep, 0.0)).rgb, luma) * nMoss * 0.32;
            float hD = dot(texture2D(uSlateMap, nSlateUv - vec2(0.0, nStep)).rgb, luma) * 0.72 + dot(texture2D(uBasaltMap, nUv - vec2(0.0, nStep)).rgb, luma) * nBasalt + dot(texture2D(uVioletMap, nVioletUv - vec2(0.0, nStep)).rgb, luma) * nMoss * 0.32;
            float hU = dot(texture2D(uSlateMap, nSlateUv + vec2(0.0, nStep)).rgb, luma) * 0.72 + dot(texture2D(uBasaltMap, nUv + vec2(0.0, nStep)).rgb, luma) * nBasalt + dot(texture2D(uVioletMap, nVioletUv + vec2(0.0, nStep)).rgb, luma) * nMoss * 0.32;
            float nTrail = tpath(vWorldPos.xz) * smoothstep(21.0, 33.0, length(vWorldPos.xz));
            float nRoad = max(nTrail, troad(vWorldPos.xz));
            float detailMask = 1.0 - smoothstep(0.12, 0.68, nRoad);
            vec3 worldDetailNormal = normalize(vWorldNormal + vec3(hL - hR, 0.0, hD - hU) * 5.4 * detailMask);
            normal = normalize(mat3(viewMatrix) * worldDetailNormal);
          }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          {
            vec3 rSplat = texture2D(uSplatMap, vWorldPos.xz / uSplatTile).rgb;
            float rBasalt = smoothstep(0.13, 0.65, rSplat.r);
            float rMoss = smoothstep(0.12, 0.62, rSplat.g);
            roughnessFactor = mix(0.96, 0.79, rBasalt);
            roughnessFactor = mix(roughnessFactor, 0.68, rMoss * 0.7);
            float roughMacro = tfbm(vWorldPos.xz * 0.19 + 29.0);
            float roughGrit = tnoise(vWorldPos.xz * 2.2);
            roughnessFactor *= 0.82 + roughMacro * 0.2 + roughGrit * 0.12;
            float rTrail = tpath(vWorldPos.xz) * smoothstep(21.0, 33.0, length(vWorldPos.xz));
            float rRoad = max(rTrail, troad(vWorldPos.xz));
            // Repeated foot traffic compacts the path core while its shoulder stays dry
            // and rough, producing a readable highlight/value break from gameplay view.
            float rRoadCore = smoothstep(0.46, 0.78, rRoad);
            float rRoadShoulder = smoothstep(0.08, 0.5, rRoad) * (1.0 - rRoadCore);
            roughnessFactor = mix(roughnessFactor, 0.72, rRoadCore * 0.72);
            roughnessFactor = mix(roughnessFactor, 0.98, rRoadShoulder * 0.65);
            roughnessFactor = clamp(roughnessFactor, 0.55, 1.0);
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += terrainGlow;',
        );
    };
    mat.customProgramCacheKey = () => 'violet-wasteland-terrain-v4-relief-path';
    return { material: mat, splatTexture };
  }, [slateTexture, basaltTexture, violetTexture]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      splatTexture.dispose();
    },
    [geometry, material, splatTexture],
  );

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
