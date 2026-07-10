import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  Box3,
  Color,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { Group, Mesh, Object3D as Object3DType } from 'three';
import { players } from '@/game/ecs/world';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { useGameModel } from '@/lib/loaders';
import { useUIStore } from '@/ui/store';
import { HUB_SPAWN, nearestHubStation, type HubStationId } from '@/game/world/hubLayout';
import { Terrain } from '@/game/world/Terrain';
import { GrassField } from '@/game/world/GrassField';
import { Trees } from '@/game/world/Trees';
import { Scatter } from '@/game/world/Scatter';

interface Props {
  obstacles: React.MutableRefObject<Object3DType[]>;
}

const MODEL_PATHS = {
  lodge: '/models/hub/roster-lodge.glb',
  shrine: '/models/hub/summoning-shrine.glb',
  gate: '/models/hub/expedition-gate.glb',
  curvedLamp: '/models/hub/lantern-curved.glb',
  straightLamp: '/models/hub/lantern-straight.glb',
} as const;

interface HubModelProps {
  path: string;
  targetHeight?: number;
  targetWidth?: number;
  position: [number, number, number];
  rotationY?: number;
  /** Corrects a model's authored front axis after applying gameplay-facing rotation. */
  faceOffset?: number;
}

/** Normalizes arbitrary Tripo export scale/pivot while preserving the authored proportions. */
const HubModel = ({ path, targetHeight, targetWidth, position, rotationY = 0, faceOffset = 0 }: HubModelProps) => {
  const gltf = useGameModel(path);
  const { object, scale, offset } = useMemo(() => {
    const clone = gltf.scene.clone(true);
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const s = targetWidth ? targetWidth / Math.max(size.x, 0.001) : (targetHeight ?? 1) / Math.max(size.y, 0.001);

    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const multipleMaterials = Array.isArray(mesh.material);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const clonedMaterials = materials.map((source) => {
        const material = source.clone() as MeshStandardMaterial;
        if (material.isMeshStandardMaterial) {
          material.roughness = Math.max(0.55, material.roughness);
          material.envMapIntensity = 0.35;
        }
        return material;
      });
      mesh.material = multipleMaterials ? clonedMaterials : clonedMaterials[0]!;
    });

    return {
      object: clone,
      scale: s,
      offset: [-center.x * s, -box.min.y * s, -center.z * s] as [number, number, number],
    };
  }, [gltf.scene, targetHeight, targetWidth]);

  return (
    <group position={position} rotation={[0, rotationY + faceOffset, 0]}>
      <primitive object={object} scale={scale} position={offset} />
    </group>
  );
};

const BRICK_COLORS = ['#777269', '#817a70', '#6c6964', '#8c8376'];

/** Procedural plaza: cheap, readable stonework with real grout gaps and restrained moss. */
const HavenPlaza = () => {
  const outer = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => {
        const angle = (i / 48) * Math.PI * 2;
        const radius = 18.8;
        return {
          position: [Math.sin(angle) * radius, 0.1 + (i % 3) * 0.007, Math.cos(angle) * radius] as const,
          rotation: -angle,
          color: BRICK_COLORS[i % BRICK_COLORS.length]!,
          scale: 0.94 + (i % 4) * 0.02,
        };
      }),
    [],
  );

  return (
    <group>
      <mesh position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[18.2, 80]} />
        <meshStandardMaterial color="#8b765c" roughness={0.96} />
      </mesh>
      <mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <ringGeometry args={[5.4, 5.85, 56]} />
        <meshStandardMaterial color="#686861" roughness={0.95} />
      </mesh>
      {outer.map((brick, i) => (
        <mesh
          key={i}
          position={brick.position}
          rotation={[0, brick.rotation, 0]}
          scale={brick.scale}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[2.28, 0.16, 0.9]} />
          <meshStandardMaterial color={brick.color} roughness={0.94} />
        </mesh>
      ))}
      {[0.6, 2.5, 4.1, 5.45].map((angle, i) => (
        <mesh
          key={angle}
          position={[Math.sin(angle) * 17.9, 0.112, Math.cos(angle) * 17.9]}
          rotation={[-Math.PI / 2, 0, angle]}
        >
          <circleGeometry args={[0.48 + i * 0.05, 9]} />
          <meshStandardMaterial color="#56703b" roughness={1} />
        </mesh>
      ))}
      {[
        { from: [0, 5], to: [0, -15.2], count: 10 },
        { from: [-1.5, 0], to: [-9.6, -6.1], count: 7 },
        { from: [1.5, 0], to: [9.3, -6.5], count: 7 },
      ].flatMap((path, pathIndex) =>
        Array.from({ length: path.count }, (_, i) => {
          const t = (i + 1) / (path.count + 1);
          const x = path.from[0]! + (path.to[0]! - path.from[0]!) * t;
          const z = path.from[1]! + (path.to[1]! - path.from[1]!) * t;
          const heading = Math.atan2(path.to[0]! - path.from[0]!, path.to[1]! - path.from[1]!);
          return (
            <mesh key={`${pathIndex}-${i}`} position={[x, 0.115 + (i % 2) * 0.008, z]} rotation={[0, heading, 0]} castShadow receiveShadow>
              <boxGeometry args={[1.45 + (i % 3) * 0.08, 0.13, 1.15]} />
              <meshStandardMaterial color={BRICK_COLORS[(i + pathIndex) % BRICK_COLORS.length]} roughness={0.96} />
            </mesh>
          );
        }),
      )}
    </group>
  );
};

const StationRing = ({ position, color, radius = 1.75 }: { position: [number, number, number]; color: string; radius?: number }) => {
  const ref = useRef<Mesh>(null);
  const material = useMemo(
    () => new MeshStandardMaterial({ color, emissive: new Color(color), emissiveIntensity: 0.42, roughness: 0.72 }),
    [color],
  );
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 1.8) * 0.025;
    ref.current.scale.setScalar(pulse);
    material.emissiveIntensity = 0.34 + Math.sin(clock.elapsedTime * 1.8) * 0.08;
  });
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh ref={ref} position={position} rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <ringGeometry args={[radius - 0.1, radius, 48]} />
    </mesh>
  );
};

const HubInteractions = () => {
  const initialized = useRef(false);
  const activeStation = useRef<HubStationId | undefined>(undefined);
  const setHubStation = useUIStore((s) => s.setHubStation);
  const setScene = useUIStore((s) => s.setScene);

  useFrame(() => {
    const player = players.first;
    if (!player?.transform) return;
    if (!initialized.current) {
      player.transform.position = [...HUB_SPAWN];
      player.transform.rotationY = Math.PI;
      initialized.current = true;
    }
    const station = nearestHubStation(player.transform.position[0], player.transform.position[2]);
    if (station?.id !== activeStation.current) {
      activeStation.current = station?.id;
      setHubStation(station?.id);
    }
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat) return;
      const station = activeStation.current;
      if (station === 'roster') {
        const store = useUIStore.getState();
        const ids = Object.keys(PLAYER_CHARACTERS) as PlayerCharacterId[];
        const next = ids[(ids.indexOf(store.playerCharacter) + 1) % ids.length];
        if (next) store.setPlayerCharacter(next);
      } else if (station === 'expedition') {
        const player = players.first;
        if (player?.transform && player.velocity) {
          player.transform.position = [0, 0, 0];
          player.transform.rotationY = Math.PI;
          player.velocity.linear = [0, 0, 0];
        }
        setHubStation(undefined);
        setScene('expedition');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setHubStation, setScene]);

  return null;
};

/** Heartwood Haven: a compact social hub built from the first production asset set. */
export const SocialHub = ({ obstacles }: Props) => {
  const landmarks = useRef<Group>(null);

  useEffect(() => {
    const meshes: Mesh[] = [];
    landmarks.current?.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
    obstacles.current = meshes;
    return () => {
      obstacles.current = [];
    };
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <GrassField clearRadius={20.5} />
      <Scatter clearRadius={26} />
      <Trees clearRadius={21.5} />
      <HavenPlaza />
      <group ref={landmarks}>
        <HubModel path={MODEL_PATHS.lodge} targetWidth={9.4} position={[-10.5, 0, -10.5]} rotationY={0} />
        <HubModel path={MODEL_PATHS.shrine} targetHeight={3.35} position={[10.5, 0.08, -7.4]} rotationY={-0.35} />
        <HubModel
          path={MODEL_PATHS.gate}
          targetHeight={4.5}
          position={[0, 0.08, -17]}
          rotationY={Math.PI}
          faceOffset={-Math.PI / 2}
        />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.55} position={[-6.8, 0.04, 7]} rotationY={0.45} />
        <HubModel path={MODEL_PATHS.straightLamp} targetHeight={3.05} position={[6.8, 0.04, 7]} rotationY={-0.45} />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.3} position={[-14.8, 0.04, -1.5]} rotationY={0.9} />
        <HubModel path={MODEL_PATHS.straightLamp} targetHeight={2.7} position={[14.8, 0.04, -1.5]} rotationY={-0.9} />
      </group>

      <StationRing position={[10.5, 0.105, -7.4]} color="#d1a344" radius={1.95} />
      <StationRing position={[0, 0.105, -17]} color="#42c8c7" radius={2.05} />

      {[
        [-6.8, 2.1, 7],
        [6.8, 2.5, 7],
        [-14.8, 1.9, -1.5],
        [14.8, 2.25, -1.5],
      ].map((position, i) => (
        <pointLight key={i} position={position as [number, number, number]} color="#ffb55f" intensity={5} distance={5.5} decay={2} />
      ))}
      <pointLight position={[0, 2, -17]} color="#66e1dc" intensity={9} distance={7} decay={2} />
      <directionalLight position={[2, 9, 12]} color="#ffe0b8" intensity={1.35} />

      <Html position={[-10.5, 3.55, -9.75]} center distanceFactor={13} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-full border border-amber-100/20 bg-[#21170f]/75 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.24em] text-amber-100 shadow-lg backdrop-blur-sm">
          Roster Lodge
        </div>
      </Html>
      <HubInteractions />
    </>
  );
};

Object.values(MODEL_PATHS).forEach((path) => useGameModel.preload(path));
