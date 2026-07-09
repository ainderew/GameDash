import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { dealDamage } from '@/game/ecs/systems/combatHelpers';
import { computeDamage } from '@shared/combat';
import { PROJECTILE_SPEED } from '@shared/balance';

/** Base wake radius — a monster idles in place until the player comes this close. */
const AGGRO_RANGE = 12;
/** Extra distance beyond the wake radius before an engaged monster gives up (hysteresis). */
const LEASH_MARGIN = 8;

/**
 * Monster FSM: idle → chase → attack → cooldown. Pure over (world, dt, now)
 * apart from mutating monster/player entities. The transition logic is unit-tested.
 */
export const aiSystem = (world: World<Entity>, dt: number, now: number): void => {
  const player = world.with('playerControlled', 'transform', 'health').first;
  if (!player?.transform) return;
  const pp = player.transform.position;

  for (const m of world.with('transform', 'aiBrain', 'monster', 'velocity')) {
    const brain = m.aiBrain;
    // Staggered: the monster can't act while its knockback plays out. knockbackSystem
    // owns its velocity this frame; skip all AI (movement + attacks).
    if ((m.staggerUntil ?? 0) > now) continue;
    const mp = m.transform.position;
    const dx = pp[0] - mp[0];
    const dz = pp[2] - mp[2];
    const dist = Math.hypot(dx, dz);
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
      m.velocity.linear[0] = 0;
      m.velocity.linear[2] = 0;
      continue;
    }

    // Engaged: track the player.
    m.transform.rotationY = Math.atan2(dx, dz);

    const offCooldown = now - brain.lastAttackAt >= cooldown;

    if (dist > range) {
      brain.state = 'chase';
    } else if (offCooldown) {
      brain.state = 'attack';
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

    // Attack.
    if (brain.state === 'attack') {
      brain.lastAttackAt = now;
      m.attackStartedAt = now; // drives the lunge animation in MonsterModels

      if (m.ranged) {
        fireMonsterProjectile(world, m, dx, dz, dist, now);
      } else {
        // Brutes hit heavy; everything else jabs. Strength scales the player's knockback
        // (feel.knockback.playerScale shove under the hurt anim) + shake/flash/audio/hitstop.
        const strength = m.monster === 'brute' ? 'heavy' : 'light';
        dealDamage(world, player, computeDamage(m.attackDamage ?? 5), now, false, {
          attacker: m,
          strength,
        });
      }
      brain.state = 'cooldown';
    }
  }
};

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
