import type { Vector3Tuple } from '@shared/types';
import type { Faction } from '@shared/combat';
import type { MonsterArchetype } from '@shared/monsters';

/**
 * ECS component definitions. Entities are plain objects holding a subset of these.
 * Systems (see ./systems) read/mutate these each frame — never React state on the hot path.
 */

export interface Transform {
  position: Vector3Tuple;
  /** Y-axis facing in radians. */
  rotationY: number;
}

export interface Velocity {
  linear: Vector3Tuple;
}

export interface Health {
  current: number;
  max: number;
}

export type AiState = 'idle' | 'chase' | 'attack' | 'cooldown';

export interface AiBrain {
  state: AiState;
  /** Timestamp (ms) of the monster's last attack, for cooldown gating. */
  lastAttackAt: number;
}

export interface AttackState {
  kind: 'melee' | 'ranged';
  /** performance.now() when the swing started. */
  startedAt: number;
  /** Monster entities already hit by the current swing (no multi-hit). */
  hitSet: Set<Entity>;
  /** Index into the melee combo chain this swing belongs to (melee only). */
  combo?: number;
}

export interface Entity {
  transform?: Transform;
  velocity?: Velocity;
  health?: Health;
  /** Marks the single player-controlled entity. */
  playerControlled?: true;
  /** Timestamp (ms, performance.now) until which the entity has i-frames. */
  iframeUntil?: number;
  /** Timestamp (ms) until which the entity is mid-dodge (dash active). */
  dodgingUntil?: number;
  /** Timestamp (ms) after which another dodge may start. */
  dodgeReadyAt?: number;
  /** Dodge dash direction (unit-ish), consumed by the movement system. */
  dodgeDir?: Vector3Tuple;

  // ── Combat ──────────────────────────────────────────────────────────────
  /** Which side the entity is on; hostility gates damage. */
  faction?: Faction;
  /** Present while a melee swing is active. */
  attackState?: AttackState;
  /** Timestamp (ms) after which the player may melee again. */
  meleeReadyAt?: number;
  /** Index of the last melee combo move performed. */
  meleeCombo?: number;
  /** Timestamp (ms) until which the next melee press continues the combo chain. */
  meleeComboExpiresAt?: number;
  /** Timestamp (ms) after which the player may fire again. */
  rangedReadyAt?: number;

  // ── Monster ─────────────────────────────────────────────────────────────
  monster?: MonsterArchetype;
  aiBrain?: AiBrain;
  /** Loot table granted on death. */
  lootTableId?: string;
  attackDamage?: number;
  attackRange?: number;
  attackCooldownMs?: number;
  moveSpeed?: number;
  ranged?: boolean;
  /** Body radius for hit tests + rendering. */
  radius?: number;
  /** Timestamp (ms) until which the monster renders a hit flash. */
  hitFlashUntil?: number;
  /** performance.now() when the monster last began an attack, driving its lunge animation. */
  attackStartedAt?: number;

  // ── Projectile ──────────────────────────────────────────────────────────
  projectile?: true;
  /** performance.now() when the projectile spawned (lifetime gate). */
  spawnedAt?: number;
  /** Damage applied on projectile hit. */
  damage?: number;

  // ── Pickup ──────────────────────────────────────────────────────────────
  pickup?: { tableId: string };

  // ── FX ──────────────────────────────────────────────────────────────────
  /** Floating damage number: transient, aged out by floatingNumberSystem. */
  floatingNumber?: { amount: number; spawnedAt: number; crit: boolean };
}
