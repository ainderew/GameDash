import type { MonsterDef } from './types';

export type MonsterArchetype = 'chaser' | 'spitter' | 'brute' | 'relicBoss';

export interface MonsterArchetypeDef extends MonsterDef {
  archetype: MonsterArchetype;
  /** Movement speed, world units/sec. */
  speed: number;
  /** Contact/attack damage dealt to the player. */
  attackDamage: number;
  /** Range at which the monster attacks the player, world units. */
  attackRange: number;
  /** Cooldown between the monster's attacks, ms. */
  attackCooldownMs: number;
  /**
   * Telegraph windup, ms: how long after the attack STARTS (anticipation pose begins)
   * before the blow actually lands. Gives the player a readable, dodgeable tell — the
   * hit whiffs if they leave range during this window. ~250ms is the fair reaction floor;
   * bigger/heavier hits telegraph longer.
   */
  attackWindupMs: number;
  /** True if the monster attacks by firing a projectile instead of melee. */
  ranged: boolean;
  /** Loot table id granted on death. */
  lootTableId: string;
  /** Render color for the grey-box primitive. */
  color: string;
  /** Approximate body radius, world units (collision + rendering). */
  radius: number;
}

/** The three Phase 2 archetypes. Balance lives here; systems read it. */
export const MONSTER_ARCHETYPES: Record<MonsterArchetype, MonsterArchetypeDef> = {
  chaser: {
    id: 'chaser',
    name: 'Chaser',
    archetype: 'chaser',
    maxHealth: 60,
    speed: 4.6,
    attackDamage: 7,
    attackRange: 1.8,
    attackCooldownMs: 1000,
    attackWindupMs: 260,
    ranged: false,
    lootTableId: 'common',
    color: '#ef4444',
    radius: 0.5,
  },
  spitter: {
    id: 'spitter',
    name: 'Spitter',
    archetype: 'spitter',
    maxHealth: 40,
    speed: 2.8,
    attackDamage: 8,
    attackRange: 12,
    attackCooldownMs: 1500,
    attackWindupMs: 350,
    ranged: true,
    lootTableId: 'common',
    color: '#a855f7',
    radius: 0.45,
  },
  brute: {
    id: 'brute',
    name: 'Brute',
    archetype: 'brute',
    maxHealth: 160,
    speed: 2.2,
    attackDamage: 22,
    attackRange: 2.4,
    attackCooldownMs: 1600,
    attackWindupMs: 520,
    ranged: false,
    lootTableId: 'rare',
    color: '#f59e0b',
    radius: 0.85,
  },
  relicBoss: {
    id: 'relicBoss',
    name: 'Relicborn Tyrant',
    archetype: 'relicBoss',
    maxHealth: 900,
    speed: 2.5,
    attackDamage: 36,
    attackRange: 3.2,
    attackCooldownMs: 1900,
    attackWindupMs: 680,
    ranged: false,
    lootTableId: 'legendary',
    color: '#f00067',
    radius: 1.35,
  },
};

export const MONSTER_LIST = Object.values(MONSTER_ARCHETYPES);
