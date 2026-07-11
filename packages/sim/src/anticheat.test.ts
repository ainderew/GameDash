import { describe, expect, it } from 'vitest';
import { createGameWorld } from './world';
import { EventQueue } from './events';
import { stepSim, type PlayerIntent } from './step';
import { createMonster } from './systems/spawnSystem';
import type { Entity } from './components';

/**
 * ANTI-CHEAT (plan acceptance): the server received only INPUTS — there is no "I hit X"
 * message to trust. Melee damage lands ONLY when the sim's own arc test passes, so a
 * tampered client spamming the melee button from out of reach kills nothing. (Position is
 * proven server-derived by the netcode speed-hack integration test; HP/loot are proven
 * server-owned by the 2-bot replication test — a client can neither refuse damage nor
 * inflate the shared-pool tally.)
 */

const MS = 1000 / 30;
const DT = 1 / 30;

const makePlayer = (pos: [number, number, number]): Entity => ({
  transform: { position: pos, rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  radius: 0.45,
  playerControlled: true,
});

describe('anti-cheat: melee damage requires the server arc test', () => {
  it('a client mashing melee from out of reach deals ZERO damage', () => {
    const world = createGameWorld();
    const events = new EventQueue();
    // Player far from a monster that is beyond aggro range (idle, so it never approaches).
    const player = world.add(makePlayer([0, 0, 0]));
    const monster = world.add(createMonster('chaser', [0, 0, 20]));
    const startHp = monster.health!.current;

    const intents = new Map<Entity, PlayerIntent>();
    for (let k = 1; k <= 90; k += 1) {
      intents.clear();
      // Tampered intent: melee EVERY tick, facing the far monster — but never in reach.
      intents.set(player, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false, melee: true, aimYaw: 0 });
      stepSim(world, events, intents, DT, k * MS, 'expedition', undefined, { authority: 'server' });
    }
    // 90 ticks (3 s) of melee spam from 20 m away → the arc never passes → no damage.
    expect(monster.health!.current).toBe(startHp);
  });

  it('the same swing lands only once the player is actually inside the arc', () => {
    const world = createGameWorld();
    const events = new EventQueue();
    const player = world.add(makePlayer([0, 0, 0]));
    const monster = world.add(createMonster('chaser', [0, 0, 1.6])); // in reach, ahead
    const startHp = monster.health!.current;

    const intents = new Map<Entity, PlayerIntent>();
    for (let k = 1; k <= 20; k += 1) {
      intents.clear();
      intents.set(player, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false, melee: k === 1, aimYaw: 0 });
      stepSim(world, events, intents, DT, k * MS, 'expedition', undefined, { authority: 'server' });
    }
    expect(monster.health!.current).toBeLessThan(startHp);
  });
});
