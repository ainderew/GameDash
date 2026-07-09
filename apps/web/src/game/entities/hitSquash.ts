import type { Entity } from '@/game/ecs/components';
import { feel } from '@/game/feel/config';

/**
 * TARGET HIT REACTION — squash & stretch. On impact the body squashes (short + wide),
 * then springs through a decaying wobble back to rest. Returns [scaleXZ, scaleY].
 * Shared by the instanced monsters (MonsterModels) and the skinned mutant (MutantModels).
 */
export const hitSquash = (e: Entity, now: number): [number, number] => {
  const start = e.hitReactionAt;
  if (start === undefined) return [1, 1];
  const t = (now - start) / feel.squash.durationMs;
  if (t < 0 || t > 1) return [1, 1];
  const amt = feel.squash.amount[e.hitReactionStrength ?? 'light'];
  // Damped oscillation: starts at +1 (squash), swings to stretch, decays to 0.
  const wob = Math.cos(t * Math.PI * 3) * (1 - t);
  return [1 + amt * 0.6 * wob, 1 - amt * wob];
};
