import type { Entity } from './components';
import type { GameWorld } from './world';
import type { EventQueue, GameEvent } from './events';
import { NOOP_HOOKS, type SimHooks } from './hooks';
import { applyPlayerIntent, movementSystem, type InputIntent } from './systems/movementSystem';
import { fireRanged, MELEE_BUFFER_MS, startMelee, weaponSystem } from './systems/weaponSystem';
import { projectileSystem } from './systems/projectileSystem';
import { dropRelic, passRelic, relicSystem } from './systems/relicSystem';
import { teammateSystem } from './systems/teammateSystem';
import { aiSystem } from './systems/aiSystem';
import { knockbackSystem } from './systems/knockbackSystem';
import { separationSystem } from './systems/separationSystem';
import { floatingNumberSystem } from './systems/combatHelpers';
import { healthSystem } from './systems/healthSystem';
import { pickupSystem, spawnPickupsFromEvents } from './systems/lootSystem';
import { spawnSystem } from './systems/spawnSystem';
import { resolveHubCollisions } from './terrain/hubCollision';
import { PARRY_TUNING } from '@shared/balance';

export type SimMode = 'hub' | 'expedition';

/**
 * Everything a player asks of one tick. Movement (InputIntent) plus the combat/relic
 * verbs. Intents are INPUT, never state: the client sends these over the wire from
 * Phase 3 on, and the server runs the identical stepSim over them.
 */
export interface PlayerIntent extends InputIntent {
  /** Melee press this tick (the 250 ms buffer lives on the entity — see below). */
  melee?: boolean;
  /** Ranged fire held/pressed this tick. */
  ranged?: boolean;
  /** Open the parry window this tick. */
  parry?: boolean;
  /** Intentional relic drop (G) — its own verb, never a failed-pass fallback. */
  drop?: boolean;
  /** Ground point (XZ) attacks aim at — snaps facing at swing/shot start. */
  aimAt?: [number, number];
  /** Launch a relic pass to this receiver (resolved by the client's aim/targeting UI). */
  passTo?: Entity | null;
  /** True while holding pass-aim — steadies the carried relic + scales move speed client-side. */
  passAiming?: boolean;
}

export type IntentsByPlayer = ReadonlyMap<Entity, PlayerIntent>;

/**
 * THE tick — the one function both the client (per render frame today, fixed-tick from
 * Phase 3) and the room server (fixed 30 Hz) call. Runs game systems in explicit,
 * deterministic order; extracted verbatim from SystemRunner.tsx.
 * ANTI-PATTERN: never scatter per-entity stepping across callers — order must stay deterministic.
 *
 * In 'hub' mode player intent + movement + hub collision are the WHOLE simulation: no
 * spawns, combat, Relic, or teammate stand-ins may leak into the safe social space
 * (combat intents are ignored outright).
 *
 * Returns the events drained this tick (loot pickups already applied) so the caller can
 * feed feedback (audio/UI) or, later, the wire.
 */
export const stepSim = (
  world: GameWorld,
  events: EventQueue,
  intents: IntentsByPlayer,
  dt: number,
  now: number,
  mode: SimMode,
  hooks: SimHooks = NOOP_HOOKS,
): GameEvent[] => {
  // 1. Player intent.
  for (const [player, intent] of intents) {
    applyPlayerIntent(player, intent, now);
    if (mode === 'hub') continue;
    player.passAiming = intent.passAiming === true;
    // A melee press during the swing lockout stays buffered ON THE ENTITY and fires the
    // moment the lockout ends — mashing never drops a press that lands within the buffer.
    // Entity-resident so server-side replay buffers identically.
    if (intent.melee) player.meleeBufferedAt = now;
    if (
      now - (player.meleeBufferedAt ?? -Infinity) <= MELEE_BUFFER_MS &&
      startMelee(world, player, now, intent.aimAt, hooks)
    ) {
      player.meleeBufferedAt = undefined;
    }
    if (intent.ranged) fireRanged(world, player, now, intent.aimAt);
    // Relic pass: the receiver was resolved by the sender's aim UI (validated server-side
    // in Phase 5). Intentional drop is its own verb — a failed pass must never dump it.
    if (intent.passTo) passRelic(world, player, intent.passTo, now, events);
    if (intent.drop) dropRelic(world, player, now);
    // Parry: open a brief block window at will; a hit inside it is negated + punished.
    if (intent.parry && PARRY_TUNING.enabled) player.blockingUntil = now + PARRY_TUNING.windowMs;
  }

  if (mode === 'hub') {
    // Knockback runs in the hub too: nothing HUB-native ever sets it, but server-issued
    // impulses (ServerImpulse events) enter through `entity.knockback`, and the client's
    // prediction replay must decay them through the IDENTICAL system the server ran
    // (no-rubberband contract #3).
    knockbackSystem(world, dt, now);
    movementSystem(world, dt);
    for (const player of world.with('transform', 'velocity', 'playerControlled')) {
      resolveHubCollisions(player);
    }
    return events.drain();
  }

  // 2. Expedition spawning.
  spawnSystem(world, now, world.spawn);

  // 3. AI → 4. weapons → 5. knockback → 6. projectiles → 7. movement.
  aiSystem(world, dt, now, hooks);
  teammateSystem(world, now, events); // stand-in players: patrol + return passes
  weaponSystem(world, now, hooks);
  knockbackSystem(world, dt, now); // drives staggered targets before integration
  projectileSystem(world, dt, now, hooks);
  movementSystem(world, dt);
  separationSystem(world); // resolve overlaps after integration
  relicSystem(world, dt, now, events, hooks); // after integration so the carried Relic tracks the final pose

  // 8. Death resolution (emits LootDropped / PlayerDowned).
  healthSystem(world, events);
  floatingNumberSystem(world, now);

  // 9. Pickups (collect → emits MaterialCollected).
  pickupSystem(world, events);

  // 10. Drain events; loot becomes pickups INSIDE the sim (the server must spawn them too).
  const drained = events.drain();
  if (drained.length > 0) spawnPickupsFromEvents(world, drained);
  return drained;
};
