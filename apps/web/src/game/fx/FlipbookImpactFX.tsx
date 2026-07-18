import { useFrame } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three';
import { world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';

/**
 * BLENDER IMPACT FLIPBOOK
 *
 * Plays the Blender-authored hit burst (public/fx/impact_flipbook.png) on a single
 * camera-facing billboard per hit. The sheet is a 5×5 grid of 25 frames, emissive on
 * black; ADDITIVE blending drops the black out so no alpha matte is needed and PostFX
 * bloom picks up the hot core for free.
 *
 * Pooled like ImpactFX: a fixed set of quads, each with its own ShaderMaterial so several
 * hits can play different frames at once. A hit only claims a free slot; the cosmetic cap
 * means gameplay never waits on VFX. Aged on REAL time so the burst blooms during hitstop.
 */

// Baked Blender sheets, both 5×5 / 25 frames: the default hit and the bigger dash-slash impact.
// A pooled slot swaps its map + grid uniforms to whichever variant the spawn asked for.
type Variant = 'impact' | 'dashSlash';
interface SheetMeta {
  url: string;
  cols: number;
  rows: number;
  frames: number;
}
const SHEETS: Record<Variant, SheetMeta> = {
  impact: { url: '/fx/impact_flipbook.png', cols: 5, rows: 5, frames: 25 },
  dashSlash: { url: '/fx/dashslash_flipbook.png', cols: 5, rows: 5, frames: 25 },
};
const POOL = 10;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Sample one cell of the sheet. Image rows run top→bottom while UV.v runs bottom→top,
// so the row term is flipped. uOpacity rides on alpha; with AdditiveBlending (SrcAlpha,One)
// black texels contribute nothing regardless, so the burst composites as pure light.
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uFrame;
  uniform float uOpacity;
  uniform vec3 uTint;
  uniform float uCols;
  uniform float uRows;
  varying vec2 vUv;
  void main() {
    float col = mod(uFrame, uCols);
    float row = floor(uFrame / uCols);
    vec2 cell = vec2(
      (col + vUv.x) / uCols,
      1.0 - (row + (1.0 - vUv.y)) / uRows
    );
    vec3 c = texture2D(uMap, cell).rgb * uTint;
    gl_FragColor = vec4(c, uOpacity);
  }
`;

const easeOutFade = (age: number): number => {
  const fadeIn = Math.min(1, age / 0.06);
  const fadeOut = age > 0.8 ? Math.max(0, 1 - (age - 0.8) / 0.2) : 1;
  return fadeIn * fadeOut;
};

interface Slot {
  mesh: Mesh;
  material: ShaderMaterial;
}

const makeSlot = (geometry: PlaneGeometry, tex: Texture): Slot => {
  const material = new ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uFrame: { value: 0 },
      uOpacity: { value: 0 },
      uTint: { value: new Vector3(1, 1, 1) },
      uCols: { value: SHEETS.impact.cols },
      uRows: { value: SHEETS.impact.rows },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  mesh.frustumCulled = false;
  return { mesh, material };
};

/** Bounded, pooled Blender-baked sword impacts. Never more than POOL billboards on screen. */
export const FlipbookImpactFX = () => {
  const [impactTex, dashTex] = useTexture([SHEETS.impact.url, SHEETS.dashSlash.url]) as Texture[];
  for (const t of [impactTex, dashTex]) {
    if (!t) continue;
    t.colorSpace = SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
  }
  const texFor = (variant: Variant): Texture => (variant === 'dashSlash' ? dashTex! : impactTex!);
  const metaFor = (variant?: Variant): SheetMeta => SHEETS[variant ?? 'impact'];

  const geometry = useMemo(() => new PlaneGeometry(1, 1), []);
  const slots = useMemo<Slot[]>(
    () => Array.from({ length: POOL }, () => makeSlot(geometry, impactTex!)),
    [geometry, impactTex],
  );

  const slotOf = useRef(new Map<Entity, number>());
  const free = useRef<number[]>(Array.from({ length: POOL }, (_, i) => i));
  const active = useRef(new Uint8Array(POOL));
  const camPos = useRef(new Vector3());
  const toCam = useRef(new Vector3());

  useFrame((state) => {
    const now = performance.now();
    const marks = active.current;
    marks.fill(0);
    state.camera.getWorldPosition(camPos.current);

    for (const e of world.with('blenderImpactFx', 'transform')) {
      const fx = e.blenderImpactFx;
      const age = (now - fx.spawnedAtReal) / fx.lifetimeMs;
      if (age < 0 || age > 1) continue;

      const meta = metaFor(fx.variant);
      let slot = slotOf.current.get(e);
      if (slot === undefined) {
        const next = free.current.pop();
        if (next === undefined) continue; // cosmetic cap: gameplay never waits for VFX
        slot = next;
        slotOf.current.set(e, slot);
        // Point this slot at the sheet + grid the spawn asked for (impact 5×5 vs trail 8×8).
        const u = slots[slot]!.material.uniforms;
        u.uMap!.value = texFor(fx.variant ?? 'impact');
        u.uCols!.value = meta.cols;
        u.uRows!.value = meta.rows;
      }
      marks[slot] = 1;

      const s = slots[slot]!;
      const [x, y, z] = e.transform.position;
      // Nudge toward the camera so the flat billboard never clips into the enemy body.
      toCam.current.set(camPos.current.x - x, camPos.current.y - y, camPos.current.z - z).normalize();
      s.mesh.position.set(
        x + toCam.current.x * 0.3,
        y + toCam.current.y * 0.3,
        z + toCam.current.z * 0.3,
      );
      // Face the camera, then spin around the view axis so the slash aligns with the swing.
      s.mesh.quaternion.copy(state.camera.quaternion);
      s.mesh.rotateZ(Math.atan2(fx.dirX, fx.dirZ));
      s.mesh.scale.setScalar(fx.size);

      s.material.uniforms.uFrame!.value = Math.min(meta.frames - 1, Math.floor(age * meta.frames));
      s.material.uniforms.uOpacity!.value = easeOutFade(age);
      s.mesh.visible = true;
    }

    for (const [e, slot] of slotOf.current) {
      if (marks[slot]) continue;
      slotOf.current.delete(e);
      free.current.push(slot);
      slots[slot]!.mesh.visible = false;
    }
  });

  return (
    <>
      {slots.map((s, i) => (
        <primitive key={`flip-${i}`} object={s.mesh} />
      ))}
    </>
  );
};
