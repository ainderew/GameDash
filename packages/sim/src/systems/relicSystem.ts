import type { World } from 'miniplex';
import type { Entity } from '../components';
import type { Vector3Tuple } from '@shared/types';
import type { EventQueue } from '../events';
import { NOOP_HOOKS, type SimHooks } from '../hooks';
import { heightAt } from '../terrain/terrainHeight';
import { createMonster } from './spawnSystem';
import { dealDamage } from './combatHelpers';
import {
  bezierControl,
  passDurationMs,
  predictCatchPos,
  sampleBezier,
} from '../combat/passTargeting';
import {
  RELIC_AIM_OFFSET,
  RELIC_CARRY_OFFSET,
  RELIC_CORRUPTION_BOSS_DISTANCE,
  RELIC_CORRUPTION_TUNING,
  RELIC_FAIL_BOUNCE_ARC,
  RELIC_FAIL_BOUNCE_DIST,
  RELIC_FAIL_BOUNCE_MS,
  RELIC_CATCH_HEIGHT,
  RELIC_CATCH_RADIUS,
  RELIC_CATCH_ROOT_MS,
  RELIC_CATCH_SOCKET_Y,
  RELIC_FLIGHT_MIN_MS,
  RELIC_GROUND_HOVER,
  RELIC_HANDOFF_SHIELD_MS,
  RELIC_HOMING_MAX_CORRECTION,
  RELIC_HOMING_RATE,
  RELIC_HOMING_START_T,
  RELIC_PASS_RECATCH_MS,
  RELIC_RECATCH_DELAY_MS,
  RELIC_SHOCKWAVE_KNOCKBACK,
  RELIC_SHOCKWAVE_RADIUS,
  RELIC_SHOCKWAVE_STUN_MS,
  RELIC_THROW_MIN,
  RELIC_THROW_SPEED,
} from '@shared/balance';
import type { RelicTierDefinition } from '@shared/balance';

/** On arrival, the receiver must be this close to the endpoint or the pass drops. */
const ARRIVAL_TOLERANCE = 2;

export const getRelicTierIndex = (corruption: number): number => {
  const value = Math.max(0, Math.min(RELIC_CORRUPTION_TUNING.max, corruption));
  const tiers = RELIC_CORRUPTION_TUNING.tiers;
  const found = tiers.findIndex((tier, index) =>
    index === tiers.length - 1
      ? value >= tier.minCorruption && value <= tier.maxCorruption
      : value >= tier.minCorruption && value < tier.maxCorruption,
  );
  return found < 0 ? tiers.length - 1 : found;
};

export const getRelicTier = (corruption: number): RelicTierDefinition =>
  RELIC_CORRUPTION_TUNING.tiers[getRelicTierIndex(corruption)]!;

export const clearRelicBuffs = (holder?: Entity): void => {
  if (holder) holder.relicBuff = undefined;
};

const applyRelicBuffs = (holder: Entity, corruption: number): void => {
  const tierIndex = getRelicTierIndex(corruption);
  const tier = RELIC_CORRUPTION_TUNING.tiers[tierIndex]!;
  holder.relicBuff = {
    tierIndex,
    tierName: tier.name,
    damageMult: tier.damageMult,
    projectileCount: tier.projectileCount,
    attackRateMult: tier.attackRateMult,
    pierce: tier.pierce,
    knockback: tier.knockback,
    lifestealPct: tier.lifestealPct,
    moveSpeedMult: tier.moveSpeedMult,
  };
};

const emitCorruption = (events: EventQueue, oldValue: number, value: number): void => {
  const oldTierIndex = getRelicTierIndex(oldValue);
  const newTierIndex = getRelicTierIndex(value);
  if (oldTierIndex !== newTierIndex) {
    events.emit({
      type: 'RelicTierChanged',
      oldTierIndex,
      newTierIndex,
      oldTier: RELIC_CORRUPTION_TUNING.tiers[oldTierIndex]!,
      newTier: RELIC_CORRUPTION_TUNING.tiers[newTierIndex]!,
    });
  }
  events.emit({
    type: 'RelicCorruptionChanged',
    value,
    tierIndex: newTierIndex,
    tier: RELIC_CORRUPTION_TUNING.tiers[newTierIndex]!,
  });
};

const dischargeJitter = (relic: Entity, now: number): number => {
  const seed = (relic.id ?? 1) * 12.9898 + Math.floor(now) * 0.078233;
  const unit = Math.sin(seed) * 43758.5453;
  return (unit - Math.floor(unit)) * 2 - 1;
};

const scheduleNextDischarge = (relic: Entity, now: number, tierIndex: number): void => {
  const tuning = RELIC_CORRUPTION_TUNING.volatileDischarge;
  const overload = tierIndex === RELIC_CORRUPTION_TUNING.tiers.length - 1;
  const interval = tuning.intervalMs * (overload ? tuning.overloadIntervalMult : 1);
  relic.relic!.nextVolatileDischargeAt =
    now + interval * (1 + dischargeJitter(relic, now) * tuning.intervalJitter);
};

const updateVolatileDischarge = (
  world: World<Entity>,
  relic: Entity,
  holder: Entity,
  tierIndex: number,
  now: number,
  events: EventQueue,
  hooks: SimHooks,
): void => {
  const s = relic.relic!;
  const tuning = RELIC_CORRUPTION_TUNING.volatileDischarge;
  if (tierIndex < tuning.minTierIndex) {
    s.nextVolatileDischargeAt = undefined;
    return;
  }
  if (s.nextVolatileDischargeAt === undefined) {
    scheduleNextDischarge(relic, now, tierIndex);
    return;
  }
  if (now < s.nextVolatileDischargeAt || !holder.transform) return;

  const origin = holder.transform.position;
  const overload = tierIndex === RELIC_CORRUPTION_TUNING.tiers.length - 1;
  const damage = tuning.damage * (overload ? tuning.overloadDamageMult : 1);
  const radiusSq = tuning.radius * tuning.radius;
  for (const target of world.with('transform', 'health', 'faction')) {
    if (target === holder || target.health.current <= 0) continue;
    const dx = target.transform.position[0] - origin[0];
    const dz = target.transform.position[2] - origin[2];
    const distSq = dx * dx + dz * dz;
    if (distSq > radiusSq) continue;
    const distance = Math.sqrt(distSq) || 1;
    dealDamage(
      world,
      target,
      damage,
      now,
      false,
      {
        attacker: holder,
        strength: 'heavy',
        dir: [dx / distance, dz / distance],
        point: [
          target.transform.position[0],
          target.transform.position[1] + 1,
          target.transform.position[2],
        ],
        knockbackScale: tuning.knockbackScale,
        unblockable: true,
      },
      hooks,
    );
  }
  events.emit({
    type: 'RelicVolatileDischarge',
    holderId: holder.id,
    position: [origin[0], origin[1] + 0.8, origin[2]],
    radius: tuning.radius,
    tierIndex,
  });
  scheduleNextDischarge(relic, now, tierIndex);
};

const isDead = (e: Entity): boolean => (e.health?.current ?? 1) <= 0;

/**
 * A successful catch: attach to the new carrier and release the defensive shockwave —
 * a visual ring plus a short shove/stagger on monsters near the catch point. No damage;
 * the reward for a clean catch is space, not kills. The receiver also gets a brief
 * handoff shield so an enemy hit landing on the exact catch frame never feels unfair.
 */
const catchRelic = (
  world: World<Entity>,
  relic: Entity,
  catcher: Entity,
  now: number,
  events: EventQueue,
  hooks: SimHooks,
): void => {
  const s = relic.relic!;
  const caughtInFlight = s.phase === 'inFlight';
  const oldCorruption = s.corruption;
  s.phase = 'carried';
  s.carrier = catcher;
  if (caughtInFlight) s.corruption = RELIC_CORRUPTION_TUNING.catchResetValue;
  s.mode = undefined;
  s.target = undefined;
  s.thrower = undefined;
  s.nextVolatileDischargeAt = undefined;
  s.failedAt = undefined;
  s.from = undefined;
  s.to = undefined;
  s.control = undefined;
  s.endBase = undefined;
  catcher.iframeUntil = Math.max(catcher.iframeUntil ?? 0, now + RELIC_HANDOFF_SHIELD_MS);
  if (catcher.teammate) catcher.relicHeldSince = now;

  applyRelicBuffs(catcher, s.corruption);
  if (caughtInFlight) emitCorruption(events, oldCorruption, s.corruption);

  const point = relic.transform!.position;
  if (caughtInFlight) {
    events.emit({
      type: 'RelicCaught',
      byLocalPlayer: catcher.localPlayer === true,
      position: [point[0], point[1], point[2]],
    });
  } else {
    events.emit({ type: 'RelicPickedUp', playerId: catcher.id });
  }
  // Catch juice (teal shockwave VFX, catch bloom, shake, local-player hitstop) is the
  // client's business — see simHooks.onRelicCaught in apps/web.
  hooks.onRelicCaught?.(world, relic, catcher, [point[0], point[1], point[2]]);

  // Plant the catcher so the catch clip doesn't glide on residual run momentum — sim
  // state, because movementSystem enforces it. AI teammates skip it (they hold anyway).
  if (catcher.playerControlled) {
    catcher.catchRootUntil = now + RELIC_CATCH_ROOT_MS;
  }

  for (const m of world.with('transform', 'health', 'monster')) {
    if (isDead(m)) continue;
    const dx = m.transform.position[0] - point[0];
    const dz = m.transform.position[2] - point[2];
    const distSq = dx * dx + dz * dz;
    if (distSq > RELIC_SHOCKWAVE_RADIUS * RELIC_SHOCKWAVE_RADIUS) continue;
    const len = Math.sqrt(distSq) || 1;
    m.knockback = [
      (dx / len) * RELIC_SHOCKWAVE_KNOCKBACK,
      0,
      (dz / len) * RELIC_SHOCKWAVE_KNOCKBACK,
    ];
    m.staggerUntil = now + RELIC_SHOCKWAVE_STUN_MS;
  }
};

/** Can this player walk-in catch the relic right now? XZ radius + a vertical band. */
const canCatch = (relic: Entity, player: Entity, now: number): boolean => {
  if (now < (relic.relic!.noCatchUntil ?? 0)) return false;
  if (now < (player.relicRecatchUntil ?? 0)) return false;
  if (isDead(player)) return false;
  const rp = relic.transform!.position;
  const pp = player.transform!.position;
  const dx = pp[0] - rp[0];
  const dz = pp[2] - rp[2];
  if (dx * dx + dz * dz > RELIC_CATCH_RADIUS * RELIC_CATCH_RADIUS) return false;
  return Math.abs(rp[1] - (pp[1] + 1.0)) < RELIC_CATCH_HEIGHT;
};

const tryCatch = (
  world: World<Entity>,
  relic: Entity,
  now: number,
  events: EventQueue,
  hooks: SimHooks,
): void => {
  const rp = relic.transform!.position;
  let nearest: Entity | undefined;
  let nearestDistSq = Infinity;
  for (const player of world.with('transform', 'playerControlled')) {
    if (!canCatch(relic, player, now)) continue;
    const pp = player.transform.position;
    const dx = pp[0] - rp[0];
    const dz = pp[2] - rp[2];
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearest = player;
      nearestDistSq = distSq;
    }
  }
  if (nearest) catchRelic(world, relic, nearest, now, events, hooks);
};

/** The relic this entity is currently carrying, if any. */
export const carriedRelicOf = (world: World<Entity>, carrier: Entity): Entity | undefined => {
  for (const r of world.with('transform', 'relic')) {
    if (r.relic.phase === 'carried' && r.relic.carrier === carrier) return r;
  }
  return undefined;
};

/**
 * Spawn THE session relic, grounded at `pos` (netcode: the server does this on expedition
 * entry — Task 1 — replacing the single-player client-side spawn). One per world; the
 * caller owns the returned entity for snapshot/event wiring.
 */
export const spawnRelic = (world: World<Entity>, pos: Vector3Tuple): Entity =>
  world.add({
    transform: {
      position: [pos[0], heightAt(pos[0], pos[2]) + RELIC_GROUND_HOVER, pos[2]],
      rotationY: 0,
    },
    relic: { phase: 'grounded', corruption: 0 },
  });

/**
 * The server's single-source-of-truth invariant (Phase 5 acceptance): there is exactly ONE
 * relic and its state machine is internally consistent — exactly one of carried / inFlight /
 * grounded, with the fields that phase requires present and the others absent. Returns null
 * when the invariant holds, else a description of the first violation (tests assert null).
 */
export const relicInvariantViolation = (world: World<Entity>): string | null => {
  const found = [...world.with('relic')];
  if (found.length !== 1) return `expected exactly 1 relic, found ${found.length}`;
  const s = found[0]!.relic;
  if (
    !Number.isFinite(s.corruption) ||
    s.corruption < 0 ||
    s.corruption > RELIC_CORRUPTION_TUNING.max
  ) {
    return `relic corruption out of range: ${String(s.corruption)}`;
  }
  if (s.phase === 'carried') {
    if (!s.carrier) return 'carried relic has no carrier';
    if (s.mode !== undefined) return 'carried relic still has a flight mode';
  } else if (s.phase === 'inFlight') {
    if (s.carrier) return 'in-flight relic still bound to a carrier';
    if (!s.from || !s.to) return 'in-flight relic missing from/to endpoints';
    if (s.mode !== 'pass' && s.mode !== 'lob')
      return `in-flight relic has bad mode ${String(s.mode)}`;
  } else if (s.phase === 'grounded') {
    if (s.carrier) return 'grounded relic still bound to a carrier';
    if (s.mode !== undefined) return 'grounded relic still has a flight mode';
  } else {
    return `unknown relic phase ${String(s.phase)}`;
  }
  return null;
};

/**
 * Targeted pass: deterministic Bézier from the Relic to the receiver's predicted catch
 * socket. Auto-caught on arrival; the thrower enters the rotation cooldown so the pair
 * can't ping-pong it. Returns false if this entity isn't carrying the Relic.
 */
export const passRelic = (
  world: World<Entity>,
  carrier: Entity,
  target: Entity,
  now: number,
  events: EventQueue,
): boolean => {
  const relic = carriedRelicOf(world, carrier);
  const s = relic?.relic;
  if (!relic?.transform || !s || !target.transform || isDead(target)) return false;

  const from: Vector3Tuple = [...relic.transform.position];
  const to = predictCatchPos(target);
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);

  s.phase = 'inFlight';
  s.mode = 'pass';
  s.carrier = undefined;
  clearRelicBuffs(carrier);
  s.target = target;
  s.thrower = carrier;
  s.from = from;
  s.to = to;
  s.endBase = [...to];
  s.control = bezierControl(from, to);
  s.startedAt = now;
  s.flightMs = passDurationMs(dist);
  s.noCatchUntil = 0;
  events.emit({ type: 'RelicPassLaunched', toLocalPlayer: target.localPlayer === true, from });
  events.emit({ type: 'RelicThrown', holderId: carrier.id, targetId: target.id });

  // Face the receiver — the throw animation and the pass read as one motion.
  if (carrier.transform) {
    const dx = to[0] - carrier.transform.position[0];
    const dz = to[2] - carrier.transform.position[2];
    if (dx * dx + dz * dz > 1e-6) carrier.transform.rotationY = Math.atan2(dx, dz);
  }
  carrier.relicRecatchUntil = now + RELIC_PASS_RECATCH_MS;
  return true;
};

/**
 * Intentional drop: a short untargeted lob in the carrier's facing. Deliberately a
 * SEPARATE verb from passing — release-to-drop would turn every missed pass into an
 * argument. The lob is walk-in catchable like any grounded relic.
 */
export const dropRelic = (
  world: World<Entity>,
  carrier: Entity,
  now: number,
  events?: EventQueue,
): boolean => {
  const relic = carriedRelicOf(world, carrier);
  const s = relic?.relic;
  const t = carrier.transform;
  if (!relic?.transform || !s || !t) return false;

  const dx = Math.sin(t.rotationY);
  const dz = Math.cos(t.rotationY);
  const dist = RELIC_THROW_MIN;
  const tx = t.position[0] + dx * dist;
  const tz = t.position[2] + dz * dist;

  s.phase = 'inFlight';
  s.mode = 'lob';
  s.carrier = undefined;
  clearRelicBuffs(carrier);
  s.target = undefined;
  s.from = [...relic.transform.position];
  s.to = [tx, heightAt(tx, tz) + RELIC_GROUND_HOVER, tz];
  s.startedAt = now;
  s.flightMs = Math.max(RELIC_FLIGHT_MIN_MS, (dist / RELIC_THROW_SPEED) * 1000);
  s.arcHeight = 1;
  // Only the thrower is locked out; teammates may intercept the lob immediately.
  s.noCatchUntil = 0;
  carrier.relicRecatchUntil = now + RELIC_RECATCH_DELAY_MS;
  events?.emit({ type: 'RelicThrown', holderId: carrier.id });
  return true;
};

/** Land the relic where its flight ends and let walk-ins claim it. */
const ground = (s: NonNullable<Entity['relic']>, pos: Vector3Tuple, events?: EventQueue): void => {
  s.phase = 'grounded';
  s.nextVolatileDischargeAt = undefined;
  s.mode = undefined;
  s.target = undefined;
  s.thrower = undefined;
  // failedAt survives grounding — the marker runs hot for a moment after a failure.
  s.from = undefined;
  s.to = undefined;
  s.control = undefined;
  s.endBase = undefined;
  pos[1] = heightAt(pos[0], pos[2]) + RELIC_GROUND_HOVER;
  events?.emit({ type: 'RelicGrounded', position: [pos[0], pos[1], pos[2]] });
};

/** Immediate authoritative drop for death/disconnect; corruption is deliberately retained. */
export const groundHeldRelic = (
  world: World<Entity>,
  holder: Entity,
  events?: EventQueue,
): boolean => {
  const relic = carriedRelicOf(world, holder);
  if (!relic?.relic || !relic.transform || !holder.transform) return false;
  clearRelicBuffs(holder);
  relic.relic.carrier = undefined;
  relic.transform.position = [...holder.transform.position];
  ground(relic.relic, relic.transform.position, events);
  return true;
};

const erupt = (
  world: World<Entity>,
  relic: Entity,
  holder: Entity,
  now: number,
  events: EventQueue,
): void => {
  const s = relic.relic!;
  const cp = holder.transform?.position ?? relic.transform!.position;
  const rotationY = holder.transform?.rotationY ?? 0;
  world.add(
    createMonster('relicBoss', [
      cp[0] + Math.sin(rotationY) * RELIC_CORRUPTION_BOSS_DISTANCE,
      0,
      cp[2] + Math.cos(rotationY) * RELIC_CORRUPTION_BOSS_DISTANCE,
    ]),
  );
  if (holder.health) holder.health.current = 0;
  clearRelicBuffs(holder);
  s.corruption = 0;
  s.carrier = undefined;
  relic.transform!.position = [cp[0], cp[1], cp[2]];
  ground(s, relic.transform!.position, events);
  s.noCatchUntil = now;
  events.emit({
    type: 'RelicErupted',
    holderId: holder.id,
    position: [cp[0], cp[1], cp[2]],
  });
  emitCorruption(events, RELIC_CORRUPTION_TUNING.max, 0);
};

/** Charge the authoritative Relic once for each successful holder ranged attack. */
export const onRelicAttackUsed = (
  world: World<Entity>,
  holder: Entity,
  now: number,
  events: EventQueue,
): boolean => {
  const relic = carriedRelicOf(world, holder);
  if (!relic?.relic) return false;
  const s = relic.relic;
  const oldValue = s.corruption;
  const tier = getRelicTier(oldValue);
  s.corruption = Math.max(
    0,
    Math.min(
      RELIC_CORRUPTION_TUNING.max,
      oldValue + RELIC_CORRUPTION_TUNING.abilityCorruptionCost + tier.extraCorruptionPerAttack,
    ),
  );
  emitCorruption(events, oldValue, s.corruption);
  if (s.corruption >= RELIC_CORRUPTION_TUNING.max) erupt(world, relic, holder, now, events);
  else applyRelicBuffs(holder, s.corruption);
  return true;
};

/** A confirmed pass failed at arrival: bounce once along the remaining momentum. */
const failPass = (
  relic: Entity,
  now: number,
  reason: 'receiver_downed' | 'receiver_escaped',
  events: EventQueue,
): void => {
  const s = relic.relic!;
  const pos = relic.transform!.position;

  // Refund the thrower's rotation cooldown — see the failure-behavior plan, Q1.
  if (s.thrower) s.thrower.relicRecatchUntil = 0;
  s.failedAt = now;
  s.failReason = reason;
  events.emit({ type: 'RelicPassFailed', position: [pos[0], pos[1], pos[2]], reason });

  // Exit tangent of the quadratic Bézier at t=1 is P2 − P1; fall back to the chord.
  let dx = (s.to?.[0] ?? pos[0]) - (s.control?.[0] ?? pos[0]);
  let dz = (s.to?.[2] ?? pos[2]) - (s.control?.[2] ?? pos[2]);
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    dx = 1;
    dz = 0;
  } else {
    dx /= len;
    dz /= len;
  }
  const tx = pos[0] + dx * RELIC_FAIL_BOUNCE_DIST;
  const tz = pos[2] + dz * RELIC_FAIL_BOUNCE_DIST;

  s.mode = 'lob';
  s.target = undefined;
  s.thrower = undefined;
  s.from = [pos[0], pos[1], pos[2]];
  s.to = [tx, heightAt(tx, tz) + RELIC_GROUND_HOVER, tz];
  s.control = undefined;
  s.endBase = undefined;
  s.startedAt = now;
  s.flightMs = RELIC_FAIL_BOUNCE_MS;
  s.arcHeight = RELIC_FAIL_BOUNCE_ARC;
  s.noCatchUntil = 0; // immediately recoverable, even mid-bounce
};

/**
 * Per-frame Relic state machine. Runs AFTER movement/separation so the carried position
 * follows the carrier's final transform for the frame (no one-frame trailing).
 */
export const relicSystem = (
  world: World<Entity>,
  dt: number,
  now: number,
  events: EventQueue,
  hooks: SimHooks = NOOP_HOOKS,
): void => {
  for (const relic of world.with('transform', 'relic')) {
    const s = relic.relic;
    const pos = relic.transform.position;

    if (s.phase === 'carried') {
      const c = s.carrier;
      if (!c?.transform || isDead(c)) {
        // Carrier died (or vanished): the Relic drops where they fell.
        clearRelicBuffs(c);
        s.carrier = undefined;
        if (c?.transform) {
          pos[0] = c.transform.position[0];
          pos[1] = c.transform.position[1];
          pos[2] = c.transform.position[2];
        }
        ground(s, pos, events);
        continue;
      }
      // Float at the carrier's left shoulder; while aiming it steadies forward-left so
      // the throw reads without hiding the character or the receiver. Aim state is fed
      // in as part of the carrier's intent (entity.passAiming), not read from client UI.
      const aimingThis = c.passAiming === true && c.playerControlled === true;
      const [ox, oy, oz] = aimingThis ? RELIC_AIM_OFFSET : RELIC_CARRY_OFFSET;
      const cr = c.transform.rotationY;
      const cp = c.transform.position;
      pos[0] = cp[0] + ox * Math.cos(cr) + oz * Math.sin(cr);
      pos[1] = cp[1] + oy;
      pos[2] = cp[2] - ox * Math.sin(cr) + oz * Math.cos(cr);

      // Buffs are derived, never accumulated. Apply the current tier, then advance the one
      // authoritative corruption value with that tier's deliberately escalating drip.
      applyRelicBuffs(c, s.corruption);
      const oldCorruption = s.corruption;
      const tier = getRelicTier(oldCorruption);
      s.corruption = Math.max(
        0,
        Math.min(
          RELIC_CORRUPTION_TUNING.max,
          oldCorruption + RELIC_CORRUPTION_TUNING.baseDripPerSecond * tier.dripMult * dt,
        ),
      );
      emitCorruption(events, oldCorruption, s.corruption);
      if (s.corruption >= RELIC_CORRUPTION_TUNING.max) {
        erupt(world, relic, c, now, events);
        continue;
      }
      updateVolatileDischarge(world, relic, c, getRelicTierIndex(s.corruption), now, events, hooks);
    } else if (s.phase === 'inFlight' && s.mode === 'pass') {
      const t = Math.min(1, (now - (s.startedAt ?? now)) / (s.flightMs ?? 1));
      const target = s.target;
      const from = s.from!;
      const to = s.to!;

      // Late homing: the endpoint chases the receiver's live socket, clamped to a max
      // correction from the release-time prediction — smooth, never a 90° corner.
      if (t >= RELIC_HOMING_START_T && target?.transform && !isDead(target)) {
        const tp = target.transform.position;
        const live: Vector3Tuple = [tp[0], tp[1] + RELIC_CATCH_SOCKET_Y, tp[2]];
        const base = s.endBase!;
        let cx = live[0] - base[0];
        let cy = live[1] - base[1];
        let cz = live[2] - base[2];
        const corr = Math.hypot(cx, cy, cz);
        if (corr > RELIC_HOMING_MAX_CORRECTION) {
          const k = RELIC_HOMING_MAX_CORRECTION / corr;
          cx *= k;
          cy *= k;
          cz *= k;
        }
        const blend = 1 - Math.exp(-RELIC_HOMING_RATE * dt);
        to[0] += (base[0] + cx - to[0]) * blend;
        to[1] += (base[1] + cy - to[1]) * blend;
        to[2] += (base[2] + cz - to[2]) * blend;
      }

      sampleBezier(from, s.control!, to, t, pos);

      if (t >= 1) {
        const tp = target?.transform?.position;
        const near =
          tp !== undefined && Math.hypot(tp[0] - pos[0], tp[2] - pos[2]) <= ARRIVAL_TOLERANCE;
        if (target && tp && !isDead(target) && near) {
          catchRelic(world, relic, target, now, events, hooks);
        } else {
          // Receiver died or outran the correction budget — the pass FAILS. The relic
          // keeps its remaining momentum (the Bézier's exit tangent) and bounces once
          // as a mini-lob before settling; lob flights are walk-in catchable, so the
          // bounce itself is already recoverable. The thrower's rotation cooldown is
          // refunded — failure shouldn't strand them next to their own relic.
          failPass(
            relic,
            now,
            target && !isDead(target) ? 'receiver_escaped' : 'receiver_downed',
            events,
          );
        }
      }
    } else if (s.phase === 'inFlight') {
      // Untargeted lob: the original parabola. Walk-in interception is a valid catch.
      const t = Math.min(1, (now - (s.startedAt ?? now)) / (s.flightMs ?? 1));
      const from = s.from ?? pos;
      const to = s.to ?? pos;
      pos[0] = from[0] + (to[0] - from[0]) * t;
      pos[2] = from[2] + (to[2] - from[2]) * t;
      pos[1] = from[1] + (to[1] - from[1]) * t + (s.arcHeight ?? 1.5) * 4 * t * (1 - t);
      if (t >= 1) ground(s, pos, events);
      else tryCatch(world, relic, now, events, hooks);
    } else {
      // grounded: hold the hover height (terrain may differ from where the throw aimed).
      pos[1] = heightAt(pos[0], pos[2]) + RELIC_GROUND_HOVER;
      tryCatch(world, relic, now, events, hooks);
    }
  }
};
