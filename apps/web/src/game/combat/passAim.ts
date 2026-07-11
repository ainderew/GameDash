import type { Entity } from '@sim/components';
import type { Candidate } from '@sim/combat/passTargeting';
import type { Vector3Tuple } from '@shared/types';

/**
 * PASS-AIM STATE — mutable module singleton (same pattern as cameraRig).
 *
 * Written once per tick by SystemRunner's pass state machine; read by the world-space
 * aim UI (trajectory + markers), the camera (aim framing), and the Relic renderer
 * (aim pose). Never React state — this changes every frame.
 */
export interface PassAimState {
  /** True while the carrier holds E past the tap threshold (aim mode). */
  aiming: boolean;
  /** Currently locked receiver (null = no valid target in cone). */
  target: Entity | null;
  /** All teammates considered this frame, with their scores' inputs (UI markers). */
  candidates: Candidate[];
  /** Wheel steps accumulated while aiming; consumed by targeting each tick. */
  cycle: number;
  /** Sampled preview curve to the predicted catch point (world space, aim mode only). */
  curve: Vector3Tuple[];
  /** True when releasing right now would pass (valid locked target). */
  valid: boolean;
}

export const passAim: PassAimState = {
  aiming: false,
  target: null,
  candidates: [],
  cycle: 0,
  curve: [],
  valid: false,
};

// Dev-only console handle (same pattern as window.__cameraRig) so tooling can drive
// the aim state — e.g. freeze the aim pose for screenshots without holding a key.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __passAim?: PassAimState }).__passAim = passAim;
}

/** Clear everything (pass thrown, canceled, or the relic left the player's hands). */
export const resetPassAim = (): void => {
  passAim.aiming = false;
  passAim.target = null;
  passAim.candidates = [];
  passAim.cycle = 0;
  passAim.curve = [];
  passAim.valid = false;
};
