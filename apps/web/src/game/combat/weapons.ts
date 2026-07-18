import type { Vector3Tuple } from '@shared/types';
import type { HitStrength } from '@/game/feel/config';

/**
 * WEAPON REGISTRY — interchangeable armaments.
 *
 * A weapon is data: how to build/where to load its mesh, how it sits in the hand, its
 * reach, and its trail look. The player mounts the current weapon on the `R_Hand` bone
 * (see Weapon.tsx); swapping is just changing an id. Tripo-generated GLBs drop straight in
 * by setting `modelPath` — no code change, only a new registry entry.
 *
 * Grip transforms are in the R_Hand bone's LOCAL space and are best dialed in live via the
 * leva panel (Tripo rig bone axes aren't knowable ahead of time), then pasted back here.
 */

export type WeaponClass = 'katana' | 'greatsword' | 'dagger' | 'custom';

export interface WeaponDef {
  id: string;
  name: string;
  class: WeaponClass;
  /** GLB to load (e.g. a Tripo export). When omitted, a procedural mesh is built. */
  modelPath?: string;
  /** Original model-local hilt point. GLB mounts are re-centered here before hand rotation. */
  modelGripPivot?: Vector3Tuple;

  // Procedural mesh dimensions (world units, pre-attach-scale). Ignored if modelPath is set.
  blade: { length: number; width: number; thickness: number; color: string; metalness: number };
  guard: { width: number; depth: number; color: string };
  grip: { length: number; radius: number; color: string };

  /** Attach transform in the R_Hand bone's local space. Tunable in leva. */
  attach: { position: Vector3Tuple; rotation: Vector3Tuple; scale: number };
  /** Alternate hand-local transform calibrated against the sword-running Mixamo clip. */
  runAttach: { position: Vector3Tuple; rotation: Vector3Tuple; scale: number };
  /** Local blade points used to generate the actual moving sword trail. */
  bladeBase: Vector3Tuple;
  bladeTip: Vector3Tuple;

  /** Melee reach multiplier vs the base MELEE_RANGE (a greatsword out-reaches a dagger). */
  reachMul: number;
  /** Which hit weight this weapon biases toward — flavors feedback + moveset. */
  weightBias: HitStrength;
  /** One- or two-handed grip — drives the idle/attack hand pose. */
  hands: 'one' | 'two';
  /** Blade-trail color during the active window. */
  trailColor: string;
}

/**
 * Default grip. A blade built pointing up (+Y) from the grip; this rotation lays it into
 * the hand pointing roughly along the forearm. Expect to fine-tune per-rig in leva.
 */
const DEFAULT_ATTACH = {
  position: [0, 0.02, 0] as Vector3Tuple,
  rotation: [Math.PI / 2, 0, 0] as Vector3Tuple,
  scale: 1,
};

export const WEAPONS: Record<string, WeaponDef> = {
  katana: {
    id: 'katana',
    name: 'Katana',
    class: 'katana',
    blade: { length: 1.05, width: 0.05, thickness: 0.015, color: '#d9e2ec', metalness: 0.9 },
    guard: { width: 0.14, depth: 0.14, color: '#20242b' },
    grip: { length: 0.26, radius: 0.02, color: '#7a1f1f' },
    attach: { ...DEFAULT_ATTACH },
    runAttach: { position: [0, 0.02, 0], rotation: [Math.PI / 2, 0, 0], scale: 1 },
    bladeBase: [0, 0.26, 0],
    bladeTip: [0, 1.31, 0],
    reachMul: 1,
    weightBias: 'light',
    hands: 'two',
    trailColor: '#bfe9ff',
  },
  greatsword: {
    id: 'greatsword',
    name: 'Greatsword',
    class: 'greatsword',
    blade: { length: 1.5, width: 0.11, thickness: 0.03, color: '#c7ccd6', metalness: 0.85 },
    guard: { width: 0.34, depth: 0.06, color: '#2b2118' },
    grip: { length: 0.34, radius: 0.026, color: '#3a2a1a' },
    attach: { position: [0, 0.02, 0], rotation: [Math.PI / 2, 0, 0], scale: 1 },
    runAttach: { position: [0, 0.02, 0], rotation: [Math.PI / 2, 0, 0], scale: 1 },
    bladeBase: [0, 0.34, 0],
    bladeTip: [0, 1.84, 0],
    reachMul: 1.3,
    weightBias: 'heavy',
    hands: 'two',
    trailColor: '#ffd9a0',
  },
  dagger: {
    id: 'dagger',
    name: 'Dagger',
    class: 'dagger',
    blade: { length: 0.42, width: 0.045, thickness: 0.012, color: '#e2e8f0', metalness: 0.9 },
    guard: { width: 0.1, depth: 0.03, color: '#1c1c22' },
    grip: { length: 0.14, radius: 0.018, color: '#243b53' },
    attach: { position: [0, 0.01, 0], rotation: [Math.PI / 2, 0, 0], scale: 1 },
    runAttach: { position: [0, 0.01, 0], rotation: [Math.PI / 2, 0, 0], scale: 1 },
    bladeBase: [0, 0.14, 0],
    bladeTip: [0, 0.56, 0],
    reachMul: 0.8,
    weightBias: 'light',
    hands: 'one',
    trailColor: '#d6f5ff',
  },
  // Tripo-generated katana (v3.1 HD, text-to-3D). The GLB lives at the modelPath below.
  // The mesh is normalized ~1 unit tall, blade along +Y, origin at its center — so the grip
  // sits near the bottom. The attach transform was tuned live against the Tripo→Mixamo hero
  // rig in the leva "Weapon · grip" panel; retune there if the rig or mesh changes.
  'tripo-sword': {
    id: 'tripo-sword',
    name: 'Tripo Katana',
    class: 'katana',
    modelPath: '/models/weapon-tripo-sword.glb',
    modelGripPivot: [0, -0.42, 0],
    // Fallback procedural dims (unused while modelPath resolves).
    blade: { length: 1.1, width: 0.06, thickness: 0.02, color: '#d9e2ec', metalness: 0.9 },
    guard: { width: 0.16, depth: 0.1, color: '#20242b' },
    grip: { length: 0.24, radius: 0.02, color: '#5a3a1a' },
    // Equivalent to the previously tuned idle transform after re-centering on the hilt.
    attach: { position: [0.0102, -0.0221, 0.0263], rotation: [3.0908, 0, -1.32], scale: 0.7 },
    // Keep the hilt in the same palm but rotate/offset the blade outward for Mixamo's
    // sword-run wrist pose, avoiding the chest/head silhouette during arm swing.
    runAttach: { position: [0.0102, -0.0221, 0.0263], rotation: [3.0908, 0.18, -1.9], scale: 0.7 },
    // Socket coordinates are relative to the new grip-centred origin.
    bladeBase: [0, 0.17, 0],
    bladeTip: [0, 0.92, 0],
    reachMul: 1,
    weightBias: 'light',
    hands: 'two',
    trailColor: '#45c7ff',
  },
};

/** Ordered ids for cycling through weapons (Q / 1-4). */
export const WEAPON_IDS: string[] = ['tripo-sword', 'katana', 'greatsword', 'dagger'];

/** The Tripo-generated katana is the default now that its GLB exists. */
export const DEFAULT_WEAPON_ID = 'tripo-sword';

export const getWeapon = (id: string): WeaponDef => WEAPONS[id] ?? WEAPONS[DEFAULT_WEAPON_ID]!;
