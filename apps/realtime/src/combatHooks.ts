import type { Vector3Tuple } from '@shared/types';
import type { Entity } from '@sim/components';
import type { HitContext, SimHooks } from '@sim/hooks';

/**
 * Server-side capture of the sim's feel hooks (Phase 4, Task 5). The room server runs the
 * sim SILENT — no audio, no VFX, no hitstop — but it must learn which hits the authoritative
 * combat CONFIRMED so it can turn them into reliable `DamageDealt`/`ParrySuccess` wire events
 * the clients react to. These hooks are pure sinks: they record contexts, never mutate
 * gameplay (the sim already applied damage before calling them).
 *
 * `onPlayerImpulse` is the exception the no-rubberband contract requires: a monster's shove
 * on a player is DEFERRED here (not applied in-sim) and routed into the sequenced
 * ServerImpulse pipeline so the owning client replays the identical knockback + stagger.
 */

export interface CapturedHit {
  kind: 'hit' | 'parry';
  ctx: HitContext;
}

/** A SimHooks impl that captures confirmed hits and routes player shoves to `onImpulse`. */
export const makeServerCombatHooks = (
  sink: CapturedHit[],
  onImpulse: (target: Entity, impulse: Vector3Tuple, staggerMs: number) => void,
): SimHooks => ({
  onHitLanded: (ctx) => sink.push({ kind: 'hit', ctx }),
  onParry: (ctx) => sink.push({ kind: 'parry', ctx }),
  onPlayerImpulse: onImpulse,
  // onSwing / onRelicCaught / refineMeleeHit are presentation — the server has none.
});
