import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Box3, Vector3 } from 'three';
import type { BufferGeometry, Material, Mesh, MeshStandardMaterial } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';

const BANNER_PATH = '/models/hub/banner.glb';

const applyBannerWind = (material: MeshStandardMaterial, geometry: BufferGeometry) => {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const [minY, maxY, minZ, maxZ] = [
    bounds.min.y,
    bounds.max.y,
    bounds.min.z,
    bounds.max.z,
  ];
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uMinY = { value: minY };
    shader.uniforms.uMaxY = { value: maxY };
    shader.uniforms.uMinZ = { value: minZ };
    shader.uniforms.uMaxZ = { value: maxZ };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uMinY;
        uniform float uMaxY;
        uniform float uMinZ;
        uniform float uMaxZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float hy = clamp((uMaxY - transformed.y) / max(uMaxY - uMinY, 1e-4), 0.0, 1.0);
          float hz = clamp((transformed.z - uMinZ) / max(uMaxZ - uMinZ, 1e-4), 0.0, 1.0);
          float vert = smoothstep(0.16, 0.34, hy) * (1.0 - smoothstep(0.80, 0.92, hy));
          float horiz = smoothstep(0.14, 0.30, hz) * (1.0 - smoothstep(0.70, 0.86, hz));
          float amp = vert * horiz;
          float g = sin(uTime * 0.53) + sin(uTime * 0.27 + 2.1);
          float gust = 0.55 + smoothstep(0.55, 1.85, g) * 1.7;
          float p = uTime * 2.4;
          float wave = sin(p + transformed.z * 9.0 + transformed.y * 3.5) * 0.6
                     + sin(p * 1.7 + transformed.z * 17.0 - transformed.y * 6.0) * 0.28
                     + sin(p * 2.9 + hz * 22.0) * 0.14;
          float disp = wave * amp * gust * 0.16;
          transformed.x += disp;
          transformed.z += disp * 0.06;
        }`,
      );
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'shared-banner-wind-v1';
  material.needsUpdate = true;
};

export const WindBanner = ({
  position,
  rotationY = 0,
  targetHeight = 3.35,
}: {
  position: [number, number, number];
  rotationY?: number;
  targetHeight?: number;
}) => {
  const gltf = useGameModel(BANNER_PATH);
  const { object, scale, offset, windMaterials } = useMemo(() => {
    const clone = gltf.scene.clone(true);
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const normalizedScale = targetHeight / Math.max(size.y, 0.001);
    const materials: MeshStandardMaterial[] = [];

    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const multiple = Array.isArray(mesh.material);
      const sources: Material[] = multiple
        ? (mesh.material as Material[])
        : [mesh.material as Material];
      const clones = sources.map((source) => {
        const material = source.clone() as MeshStandardMaterial;
        if (material.isMeshStandardMaterial) {
          material.roughness = Math.max(0.55, material.roughness);
          material.envMapIntensity = 0.35;
          applyBannerWind(material, mesh.geometry as BufferGeometry);
          materials.push(material);
        }
        return material;
      });
      mesh.material = multiple ? clones : clones[0]!;
    });

    return {
      object: clone,
      scale: normalizedScale,
      offset: [
        -center.x * normalizedScale,
        -box.min.y * normalizedScale,
        -center.z * normalizedScale,
      ] as [number, number, number],
      windMaterials: materials,
    };
  }, [gltf.scene, targetHeight]);

  const windPhase = position[0] * 1.3 + position[2] * 0.7;
  useFrame(({ clock }) => {
    const time = clock.elapsedTime + windPhase;
    for (const material of windMaterials) {
      const shader = material.userData.shader as
        | { uniforms: { uTime?: { value: number } } }
        | undefined;
      if (shader?.uniforms.uTime) shader.uniforms.uTime.value = time;
    }
  });

  useEffect(() => () => windMaterials.forEach((material) => material.dispose()), [windMaterials]);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <primitive object={object} scale={scale} position={offset} />
    </group>
  );
};

const EXPEDITION_BANNERS = [
  { id: 'west-ruin-banner', position: [-13.2, -17.1] as const, rotationY: -Math.PI / 2 },
  { id: 'east-ruin-banner', position: [16.2, -17.25] as const, rotationY: -Math.PI / 2 },
] as const;

export const ExpeditionBanners = () => (
  <group name="expedition-reused-hub-banners">
    {EXPEDITION_BANNERS.map(({ id, position: [x, z], rotationY }) => (
      <WindBanner
        key={id}
        position={[x, heightAt(x, z), z]}
        rotationY={rotationY}
        targetHeight={3.2}
      />
    ))}
  </group>
);

useGameModel.preload(BANNER_PATH);
