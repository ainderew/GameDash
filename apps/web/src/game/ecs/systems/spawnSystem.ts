import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import type { MonsterArchetype } from '@shared/monsters';
import { MONSTER_ARCHETYPES } from '@shared/monsters';
import { MAX_MONSTERS } from '@shared/balance';

/** Build a monster entity of the given archetype at a position. */
export const createMonster = (
  archetype: MonsterArchetype,
  position: [number, number, number],
): Entity => {
  const def = MONSTER_ARCHETYPES[archetype];
  return {
    transform: { position: [...position], rotationY: 0 },
    velocity: { linear: [0, 0, 0] },
    health: { current: def.maxHealth, max: def.maxHealth },
    faction: 'monster',
    monster: archetype,
    aiBrain: { state: 'idle', lastAttackAt: 0 },
    lootTableId: def.lootTableId,
    attackDamage: def.attackDamage,
    attackRange: def.attackRange,
    attackCooldownMs: def.attackCooldownMs,
    moveSpeed: def.speed,
    ranged: def.ranged,
    radius: def.radius,
  };
};

// Wave composition grows each clear.
const WAVES: { archetype: MonsterArchetype; count: number }[][] = [
  [{ archetype: 'chaser', count: 3 }],
  [
    { archetype: 'chaser', count: 5 },
    { archetype: 'spitter', count: 2 },
  ],
  [
    { archetype: 'chaser', count: 8 },
    { archetype: 'spitter', count: 3 },
    { archetype: 'brute', count: 1 },
  ],
];

const RESPAWN_DELAY_MS = 2500;
const RING_RADIUS = 18;

interface SpawnState {
  wave: number;
  nextSpawnAt: number;
  started: boolean;
}

export const createSpawnState = (): SpawnState => ({ wave: 0, nextSpawnAt: 0, started: false });

/** Deterministic ring placement (no Math.random — keeps the sim replayable). */
const ringPosition = (i: number, total: number): [number, number, number] => {
  const angle = (i / Math.max(1, total)) * Math.PI * 2;
  return [Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS];
};

/**
 * Spawn waves in the grey-box arena. When the field is cleared, the next (larger)
 * wave spawns after a delay. Enforces a hard monster cap for perf.
 */
export const spawnSystem = (world: World<Entity>, now: number, state: SpawnState): void => {
  const aliveMonsters = world.with('monster').entities.length;
  if (aliveMonsters > 0) {
    state.nextSpawnAt = now + RESPAWN_DELAY_MS;
    return;
  }
  if (state.started && now < state.nextSpawnAt) return;

  const composition = WAVES[Math.min(state.wave, WAVES.length - 1)];
  if (!composition) return;

  const units: MonsterArchetype[] = [];
  for (const group of composition) {
    for (let i = 0; i < group.count; i++) units.push(group.archetype);
  }
  const total = Math.min(units.length, MAX_MONSTERS);
  for (let i = 0; i < total; i++) {
    const archetype = units[i];
    if (archetype) world.add(createMonster(archetype, ringPosition(i, total)));
  }

  state.wave = Math.min(state.wave + 1, WAVES.length - 1);
  state.started = true;
};
