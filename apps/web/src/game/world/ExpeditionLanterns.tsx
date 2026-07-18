import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Box3, CanvasTexture, Color, Vector3 } from 'three';
import type { Group, Mesh, PointLight, Sprite } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';
import { enhanceNatureMaterial } from '@/game/world/natureMaterials';
import { EXPEDITION_LANTERNS } from '@/game/world/expeditionEnvironment';
import { moodForScene } from '@/game/world/worldLighting';
import type { WarmLightRig } from '@/game/world/worldLighting';

const MODEL_PATHS = {
  ground: '/models/hub/lamp_1.glb',
  post: '/models/hub/lantern-straight.glb',
} as const;

const createWarmHaloTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 63);
  gradient.addColorStop(0, 'rgba(255,245,202,1)');
  gradient.addColorStop(0.16, 'rgba(255,180,76,0.8)');
  gradient.addColorStop(0.48, 'rgba(255,112,35,0.25)');
  gradient.addColorStop(1, 'rgba(255,78,16,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
};

const WarmLanternGlow = ({
  position,
  phase,
  withLight,
  size,
  warm,
}: {
  position: readonly [number, number, number];
  phase: number;
  withLight: boolean;
  size: number;
  /** Point-light colour/intensity/reach from the active mood — the warm accent that fights
   *  the cool moon key. The glow sprite + emissive bulb stay authored art. */
  warm: WarmLightRig;
}) => {
  const light = useRef<PointLight>(null);
  const halo = useRef<Sprite>(null);
  const texture = useMemo(createWarmHaloTexture, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const flicker =
      0.96 +
      Math.sin(t * 2.1 + phase) * 0.022 +
      Math.sin(t * 9.7 + phase * 1.73) * 0.014 +
      Math.sin(t * 17.3 + phase * 0.61) * 0.008;
    if (light.current) light.current.intensity = warm.intensity * flicker;
    halo.current?.scale.set(size * flicker, size * flicker, 1);
  });

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <group position={position}>
      <sprite ref={halo} scale={[size, size, 1]}>
        <spriteMaterial
          map={texture}
          color="#ffad45"
          transparent
          opacity={0.72}
          depthWrite={false}
          blending={AdditiveBlending}
          fog={false}
        />
      </sprite>
      <mesh>
        <sphereGeometry args={[0.075, 10, 8]} />
        <meshStandardMaterial
          color="#ffcf72"
          emissive={new Color('#ff761f')}
          emissiveIntensity={4.8}
          roughness={0.18}
        />
      </mesh>
      {withLight && (
        <pointLight ref={light} color={warm.color} intensity={warm.intensity} distance={warm.distance} decay={2} />
      )}
    </group>
  );
};

const normalizeModel = (source: Group, targetHeight: number) => {
  const object = source.clone(true);
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) {
      mesh.material = enhanceNatureMaterial(mesh.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const scale = targetHeight / Math.max(size.y, 0.001);
  object.scale.setScalar(scale);
  object.position.set(
    -((box.min.x + box.max.x) * 0.5) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) * 0.5) * scale,
  );
  return object;
};

/** Warm ruin lights that guide the lane without turning every prop into a point light. */
export const ExpeditionLanterns = () => {
  const ground = useGameModel(MODEL_PATHS.ground);
  const post = useGameModel(MODEL_PATHS.post);
  const warm = moodForScene('expedition').warm;

  const objects = useMemo(
    () =>
      EXPEDITION_LANTERNS.map((placement) => ({
        placement,
        object: normalizeModel(placement.model === 'ground' ? ground.scene : post.scene, placement.height),
      })),
    [ground.scene, post.scene],
  );

  return (
    <group name="expedition-warm-lanterns">
      {objects.map(({ placement, object }) => {
        const [x, z] = placement.position;
        const y = heightAt(x, z) + 0.02;
        const glowY = y + placement.height * (placement.model === 'post' ? 0.76 : 0.68);
        return (
          <group key={placement.id}>
            <group position={[x, y, z]} rotation={[0, placement.rotationY, 0]}>
              <primitive object={object} />
            </group>
            <WarmLanternGlow
              position={[x, glowY, z]}
              phase={placement.phase}
              withLight={placement.light}
              size={placement.model === 'post' ? 1.55 : 1.25}
              warm={warm}
            />
          </group>
        );
      })}
    </group>
  );
};

Object.values(MODEL_PATHS).forEach((path) => useGameModel.preload(path));
