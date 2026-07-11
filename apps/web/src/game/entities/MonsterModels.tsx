import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  Box3,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Object3D,
  Vector3,
} from 'three';
import type { BufferGeometry, InstancedMesh, Material, Mesh } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { monsters } from '@/game/ecs/world';
import type { Entity } from '@sim/components';
import { useGameModel } from '@/lib/loaders';
import { MutantMonsters } from '@/game/entities/MutantModels';
import { hitSquash } from '@/game/entities/hitSquash';
import type { MonsterArchetype } from '@shared/monsters';
import { MONSTER_ARCHETYPES } from '@shared/monsters';
import { MAX_MONSTERS } from '@shared/balance';
import { gameNow } from '@/game/feel/time';
import { feel } from '@/game/feel/config';

interface ArchMeta {
  path: string;
  /** World-space display height, world units. */
  height: number;
  /** Y-rotation to correct the model's forward axis (Tripo tends to face +X). */
  faceOffset: number;
}

// The chaser is rendered by MutantModels (skinned + skeletally animated) instead.
const ARCHES: Partial<Record<MonsterArchetype, ArchMeta>> = {
  spitter: { path: '/models/monster-spitter.glb', height: 1.3, faceOffset: -Math.PI / 2 },
  brute: { path: '/models/monster-brute.glb', height: 2.7, faceOffset: -Math.PI / 2 },
};

const dummy = new Object3D();

/** Follow-through after the blow lands (rear the model back to rest), ms. */
const ATTACK_RECOVER_MS = 300;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Procedural melee jab driven by ABSOLUTE elapsed ms and the archetype's telegraph windup,
 * so the visible strike connects exactly when the sim lands damage (`attackStartedAt +
 * windupMs`). The windup rears back then thrusts to full extension at contact; recovery
 * eases back to rest. Returns [forwardFactor, scaleY, scaleXZ]; outside the window = rest.
 */
const attackPose = (elapsedMs: number, windupMs: number): [number, number, number] => {
  const total = windupMs + ATTACK_RECOVER_MS;
  if (elapsedMs < 0 || elapsedMs > total) return [0, 1, 1];
  if (elapsedMs < windupMs) {
    // Anticipation: rear back over the first ~55% of the tell, then snap toward contact.
    const w = elapsedMs / windupMs;
    if (w < 0.55) {
      const k = smooth(w / 0.55);
      return [-0.28 * k, 1 - 0.12 * k, 1 + 0.08 * k];
    }
    const k = smooth((w - 0.55) / 0.45);
    return [-0.28 + 1.28 * k, 0.88 + 0.24 * k, 1.08 - 0.16 * k];
  }
  // Recovery: from full forward extension at contact back to rest.
  const k = smooth((elapsedMs - windupMs) / ATTACK_RECOVER_MS);
  return [1 - k, 1.12 - 0.12 * k, 0.92 + 0.08 * k];
};


/** Bake a GLB scene into a single unit-height geometry (feet at y=0, centered in XZ). */
const bake = (scene: Object3D): { geometry: BufferGeometry; material: Material } => {
  scene.updateWorldMatrix(true, true);
  const geoms: BufferGeometry[] = [];
  let material: Material | undefined;
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    geoms.push(g);
    if (!material) material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)!;
  });
  let geometry = geoms[0]!;
  if (geoms.length > 1) {
    try {
      geometry = mergeGeometries(geoms, false) ?? geoms[0]!;
    } catch {
      geometry = geoms[0]!;
    }
  }
  const box = new Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as never,
  );
  const size = box.getSize(new Vector3());
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const h = size.y || 1;
  geometry.scale(1 / h, 1 / h, 1 / h);
  return { geometry, material: material! };
};

/**
 * Add a per-instance additive-flash attribute (`aFlash`) and patch the material so it adds
 * that color to the final fragment. Lets each monster flash white/red independently within
 * a single instanced draw call, without a bespoke shader. Degrades to no-flash if the
 * shader chunk name ever changes (never crashes).
 */
const withFlash = (geometry: BufferGeometry, src: Material): Material => {
  const flash = new InstancedBufferAttribute(new Float32Array(MAX_MONSTERS * 3), 3);
  flash.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aFlash', flash);

  const material = src.clone();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute vec3 aFlash;\nvarying vec3 vFlash;\n' +
      shader.vertexShader.replace('void main() {', 'void main() {\n  vFlash = aFlash;');
    shader.fragmentShader =
      'varying vec3 vFlash;\n' +
      shader.fragmentShader
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.rgb += vFlash;')
        .replace('#include <output_fragment>', '#include <output_fragment>\n  gl_FragColor.rgb += vFlash;');
  };
  (material as Material & { customProgramCacheKey: () => string }).customProgramCacheKey = () =>
    'monster-flash-v1';
  material.needsUpdate = true;
  return material;
};

/** One instanced draw call per archetype, matrices written from the ECS each frame. */
const ArchetypeInstances = ({ archetype }: { archetype: MonsterArchetype }) => {
  const meta = ARCHES[archetype]!;
  const { scene } = useGameModel(meta.path);
  const windupMs = MONSTER_ARCHETYPES[archetype].attackWindupMs;
  const ref = useRef<InstancedMesh>(null);
  const { geometry, material } = useMemo(() => {
    const baked = bake(scene.clone(true));
    return { geometry: baked.geometry, material: withFlash(baked.geometry, baked.material) };
  }, [scene]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const now = gameNow();
    const flashAttr = geometry.getAttribute('aFlash') as InstancedBufferAttribute;
    const flashArr = flashAttr.array as Float32Array;
    let i = 0;
    for (const m of monsters) {
      if (m.monster !== archetype) continue;
      if (i >= MAX_MONSTERS) break;
      const [x, , z] = m.transform.position;

      // Attack lunge: shove the model toward whoever it faces + squash/stretch. Elapsed ms
      // since the telegraph began; the strike extension peaks at `windupMs` (= sim hit time).
      const elapsed = now - (m.attackStartedAt ?? -1e9);
      const [fwd, sy, sxz] = attackPose(elapsed, windupMs);
      // Hit reaction squash multiplies on top of the attack pose.
      const [hsXZ, hsY] = hitSquash(m, now);
      const lunge = fwd * meta.height * 0.5;
      dummy.position.set(
        x + Math.sin(m.transform.rotationY) * lunge,
        0,
        z + Math.cos(m.transform.rotationY) * lunge,
      );
      dummy.rotation.set(0, m.transform.rotationY + meta.faceOffset, 0);
      dummy.scale.set(
        meta.height * sxz * hsXZ,
        meta.height * sy * hsY,
        meta.height * sxz * hsXZ,
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Per-instance hit flash (white for light, red for heavy), fading over its window.
      const flashUntil = m.hitFlashUntil ?? 0;
      if (flashUntil > now && m.hitFlashColor) {
        const dur = feel.flash.durationMs[m.hitReactionStrength ?? 'light'];
        const remaining = Math.max(0, Math.min(1, (flashUntil - now) / dur));
        const k = feel.flash.intensity * remaining;
        flashArr[i * 3] = m.hitFlashColor[0] * k;
        flashArr[i * 3 + 1] = m.hitFlashColor[1] * k;
        flashArr[i * 3 + 2] = m.hitFlashColor[2] * k;
      } else {
        flashArr[i * 3] = 0;
        flashArr[i * 3 + 1] = 0;
        flashArr[i * 3 + 2] = 0;
      }
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    flashAttr.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, MAX_MONSTERS]}
      castShadow
      receiveShadow
      frustumCulled={false}
    />
  );
};

/** Real monster models: the skinned mutant chaser + instanced spitter/brute. */
export const MonsterModels = () => (
  <>
    <MutantMonsters />
    <ArchetypeInstances archetype="spitter" />
    <ArchetypeInstances archetype="brute" />
  </>
);
