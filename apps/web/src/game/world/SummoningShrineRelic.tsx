import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  MathUtils,
} from 'three';
import type {
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Points,
} from 'three';
import { players } from '@/game/ecs/world';
import { useGameModel } from '@/lib/loaders';

const PART_PATHS = {
  shell: '/models/relic/shell.glb',
  core: '/models/relic/violet_relic_crystal.glb',
  rune: '/models/relic/rune_fragment.glb',
} as const;

const TEAL = '#c06cff';
const GOLD = '#8f63ff';

interface PreparedPart {
  object: Object3D;
  materials: MeshStandardMaterial[];
}

/** Clone materials as well as nodes: the hub glow must not mutate the gameplay Relic. */
const preparePart = (source: Object3D, glow: string, intensity: number): PreparedPart => {
  const object = source.clone(true);
  const materials: MeshStandardMaterial[] = [];
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const wasArray = Array.isArray(mesh.material);
    const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const clones = originals.map((original) => {
      const material = original.clone() as MeshStandardMaterial;
      if (material.isMeshStandardMaterial) {
        material.emissive = new Color(glow);
        material.emissiveIntensity = intensity;
        material.toneMapped = false;
        material.roughness = Math.max(0.42, material.roughness);
        materials.push(material);
      }
      return material;
    });
    mesh.material = wasArray ? clones : clones[0]!;
  });
  return { object, materials };
};

const buildMotes = () => {
  const positions = new Float32Array(42 * 3);
  for (let i = 0; i < 42; i++) {
    // Golden-angle distribution: deterministic, evenly messy, and cheap to animate.
    const angle = i * 2.399963;
    const ring = 0.55 + ((i * 17) % 19) / 19 * 0.8;
    positions[i * 3] = Math.cos(angle) * ring;
    positions[i * 3 + 1] = -1.15 + ((i * 11) % 41) / 41 * 2.55;
    positions[i * 3 + 2] = Math.sin(angle) * ring;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
};

interface Props {
  position: [number, number, number];
  rotationY?: number;
}

/**
 * A shrine-only display Relic. It has no ECS entity and cannot be caught or thrown; this
 * keeps the hub spectacle completely separate from expedition gameplay rules.
 */
export const SummoningShrineRelic = ({ position, rotationY = 0 }: Props) => {
  const shellGltf = useGameModel(PART_PATHS.shell);
  const coreGltf = useGameModel(PART_PATHS.core);
  const runeGltf = useGameModel(PART_PATHS.rune);

  const core = useMemo(() => preparePart(coreGltf.scene, TEAL, 1.4), [coreGltf.scene]);
  const shells = useMemo(
    () => [preparePart(shellGltf.scene, '#8f78c9', 0.28), preparePart(shellGltf.scene, '#8f78c9', 0.28)],
    [shellGltf.scene],
  );
  const runes = useMemo(
    () => Array.from({ length: 5 }, () => preparePart(runeGltf.scene, GOLD, 1.35)),
    [runeGltf.scene],
  );
  const moteGeometry = useMemo(buildMotes, []);

  const hover = useRef<Group>(null);
  const assembly = useRef<Group>(null);
  const shellRefs = useRef<(Group | null)[]>([]);
  const runeOrbit = useRef<Group>(null);
  const runeRefs = useRef<(Group | null)[]>([]);
  const motes = useRef<Points>(null);
  const glowLight = useRef<PointLight>(null);
  const energy = useRef(0);

  useEffect(
    () => () => {
      moteGeometry.dispose();
      for (const part of [core, ...shells, ...runes]) {
        for (const material of part.materials) material.dispose();
      }
    },
    [core, moteGeometry, runes, shells],
  );

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const player = players.first?.transform?.position;
    const distance = player ? Math.hypot(player[0] - position[0], player[2] - position[2]) : 99;
    const targetEnergy = distance < 4.2 ? 1 : 0;
    energy.current = MathUtils.damp(energy.current, targetEnergy, 4, dt);
    const active = energy.current;

    if (hover.current) {
      hover.current.position.y = Math.sin(t * 1.65) * (0.065 + active * 0.025);
      hover.current.rotation.y = rotationY + t * (0.13 + active * 0.06);
    }
    if (assembly.current) assembly.current.rotation.y = Math.sin(t * 0.52) * 0.08;
    for (let i = 0; i < shellRefs.current.length; i++) {
      const shell = shellRefs.current[i];
      if (!shell) continue;
      const side = i === 0 ? -1 : 1;
      const breathe = Math.sin(t * 1.65 + i * Math.PI) * (0.045 + active * 0.025);
      shell.position.set(side * (0.58 + breathe), -0.08, 0);
      shell.rotation.set(0, side * Math.PI / 2 + t * side * 0.035, side * (0.28 + breathe * 0.35));
    }

    if (runeOrbit.current) runeOrbit.current.rotation.y = -t * (0.72 + active * 0.3);
    for (let i = 0; i < runeRefs.current.length; i++) {
      const rune = runeRefs.current[i];
      if (!rune) continue;
      const angle = (i / runeRefs.current.length) * Math.PI * 2;
      const radius = 1.02 + Math.sin(t * 1.4 + i) * 0.06;
      rune.position.set(Math.cos(angle) * radius, 0.05 + Math.sin(t * 2 + i * 1.3) * 0.22, Math.sin(angle) * radius);
      rune.rotation.set(t * 0.8 + i, -angle + t * 0.35, t * 0.45);
    }

    if (motes.current) {
      motes.current.rotation.y = -t * (0.28 + active * 0.18);
      motes.current.position.y = ((t * (0.12 + active * 0.06)) % 0.35) - 0.18;
    }

    const pulse = Math.sin(t * 3.2) * 0.22;
    for (const material of core.materials) material.emissiveIntensity = 1.35 + pulse + active * 0.75;
    for (const rune of runes) {
      for (const material of rune.materials) material.emissiveIntensity = 1.15 + pulse * 0.6 + active * 0.5;
    }
    if (glowLight.current) glowLight.current.intensity = 4.2 + active * 3 + pulse;
  });

  return (
    <group position={position}>
      <group ref={hover} rotation={[0, rotationY, 0]}>
        <group ref={assembly} scale={1.12}>
          <primitive object={core.object} scale={1.3} position={[0, 0.12, 0]} />
          {shells.map((shell, index) => (
            <group key={index} ref={(group) => (shellRefs.current[index] = group)}>
              <primitive object={shell.object} scale={0.94} />
            </group>
          ))}
          <group ref={runeOrbit}>
            {runes.map((rune, index) => (
              <group key={index} ref={(group) => (runeRefs.current[index] = group)}>
                <primitive object={rune.object} scale={0.25} />
              </group>
            ))}
          </group>
        </group>

        <points ref={motes} geometry={moteGeometry}>
          <pointsMaterial color={TEAL} size={0.055} sizeAttenuation transparent opacity={0.82} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </points>
      </group>

      <pointLight ref={glowLight} color={TEAL} intensity={4.2} distance={5.5} decay={2} />
      <pointLight color={GOLD} intensity={2.2} distance={4.2} decay={2} position={[0, -0.45, 0]} />
    </group>
  );
};

Object.values(PART_PATHS).forEach((path) => useGameModel.preload(path));
