import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Object3D,
  ShaderMaterial,
  MeshBasicMaterial,
  type InstancedMesh,
  type LineSegments,
  type LineBasicMaterial,
  type Group,
} from 'three';
import { RELIC_CORRUPTION_TUNING } from '@shared/balance';
import type { Entity } from '@sim/components';
import { localPlayers, relics, world } from '@/game/ecs/world';
import { netClient } from '@/net/client';
import { relicNet } from '@/net/relicNet';

const AMBER = '#ffb347';
const GOLD = '#ffe08a';
const VIOLET = '#a855f7';
const MAGENTA = '#ff42c8';
const BLOOD = '#ff456f';
const WHITE_HOT = '#fff1ff';

const tierAt = (corruption: number): number => {
  const value = Math.max(0, Math.min(RELIC_CORRUPTION_TUNING.max, corruption));
  const index = RELIC_CORRUPTION_TUNING.tiers.findIndex((tier, tierIndex) =>
    tierIndex === RELIC_CORRUPTION_TUNING.tiers.length - 1
      ? value <= tier.maxCorruption
      : value < tier.maxCorruption,
  );
  return Math.max(0, index);
};

/** Resolve the authoritative carrier into the local presentation ECS in either mode. */
const carrierState = (): { carrier?: Entity; corruption: number } => {
  const net = relicNet.state;
  if (net.phase !== 'absent') {
    if (net.phase !== 'carried' || net.carrierId === null) {
      return { corruption: net.corruption };
    }
    if (net.carrierId === netClient.localEntityId()) {
      return { carrier: localPlayers.first, corruption: net.corruption };
    }
    for (const entity of world.with('transform')) {
      if (entity.serverEntityId === net.carrierId) {
        return { carrier: entity, corruption: net.corruption };
      }
    }
    return { corruption: net.corruption };
  }

  const relic = relics.first?.relic;
  return {
    carrier: relic?.phase === 'carried' ? relic.carrier : undefined,
    corruption: relic?.corruption ?? 0,
  };
};

const makeLightning = (): BufferGeometry => {
  const geometry = new BufferGeometry();
  // Three broken arcs, seven segments each. Positions are rewritten in-place while overloaded.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(3 * 7 * 2 * 3), 3));
  return geometry;
};

const VFX_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SIGIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uTier;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vUv;

  float band(float value, float center, float width) {
    return 1.0 - smoothstep(width, width + 0.012, abs(value - center));
  }
  void main() {
    vec2 p = vUv - 0.5;
    float radius = length(p) * 2.0;
    float angle = atan(p.y, p.x);
    float spokes = abs(sin(angle * (4.0 + uTier) + uTime * 0.32));
    float broken = step(0.22 + 0.05 * sin(uTime * 1.7), spokes);
    float outer = band(radius, 0.78, 0.018) * broken;
    float inner = band(radius, 0.55, 0.012) * step(0.48, abs(cos(angle * 6.0 - uTime * 0.45)));
    float teeth = band(radius, 0.665 + sin(angle * 8.0) * 0.035, 0.014)
      * step(0.68, abs(sin(angle * 8.0)));
    float sweep = band(radius, 0.39 + 0.055 * sin(angle * 3.0 + uTime * 1.5), 0.012);
    float glyph = max(max(outer, inner), max(teeth, sweep));
    float soft = band(radius, 0.67, 0.15) * 0.08;
    float flicker = 0.82 + 0.18 * sin(uTime * 6.0 + angle * 5.0);
    vec3 color = mix(uColorA, uColorB, clamp(radius + sin(angle * 3.0) * 0.18, 0.0, 1.0));
    float alpha = (glyph * 0.82 + soft) * flicker * uIntensity;
    gl_FragColor = vec4(color * (1.1 + glyph * 1.9), alpha);
  }
`;

const SHELL_VERTEX = /* glsl */ `
  varying float vRim;
  varying vec3 vLocal;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 viewDir = normalize(-mv.xyz);
    vec3 n = normalize(normalMatrix * normal);
    vRim = 1.0 - abs(dot(n, viewDir));
    vLocal = position;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHELL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uTier;
  uniform vec3 uColor;
  varying float vRim;
  varying vec3 vLocal;
  void main() {
    float rim = pow(vRim, 3.1);
    float scan = pow(max(0.0, sin(vLocal.y * 17.0 - uTime * (2.0 + uTier * 0.35))), 12.0);
    float fracture = step(0.92, sin(vLocal.x * 31.0 + sin(vLocal.y * 19.0) * 2.4));
    float detail = rim * (0.32 + scan * 0.72) + rim * fracture * 0.22;
    gl_FragColor = vec4(uColor * (1.0 + detail * 2.4), detail * uIntensity * 0.34);
  }
`;

const makeSigilMaterial = (): ShaderMaterial =>
  new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uTier: { value: 0 },
      uColorA: { value: new Color(VIOLET) },
      uColorB: { value: new Color(MAGENTA) },
    },
    vertexShader: VFX_VERTEX,
    fragmentShader: SIGIL_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });

const makeShellMaterial = (): ShaderMaterial =>
  new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uTier: { value: 0 },
      uColor: { value: new Color(MAGENTA) },
    },
    vertexShader: SHELL_VERTEX,
    fragmentShader: SHELL_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });

const MOTE_COUNT = 28;
const moteSeeds = Array.from({ length: MOTE_COUNT }, (_, index) => ({
  phase: (index * 0.61803398875) % 1,
  angle: index * 2.399963,
  radius: 0.38 + ((index * 17) % 11) * 0.035,
  speed: 0.55 + ((index * 13) % 9) * 0.045,
}));

/**
 * Cumulative, gameplay-readable carrier VFX:
 * Stirring = amber damage/attack arcs; Charged = twin-shot wisps + lifesteal motes;
 * Volatile = speed rune + piercing lances; Overload = triple crown + unstable lightning.
 * All geometry is tiny, unlit and additive: no texture fetches, shadows, or dynamic lights.
 */
export const RelicCarrierPowerVFX = () => {
  const root = useRef<Group>(null);
  const attackLayer = useRef<Group>(null);
  const chargedLayer = useRef<Group>(null);
  const volatileLayer = useRef<Group>(null);
  const overloadLayer = useRef<Group>(null);
  const twinWisps = useRef<Group>(null);
  const lifestealMotes = useRef<Group>(null);
  const pierceLances = useRef<Group>(null);
  const crown = useRef<Group>(null);
  const lightning = useRef<LineSegments>(null);
  const energyMotes = useRef<InstancedMesh>(null);
  const moteMaterial = useRef<MeshBasicMaterial>(null);
  const tierBurst = useRef<Group>(null);
  const lightningGeometry = useMemo(makeLightning, []);
  const sigilMaterial = useMemo(makeSigilMaterial, []);
  const shellMaterial = useMemo(makeShellMaterial, []);
  const tierBurstMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: MAGENTA,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    [],
  );
  const moteDummy = useMemo(() => new Object3D(), []);
  const energy = useRef([0, 0, 0, 0]);
  const lastCarrier = useRef<Entity | undefined>(undefined);
  const lastTier = useRef(0);
  const burstAt = useRef(-10);
  const pulseColor = useMemo(() => new Color(MAGENTA), []);
  const whiteHot = useMemo(() => new Color(WHITE_HOT), []);
  const moteColor = useMemo(() => new Color(VIOLET), []);

  useEffect(
    () => () => {
      sigilMaterial.dispose();
      shellMaterial.dispose();
      lightningGeometry.dispose();
      tierBurstMaterial.dispose();
    },
    [lightningGeometry, shellMaterial, sigilMaterial, tierBurstMaterial],
  );

  useFrame((state, dt) => {
    const resolved = carrierState();
    const carrier = resolved.carrier;
    const transform = carrier?.transform;
    const activeTier = carrier ? tierAt(resolved.corruption) : 0;
    const time = state.clock.elapsedTime;

    const changedCarrier = carrier !== lastCarrier.current;
    if (transform && root.current) {
      // A pass relocates the complete power signature on the same frame; no ghost remains on
      // the previous holder. The short scale-in makes the recipient feel like they absorbed it.
      if (changedCarrier) {
        energy.current.fill(0);
        lastTier.current = activeTier;
      }
      root.current.position.set(...transform.position);
      root.current.rotation.y = transform.rotationY;
      lastCarrier.current = carrier;
    }

    if (!changedCarrier && carrier && activeTier > lastTier.current) burstAt.current = time;
    lastTier.current = activeTier;

    const layers = [attackLayer.current, chargedLayer.current, volatileLayer.current, overloadLayer.current];
    for (let i = 0; i < layers.length; i += 1) {
      const target = carrier && activeTier >= i + 1 ? 1 : 0;
      const current = energy.current[i] ?? 0;
      const rate = target > current ? 7 : 12;
      energy.current[i] = current + (target - current) * (1 - Math.exp(-rate * dt));
      const layer = layers[i];
      if (!layer) continue;
      const value = energy.current[i]!;
      layer.visible = value > 0.015;
      layer.scale.setScalar(Math.max(0.001, value));
    }
    if (root.current) root.current.visible = energy.current.some((value) => value > 0.015);

    // A single shared rune language grounds every tier. The glyph gains spokes with the tier,
    // while the body shell stays mostly on the silhouette so it never paints over the hero.
    sigilMaterial.uniforms.uTime!.value = time;
    sigilMaterial.uniforms.uIntensity!.value = energy.current[0] ?? 0;
    sigilMaterial.uniforms.uTier!.value = activeTier;
    shellMaterial.uniforms.uTime!.value = time;
    shellMaterial.uniforms.uIntensity!.value = (energy.current[0] ?? 0) * (0.65 + activeTier * 0.09);
    shellMaterial.uniforms.uTier!.value = activeTier;

    // Energy fragments rise, orbit and dissolve instead of forming a uniform particle cloud.
    // Count is tier-bounded (10/16/22/28), keeping the one-carrier effect predictable to budget.
    if (energyMotes.current) {
      const count = carrier && activeTier > 0 ? Math.min(MOTE_COUNT, 4 + activeTier * 6) : 0;
      energyMotes.current.count = count;
      for (let index = 0; index < count; index += 1) {
        const seed = moteSeeds[index]!;
        const life = (time * seed.speed + seed.phase) % 1;
        const angle = seed.angle + time * (0.8 + activeTier * 0.11) + life * 1.2;
        const radius = seed.radius * (0.78 + Math.sin(life * Math.PI) * 0.32);
        moteDummy.position.set(
          Math.cos(angle) * radius,
          0.18 + life * 1.72,
          Math.sin(angle) * radius,
        );
        moteDummy.rotation.set(angle * 0.7, time * 1.8 + seed.angle, angle);
        const taper = Math.sin(life * Math.PI);
        moteDummy.scale.set(0.035 + taper * 0.03, 0.075 + taper * 0.1, 0.035 + taper * 0.03);
        moteDummy.updateMatrix();
        energyMotes.current.setMatrixAt(index, moteDummy.matrix);
      }
      energyMotes.current.instanceMatrix.needsUpdate = true;
    }
    if (moteMaterial.current) {
      moteColor
        .set(activeTier >= 3 ? MAGENTA : VIOLET)
        .lerp(whiteHot, activeTier === 4 ? Math.max(0, Math.sin(time * 9)) * 0.28 : 0);
      moteMaterial.current.color.copy(moteColor);
      moteMaterial.current.opacity = 0.35 + activeTier * 0.1;
    }

    // Tier-up accent: anticipation is supplied by the meter; this 420 ms peak/recovery burst
    // confirms the new power on the avatar, then clears before it can become combat clutter.
    const burstAge = time - burstAt.current;
    if (tierBurst.current) {
      const active = burstAge >= 0 && burstAge < 0.42;
      tierBurst.current.visible = active;
      if (active) {
        const u = Math.min(1, burstAge / 0.42);
        const eased = 1 - Math.pow(1 - u, 3);
        tierBurst.current.scale.setScalar(0.35 + eased * 1.15);
        tierBurst.current.rotation.y = time * 2.8;
        tierBurstMaterial.opacity = Math.sin(u * Math.PI) * 0.92;
      }
    }

    // Stirring: two counter-rotating, broken-looking amber attack halos around the torso.
    if (attackLayer.current) {
      attackLayer.current.rotation.y = time * 1.45;
      attackLayer.current.rotation.z = Math.sin(time * 2.1) * 0.08;
    }

    // Charged: exactly two orbiting projectile souls, plus blood-pink motes that spiral inward
    // to teach the 15% lifesteal without placing an icon over the character.
    if (twinWisps.current) {
      twinWisps.current.rotation.y = -time * 2.65;
      twinWisps.current.rotation.z = Math.sin(time * 1.8) * 0.18;
      twinWisps.current.children.forEach((child, index) => {
        const angle = index * Math.PI;
        child.position.set(Math.cos(angle) * 0.72, 1.15 + Math.sin(time * 4 + angle) * 0.1, Math.sin(angle) * 0.72);
        child.rotation.y = time * 4 + angle;
      });
    }
    if (lifestealMotes.current) {
      lifestealMotes.current.children.forEach((child, index) => {
        const phase = (time * 0.85 + index / 7) % 1;
        const angle = time * 2.2 + index * 2.399;
        const radius = 0.5 * (1 - phase) + 0.08;
        child.position.set(Math.cos(angle) * radius, 0.35 + phase * 1.25, Math.sin(angle) * radius);
        child.scale.setScalar(0.55 + (1 - phase) * 0.6);
      });
    }

    // Volatile: a rotating movement rune at the feet and three forward-pointing pierce fins.
    if (volatileLayer.current) volatileLayer.current.rotation.y = time * 0.9;
    if (pierceLances.current) {
      pierceLances.current.position.z = 0.05 + Math.sin(time * 5.5) * 0.06;
      pierceLances.current.children.forEach((child, index) => {
        child.position.y = 0.78 + index * 0.33 + Math.sin(time * 4 + index) * 0.05;
      });
    }

    // Overload: the three-shot crown judders while procedural lightning tears toward the body.
    if (crown.current) {
      const shake = Math.sin(time * 31) * 0.018 + Math.sin(time * 47.3) * 0.009;
      crown.current.position.set(shake, 2.2 + Math.sin(time * 8) * 0.035, -shake);
      crown.current.rotation.y = -time * 2.4 + shake * 8;
      crown.current.children.forEach((child, index) => {
        const flare = 1 + Math.max(0, Math.sin(time * 10 + index * 2.1)) * 0.28;
        child.scale.setScalar(flare);
      });
    }
    const positions = lightningGeometry.getAttribute('position') as BufferAttribute;
    const array = positions.array as Float32Array;
    let cursor = 0;
    for (let arc = 0; arc < 3; arc += 1) {
      const angle = time * -2.4 + arc * ((Math.PI * 2) / 3);
      for (let segment = 0; segment < 7; segment += 1) {
        for (let end = 0; end < 2; end += 1) {
          const u = (segment + end) / 7;
          const jitter = Math.sin(time * 37 + arc * 9.1 + (segment + end) * 4.7) * 0.055;
          const radius = 0.42 * (1 - u) + 0.1;
          array[cursor++] = Math.cos(angle + jitter * 3) * radius + jitter;
          array[cursor++] = 2.18 - u * 1.15 + Math.sin(time * 29 + segment) * 0.025;
          array[cursor++] = Math.sin(angle + jitter * 3) * radius - jitter;
        }
      }
    }
    positions.needsUpdate = true;
    if (lightning.current) {
      const material = lightning.current.material as LineBasicMaterial;
      if (!Array.isArray(material)) {
        pulseColor.set(MAGENTA).lerp(whiteHot, Math.max(0, Math.sin(time * 18)) * 0.8);
        material.color.copy(pulseColor);
        material.opacity = 0.35 + Math.max(0, Math.sin(time * 23.7)) * 0.6;
      }
    }
  });

  return (
    <group ref={root} visible={false}>
      {/* Shared focal hierarchy: authored ground sigil -> silhouette shell -> sparse fragments. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.028, 0]} scale={1.18}>
        <planeGeometry args={[1.65, 1.65, 1, 1]} />
        <primitive object={sigilMaterial} attach="material" />
      </mesh>
      <mesh position={[0, 1.02, 0]} scale={[0.52, 0.98, 0.4]}>
        <sphereGeometry args={[1, 24, 16]} />
        <primitive object={shellMaterial} attach="material" />
      </mesh>
      <instancedMesh ref={energyMotes} args={[undefined, undefined, MOTE_COUNT]} frustumCulled={false}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          ref={moteMaterial}
          color={VIOLET}
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>
      <group ref={tierBurst} visible={false} position={[0, 1.05, 0]}>
        {Array.from({ length: 12 }, (_, index) => {
          const angle = index * (Math.PI / 6);
          return (
            <mesh
              key={index}
              position={[Math.cos(angle) * 0.56, Math.sin(index * 2.2) * 0.13, Math.sin(angle) * 0.56]}
              rotation={[Math.PI / 2, -angle, Math.PI / 4]}
              scale={[0.34, 1.25, 0.34]}
            >
              <octahedronGeometry args={[0.12, 0]} />
              <primitive object={tierBurstMaterial} attach="material" />
            </mesh>
          );
        })}
      </group>
      <group ref={attackLayer} visible={false} position={[0, 1.05, 0]}>
        <mesh rotation={[Math.PI / 2.8, 0, 0.22]}>
          <torusGeometry args={[0.58, 0.025, 5, 32, Math.PI * 1.42]} />
          <meshBasicMaterial color={AMBER} transparent opacity={0.78} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2.5, Math.PI, -0.28]}>
          <torusGeometry args={[0.48, 0.018, 4, 28, Math.PI * 1.12]} />
          <meshBasicMaterial color={GOLD} transparent opacity={0.58} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
        {[0, 1, 2, 3].map((index) => (
          <mesh key={index} position={[Math.cos(index * Math.PI / 2) * 0.58, (index % 2) * 0.12 - 0.06, Math.sin(index * Math.PI / 2) * 0.58]} rotation={[0, index * Math.PI / 2, Math.PI / 4]}>
            <octahedronGeometry args={[0.075, 0]} />
            <meshBasicMaterial color={index % 2 ? GOLD : AMBER} transparent opacity={0.9} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
          </mesh>
        ))}
      </group>

      <group ref={chargedLayer} visible={false}>
        <group ref={twinWisps}>
          {[0, 1].map((index) => (
            <mesh key={index} scale={[0.7, 1.35, 0.7]}>
              <octahedronGeometry args={[0.13, 0]} />
              <meshBasicMaterial color={index ? MAGENTA : VIOLET} transparent opacity={0.92} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
            </mesh>
          ))}
        </group>
        <group ref={lifestealMotes}>
          {Array.from({ length: 7 }, (_, index) => (
            <mesh key={index}>
              <sphereGeometry args={[0.035, 5, 4]} />
              <meshBasicMaterial color={BLOOD} transparent opacity={0.72} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
            </mesh>
          ))}
        </group>
      </group>

      <group ref={volatileLayer} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
          <ringGeometry args={[0.62, 0.68, 24, 1, 0.18, Math.PI * 1.72]} />
          <meshBasicMaterial color={VIOLET} side={DoubleSide} transparent opacity={0.62} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
        {[0, 1, 2, 3].map((index) => {
          const angle = index * Math.PI / 2;
          return (
            <mesh key={index} position={[Math.cos(angle) * 0.68, 0.045, Math.sin(angle) * 0.68]} rotation={[0, -angle, Math.PI / 2]}>
              <coneGeometry args={[0.11, 0.3, 3]} />
              <meshBasicMaterial color={MAGENTA} side={DoubleSide} transparent opacity={0.78} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
            </mesh>
          );
        })}
        <group ref={pierceLances} position={[0, 0.8, 0.1]}>
          {[-1, 0, 1].map((index) => (
            <mesh key={index} position={[index * 0.35, 0, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[0.45, 1.35, 0.45]}>
              <octahedronGeometry args={[0.115, 0]} />
              <meshBasicMaterial color={index === 0 ? VIOLET : MAGENTA} transparent opacity={0.66} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
            </mesh>
          ))}
        </group>
      </group>

      <group ref={overloadLayer} visible={false}>
        <group ref={crown}>
          {[0, 1, 2].map((index) => {
            const angle = index * ((Math.PI * 2) / 3);
            return (
              <mesh key={index} position={[Math.cos(angle) * 0.43, 0, Math.sin(angle) * 0.43]} rotation={[0, -angle, 0]} scale={[0.65, 1.55, 0.65]}>
                <octahedronGeometry args={[0.16, 0]} />
                <meshBasicMaterial color={index === 1 ? WHITE_HOT : MAGENTA} transparent opacity={0.95} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
              </mesh>
            );
          })}
        </group>
        <lineSegments ref={lightning} geometry={lightningGeometry}>
          <lineBasicMaterial color={MAGENTA} transparent opacity={0.7} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
        </lineSegments>
      </group>
    </group>
  );
};
