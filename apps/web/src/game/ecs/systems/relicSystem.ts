import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import type { Vector3Tuple } from '@shared/types';
import { spawnImpactVfx } from '@/game/feel/onHit';
import { addTrauma } from '@/game/feel/screenShake';
import { requestHitstop } from '@/game/feel/time';
import { emit } from '@/game/events';
import { heightAt } from '@/game/world/terrainHeight';
import { passAim } from '@/game/combat/passAim';
import { bezierControl, passDurationMs, predictCatchPos, sampleBezier } from '@/game/combat/passTargeting';
import {
  RELIC_AIM_OFFSET,
  RELIC_CARRY_OFFSET,
  RELIC_FAIL_BOUNCE_ARC,
  RELIC_FAIL_BOUNCE_DIST,
  RELIC_FAIL_BOUNCE_MS,
  RELIC_CATCH_HEIGHT,
  RELIC_CATCH_HITSTOP_MS,
  RELIC_CATCH_RADIUS,
  RELIC_CATCH_ROOT_MS,
  RELIC_CATCH_SOCKET_Y,
  RELIC_FLIGHT_MIN_MS,
  RELIC_GROUND_HOVER,
  RELIC_HANDOFF_SHIELD_MS,
  RELIC_HOMING_MAX_CORRECTION,
  RELIC_HOMING_START_T,
  RELIC_PASS_RECATCH_MS,
  RELIC_RECATCH_DELAY_MS,
  RELIC_SHOCKWAVE_KNOCKBACK,
  RELIC_SHOCKWAVE_RADIUS,
  RELIC_SHOCKWAVE_STUN_MS,
  RELIC_THROW_MIN,
  RELIC_THROW_SPEED,
} from '@shared/balance';

/** The Relic's glow color — catch shockwave ring matches the crystal. */
const RELIC_FX_COLOR = '#2dd4bf';

/** How fast the homing endpoint chases the receiver, 1/s (exponential smoothing). */
const HOMING_RATE = 10;

/** On arrival, the receiver must be this close to the endpoint or the pass drops. */
const ARRIVAL_TOLERANCE = 2;

const isDead = (e: Entity): boolean => (e.health?.current ?? 1) <= 0;

/**
 * A wide white-hot "claim" bloom, layered over the teal shockwave spark+ring so a catch
 * reads bigger and brighter than a combat hit. Colour values exceed 1 to cross the Bloom
 * threshold for a hard flash; aged on real time so it erupts through the catch hitstop.
 */
const spawnCatchBloom = (world: World<Entity>, point: Vector3Tuple): void => {
  world.add({
    transform: { position: [...point], rotationY: 0 },
    impactFx: {
      kind: 'ring',
      strength: 'heavy',
      spawnedAtReal: performance.now(),
      lifetimeMs: 340,
      color: [1.6, 1.6, 1.45],
      count: 0,
      radius: RELIC_SHOCKWAVE_RADIUS * 0.75,
      dirX: 0,
      dirZ: 0,
    },
  });
};

/**
 * A successful catch: attach to the new carrier and release the defensive shockwave —
 * a visual ring plus a short shove/stagger on monsters near the catch point. No damage;
 * the reward for a clean catch is space, not kills. The receiver also gets a brief
 * handoff shield so an enemy hit landing on the exact catch frame never feels unfair.
 */
const catchRelic = (world: World<Entity>, relic: Entity, catcher: Entity, now: number): void => {
  const s = relic.relic!;
  s.phase = 'carried';
  s.carrier = catcher;
  s.mode = undefined;
  s.target = undefined;
  s.thrower = undefined;
  s.failedAt = undefined;
  s.from = undefined;
  s.to = undefined;
  s.control = undefined;
  s.endBase = undefined;
  catcher.iframeUntil = Math.max(catcher.iframeUntil ?? 0, now + RELIC_HANDOFF_SHIELD_MS);
  if (catcher.teammate) catcher.relicHeldSince = now;

  const point = relic.transform!.position;
  emit({
    type: 'RelicCaught',
    byLocalPlayer: catcher.playerControlled === true,
    position: [point[0], point[1], point[2]],
  });
  spawnImpactVfx(world, [point[0], point[1], point[2]], 'heavy', RELIC_FX_COLOR);
  spawnCatchBloom(world, [point[0], point[1], point[2]]);
  addTrauma(0.25);

  // Local-player catch juice: a brief whole-scene "thunk" freeze plus a plant that keeps the
  // catch clip from gliding on residual run momentum. Teammate catches skip this — freezing
  // the fight every time an AI receives a relay pass would feel like a stutter, not a beat.
  if (catcher.playerControlled) {
    requestHitstop(RELIC_CATCH_HITSTOP_MS);
    catcher.catchRootUntil = now + RELIC_CATCH_ROOT_MS;
  }

  for (const m of world.with('transform', 'health', 'monster')) {
    if (isDead(m)) continue;
    const dx = m.transform.position[0] - point[0];
    const dz = m.transform.position[2] - point[2];
    const distSq = dx * dx + dz * dz;
    if (distSq > RELIC_SHOCKWAVE_RADIUS * RELIC_SHOCKWAVE_RADIUS) continue;
    const len = Math.sqrt(distSq) || 1;
    m.knockback = [(dx / len) * RELIC_SHOCKWAVE_KNOCKBACK, 0, (dz / len) * RELIC_SHOCKWAVE_KNOCKBACK];
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

const tryCatch = (world: World<Entity>, relic: Entity, now: number): void => {
  for (const player of world.with('transform', 'playerControlled')) {
    if (canCatch(relic, player, now)) {
      catchRelic(world, relic, player, now);
      return;
    }
  }
};

/** The relic this entity is currently carrying, if any. */
export const carriedRelicOf = (world: World<Entity>, carrier: Entity): Entity | undefined => {
  for (const r of world.with('transform', 'relic')) {
    if (r.relic.phase === 'carried' && r.relic.carrier === carrier) return r;
  }
  return undefined;
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
  s.target = target;
  s.thrower = carrier;
  s.from = from;
  s.to = to;
  s.endBase = [...to];
  s.control = bezierControl(from, to);
  s.startedAt = now;
  s.flightMs = passDurationMs(dist);
  s.noCatchUntil = 0;
  emit({ type: 'RelicPassLaunched', toLocalPlayer: target.playerControlled === true, from });

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
export const dropRelic = (world: World<Entity>, carrier: Entity, now: number): boolean => {
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
  s.target = undefined;
  s.from = [...relic.transform.position];
  s.to = [tx, heightAt(tx, tz) + RELIC_GROUND_HOVER, tz];
  s.startedAt = now;
  s.flightMs = Math.max(RELIC_FLIGHT_MIN_MS, (dist / RELIC_THROW_SPEED) * 1000);
  s.arcHeight = 1;
  s.noCatchUntil = now + RELIC_RECATCH_DELAY_MS;
  carrier.relicRecatchUntil = now + RELIC_RECATCH_DELAY_MS;
  return true;
};

/** Land the relic where its flight ends and let walk-ins claim it. */
const ground = (s: NonNullable<Entity['relic']>, pos: Vector3Tuple): void => {
  s.phase = 'grounded';
  s.mode = undefined;
  s.target = undefined;
  s.thrower = undefined;
  // failedAt survives grounding — the marker runs hot for a moment after a failure.
  s.from = undefined;
  s.to = undefined;
  s.control = undefined;
  s.endBase = undefined;
  pos[1] = heightAt(pos[0], pos[2]) + RELIC_GROUND_HOVER;
};

/** A confirmed pass failed at arrival: bounce once along the remaining momentum. */
const failPass = (
  relic: Entity,
  now: number,
  reason: 'receiver_downed' | 'receiver_escaped',
): void => {
  const s = relic.relic!;
  const pos = relic.transform!.position;

  // Refund the thrower's rotation cooldown — see the failure-behavior plan, Q1.
  if (s.thrower) s.thrower.relicRecatchUntil = 0;
  s.failedAt = now;
  emit({ type: 'RelicPassFailed', position: [pos[0], pos[1], pos[2]], reason });

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
export const relicSystem = (world: World<Entity>, dt: number, now: number): void => {
  for (const relic of world.with('transform', 'relic')) {
    const s = relic.relic;
    const pos = relic.transform.position;

    if (s.phase === 'carried') {
      const c = s.carrier;
      if (!c?.transform || isDead(c)) {
        // Carrier died (or vanished): the Relic drops where they fell.
        s.carrier = undefined;
        ground(s, pos);
        continue;
      }
      // Float at the carrier's left shoulder; while aiming it steadies forward-left so
      // the throw reads without hiding the character or the receiver.
      const aimingThis = passAim.aiming && c.playerControlled === true;
      const [ox, oy, oz] = aimingThis ? RELIC_AIM_OFFSET : RELIC_CARRY_OFFSET;
      const cr = c.transform.rotationY;
      const cp = c.transform.position;
      pos[0] = cp[0] + ox * Math.cos(cr) + oz * Math.sin(cr);
      pos[1] = cp[1] + oy;
      pos[2] = cp[2] - ox * Math.sin(cr) + oz * Math.cos(cr);
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
        const blend = 1 - Math.exp(-HOMING_RATE * dt);
        to[0] += (base[0] + cx - to[0]) * blend;
        to[1] += (base[1] + cy - to[1]) * blend;
        to[2] += (base[2] + cz - to[2]) * blend;
      }

      sampleBezier(from, s.control!, to, t, pos);

      if (t >= 1) {
        const tp = target?.transform?.position;
        const near =
          tp !== undefined &&
          Math.hypot(tp[0] - pos[0], tp[2] - pos[2]) <= ARRIVAL_TOLERANCE;
        if (target && tp && !isDead(target) && near) {
          catchRelic(world, relic, target, now);
        } else {
          // Receiver died or outran the correction budget — the pass FAILS. The relic
          // keeps its remaining momentum (the Bézier's exit tangent) and bounces once
          // as a mini-lob before settling; lob flights are walk-in catchable, so the
          // bounce itself is already recoverable. The thrower's rotation cooldown is
          // refunded — failure shouldn't strand them next to their own relic.
          failPass(relic, now, target && !isDead(target) ? 'receiver_escaped' : 'receiver_downed');
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
      if (t >= 1) ground(s, pos);
      else tryCatch(world, relic, now);
    } else {
      // grounded: hold the hover height (terrain may differ from where the throw aimed).
      pos[1] = heightAt(pos[0], pos[2]) + RELIC_GROUND_HOVER;
      tryCatch(world, relic, now);
    }
  }
};
