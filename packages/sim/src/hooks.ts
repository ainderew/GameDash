import type { World } from 'miniplex';
import type { HitStrength } from '@shared/combat';
import type { Vector3Tuple } from '@shared/types';
import type { Entity } from './components';

/**
 * THE FEEL SEAM — every client-only side effect the sim used to call directly (hitstop,
 * screen shake, audio, impact VFX, damage numbers, blade-socket refinement) enters through
 * this injected interface instead. The client passes its feel implementation
 * (apps/web/src/game/feel/simHooks.ts); the room server passes nothing and the sim runs
 * silent. Hooks may read/mutate presentation-only entity fields (flash, FX markers) but
 * must never change a gameplay outcome — the server would not run them.
 */

/** Everything the feel layer needs to know about a confirmed hit (was feel/onHit.ts). */
export interface HitContext {
  world: World<Entity>;
  /** Who dealt the hit (for directional feedback). Optional (e.g. a stray projectile). */
  attacker?: Entity;
  target: Entity;
  amount: number;
  strength: HitStrength;
  crit: boolean;
  /** Contact point in world space — where sparks + shockwave spawn. */
  point: Vector3Tuple;
  /** Unit knockback direction in XZ (away from the attacker). */
  dirX: number;
  dirZ: number;
  /** gameNow() of the hit. */
  now: number;
}

export interface SimHooks {
  /** A hit landed (damage applied, knockback/stagger already stamped by the sim). */
  onHitLanded?(ctx: HitContext): void;
  /** A player parried the hit (sim already staggered/shoved the attacker). */
  onParry?(ctx: HitContext): void;
  /** A melee swing started — whoosh etc. Fires for every player, whiff or hit. */
  onSwing?(player: Entity, strength: HitStrength): void;
  /** Someone caught the Relic at `point` (event already emitted, shockwave applied). */
  onRelicCaught?(world: World<Entity>, relic: Entity, catcher: Entity, point: Vector3Tuple): void;
  /**
   * Optional client-side refinement of a melee contact point against the previous rendered
   * blade pose (weapon sockets). Mutates `point` in place. The deterministic arc broad phase
   * remains the gameplay truth the server trusts — this only moves where sparks land.
   */
  refineMeleeHit?(player: Entity, target: Entity, point: Vector3Tuple): void;
}

/** Server default: the sim runs with zero feel side effects. */
export const NOOP_HOOKS: SimHooks = {};
