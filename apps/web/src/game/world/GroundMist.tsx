import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, Object3D, ShaderMaterial } from 'three';
import type { InstancedMesh } from 'three';
import { heightAt } from '@/game/world/Terrain';

const MIST_COUNT = 28;

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MIST_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  void main() {
    vUv = uv;
    vec4 local = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif
    vec4 world = modelMatrix * local;
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const MIST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
    float a=hash21(i), b=hash21(i+vec2(1,0)), c=hash21(i+vec2(0,1)), d=hash21(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }
  void main() {
    vec2 centered = vUv * 2.0 - 1.0;
    float radial = 1.0 - smoothstep(0.28, 1.0, length(centered));
    vec2 flow = vWorldPosition.xz * 0.12 + vec2(uTime * 0.018, -uTime * 0.011);
    float broad = noise2(flow) * 0.65 + noise2(flow * 2.17 + 7.3) * 0.35;
    float wisps = smoothstep(0.3, 0.78, broad);
    float alpha = radial * wisps * 0.22;
    if (alpha < 0.006) discard;
    vec3 color = mix(vec3(0.24,0.23,0.37), vec3(0.48,0.45,0.66), broad);
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Low, translucent mist sheets that occupy hollows without blurring the whole frame. */
export const GroundMist = () => {
  const ref = useRef<InstancedMesh>(null);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        vertexShader: MIST_VERTEX,
        fragmentShader: MIST_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        fog: false,
      }),
    [],
  );

  const placements = useMemo(() => {
    const rng = mulberry32(991731);
    return Array.from({ length: MIST_COUNT }, (_, index) => {
      const band = index < 9 ? [10, 28] : index < 20 ? [24, 48] : [42, 68];
      const r = band[0]! + rng() * (band[1]! - band[0]!);
      const angle = rng() * Math.PI * 2;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      return {
        x,
        z,
        y: heightAt(x, z) + 0.12 + rng() * 0.14,
        scaleX: 5.5 + rng() * 8,
        scaleZ: 2.8 + rng() * 5,
        rotationY: rng() * Math.PI,
      };
    });
  }, []);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const transform = new Object3D();
    placements.forEach((placement, index) => {
      transform.position.set(placement.x, placement.y, placement.z);
      // Rotate within the plane first (local Z), then lay it flat. Using Euler Y here
      // tilts the already-flattened sheet and turns elongated mist into a light shaft.
      transform.rotation.set(-Math.PI / 2, 0, placement.rotationY);
      transform.scale.set(placement.scaleX, placement.scaleZ, 1);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements]);

  useFrame(({ clock }) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
  });

  useEffect(() => () => material.dispose(), [material]);

  return (
    <instancedMesh ref={ref} args={[undefined, material, MIST_COUNT]} frustumCulled={false} renderOrder={3}>
      <planeGeometry args={[2, 2, 1, 1]} />
    </instancedMesh>
  );
};
