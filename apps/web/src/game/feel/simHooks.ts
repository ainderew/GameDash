import { Vector3 } from 'three';
import type { World } from 'miniplex';
import type { SimHooks } from '@sim/hooks';
import type { Entity } from '@sim/components';
import type { Vector3Tuple } from '@shared/types';
import { RELIC_CATCH_HITSTOP_MS, RELIC_SHOCKWAVE_RADIUS } from '@shared/balance';
import { onHitLanded, onParry, spawnImpactVfx } from '@/game/feel/onHit';
import { addTrauma } from '@/game/feel/screenShake';
import { requestHitstop } from '@/game/feel/time';
import { playWhoosh } from '@/game/feel/audio';
import { weaponSockets } from '@/game/combat/weaponSockets';

/**
 * The CLIENT's SimHooks — everything juicy the headless sim used to call directly, now
 * injected into stepSim by SystemRunner. The room server passes no hooks and the same
 * tick runs silent; nothing in here may change a gameplay outcome.
 */

/** The Relic's glow color — catch shockwave ring matches the crystal. */
const RELIC_FX_COLOR = '#2dd4bf';

// Scratch vectors for the blade-socket refinement (render-side three.js is fine HERE).
const bladeBase = new Vector3();
const bladeTip = new Vector3();
const bladeContact = new Vector3();

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

export const clientSimHooks: SimHooks = {
  onHitLanded,
  onParry,

  // Whoosh on the swing itself so even a whiff feels like effort.
  onSwing: (_player, strength) => playWhoosh(strength),

  onRelicCaught: (world, _relic, catcher, point) => {
    spawnImpactVfx(world, point, 'heavy', RELIC_FX_COLOR);
    spawnCatchBloom(world, point);
    addTrauma(0.25);
    // Local-player catch juice: a brief whole-scene "thunk" freeze. Teammate catches skip
    // it — freezing the fight every time an AI receives a relay pass would read as stutter.
    if (catcher.localPlayer) requestHitstop(RELIC_CATCH_HITSTOP_MS);
  },

  /**
   * Renderer-owned sockets refine the visual contact point against the previous rendered
   * blade pose. Gameplay uses the sim's deterministic arc broad phase either way — this
   * only moves where the sparks land.
   */
  refineMeleeHit: (_player, _target, point) => {
    const baseSocket = weaponSockets.base;
    const tipSocket = weaponSockets.tip;
    if (!baseSocket || !tipSocket) return;
    baseSocket.getWorldPosition(bladeBase);
    tipSocket.getWorldPosition(bladeTip);
    bladeContact.set(point[0], point[1], point[2]);
    const blade = bladeTip.sub(bladeBase);
    const lenSq = blade.lengthSq();
    if (lenSq <= 1e-6) return;
    const fraction = Math.max(0, Math.min(1, bladeContact.sub(bladeBase).dot(blade) / lenSq));
    bladeBase.addScaledVector(blade, fraction);
    point[0] = bladeBase.x;
    point[1] = bladeBase.y;
    point[2] = bladeBase.z;
  },
};
