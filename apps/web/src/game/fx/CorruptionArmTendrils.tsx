import { createPortal, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  CatmullRomCurve3,
  Color,
  TubeGeometry,
  Vector3,
  type Group,
  type MeshBasicMaterial,
  type Object3D,
} from 'three';

const makeHelix = (phase: number): TubeGeometry => {
  const points = Array.from({ length: 28 }, (_, index) => {
    const t = index / 27;
    const angle = phase + t * Math.PI * 5.5;
    const radius = 0.075 + Math.sin(t * Math.PI) * 0.018;
    return new Vector3(Math.cos(angle) * radius, -0.08 + t * 0.62, Math.sin(angle) * radius);
  });
  return new TubeGeometry(new CatmullRomCurve3(points), 40, 0.012, 5, false);
};

const ArmTendrils = ({
  bone,
  activeRef,
  corruptionRef,
  phase,
}: {
  bone: Object3D;
  activeRef: React.MutableRefObject<boolean>;
  corruptionRef: React.MutableRefObject<number>;
  phase: number;
}) => {
  const root = useRef<Group>(null);
  const firstMaterial = useRef<MeshBasicMaterial>(null);
  const secondMaterial = useRef<MeshBasicMaterial>(null);
  const first = useMemo(() => makeHelix(phase), [phase]);
  const second = useMemo(() => makeHelix(phase + Math.PI), [phase]);
  const violet = useMemo(() => new Color('#7c3aed'), []);
  const whiteHot = useMemo(() => new Color('#fff0ff'), []);

  useFrame((state) => {
    const progress = corruptionRef.current;
    const intensity =
      activeRef.current && progress >= 0.7
        ? 0.28 + Math.max(0, Math.min(1, (progress - 0.7) / 0.3)) * 0.72
        : 0;
    const g = root.current;
    if (!g) return;
    g.visible = intensity > 0.01;
    if (!g.visible) return;

    const time = state.clock.elapsedTime;
    const erratic = Math.sin(time * 13.7 + phase) * 0.55 + Math.sin(time * 23.1 + phase * 2) * 0.24;
    g.rotation.y = time * (1.8 + intensity * 4.2) + erratic * intensity;
    g.rotation.x = Math.sin(time * 9.3 + phase) * 0.08 * intensity;
    g.scale.set(1 + erratic * 0.035, 1, 1 + erratic * 0.035);

    const pulse = 0.65 + Math.sin(time * (8 + intensity * 9) + phase) * 0.35;
    if (firstMaterial.current) {
      firstMaterial.current.color.copy(violet).lerp(whiteHot, intensity * pulse * 0.55);
      firstMaterial.current.opacity = intensity * (0.42 + pulse * 0.4);
    }
    if (secondMaterial.current) {
      secondMaterial.current.color.copy(violet).lerp(whiteHot, intensity * 0.3);
      secondMaterial.current.opacity = intensity * (0.2 + (1 - pulse) * 0.28);
    }
  });

  return createPortal(
    <group ref={root} visible={false}>
      <mesh geometry={first}>
        <meshBasicMaterial
          ref={firstMaterial}
          transparent
          opacity={0}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <mesh geometry={second}>
        <meshBasicMaterial
          ref={secondMaterial}
          transparent
          opacity={0}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        color="#a855f7"
        intensity={0.8}
        distance={0.9}
        decay={2}
        position={[0, 0.28, 0]}
      />
    </group>,
    bone,
  );
};

/** Bone-mounted tendrils follow every animated arm pose for local and remote carriers. */
export const CorruptionArmTendrils = ({
  leftArm,
  rightArm,
  activeRef,
  corruptionRef,
}: {
  leftArm: Object3D | null;
  rightArm: Object3D | null;
  activeRef: React.MutableRefObject<boolean>;
  corruptionRef: React.MutableRefObject<number>;
}) => (
  <>
    {leftArm && (
      <ArmTendrils
        bone={leftArm}
        activeRef={activeRef}
        corruptionRef={corruptionRef}
        phase={0.35}
      />
    )}
    {rightArm && (
      <ArmTendrils
        bone={rightArm}
        activeRef={activeRef}
        corruptionRef={corruptionRef}
        phase={2.15}
      />
    )}
  </>
);
