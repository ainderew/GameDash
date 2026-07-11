import { describe, expect, it } from 'vitest';
import { createGameWorld } from './world';
import { EventQueue } from './events';
import { stepSim, type PlayerIntent } from './step';
import type { Entity } from './components';
import type { GameEvent } from './events';

/**
 * HEADLESS SMOKE SIM — the proof the room server can run the game (Phase 1, Task 6).
 * Two players + the wave-1 arena, 30 simulated seconds of fixed 30 Hz ticks in plain
 * Node with scripted intents: players hunt the nearest monster and mash melee; at t=1s
 * player 1 passes the Relic to player 2. If this test is green, the entire gameplay
 * loop ran with zero DOM/three/React and no per-frame client scaffolding.
 */

const HZ = 30;
const DT = 1 / HZ;
const SECONDS = 30;

const makePlayer = (world: ReturnType<typeof createGameWorld>, x: number, z: number) =>
  world.add({
    transform: { position: [x, 0, z] as [number, number, number], rotationY: 0 },
    velocity: { linear: [0, 0, 0] as [number, number, number] },
    health: { current: 100, max: 100 },
    faction: 'player' as const,
    radius: 0.45,
    playerControlled: true as const,
  });

const nearestMonster = (world: ReturnType<typeof createGameWorld>, p: Entity) => {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const m of world.with('monster', 'transform', 'health')) {
    if (m.health.current <= 0) continue;
    const d = Math.hypot(
      m.transform.position[0] - p.transform!.position[0],
      m.transform.position[2] - p.transform!.position[2],
    );
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return { monster: best, dist: bestD };
};

/** Hunt-the-nearest-monster bot: run in, stop at melee range, swing at it. */
const huntIntent = (world: ReturnType<typeof createGameWorld>, p: Entity): PlayerIntent => {
  const intent: PlayerIntent = { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: true };
  const { monster, dist } = nearestMonster(world, p);
  if (!monster?.transform) return intent;
  const dx = monster.transform.position[0] - p.transform!.position[0];
  const dz = monster.transform.position[2] - p.transform!.position[2];
  if (dist > 1.8) {
    intent.moveX = dx / (dist || 1);
    intent.moveZ = dz / (dist || 1);
  }
  if (dist <= 2.4) {
    intent.melee = true;
    intent.aimAt = [monster.transform.position[0], monster.transform.position[2]];
  }
  return intent;
};

describe('headless smoke sim', () => {
  it('runs 30 s of two-player expedition ticks: kills, a relic pass→catch, no NaN', () => {
    const world = createGameWorld();
    const events = new EventQueue();

    const p1 = makePlayer(world, -3, 8);
    const p2 = makePlayer(world, 3, 8);
    const relic = world.add({
      transform: { position: [-3, 1.2, 8] as [number, number, number], rotationY: 0 },
      relic: { phase: 'carried' as const, carrier: p1 as Entity },
    });

    let lootDrops = 0;
    let caughtEvents = 0;
    let caughtByP2 = false;
    const seen: GameEvent['type'][] = [];

    let now = 0;
    const passTick = HZ; // t = 1 s — before the first wave reaches the players
    for (let tick = 0; tick < SECONDS * HZ; tick++) {
      now += DT * 1000;

      const i1 = huntIntent(world, p1);
      const i2 = huntIntent(world, p2);
      if (tick === passTick) {
        i1.passTo = p2;
        i1.melee = false; // throwing, not swinging
      }
      const intents = new Map<Entity, PlayerIntent>([
        [p1, i1],
        [p2, i2],
      ]);

      const drained = stepSim(world, events, intents, DT, now, 'expedition');
      for (const ev of drained) {
        seen.push(ev.type);
        if (ev.type === 'LootDropped') lootDrops += 1;
        if (ev.type === 'RelicCaught') {
          caughtEvents += 1;
          if (relic.relic!.carrier === p2) caughtByP2 = true;
        }
      }

      // No NaN transforms, ever — the headless sim must stay numerically sound.
      for (const e of world.with('transform')) {
        const [x, y, z] = e.transform.position;
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
        expect(Number.isFinite(e.transform.rotationY)).toBe(true);
      }
    }

    // Monsters died to the scripted melee (wave 1 alone is 3 chasers).
    expect(lootDrops).toBeGreaterThanOrEqual(3);
    expect(seen).toContain('LootDropped');
    expect(world.spawn.wave).toBeGreaterThanOrEqual(1);

    // The relic relay worked between the two REAL players: pass launched, caught by p2.
    expect(seen).toContain('RelicPassLaunched');
    expect(caughtEvents).toBeGreaterThanOrEqual(1);
    expect(caughtByP2).toBe(true);

    // Stable per-world entity ids were stamped (needed for the wire in Phase 3).
    const ids = [...world.entities].map((e) => e.id);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hub mode keeps combat out of the safe space', () => {
    const world = createGameWorld();
    const events = new EventQueue();
    const p1 = makePlayer(world, 0, 11.5);

    const intents = new Map<Entity, PlayerIntent>([
      [p1, { moveX: 0, moveZ: -1, jump: false, dodge: false, sprint: true, melee: true, ranged: true }],
    ]);
    let now = 0;
    for (let tick = 0; tick < 5 * HZ; tick++) {
      now += DT * 1000;
      stepSim(world, events, intents, DT, now, 'hub');
    }

    // No monsters spawned, no swing started, and the hub clearing contained the walk.
    expect(world.with('monster').entities).toHaveLength(0);
    expect(p1.attackState).toBeUndefined();
    const [x, , z] = p1.transform!.position;
    expect(Math.hypot(x, z)).toBeLessThanOrEqual(28.001);
  });
});
