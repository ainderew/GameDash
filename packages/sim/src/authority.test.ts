import { describe, expect, it } from 'vitest';
import { createGameWorld } from './world';
import { EventQueue } from './events';
import { stepSim, type PlayerIntent } from './step';
import { createMonster } from './systems/spawnSystem';
import type { Entity } from './components';

/**
 * The system-list authority flag (Phase 4, Task 2). A NETWORKED CLIENT predicts with
 * authority 'local' and must advance ONLY its own avatar — monster AI, spawns, and melee
 * DAMAGE are server-owned and never run locally. The room server / solo play use 'server'
 * and run the full combat order.
 */

const MS = 1000 / 30;
const DT = 1 / 30;

const makePlayer = (): Entity => ({
  transform: { position: [0, 0, 0], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  radius: 0.45,
  playerControlled: true,
  localPlayer: true,
});

const run = (
  authority: 'server' | 'local',
  build: (world: ReturnType<typeof createGameWorld>) => { player: Entity; intentAt: (tick: number) => PlayerIntent },
  ticks: number,
) => {
  const world = createGameWorld();
  const events = new EventQueue();
  const { player, intentAt } = build(world);
  const intents = new Map<Entity, PlayerIntent>();
  for (let k = 1; k <= ticks; k += 1) {
    intents.clear();
    intents.set(player, intentAt(k));
    stepSim(world, events, intents, DT, k * MS, 'expedition', undefined, { authority });
  }
  return world;
};

describe('sim authority gating', () => {
  it("'local' skips server-owned systems: no AI, no spawns, no melee damage", () => {
    const monsterRef: { m?: Entity } = {};
    const world = run(
      'local',
      (w) => {
        const player = w.add(makePlayer());
        const m = w.add(createMonster('chaser', [0, 0, 1.5]));
        monsterRef.m = m;
        const startHp = m.health!.current;
        (m as Entity & { _startHp: number })._startHp = startHp;
        return {
          player,
          intentAt: (tick) => ({ moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false, melee: tick === 1 || tick === 10, aimAt: [0, 2] }),
        };
      },
      30,
    );
    const m = monsterRef.m!;
    // AI never ran → the monster never chased (velocity + brain untouched from idle).
    expect(m.aiBrain!.state).toBe('idle');
    expect(Math.hypot(m.velocity!.linear[0], m.velocity!.linear[2])).toBe(0);
    // Melee dealt ZERO damage locally (weaponSystem ran null-rewind for the swing anim only).
    expect(m.health!.current).toBe((m as Entity & { _startHp: number })._startHp);
    // spawnSystem never ran → exactly the one monster we placed.
    expect(world.with('monster').entities.length).toBe(1);
  });

  it("'server' runs the full order: AI chases, melee damages, waves spawn", () => {
    const monsterRef: { m?: Entity } = {};
    run(
      'server',
      (w) => {
        const player = w.add(makePlayer());
        const m = w.add(createMonster('chaser', [0, 0, 1.6]));
        monsterRef.m = m;
        return {
          player,
          intentAt: (tick) => ({ moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false, melee: tick === 1 || tick === 10, aimAt: [0, 2] }),
        };
      },
      25,
    );
    const m = monsterRef.m!;
    // The swing landed under server authority.
    expect(m.health!.current).toBeLessThan(60);
    // AI engaged (chase/attack/cooldown — anything but idle).
    expect(m.aiBrain!.state).not.toBe('idle');
  });

  it("'server' spawnSystem seeds a wave in an empty world", () => {
    const world = run(
      'server',
      (w) => ({ player: w.add(makePlayer()), intentAt: () => ({ moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false }) }),
      5,
    );
    expect(world.with('monster').entities.length).toBeGreaterThan(0);
  });
});
