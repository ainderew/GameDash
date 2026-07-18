import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, MeshBasicMaterial, Object3D } from 'three';
import type { BufferGeometry, InstancedMesh, Material, Mesh, MeshStandardMaterial, PointLight } from 'three';
import {
  EXPEDITION_CRYSTAL_PLACEMENTS,
  HUB_CRYSTAL_PLACEMENTS,
  type CrystalClusterAsset,
  type CrystalClusterPlacement,
} from '@sim/terrain/crystalClusters';
import { heightAt } from '@sim/terrain/terrainHeight';
import { useGameModel } from '@/lib/loaders';

const CRYSTAL_MODEL_PATHS: Readonly<Record<CrystalClusterAsset, string>> = {
  smallA: '/models/crystals/crystal_cluster_small_a.glb',
  smallB: '/models/crystals/crystal_cluster_small_b.glb',
  large: '/models/crystals/crystal_cluster_large.glb',
};

/** The rebuilt broad-facet meshes have a larger silhouette than v1; keep them as accents. */
const CRYSTAL_VISUAL_SCALE = 0.68;

const extractMesh = (root: Object3D): { geometry: BufferGeometry; material: Material } => {
  root.updateMatrixWorld(true);
  let source: Mesh | undefined;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh && !source) source = mesh;
  });
  if (!source) throw new Error('crystal cluster GLB contains no mesh');

  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = Array.isArray(source.material) ? source.material[0] : source.material;
  if (!material) throw new Error('crystal cluster GLB contains no material');
  return { geometry, material };
};

const CrystalInstances = ({
  geometry,
  material,
  placements,
  name,
}: {
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  placements: readonly CrystalClusterPlacement[];
  name: string;
}) => {
  const ref = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const transform = new Object3D();
    placements.forEach((placement, index) => {
      const [x, z] = placement.position;
      transform.position.set(x, heightAt(x, z) + (placement.yOffset ?? 0), z);
      transform.rotation.set(0, placement.rotationY, 0);
      transform.scale.setScalar(placement.scale * CRYSTAL_VISUAL_SCALE);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      const hash = Math.abs(
        Math.sin(
          placement.position[0] * 12.9898 +
            placement.position[1] * 78.233 +
            placement.rotationY * 19.19,
        ),
      );
      // Near-white instance tints preserve the authored violet-to-cyan vertex gradient
      // while giving repeated clusters a subtly warmer lavender or cooler ice cast.
      const color = new Color().setHSL(0.69 + hash * 0.065, 0.14 + hash * 0.07, 0.88 + hash * 0.045);
      mesh.setColorAt(index, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements]);

  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geometry, material, placements.length]}
      castShadow={false}
      receiveShadow
    />
  );
};

const CrystalGroundGlow = ({ placement }: { placement: CrystalClusterPlacement }) => {
  const light = useRef<PointLight>(null);
  const material = useMemo(() => {
    const mat = new MeshBasicMaterial({
      color: '#7f35ff',
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return mat;
  }, []);
  const phase = useMemo(
    () => Math.abs(Math.sin(placement.position[0] * 2.17 + placement.position[1] * 4.73)) * Math.PI * 2,
    [placement],
  );
  const [x, z] = placement.position;
  const y = heightAt(x, z) + 0.025;
  const visualScale = placement.scale * CRYSTAL_VISUAL_SCALE;

  useFrame(({ clock }) => {
    const pulse = 0.92 + Math.sin(clock.elapsedTime * 1.15 + phase) * 0.08;
    material.opacity = 0.075 * pulse;
    if (light.current) light.current.intensity = 0.36 * pulse;
  });

  useEffect(() => () => material.dispose(), [material]);

  return (
    <group>
      <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, placement.rotationY]} material={material}>
        <circleGeometry args={[1.45 * visualScale + 0.38, 24]} />
      </mesh>
      <pointLight
        ref={light}
        position={[x, y + 0.75 * visualScale, z]}
        color="#853cff"
        intensity={0.36}
        distance={3.8}
        decay={2}
      />
    </group>
  );
};

/** Three shared geometry/material batches, regardless of how many clusters are placed. */
const CrystalClusterField = ({
  placements,
  name,
  groundedGlow = false,
}: {
  placements: readonly CrystalClusterPlacement[];
  name: string;
  groundedGlow?: boolean;
}) => {
  const smallA = useGameModel(CRYSTAL_MODEL_PATHS.smallA);
  const smallB = useGameModel(CRYSTAL_MODEL_PATHS.smallB);
  const large = useGameModel(CRYSTAL_MODEL_PATHS.large);

  const placementsByAsset = useMemo<
    Record<CrystalClusterAsset, readonly CrystalClusterPlacement[]>
  >(
    () => ({
      smallA: placements.filter((placement) => placement.asset === 'smallA'),
      smallB: placements.filter((placement) => placement.asset === 'smallB'),
      large: placements.filter((placement) => placement.asset === 'large'),
    }),
    [placements],
  );

  const assets = useMemo(() => {
    const a = extractMesh(smallA.scene);
    const b = extractMesh(smallB.scene);
    const landmark = extractMesh(large.scene);
    const material = a.material.clone() as MeshStandardMaterial;
    material.name = 'crystal_emissive_shared';
    material.color.set('#ffffff');
    material.emissive.set('#ffffff');
    material.emissiveIntensity = 1;
    material.metalness = 0;
    material.roughness = 0.16;
    material.envMapIntensity = 1.35;
    material.vertexColors = true;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCrystalTime = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vCrystalPhase;\nvarying vec3 vCrystalLocalPosition;',
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vCrystalLocalPosition = position;
          #ifdef USE_INSTANCING
            vec2 crystalXZ = instanceMatrix[3].xz;
            vCrystalPhase = fract(sin(dot(crystalXZ, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
          #else
            vCrystalPhase = 0.0;
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uCrystalTime;\nvarying float vCrystalPhase;\nvarying vec3 vCrystalLocalPosition;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float crystalPulse = 0.94 + sin(uCrystalTime * 0.82 + vCrystalPhase) * 0.06;
          float crystalTip = smoothstep(0.34, 0.76, diffuseColor.g);
          float crystalFacing = abs(dot(normalize(vViewPosition), normal));
          float crystalRim = pow(1.0 - clamp(crystalFacing, 0.0, 1.0), 2.2);
          float crystalStriation = 0.96 + 0.04 * sin(
            vCrystalLocalPosition.y * 18.0 +
            vCrystalLocalPosition.x * 7.0 +
            vCrystalPhase
          );
          vec3 crystalPaint = diffuseColor.rgb * crystalStriation;
          vec3 crystalIce = vec3(0.64, 0.94, 1.0);
          diffuseColor.rgb = mix(
            crystalPaint,
            crystalIce,
            clamp(crystalTip * 0.14 + crystalRim * 0.28, 0.0, 0.36)
          );
          totalEmissiveRadiance = crystalPaint *
            (0.22 + crystalTip * 0.34 + crystalRim * 0.58) * crystalPulse;`,
        );
      material.userData.shader = shader;
    };
    material.customProgramCacheKey = () => 'crystal-faceted-gradient-v2';
    return {
      smallA: a.geometry,
      smallB: b.geometry,
      large: landmark.geometry,
      material,
    };
  }, [smallA.scene, smallB.scene, large.scene]);

  useFrame(({ clock }) => {
    const shader = assets.material.userData.shader as
      | { uniforms: { uCrystalTime?: { value: number } } }
      | undefined;
    if (shader?.uniforms.uCrystalTime) shader.uniforms.uCrystalTime.value = clock.elapsedTime;
  });

  useEffect(
    () => () => {
      assets.smallA.dispose();
      assets.smallB.dispose();
      assets.large.dispose();
      assets.material.dispose();
    },
    [assets],
  );

  return (
    <group name={name}>
      <CrystalInstances
        name={`${name}-small-a`}
        geometry={assets.smallA}
        material={assets.material}
        placements={placementsByAsset.smallA}
      />
      <CrystalInstances
        name={`${name}-small-b`}
        geometry={assets.smallB}
        material={assets.material}
        placements={placementsByAsset.smallB}
      />
      <CrystalInstances
        name={`${name}-large`}
        geometry={assets.large}
        material={assets.material}
        placements={placementsByAsset.large}
      />
      {groundedGlow &&
        placementsByAsset.large.map((placement) => (
          <CrystalGroundGlow key={`${name}-${placement.id}-ground-glow`} placement={placement} />
        ))}
    </group>
  );
};

export const HubCrystalClusters = () => (
  <CrystalClusterField name="hub-authored-crystals" placements={HUB_CRYSTAL_PLACEMENTS} />
);

export const ExpeditionCrystalClusters = () => (
  <CrystalClusterField
    name="expedition-authored-crystals"
    placements={EXPEDITION_CRYSTAL_PLACEMENTS}
    groundedGlow
  />
);

Object.values(CRYSTAL_MODEL_PATHS).forEach((path) => useGameModel.preload(path));
