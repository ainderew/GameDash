/**
 * Framework-free domain types shared client <-> server.
 * No React / Three imports allowed in this package.
 */

export type Vector3Tuple = [number, number, number];

export type EntityId = number;

/** Identity of a (human) player within a session — server-issued from Phase 2 on. */
export type PlayerId = string;

/** Gacha rarity tiers. */
export type Rarity = 'R3' | 'R4' | 'R5';

export type WeaponKind = 'melee' | 'ranged';

/** Filled in during Phase 3 (economy) — placeholder shape for now. */
export interface ItemDef {
  id: string;
  name: string;
  rarity: Rarity;
}

/** Filled in during Phase 5 (content/zones) — placeholder shape for now. */
export interface MonsterDef {
  id: string;
  name: string;
  maxHealth: number;
  /** Path to the optimized GLB under apps/web/public. Added for real in Phase 6. */
  modelPath?: string;
}
