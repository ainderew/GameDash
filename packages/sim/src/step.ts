import type { Entity } from './components';
import type { GameWorld } from './world';
import type { EventQueue, GameEvent } from './events';
import { NOOP_HOOKS, type SimHooks } from './hooks';
import { applyPlayerIntent, movementSystem, type InputIntent } from './systems/movementSystem';
import {
  fireRanged,
  MELEE_BUFFER_MS,
  startDashSlash,
  startMelee,
  weaponSystem,
  type MeleeResolveOptions,
} from './systems/weaponSystem';
import { projectileSystem } from './systems/projectileSystem';
import { dropRelic, onRelicAttackUsed, passRelic, relicSystem } from './systems/relicSystem';
import { teammateSystem } from './systems/teammateSystem';
import { aiSystem } from './systems/aiSystem';
import { knockbackSystem } from './systems/knockbackSystem';
import { separationSystem } from './systems/separationSystem';
import { floatingNumberSystem } from './systems/combatHelpers';
import { healthSystem } from './systems/healthSystem';
import { reviveSystem } from './systems/reviveSystem';
import { pickupSystem, spawnPickupsFromEvents } from './systems/lootSystem';
import { spawnSystem } from './systems/spawnSystem';
import { resolveHubCollisions, resolveObstacleCollisions } from './terrain/hubCollision';
import { resolveExpeditionRuinCollisions } from './terrain/expeditionCollision';
import { CollisionLayer } from './terrain/collisionField';
import { PARRY_TUNING } from '@shared/balance';

export type SimMode = 'hub' | 'expedition';

/**
 * WHO owns this stepSim invocation's gameplay outcomes (Phase 4, plan Task 2). Consulted
 * once at the system-list level — never as scattered per-system ifs.
 *  - 'server': THE authority. Runs the full combat order (spawns, AI, weapons, projectiles,
 *    relic, deaths, loot). Used by the room server AND by solo play (the solo client is its
 *    own authority — default, so single-player is byte-for-byte unchanged).
 *  - 'local': a NETWORKED client predicting only its own avatar. Runs player intent +
 *    movement + the swing animation lifecycle, and NOTHING server-owned — monsters,
 *    projectiles, damage, deaths and loot arrive over the wire (snapshots + reliable events).
 */
export type SimAuthority = 'server' | 'local';

/** Optional per-step knobs. `melee` carries the room server's lag-comp rewind resolver. */
export interface StepOptions {
  authority?: SimAuthority;
  melee?: MeleeResolveOptions;
}

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
  /** Dash-slash skill press this tick ("1") — a committed heavy lunge on its own cooldown. */
  skill1?: boolean;
  /** Open the parry window this tick. */
  parry?: boolean;
  /** Intentional relic drop (G) — its own verb, never a failed-pass fallback. */
  drop?: boolean;
  /** Ground point (XZ) attacks aim at — snaps facing at swing/shot start. */
  aimAt?: [number, number];
  /**
   * Aim YAW in radians (facing at swing/shot start). PREFERRED over `aimAt` for networked
   * play: a yaw is position-independent, so the swing faces the identical direction on the
   * client, the server, and every reconciliation replay from a rewound position — an `aimAt`
   * world point would re-project to a different angle as the replay pos moves, drifting the
   * lunge and forcing corrections. Solo play keeps the cursor `aimAt`.
   */
  aimYaw?: number;
  /** Launch a relic pass to this receiver (resolved by the client's aim/targeting UI). */
  passTo?: Entity | null;
  /** True while holding pass-aim — steadies the carried relic + scales move speed client-side. */
  passAiming?: boolean;
  /** Holding the revive input this tick (co-op revive of a downed teammate, Phase 4). */
  revive?: boolean;
}

export type IntentsByPlayer = ReadonlyMap<Entity, PlayerIntent>;

/**
 * THE tick — the one function both the client (per render frame today, fixed-tick from
 * Phase 3) and the room server (fixed 30 Hz) call. Runs game systems in explicit,
 * deterministic order; extracted verbatim from SystemRunner.tsx.
 * ANTI-PATTERN: never scatter per-entity stepping across callers — order must stay deterministic.
 *
 * Hub mode runs player combat against explicit practice targets, but never enables enemy AI,
 * wave spawning, Relic rules, loot, or teammate stand-ins.
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
  opts: StepOptions = {},
): GameEvent[] => {
  const authority = opts.authority ?? 'server';

  // 1. Player intent.
  for (const [player, intent] of intents) {
    // Downed players are inert — no movement, no combat, no revive-hold of their own.
    // (Server-owned state; a networked client sees this too because HP arrives from the
    // wire, so predicting a downed avatar as inert agrees with authority.)
    if (player.downed) {
      player.reviving = false;
      if (player.velocity) {
        player.velocity.linear[0] = 0;
        player.velocity.linear[2] = 0;
      }
      continue;
    }
    applyPlayerIntent(player, intent, now, dt);
    const expedition = mode === 'expedition';
    player.passAiming = expedition && intent.passAiming === true;
    player.reviving = expedition && intent.revive === true;
    // Facing target: a yaw (networked — position-independent, replay-stable) projected to a
    // far aim point off the player's CURRENT pos, else the raw cursor aimAt (solo).
    let aimAt = intent.aimAt;
    if (intent.aimYaw !== undefined && player.transform) {
      const p = player.transform.position;
      aimAt = [p[0] + Math.sin(intent.aimYaw) * 8, p[2] + Math.cos(intent.aimYaw) * 8];
    }
    // A melee press during the swing lockout stays buffered ON THE ENTITY and fires the
    // moment the lockout ends — mashing never drops a press that lands within the buffer.
    // Entity-resident so server-side replay buffers identically. The swing ANIMATION is
    // predicted locally (feel); its DAMAGE lands only under 'server' authority.
    if (intent.melee) player.meleeBufferedAt = now;
    if (
      now - (player.meleeBufferedAt ?? -Infinity) <= MELEE_BUFFER_MS &&
      startMelee(world, player, now, aimAt, hooks)
    ) {
      player.meleeBufferedAt = undefined;
    }
    // Dash-slash skill ("1"): a committed heavy lunge. Predicted locally like a swing (anim +
    // root motion); its DAMAGE lands only under server authority (weaponSystem), same as melee.
    if (intent.skill1) startDashSlash(world, player, now, aimAt, hooks);
    // Entity-spawning + world-mutating verbs are the AUTHORITY's alone — a networked
    // client never spawns a projectile, throws, or drops the relic locally; those replicate.
    if (authority === 'server') {
      if (intent.ranged && fireRanged(world, player, now, aimAt)) {
        if (expedition) onRelicAttackUsed(world, player, now, events);
      }
      if (expedition) {
        if (intent.passTo) passRelic(world, player, intent.passTo, now, events);
        if (intent.drop) dropRelic(world, player, now, events);
      }
    }
    // Parry: open a brief block window at will (predicted stance). The negation itself is
    // server-side in dealDamage; predicting the window costs nothing and reads instantly.
    if (intent.parry && PARRY_TUNING.enabled) player.blockingUntil = now + PARRY_TUNING.windowMs;
  }

  if (mode === 'hub') {
    // Hub combat is deliberately narrow: attacks and their presentation work against the
    // practice dummy, while spawning, AI, deaths, loot, and Relic systems stay expedition-only.
    weaponSystem(world, now, hooks, authority === 'local' ? { rewind: () => null } : opts.melee);
    if (authority === 'server') projectileSystem(world, dt, now, hooks);
    // Knockback runs in the hub too: nothing HUB-native ever sets it, but server-issued
    // impulses (ServerImpulse events) enter through `entity.knockback`, and the client's
    // prediction replay must decay them through the IDENTICAL system the server ran
    // (no-rubberband contract #3).
    knockbackSystem(world, dt, now);
    movementSystem(world, dt);
    for (const player of world.with('transform', 'velocity', 'playerControlled')) {
      resolveHubCollisions(player);
    }
    // The training dummy (and any future hub creature) shares the rock field through the
    // same layer-masked resolver — no bespoke per-body collision code.
    for (const monster of world.with('transform', 'monster')) {
      resolveObstacleCollisions(monster, CollisionLayer.OBSTACLE);
    }
    floatingNumberSystem(world, now);
    return events.drain();
  }

  // ── Expedition ─────────────────────────────────────────────────────────────
  if (authority === 'local') {
    // NETWORKED CLIENT PREDICTION: advance only the local avatar. Monster AI, spawns,
    // projectiles, damage, deaths, relic and loot are SERVER-OWNED and arrive over the
    // wire — never simulated here (plan Task 2). weaponSystem runs with a null-rewind so
    // the swing hitbox lifecycle (expiry, dodge-cancel) stays identical while it lands ZERO
    // local damage; the confirmed hits come back as DamageDealt events.
    weaponSystem(world, now, hooks, { rewind: () => null });
    knockbackSystem(world, dt, now);
    movementSystem(world, dt);
    for (const player of world.with('transform', 'velocity', 'playerControlled')) {
      resolveExpeditionRuinCollisions(player);
    }
    return events.drain();
  }

  // authority === 'server' (room server OR solo play): the full deterministic combat order.
  // 2. Expedition spawning.
  spawnSystem(world, now, world.spawn);

  // 3. AI → 4. weapons → 5. knockback → 6. projectiles → 7. movement.
  aiSystem(world, dt, now, hooks);
  teammateSystem(world, now, events); // stand-in players: patrol + return passes
  weaponSystem(world, now, hooks, opts.melee); // opts.melee = the room server's lag-comp rewind
  knockbackSystem(world, dt, now); // drives staggered targets before integration
  projectileSystem(world, dt, now, hooks);
  movementSystem(world, dt);
  separationSystem(world); // resolve overlaps after integration
  for (const actor of world.with('transform', 'velocity')) {
    if (actor.playerControlled || actor.monster || actor.teammate) {
      resolveExpeditionRuinCollisions(actor);
    }
  }
  relicSystem(world, dt, now, events, hooks); // after integration so the carried Relic tracks the final pose

  // 8. Death resolution (emits MonsterKilled / LootDropped / PlayerDowned) then co-op revive.
  healthSystem(world, events);
  reviveSystem(world, dt, events);
  floatingNumberSystem(world, now);

  // 9. Pickups (collect → emits MaterialCollected).
  pickupSystem(world, events);

  // 10. Drain events; loot becomes pickups INSIDE the sim (the server must spawn them too).
  const drained = events.drain();
  if (drained.length > 0) spawnPickupsFromEvents(world, drained);
  return drained;
};
