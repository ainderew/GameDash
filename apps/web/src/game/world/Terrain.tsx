import { useEffect, useMemo } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { useTexture } from '@react-three/drei';
import { PlaneGeometry, Color, MeshStandardMaterial, MirroredRepeatWrapping } from 'three';
import { heightAt, PLAY_RADIUS, HUB_ROADS } from '@sim/terrain/terrainHeight';
import {
  createDirtTexture,
  createGrassMacroTexture,
  DIRT_TILE,
  GRASS_MACRO_TILE,
} from '@/game/world/groundTextures';

// Re-exported so existing world modules keep importing these from Terrain.
export { heightAt, PLAY_RADIUS };

const SIZE = 220;
const SEG = 128;
const GRASS_TILE = 12;
const GRASS_ALBEDO = '/textures/terrain/grass-meadow-albedo.png';

/**
 * Ground colours, sampled from the nature pack's Grass.png gradient stripe so
 * ground, grass tufts, and clover read as one surface. grassMid ≈ the tufts' root
 * melt colour (uRootColor in GrassField.tsx) — keep them roughly in sync. The deep/
 * high/dry/moss spread gives the flat play area real large-scale colour variance
 * instead of one flat green.
 */
const COLORS = {
  grassDeep: '#426522', // shadowed / damp lows — dark cool green
  grassMid: '#628b2d', // dominant mid tone (≈ grass tuft root melt)
  grassHigh: '#96b743', // sunlit rises — bright warm green
  grassDry: '#9d9440', // sun-scorched sweeps — yellowed
  moss: '#355721', // mossy hollows — darkest, coolest
  dirt: '#b77b42', // warm walking trail tint (pathMask, terrainHeight.ts)
  dirtDark: '#6f523a',
  rock: '#716b63',
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
  uniform vec3 uGrassDeep;
  uniform vec3 uGrassMid;
  uniform vec3 uGrassHigh;
  uniform vec3 uGrassDry;
  uniform vec3 uMoss;
  uniform vec3 uDirt;
  uniform vec3 uDirtDark;
  uniform vec3 uRock;
  uniform sampler2D uDirtMap;
  uniform float uDirtTile;
  uniform sampler2D uGrassMap;
  uniform float uGrassTile;
  uniform sampler2D uGrassMacroMap;
  uniform float uGrassMacroTile;

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
  vec3 tgrass(vec2 uv) {
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    f = f * f * (3.0 - 2.0 * f);
    vec3 a = texture2D(uGrassMap, uv + thash2(cell)).rgb;
    vec3 b = texture2D(uGrassMap, uv + thash2(cell + vec2(1.0, 0.0))).rgb;
    vec3 c = texture2D(uGrassMap, uv + thash2(cell + vec2(0.0, 1.0))).rgb;
    vec3 d = texture2D(uGrassMap, uv + thash2(cell + vec2(1.0, 1.0))).rgb;
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

    // LARGE-SCALE BIOME PATCHES: a contrast-stretched ~22m field drives a deep→mid→high
    // green gradient so the ground has broad regions of distinct colour, not one flat hue.
    float macro = tfbm(p * 0.045);
    float t = clamp((macro - 0.5) * 2.1 + 0.5, 0.0, 1.0);
    t = clamp(t + tnoise(p * 0.26 + 31.4) * 0.28 + h * 0.05 - 0.04, 0.0, 1.0);
    vec3 ground = mix(uGrassDeep, uGrassMid, smoothstep(0.0, 0.55, t));
    ground = mix(ground, uGrassHigh, smoothstep(0.5, 1.0, t));

    // A second, decorrelated macro pattern nudges hue warm/cool independently of value,
    // so patches of the same brightness still differ in tone.
    float tone = tfbm(p * 0.07 + vec2(61.0, -17.0));
    ground = mix(ground, ground * vec3(1.08, 1.05, 0.86), smoothstep(0.55, 0.85, tone) * 0.5);
    ground = mix(ground, ground * vec3(0.82, 0.94, 0.9), smoothstep(0.45, 0.12, tone) * 0.45);

    // Dedicated RGB macro mask: R dry meadow, G lush growth, B cool moss. Unlike
    // mathematical noise, these overlapping soft regions form a reusable biome layer.
    vec3 biomeMask = texture2D(uGrassMacroMap, p / uGrassMacroTile).rgb;
    float dry = smoothstep(0.16, 0.68, biomeMask.r);
    float lush = smoothstep(0.16, 0.68, biomeMask.g);
    float moss = smoothstep(0.16, 0.68, biomeMask.b);
    ground = mix(ground, uGrassHigh, lush * 0.3);
    ground = mix(ground, uGrassDry, dry * 0.58);
    ground = mix(ground, uMoss, moss * 0.52);

    // AUTHORED GRASS ALBEDO: generated from the target art direction, with real layered
    // moss, low foliage and organic colour variation instead of procedural scratches.
    vec3 grassPaint = pow(tgrass(p / uGrassTile), vec3(2.2));
    vec2 grassWideUv = vec2(-p.y, p.x) / (uGrassTile * 2.73) + vec2(0.37, 0.61);
    vec3 grassWide = pow(texture2D(uGrassMap, grassWideUv).rgb, vec3(2.2));
    const vec3 grassPivot = vec3(0.032, 0.051, 0.0027);
    grassPaint = max(vec3(0.0), (grassPaint - grassPivot) * 1.18 + grassPivot);
    grassWide = max(vec3(0.0), (grassWide - grassPivot) * 1.08 + grassPivot);
    float groundLum = dot(ground, vec3(0.2126, 0.7152, 0.0722));
    const float grassPivotLum = 0.0435;
    grassPaint *= groundLum / grassPivotLum;
    grassWide *= groundLum / grassPivotLum;
    grassPaint = mix(grassPaint, grassWide, 0.18);
    ground = mix(ground, grassPaint, 0.72);

    // Dirt: the wandering wilderness trail (faded out near the hub so it doesn't clash
    // with the authored plaza roads) plus those authored roads radiating to each landmark.
    // The colour comes from a quiet hand-painted tile. A much larger second sample and
    // macro noise only nudge its value; real stones and AO provide the hard detail.
    // pow(2.2) decodes the sRGB canvas to linear against the linear grass colours.
    float trail = tpath(p) * smoothstep(21.0, 33.0, length(p));
    float road = max(trail, troad(p));
    // Painted tile is already the warm dirt colour. Keep both anti-repeat modulation
    // passes within a narrow range so layered noise cannot overwhelm its brushwork.
    vec3 dirtA = pow(texture2D(uDirtMap, p / uDirtTile).rgb, vec3(2.2));
    // Restore contrast lost to mip filtering and the shallow camera angle. This expands
    // painted variation around the warm base colour without changing the palette.
    const vec3 dirtPivot = vec3(0.39, 0.17, 0.055);
    dirtA = max(vec3(0.0), (dirtA - dirtPivot) * 1.42 + dirtPivot);
    float dirtB = pow(texture2D(uDirtMap, p / (uDirtTile * 2.9) + 0.37).r, 2.2);
    vec3 dirtCol = dirtA * (0.92 + 0.18 * dirtB);
    dirtCol *= 0.91 + 0.18 * tnoise(p * 0.12 + 3.0);
    // World-space painted structure remains legible after texture mipmapping at the
    // gameplay camera: broad compacted patches plus faint directional brush bands.
    float soilMottle = tfbm(p * 0.42 + vec2(27.0, -11.0));
    dirtCol *= 0.82 + 0.36 * soilMottle;
    float brushBand = tnoise(vec2(p.x * 0.34 + p.y * 0.12, p.y * 1.28) + vec2(8.0, 19.0));
    dirtCol *= 0.94 + 0.12 * smoothstep(0.28, 0.74, brushBand);
    dirtCol *= mix(vec3(1.0), uDirt * 1.55, 0.08);

    // Two-stage verge: a broad, dark green-brown stain first, then the packed-earth
    // core. This makes the grass dissolve organically into the path rather than ending
    // at a hard cutout, while the high-frequency road mask keeps the silhouette ragged.
    float roadOuter = smoothstep(0.08, 0.54, road);
    float roadCore = smoothstep(0.46, 0.76, road);
    vec3 verge = mix(ground, dirtCol, 0.48) * vec3(0.88, 0.92, 0.78);
    ground = mix(ground, verge, roadOuter);
    ground = mix(ground, dirtCol, roadCore);

    // Rocky tint creeping up the hill crests. Thresholds sit just under HILL_MAX
    // (terrainHeight.ts caps ridges ~14) so slopes stay grassy and only tops rock over.
    float rocky = smoothstep(9.0, 13.5, h + (tfbm(p * 0.11) - 0.5) * 3.0);
    float slope = 1.0 - smoothstep(0.48, 0.88, abs(normalize(vWorldNormal).y));
    rocky = max(rocky, slope * smoothstep(0.4, 0.72, tfbm(p * 0.18 + 83.0)));
    ground = mix(ground, uRock * (0.8 + 0.4 * tnoise(p * 0.7 + 55.0)), rocky);

    diffuseColor.rgb = ground;
  }
`;

/**
 * The stylized ground. Visual terrain undulates and rings the arena with hills;
 * a flat physics collider at y=0 keeps gameplay on level ground.
 */
export const Terrain = () => {
  const grassTexture = useTexture(GRASS_ALBEDO);
  useMemo(() => {
    // Mirrored wrapping guarantees continuous joins even if an authored border differs
    // by a few pixels; the rotated large sample hides the mirrored cadence.
    grassTexture.wrapS = MirroredRepeatWrapping;
    grassTexture.wrapT = MirroredRepeatWrapping;
    grassTexture.anisotropy = Math.max(grassTexture.anisotropy, 8);
    grassTexture.needsUpdate = true;
  }, [grassTexture]);

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

  const { material, dirtTexture, grassMacroTexture } = useMemo(() => {
    const dirtTexture = createDirtTexture();
    const grassMacroTexture = createGrassMacroTexture();
    const mat = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrassDeep = { value: new Color(COLORS.grassDeep) };
      shader.uniforms.uGrassMid = { value: new Color(COLORS.grassMid) };
      shader.uniforms.uGrassHigh = { value: new Color(COLORS.grassHigh) };
      shader.uniforms.uGrassDry = { value: new Color(COLORS.grassDry) };
      shader.uniforms.uMoss = { value: new Color(COLORS.moss) };
      shader.uniforms.uDirt = { value: new Color(COLORS.dirt) };
      shader.uniforms.uDirtDark = { value: new Color(COLORS.dirtDark) };
      shader.uniforms.uRock = { value: new Color(COLORS.rock) };
      shader.uniforms.uDirtMap = { value: dirtTexture };
      shader.uniforms.uDirtTile = { value: DIRT_TILE };
      shader.uniforms.uGrassMap = { value: grassTexture };
      shader.uniforms.uGrassTile = { value: GRASS_TILE };
      shader.uniforms.uGrassMacroMap = { value: grassMacroTexture };
      shader.uniforms.uGrassMacroTile = { value: GRASS_MACRO_TILE };
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
          `#include <common>\nvarying vec3 vWorldNormal;\n${TERRAIN_GLSL}\n${ROADS_GLSL}`,
        )
        .replace('#include <color_fragment>', TERRAIN_SPLAT)
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            // Height-derived micro-normal from the authored grass albedo. It is subtle,
            // world-aligned, and fades completely under dirt roads and rocky terrain.
            vec2 nUv = vWorldPos.xz / uGrassTile;
            float nStep = 0.00125;
            float hL = dot(pow(texture2D(uGrassMap, nUv - vec2(nStep, 0.0)).rgb, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
            float hR = dot(pow(texture2D(uGrassMap, nUv + vec2(nStep, 0.0)).rgb, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
            float hD = dot(pow(texture2D(uGrassMap, nUv - vec2(0.0, nStep)).rgb, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
            float hU = dot(pow(texture2D(uGrassMap, nUv + vec2(0.0, nStep)).rgb, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
            float nTrail = tpath(vWorldPos.xz) * smoothstep(21.0, 33.0, length(vWorldPos.xz));
            float nRoad = max(nTrail, troad(vWorldPos.xz));
            float grassNormalMask = 1.0 - smoothstep(0.12, 0.68, nRoad);
            vec3 worldDetailNormal = normalize(vWorldNormal + vec3(hL - hR, 0.0, hD - hU) * 5.5 * grassNormalMask);
            normal = normalize(mat3(viewMatrix) * worldDetailNormal);
          }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          {
            // Broad roughness patches (damp/mossy sheen vs dry matte) plus fine grain,
            // then knock the dirt roads/trail fully matte so they read as packed earth.
            roughnessFactor *= 0.7 + 0.3 * tfbm(vWorldPos.xz * 0.5 + 5.0);
            roughnessFactor *= 0.9 + 0.14 * tnoise(vWorldPos.xz * 3.0);
            vec3 rBiome = texture2D(uGrassMacroMap, vWorldPos.xz / uGrassMacroTile).rgb;
            roughnessFactor *= 0.9 + rBiome.r * 0.16 - rBiome.b * 0.1;
            float rTrail = tpath(vWorldPos.xz) * smoothstep(21.0, 33.0, length(vWorldPos.xz));
            float rRoad = max(rTrail, troad(vWorldPos.xz));
            roughnessFactor = mix(roughnessFactor, 1.0, smoothstep(0.1, 0.8, rRoad) * 0.55);
            roughnessFactor = clamp(roughnessFactor, 0.55, 1.0);
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'sunset-terrain-v9-stochastic-grass';
    return { material: mat, dirtTexture, grassMacroTexture };
  }, [grassTexture]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      dirtTexture.dispose();
      grassMacroTexture.dispose();
    },
    [geometry, material, dirtTexture, grassMacroTexture],
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
