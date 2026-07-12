import { Vector3 } from 'three';
import type { SimHooks } from '@sim/hooks';
import { RELIC_CATCH_HITSTOP_MS } from '@shared/balance';
import { onHitLanded, onParry } from '@/game/feel/onHit';
import { addTrauma } from '@/game/feel/screenShake';
import { requestHitstop, gameNow } from '@/game/feel/time';
import { playWhoosh } from '@/game/feel/audio';
import { weaponSockets } from '@/game/combat/weaponSockets';

/** Teal emissive the catcher's body glows with while it absorbs the relic's power. */
const ABSORB_GLOW_COLOR: [number, number, number] = [0.18, 0.85, 0.75];
/** How long the body holds the absorb glow — spans the collapse so both fade together. */
const ABSORB_GLOW_MS = 300;

/**
 * The CLIENT's SimHooks — everything juicy the headless sim used to call directly, now
 * injected into stepSim by SystemRunner. The room server passes no hooks and the same
 * tick runs silent; nothing in here may change a gameplay outcome.
 */

// Scratch vectors for the blade-socket refinement (render-side three.js is fine HERE).
const bladeBase = new Vector3();
const bladeTip = new Vector3();
const bladeContact = new Vector3();

export const clientSimHooks: SimHooks = {
  onHitLanded,
  onParry,

  // Whoosh on the swing itself so even a whiff feels like effort.
  onSwing: (_player, strength) => playWhoosh(strength),

  onRelicCaught: (world, _relic, catcher, point) => {
    // A large teal energy field collapses in and is drawn into the catcher's body — spiral
    // in-streams that dissolve into the torso + a shrinking aura shell. See fx/RelicCatchFX.
    // This marker entity is the only spawn; the renderer ages it out on real time.
    world.add({
      transform: { position: [...point], rotationY: 0 },
      catchBurstFx: { spawnedAtReal: performance.now() },
    });
    // The body itself glows teal as it absorbs — driven through the existing hit-flash channel
    // (Player.tsx / MutantModels.tsx read hitFlashColor). This is what sells "absorbed INTO
    // the body" rather than a flash floating in front of it.
    catcher.hitFlashColor = ABSORB_GLOW_COLOR;
    catcher.hitFlashUntil = gameNow() + ABSORB_GLOW_MS;
    addTrauma(0.32);
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
