import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  type BufferAttribute,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type Points,
  type PointsMaterial,
} from 'three';
import { RELIC_CORRUPTION_TUNING } from '@shared/balance';
import { corruptionPowerVisual } from './corruptionPower';

const MAX_MOTES = 40;

interface MoteSeed {
  angle: number;
  radius: number;
  speed: number;
  height: number;
  phase: number;
}

/**
 * Procedural holder aura that makes each corruption power spike readable in-world.
 * It is presentation-only: refs are fed by the authoritative Relic renderer and no gameplay
 * state is mutated. Geometry is fixed-size and draw ranges scale by tier to keep it inexpensive.
 */
export const CorruptionPowerVFX = ({
  progressRef,
  heldRef,
  groundOffset,
}: {
  progressRef: React.MutableRefObject<number>;
  heldRef: React.MutableRefObject<boolean>;
  groundOffset: number;
}) => {
  const root = useRef<Group>(null);
  const orbit = useRef<Group>(null);
  const burstRing = useRef<Mesh>(null);
  const auraMaterial = useRef<MeshBasicMaterial>(null);
  const groundMaterial = useRef<MeshBasicMaterial>(null);
  const orbitMaterial = useRef<MeshBasicMaterial>(null);
  const orbitMaterialSecondary = useRef<MeshBasicMaterial>(null);
  const burstMaterial = useRef<MeshBasicMaterial>(null);
  const motePoints = useRef<Points>(null);
  const moteMaterial = useRef<PointsMaterial>(null);
  const smoothed = useRef(0);
  const lastTier = useRef(0);
  const burst = useRef(0);
  const cool = useMemo(() => new Color('#8b5cf6'), []);
  const hot = useMemo(() => new Color('#fff1ff'), []);
  const currentColor = useMemo(() => new Color(), []);
  const positions = useMemo(() => new Float32Array(MAX_MOTES * 3), []);
  const seeds = useMemo<MoteSeed[]>(
    () =>
      Array.from({ length: MAX_MOTES }, (_, index) => {
        // Golden-angle distribution: deterministic, visually irregular, no per-frame RNG.
        const phase = index * 2.399963;
        return {
          angle: phase,
          radius: 0.45 + ((index * 37) % 17) / 22,
          speed: 0.65 + ((index * 13) % 11) / 10,
          height: ((index * 29) % 31) / 31,
          phase,
        };
      }),
    [],
  );

  useFrame((state, dt) => {
    const held = heldRef.current;
    const corruption = progressRef.current * RELIC_CORRUPTION_TUNING.max;
    const visual = corruptionPowerVisual(corruption);
    const active = held && visual.tierIndex > 0;
    const target = active ? visual.intensity : 0;
    smoothed.current += (target - smoothed.current) * (1 - Math.exp(-7 * dt));
    const intensity = smoothed.current;

    if (held && visual.tierIndex > lastTier.current) burst.current = 1;
    lastTier.current = held ? visual.tierIndex : 0;
    burst.current = Math.max(0, burst.current - dt * 1.45);

    const group = root.current;
    if (!group) return;
    group.visible = intensity > 0.01 || burst.current > 0.01;
    group.position.y = groundOffset;

    cool.set(visual.color);
    hot.set(visual.hotColor);
    const pulseRate = 2.4 + visual.tierIndex * 1.25;
    const pulse = 0.68 + Math.sin(state.clock.elapsedTime * pulseRate) * 0.32;
    currentColor.copy(cool).lerp(hot, pulse * (0.12 + visual.tierIndex * 0.1));

    if (auraMaterial.current) {
      auraMaterial.current.color.copy(currentColor);
      auraMaterial.current.opacity = intensity * (0.045 + visual.tierIndex * 0.018) * pulse;
    }
    if (groundMaterial.current) {
      groundMaterial.current.color.copy(currentColor);
      groundMaterial.current.opacity = intensity * (0.24 + pulse * 0.16);
    }
    if (orbitMaterial.current) {
      orbitMaterial.current.color.copy(currentColor);
      orbitMaterial.current.opacity = intensity * (0.13 + pulse * 0.12);
    }
    if (orbitMaterialSecondary.current) {
      orbitMaterialSecondary.current.color.copy(currentColor).lerp(hot, 0.2);
      orbitMaterialSecondary.current.opacity = intensity * (0.08 + pulse * 0.08);
    }
    if (moteMaterial.current) {
      moteMaterial.current.color.copy(currentColor);
      moteMaterial.current.opacity = intensity * (0.48 + pulse * 0.34);
      moteMaterial.current.size = 0.035 + visual.tierIndex * 0.012;
    }

    const radius = 0.95 + intensity * 0.35;
    group.scale.setScalar(radius);
    if (orbit.current) {
      orbit.current.rotation.y += dt * (0.5 + visual.tierIndex * 0.34);
      orbit.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.7) * 0.12;
    }

    const count = active ? visual.particleCount : 0;
    const time = state.clock.elapsedTime;
    for (let index = 0; index < count; index += 1) {
      const seed = seeds[index]!;
      const rise = (seed.height + time * seed.speed * 0.22) % 1;
      const angle = seed.angle + time * (0.45 + visual.tierIndex * 0.12) + rise * 1.8;
      const radiusWobble = seed.radius * (0.75 + Math.sin(time * 1.7 + seed.phase) * 0.13);
      const offset = index * 3;
      positions[offset] = Math.cos(angle) * radiusWobble;
      positions[offset + 1] = 0.05 + rise * (1.45 + visual.tierIndex * 0.18);
      positions[offset + 2] = Math.sin(angle) * radiusWobble;
    }
    const positionAttribute = motePoints.current?.geometry.attributes.position as
      BufferAttribute | undefined;
    if (positionAttribute) positionAttribute.needsUpdate = true;
    motePoints.current?.geometry.setDrawRange(0, count);

    const burstValue = burst.current;
    if (burstRing.current) {
      burstRing.current.visible = burstValue > 0.01;
      const expansion = 0.65 + (1 - burstValue) * 1.75;
      burstRing.current.scale.setScalar(expansion);
    }
    if (burstMaterial.current) {
      burstMaterial.current.color.copy(hot);
      burstMaterial.current.opacity = burstValue * burstValue * 0.8;
    }
  });

  return (
    <group ref={root} visible={false}>
      <mesh position={[0, 1.05, 0]}>
        <cylinderGeometry args={[0.62, 1.05, 2.1, 24, 1, true]} />
        <meshBasicMaterial
          ref={auraMaterial}
          transparent
          opacity={0}
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
        <torusGeometry args={[0.92, 0.025, 8, 48]} />
        <meshBasicMaterial
          ref={groundMaterial}
          transparent
          opacity={0}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      <group ref={orbit} position={[0, 0.9, 0]}>
        <mesh rotation={[Math.PI / 2.8, 0.2, 0]}>
          <torusGeometry args={[0.72, 0.012, 6, 40]} />
          <meshBasicMaterial
            ref={orbitMaterial}
            transparent
            opacity={0}
            depthWrite={false}
            blending={AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
        <mesh rotation={[-Math.PI / 3.3, -0.35, Math.PI / 2]}>
          <torusGeometry args={[0.82, 0.009, 6, 40]} />
          <meshBasicMaterial
            ref={orbitMaterialSecondary}
            transparent
            opacity={0}
            depthWrite={false}
            blending={AdditiveBlending}
            color="#d8b4fe"
            toneMapped={false}
          />
        </mesh>
      </group>

      <points ref={motePoints} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[positions, 3]}
            usage={DynamicDrawUsage}
          />
        </bufferGeometry>
        <pointsMaterial
          ref={moteMaterial}
          transparent
          opacity={0}
          size={0.05}
          sizeAttenuation
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </points>

      <mesh ref={burstRing} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.08, 0]} visible={false}>
        <torusGeometry args={[0.8, 0.045, 8, 48]} />
        <meshBasicMaterial
          ref={burstMaterial}
          transparent
          opacity={0}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};
