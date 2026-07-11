import type { With, World } from 'miniplex';
import type { Entity } from '../components';
import { dealDamage } from './combatHelpers';
import { NOOP_HOOKS, type SimHooks } from '../hooks';
import { computeDamage } from '@shared/combat';
import { PROJECTILE_SPEED } from '@shared/balance';

/** Base wake radius — a monster idles in place until a player comes this close. */
const AGGRO_RANGE = 12;
/** Extra distance beyond the wake radius before an engaged monster gives up (hysteresis). */
const LEASH_MARGIN = 8;

const isDead = (e: Entity): boolean => (e.health?.current ?? 1) <= 0;

/**
 * Monster FSM: idle → chase → attack → cooldown. Pure over (world, dt, now)
 * apart from mutating monster/player entities. The transition logic is unit-tested.
 * N-player: each monster targets its NEAREST LIVING player-controlled entity; with
 * nobody left alive the field stands down (the hunt has already failed by then).
 */
export const aiSystem = (
  world: World<Entity>,
  dt: number,
  now: number,
  hooks: SimHooks = NOOP_HOOKS,
): void => {
  const players = world.with('playerControlled', 'transform', 'health');

  for (const m of world.with('transform', 'aiBrain', 'monster', 'velocity')) {
    const brain = m.aiBrain;
    // Staggered: the monster can't act while its knockback plays out. knockbackSystem
    // owns its velocity this frame; skip all AI (movement + attacks). A hit landed during
    // the windup CANCELS the pending strike — the player can interrupt a telegraphed blow.
    if ((m.staggerUntil ?? 0) > now) {
      brain.strikeAt = undefined;
      continue;
    }
    const mp = m.transform.position;

    // Nearest living player is this monster's target for the tick.
    let player: With<Entity, 'playerControlled' | 'transform' | 'health'> | undefined;
    let dist = Infinity;
    for (const p of players) {
      if (isDead(p)) continue;
      const d = Math.hypot(p.transform.position[0] - mp[0], p.transform.position[2] - mp[2]);
      if (d < dist) {
        dist = d;
        player = p;
      }
    }
    if (!player) {
      brain.state = 'idle';
      brain.strikeAt = undefined;
      m.velocity.linear[0] = 0;
      m.velocity.linear[2] = 0;
      continue;
    }
    const pp = player.transform.position;
    const dx = pp[0] - mp[0];
    const dz = pp[2] - mp[2];
    const range = m.attackRange ?? 2;
    const cooldown = m.attackCooldownMs ?? 1000;
    const speed = m.moveSpeed ?? 3;

    // Proximity gate with hysteresis: a monster wakes only when the player is near,
    // and — once engaged — keeps pursuing until the player leashes further out, so
    // it doesn't flicker on/off at the boundary. Ranged monsters wake beyond their
    // attack range so a spitter isn't asleep while in firing distance.
    const wakeRange = Math.max(AGGRO_RANGE, range + 2);
    const engaged = brain.state !== 'idle';
    const active = dist <= (engaged ? wakeRange + LEASH_MARGIN : wakeRange);

    if (!active) {
      // Stand down: hold position and orientation until the player returns.
      brain.state = 'idle';
      brain.strikeAt = undefined;
      m.velocity.linear[0] = 0;
      m.velocity.linear[2] = 0;
      continue;
    }

    // Engaged: track the player. During a windup we keep tracking so the tell aims at
    // the player, but the strike still whiffs if they dodge out of range before it lands.
    m.transform.rotationY = Math.atan2(dx, dz);

    // ── Committed strike (mid-windup) ────────────────────────────────────────
    // The attack was TELEGRAPHED last time we entered range; now we're locked in until
    // the blow lands. Hold position through the tell so the anticipation reads.
    if (brain.strikeAt !== undefined) {
      brain.state = 'attack';
      m.velocity.linear[0] = 0;
      m.velocity.linear[2] = 0;
      if (now >= brain.strikeAt) {
        resolveStrike(world, m, player, dx, dz, dist, range, now, hooks);
        brain.strikeAt = undefined;
        brain.state = 'cooldown';
      }
      continue;
    }

    const offCooldown = now - brain.lastAttackAt >= cooldown;

    if (dist > range) {
      brain.state = 'chase';
    } else if (offCooldown) {
      // Begin the attack: start the telegraph NOW (drives the anticipation pose in the
      // renderer) and commit to a strike after the windup. Cooldown is gated from windup
      // start so the attack cadence is windup + cooldown, not instant.
      brain.state = 'attack';
      brain.lastAttackAt = now;
      brain.strikeAt = now + (m.attackWindupMs ?? 0);
      m.attackStartedAt = now; // telegraph anim begins now (replicated via MON_FLAG_ATTACK)
      m.velocity.linear[0] = 0;
      m.velocity.linear[2] = 0;
      continue;
    } else {
      brain.state = 'cooldown';
    }

    // Movement: chase steers toward the player; otherwise hold position.
    if (brain.state === 'chase') {
      const inv = dist > 0 ? 1 / dist : 0;
      m.velocity.linear[0] = dx * inv * speed;
      m.velocity.linear[2] = dz * inv * speed;
    } else {
      m.velocity.linear[0] = 0;
      m.velocity.linear[2] = 0;
    }
  }
};

/**
 * Land a telegraphed melee/ranged attack. Called when the windup elapses. Melee whiffs if
 * the player dodged out of range during the tell (a small pad keeps grazing hits fair);
 * ranged always fires (the projectile itself is the dodgeable threat).
 */
const resolveStrike = (
  world: World<Entity>,
  m: With<Entity, 'transform' | 'aiBrain' | 'monster' | 'velocity'>,
  player: With<Entity, 'playerControlled' | 'transform' | 'health'>,
  dx: number,
  dz: number,
  dist: number,
  range: number,
  now: number,
  hooks: SimHooks,
): void => {
  if (m.ranged) {
    fireMonsterProjectile(world, m, dx, dz, dist, now);
    return;
  }
  // Dodged out of the telegraph → the swing whiffs. The pad forgives a hair of spacing so
  // standing at the very edge of range still trades.
  if (dist > range + STRIKE_RANGE_PAD) return;
  // Brutes hit heavy; everything else jabs. Strength scales the player's knockback
  // (feel.knockback.playerScale shove under the hurt anim) + shake/flash/audio/hitstop.
  const strength = m.monster === 'brute' ? 'heavy' : 'light';
  dealDamage(
    world,
    player,
    computeDamage(m.attackDamage ?? 5),
    now,
    false,
    { attacker: m, strength },
    hooks,
  );
};

/** Grace distance beyond attackRange at strike time so edge-of-range hits still land. */
const STRIKE_RANGE_PAD = 0.6;

const fireMonsterProjectile = (
  world: World<Entity>,
  m: Entity,
  dx: number,
  dz: number,
  dist: number,
  now: number,
): void => {
  const inv = dist > 0 ? 1 / dist : 0;
  const ux = dx * inv;
  const uz = dz * inv;
  const mp = m.transform!.position;
  world.add({
    transform: { position: [mp[0] + ux, mp[1] + 0.8, mp[2] + uz], rotationY: Math.atan2(dx, dz) },
    velocity: { linear: [ux * PROJECTILE_SPEED, 0, uz * PROJECTILE_SPEED] },
    projectile: true,
    faction: 'monster',
    damage: computeDamage(m.attackDamage ?? 5),
    spawnedAt: now,
  });
};
