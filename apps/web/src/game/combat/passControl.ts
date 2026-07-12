import type { World } from 'miniplex';
import type { Entity } from '@sim/components';
import type { Vector3Tuple } from '@shared/types';
import { cameraRig } from '@/game/camera/cameraRig';
import { passAim, resetPassAim } from '@/game/combat/passAim';
import {
  predictCatchPos,
  bezierControl,
  sampleBezier,
  selectPassTarget,
  type Candidate,
} from '@sim/combat/passTargeting';
import {
  RELIC_PASS_CONE_DEG,
  RELIC_PASS_RANGE,
  RELIC_QUICK_CONE_DEG,
  RELIC_QUICK_TAP_MS,
} from '@shared/balance';

/**
 * The E-button state machine: tap = quick pass through a narrow cone, hold past the tap
 * threshold = aim mode (markers + trajectory), release = throw to the locked target.
 * Dodge / melee / heavy stagger / death cancel the aim; LIGHT damage deliberately does
 * not — chip damage must not make passing unreliable.
 */

const CURVE_SAMPLES = 24;

let heldSince: number | null = null;
let canceled = false;

// Dev-only debug handle: which branch the pass state machine took last tick.
const dbg = { heldSince: null as number | null, canceled: false, held: false, hasRelic: false, interrupted: false, tick: 0 };
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __passCtl?: typeof dbg }).__passCtl = dbg;
}

const isDead = (e: Entity): boolean => (e.health?.current ?? 1) <= 0;

/** Degrees between camera forward and the carrier→candidate direction, on XZ. */
const angleFromCamera = (carrier: Vector3Tuple, candidate: Vector3Tuple): number => {
  const fx = -Math.sin(cameraRig.yaw);
  const fz = -Math.cos(cameraRig.yaw);
  const dx = candidate[0] - carrier[0];
  const dz = candidate[2] - carrier[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return 0;
  const dot = Math.min(1, Math.max(-1, (dx / len) * fx + (dz / len) * fz));
  return (Math.acos(dot) * 180) / Math.PI;
};

/** Every receiver in range — AI teammates AND other player-controlled entities —
 * scored against the camera's intent. */
const buildCandidates = (world: World<Entity>, carrier: Entity, now: number): Candidate[] => {
  const out: Candidate[] = [];
  const cp = carrier.transform!.position;
  for (const mate of world.with('transform')) {
    if (mate === carrier) continue;
    // Receivers: AI teammates (solo), other local player-controlled entities, AND networked
    // remote players (the human co-op case — mirrored avatars carry `remotePlayer`).
    if (!mate.teammate && !mate.playerControlled && !mate.remotePlayer) continue;
    const mp = mate.transform.position;
    const dist = Math.hypot(mp[0] - cp[0], mp[2] - cp[2]);
    if (dist > RELIC_PASS_RANGE || isDead(mate)) continue;
    // Facing the carrier counts as "ready to receive".
    const toCarrierX = cp[0] - mp[0];
    const toCarrierZ = cp[2] - mp[2];
    const tcLen = Math.hypot(toCarrierX, toCarrierZ) || 1;
    const facing =
      Math.sin(mate.transform.rotationY) * (toCarrierX / tcLen) +
        Math.cos(mate.transform.rotationY) * (toCarrierZ / tcLen) >
      0.5;
    out.push({
      entity: mate,
      angleDeg: angleFromCamera(cp, mp),
      dist,
      facingCarrier: facing,
      eligible: now >= (mate.relicRecatchUntil ?? 0),
    });
  }
  return out;
};

/** Refresh the world-space trajectory preview toward the locked target. */
const updateCurve = (relicOrigin: Vector3Tuple, target: Entity): void => {
  const p0 = relicOrigin;
  const p2 = predictCatchPos(target);
  const p1 = bezierControl(p0, p2);
  passAim.curve.length = CURVE_SAMPLES;
  for (let k = 0; k < CURVE_SAMPLES; k++) {
    const pt = (passAim.curve[k] ??= [0, 0, 0]);
    sampleBezier(p0, p1, p2, k / (CURVE_SAMPLES - 1), pt);
  }
};

/**
 * Per-tick driver, called from SystemRunner for the local player. Pure input handling:
 * it returns the receiver to pass to THIS tick (or null) — the launch itself is a sim
 * intent executed inside stepSim, never a direct call from the input layer.
 */
export const updatePassControl = (
  world: World<Entity>,
  player: Entity,
  passHeld: boolean,
  now: number,
  // The carrier's relic anchor when this player holds the relic, else null. Solo passes the
  // ECS relic's position; networked passes the local avatar's position when relicNet reports
  // the local player as carrier. Decoupling from the ECS relic lets pass-aim work in a
  // networked expedition, where the relic is server-authoritative (relicNet), not an entity.
  relicOrigin: Vector3Tuple | null,
): Entity | null => {
  dbg.tick++;
  dbg.held = passHeld;
  dbg.hasRelic = relicOrigin !== null;
  dbg.heldSince = heldSince;
  dbg.canceled = canceled;
  if (!relicOrigin) {
    heldSince = null;
    canceled = false;
    if (passAim.aiming || passAim.target) resetPassAim();
    return null;
  }

  const interrupted =
    isDead(player) ||
    now < (player.dodgingUntil ?? 0) ||
    player.attackState !== undefined ||
    ((player.staggerUntil ?? 0) > now && player.hitReactionStrength === 'heavy');

  if (passHeld && heldSince === null) {
    heldSince = now;
    canceled = false;
  }

  if (passHeld && heldSince !== null) {
    if (interrupted) {
      canceled = true;
      resetPassAim();
      return null;
    }
    if (canceled || now - heldSince <= RELIC_QUICK_TAP_MS) return null;

    // Aim mode: score, apply stickiness + manual cycling, publish for the UI/camera.
    passAim.aiming = true;
    passAim.candidates = buildCandidates(world, player, now);
    passAim.target = selectPassTarget(
      passAim.target,
      passAim.candidates,
      RELIC_PASS_CONE_DEG,
      passAim.cycle,
    );
    passAim.cycle = 0;
    passAim.valid = passAim.target !== null;
    if (passAim.target) updateCurve(relicOrigin, passAim.target);
    else passAim.curve.length = 0;
    return null;
  }

  if (!passHeld && heldSince !== null) {
    const heldMs = now - heldSince;
    heldSince = null;
    const wasCanceled = canceled;
    canceled = false;

    let target: Entity | null = null;
    if (!wasCanceled && !interrupted) {
      if (heldMs <= RELIC_QUICK_TAP_MS) {
        // Quick pass: no preview was shown, so demand stronger evidence of intent
        // (narrower cone). No target → do nothing; NEVER dump it on the ground.
        target = selectPassTarget(null, buildCandidates(world, player, now), RELIC_QUICK_CONE_DEG);
      } else if (passAim.valid && passAim.target) {
        target = passAim.target;
      }
      // Release without a valid target = cancel, silently.
    }
    resetPassAim();
    return target;
  }
  return null;
};
