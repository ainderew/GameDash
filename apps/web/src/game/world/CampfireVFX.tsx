import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Mesh, PointLight } from 'three';

const volumeVertex = /* glsl */ `
  varying vec3 vLocalPosition;

  void main() {
    vLocalPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const volumeFragment = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3 uCameraLocal;
  varying vec3 vLocalPosition;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0)), f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float weight = 0.56;
    for (int octave = 0; octave < 4; octave++) {
      value += noise3(p) * weight;
      p = p * 2.03 + vec3(7.1, 3.7, 5.4);
      weight *= 0.48;
    }
    return value;
  }

  vec2 hitBox(vec3 origin, vec3 direction) {
    vec3 safeDirection = sign(direction) * max(abs(direction), vec3(0.0001));
    vec3 inverseDirection = 1.0 / safeDirection;
    vec3 nearPlane = (-0.5 - origin) * inverseDirection;
    vec3 farPlane = (0.5 - origin) * inverseDirection;
    vec3 tMin = min(nearPlane, farPlane);
    vec3 tMax = max(nearPlane, farPlane);
    return vec2(max(max(tMin.x, tMin.y), tMin.z), min(min(tMax.x, tMax.y), tMax.z));
  }

  float flameDensity(vec3 p, float time, out float height, out float heat) {
    height = clamp(p.y + 0.5, 0.0, 1.0);

    // Fire does not morph at one constant rate. These brief impulse transitions create
    // a new gust state roughly eleven times per second, then hold it long enough for the
    // eye to read the torn silhouette instead of seeing smooth rubbery interpolation.
    float gustTick = floor(time * 11.0);
    float gustPhase = fract(time * 11.0);
    float gustTransition = smoothstep(0.0, 0.28, gustPhase);
    float gustA = mix(hash11(gustTick + 3.1), hash11(gustTick + 4.1), gustTransition) - 0.5;
    float gustB = mix(hash11(gustTick + 9.7), hash11(gustTick + 10.7), gustTransition) - 0.5;
    float gustC = mix(hash11(gustTick + 17.3), hash11(gustTick + 18.3), gustTransition) - 0.5;

    // The whole plume leans and curls, increasingly toward its buoyant tip.
    vec2 curl = vec2(
      sin(time * 1.74 + height * 6.8) + sin(time * 3.1 - height * 10.0) * 0.34,
      cos(time * 1.31 + height * 5.3) + sin(time * 2.43 + height * 8.7) * 0.28
    );
    curl += vec2(gustA, gustB) * (0.72 + height * 1.25);
    p.xz -= curl * (0.018 + height * height * 0.064);

    // A tapered body, then domain-warped 3D turbulence breaks it into changing tongues.
    float radius = mix(0.32, 0.02, pow(height, 0.76));
    vec3 flow = vec3(p.x * 4.2, p.y * 3.35 - time * 1.26, p.z * 4.2);
    float broadNoise = fbm(flow + vec3(gustA, gustC, gustB) * 0.7);
    vec3 warped = flow + vec3(
      noise3(flow * 0.72 + vec3(0.0, -time * 0.38, 4.1)),
      noise3(flow * 0.61 + vec3(2.7, -time * 0.54, 0.0)),
      noise3(flow * 0.74 + vec3(5.2, -time * 0.31, 1.3))
    ) * 0.92;
    float detailNoise = fbm(warped * 1.7);
    float tearingNoise = noise3(vec3(p.x * 15.0 + gustA * 2.0, p.y * 10.5 - time * 3.7, p.z * 15.0 + gustB * 2.0));
    float verticalRidges = 1.0 - abs(noise3(vec3(p.x * 10.0, p.y * 16.0 - time * 5.2, p.z * 10.0)) * 2.0 - 1.0);
    float radial = length(p.xz);
    float disturbedSurface = radius + (broadNoise - 0.5) * (0.085 + height * 0.12);
    disturbedSurface += (detailNoise - 0.5) * 0.075;
    disturbedSurface += (verticalRidges - 0.5) * 0.035;
    float density = smoothstep(-0.018, 0.032, disturbedSurface - radial);
    // Fast rising pockets bite chunks from the body instead of merely softening it.
    float tear = smoothstep(0.58, 0.78, tearingNoise + height * 0.08);
    density *= 1.0 - tear * smoothstep(0.28, 0.86, height) * 0.72;

    // Three offset lobes share the base but rise and expire independently. At gameplay
    // distance their negative spaces matter more than tiny high-frequency detail.
    vec2 lobeCenterA = vec2(-0.18, 0.025) + (vec2(sin(time * 2.1), cos(time * 1.6)) * 0.025 + vec2(gustA, gustC) * 0.045) * height;
    vec2 lobeCenterB = vec2(0.16, -0.075) + (vec2(cos(time * 1.7), sin(time * 2.35)) * 0.03 + vec2(gustB, gustA) * 0.05) * height;
    vec2 lobeCenterC = vec2(0.045, 0.17) + (vec2(sin(time * 1.45), cos(time * 2.55)) * 0.022 + vec2(gustC, gustB) * 0.042) * height;
    float lobeRadiusA = mix(0.2, 0.018, pow(clamp(height / 0.78, 0.0, 1.0), 0.72));
    float lobeRadiusB = mix(0.18, 0.015, pow(clamp(height / 0.66, 0.0, 1.0), 0.69));
    float lobeRadiusC = mix(0.17, 0.014, pow(clamp(height / 0.86, 0.0, 1.0), 0.75));
    float lobeNoiseA = (fbm(flow + vec3(4.7, 1.3, 0.8)) - 0.5) * (0.07 + height * 0.08);
    float lobeNoiseB = (fbm(flow * 1.08 + vec3(1.1, 5.4, 3.6)) - 0.5) * (0.065 + height * 0.07);
    float lobeNoiseC = (fbm(flow * 0.94 + vec3(6.2, 2.8, 5.1)) - 0.5) * (0.06 + height * 0.075);
    float lobeA = smoothstep(-0.014, 0.026, lobeRadiusA + lobeNoiseA - length(p.xz - lobeCenterA));
    float lobeB = smoothstep(-0.013, 0.024, lobeRadiusB + lobeNoiseB - length(p.xz - lobeCenterB));
    float lobeC = smoothstep(-0.013, 0.024, lobeRadiusC + lobeNoiseC - length(p.xz - lobeCenterC));
    lobeA *= 1.0 - smoothstep(0.68, 0.8, height);
    lobeB *= 1.0 - smoothstep(0.56, 0.69, height);
    lobeC *= 1.0 - smoothstep(0.75, 0.88, height);
    density = max(density, max(lobeA * 0.92, max(lobeB * 0.86, lobeC * 0.88)));

    // Spatially varying crown height creates independent tips instead of one cone point.
    float crown = 0.71 + fbm(vec3(p.xz * 7.2, time * 0.58)) * 0.3;
    density *= 1.0 - smoothstep(crown - 0.045, crown, height);
    density *= smoothstep(0.0, 0.055, height);

    // Hollowing the lower middle creates the transparent pockets visible in real flame.
    float pocket = noise3(vec3(p.x * 9.0, p.y * 7.2 - time * 2.1, p.z * 9.0));
    density *= mix(0.42, 1.0, smoothstep(0.38, 0.67, pocket + density * 0.32));
    heat = clamp(density * 0.92 + (1.0 - height) * 0.42 - radial * 0.34, 0.0, 1.0);
    return density;
  }

  void main() {
    vec3 rayDirection = normalize(vLocalPosition - uCameraLocal);
    vec2 bounds = hitBox(uCameraLocal, rayDirection);
    if (bounds.x > bounds.y) discard;
    bounds.x = max(bounds.x, 0.0);

    const float steps = 64.0;
    float stepLength = (bounds.y - bounds.x) / steps;
    float jitter = hash31(vec3(gl_FragCoord.xy, uTime * 0.01));
    float travel = bounds.x + stepLength * jitter;
    vec3 accumulated = vec3(0.0);
    float transmittance = 1.0;

    for (int sampleIndex = 0; sampleIndex < 64; sampleIndex++) {
      vec3 samplePosition = uCameraLocal + rayDirection * travel;
      float height;
      float heat;
      float density = flameDensity(samplePosition, uTime, height, heat);

      if (density > 0.008) {
        float core = smoothstep(0.78, 0.995, heat) * (1.0 - height * 0.78);
        float middle = smoothstep(0.2, 0.78, heat);
        vec3 violet = vec3(0.24, 0.012, 0.88);
        vec3 magenta = vec3(1.35, 0.075, 1.86);
        vec3 whiteHot = vec3(3.45, 1.18, 3.9);
        vec3 emission = mix(violet, magenta, middle);
        emission = mix(emission, whiteHot, core);
        emission *= 0.88 + noise3(samplePosition * 13.0 - vec3(0.0, uTime * 3.0, 0.0)) * 0.28;

        float sampleAlpha = 1.0 - exp(-density * stepLength * 7.2);
        accumulated += transmittance * emission * sampleAlpha;
        transmittance *= 1.0 - sampleAlpha;
        if (transmittance < 0.025) break;
      }
      travel += stepLength;
    }

    float alpha = 1.0 - transmittance;
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(accumulated / max(alpha, 0.001), alpha);
  }
`;

const emberVertex = /* glsl */ `
  uniform float uTime;
  attribute float aSeed;
  attribute float aSize;
  varying float vLife;

  void main() {
    float speed = 0.2 + aSeed * 0.24;
    float life = fract(aSeed * 5.73 + uTime * speed);
    vLife = life;
    vec3 p = position;
    p.y += life * (1.35 + aSeed * 0.85);
    float spread = 0.055 + life * 0.31;
    p.x += sin(uTime * (1.7 + aSeed) + aSeed * 31.0 + life * 8.0) * spread;
    p.z += cos(uTime * (1.3 + aSeed * 0.8) + aSeed * 19.0 + life * 7.0) * spread;
    vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = aSize * (1.0 - life * 0.5) * (7.0 / max(1.0, -viewPosition.z));
  }
`;

const emberFragment = /* glsl */ `
  varying float vLife;
  void main() {
    float distanceFromCenter = length(gl_PointCoord - 0.5);
    float spark = 1.0 - smoothstep(0.1, 0.5, distanceFromCenter);
    float fade = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.54, 1.0, vLife));
    vec3 color = mix(vec3(2.8, 0.4, 4.1), vec3(3.4, 1.7, 4.4), 1.0 - vLife);
    gl_FragColor = vec4(color, spark * fade);
  }
`;

const flatVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const groundGlowFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float radius = length(vUv - 0.5) * 2.0;
    float flicker = 0.9 + sin(uTime * 6.7) * 0.045 + sin(uTime * 14.3 + 1.7) * 0.025;
    float alpha = (1.0 - smoothstep(0.0, 1.0, radius)) * 0.22 * flicker;
    gl_FragColor = vec4(vec3(1.4, 0.12, 2.55), alpha);
  }
`;

const localCamera = new Vector3();

/** A true 3D ray-marched flame volume: no intersecting cards or camera-facing planes. */
export const CampfireVFX = ({ position = [0, 0.47, 0] as [number, number, number] }) => {
  const volume = useRef<Mesh>(null);
  const light = useRef<PointLight>(null);
  const volumeMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: volumeVertex,
        fragmentShader: volumeFragment,
        uniforms: {
          uTime: { value: 0 },
          uCameraLocal: { value: new Vector3() },
        },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  const glowMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: flatVertex,
        fragmentShader: groundGlowFragment,
        uniforms: { uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    [],
  );
  const { geometry: emberGeometry, material: emberMaterial } = useMemo(() => {
    const count = 28;
    const geometry = new BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const seed = ((i * 47) % count) / count + 0.019;
      const angle = seed * Math.PI * 7.4;
      const radius = 0.055 + ((i * 17) % 11) * 0.014;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = 0.1 + ((i * 13) % 9) * 0.023;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      seeds[i] = seed;
      sizes[i] = 5.8 + ((i * 7) % 8) * 0.74;
    }
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    const material = new ShaderMaterial({
      vertexShader: emberVertex,
      fragmentShader: emberFragment,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    return { geometry, material };
  }, []);

  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    volumeMaterial.uniforms.uTime!.value = t;
    emberMaterial.uniforms.uTime!.value = t;
    glowMaterial.uniforms.uTime!.value = t;
    if (volume.current) {
      localCamera.copy(camera.position);
      volume.current.worldToLocal(localCamera);
      volumeMaterial.uniforms.uCameraLocal!.value.copy(localCamera);
    }
    if (light.current) {
      const rolling = Math.sin(t * 6.2 + Math.sin(t * 0.93) * 1.6);
      const flutter = Math.sin(t * 15.9 + 2.1) * 0.43 + Math.sin(t * 26.7) * 0.16;
      light.current.intensity = 7.4 + rolling * 0.78 + flutter * 0.58;
      light.current.position.x = Math.sin(t * 2.6) * 0.05;
      light.current.position.z = Math.cos(t * 2.08) * 0.045;
    }
  });

  useEffect(
    () => () => {
      volumeMaterial.dispose();
      glowMaterial.dispose();
      emberGeometry.dispose();
      emberMaterial.dispose();
    },
    [emberGeometry, emberMaterial, glowMaterial, volumeMaterial],
  );

  return (
    <group position={position}>
      <mesh position={[0, -0.37, 0]} rotation={[-Math.PI / 2, 0, 0]} material={glowMaterial} renderOrder={1}>
        <planeGeometry args={[2.15, 2.15]} />
      </mesh>
      <mesh ref={volume} position={[0, 0.57, 0]} scale={[1.08, 1.16, 1.08]} material={volumeMaterial} renderOrder={2}>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>
      <points geometry={emberGeometry} material={emberMaterial} scale={0.82} renderOrder={3} />
      <pointLight ref={light} position={[0, 0.58, 0]} color="#b13cff" intensity={7.4} distance={7.5} decay={2} />
    </group>
  );
};
