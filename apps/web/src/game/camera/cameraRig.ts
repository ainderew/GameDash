/**
 * ORBIT RIG — the mouse-driven third-person camera state (AAA-style mouse look).
 *
 * Mutable module singleton, written by ThirdPersonCamera's pointer-lock handlers and read
 * by both the camera (position) and SystemRunner (camera-relative WASD + aim fallback).
 * yaw 0 = camera behind the player on +Z (the old fixed view); pitch is the look-down
 * angle above the horizon; dist is the boom length from the look-at point (player + 1y).
 */
export interface CameraRigState {
  yaw: number;
  pitch: number;
  dist: number;
}

export const ENTRY_CAMERA_RIG: Readonly<CameraRigState> = {
  yaw: 0,
  // Elevated hub overview, zoomed in 50% from the old fully-out framing (dist 20 → 20/1.5)
  // for a tighter entry read. Zoom is locked, so this boom length is fixed for the session.
  pitch: 0.5,
  dist: 20 / 1.5,
};

export const cameraRig: CameraRigState = { ...ENTRY_CAMERA_RIG };

/** Restore the authored first-play framing after the gameplay canvas is entered again. */
export const resetCameraRig = (): void => {
  cameraRig.yaw = ENTRY_CAMERA_RIG.yaw;
  cameraRig.pitch = ENTRY_CAMERA_RIG.pitch;
  cameraRig.dist = ENTRY_CAMERA_RIG.dist;
};

// Dev-only console handle (same pattern as window.__scene) so tooling can aim the camera.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __cameraRig?: typeof cameraRig }).__cameraRig = cameraRig;
}

/** Radians of orbit per pixel of mouse travel. */
export const MOUSE_SENS = 0.0025;
/** Pitch limits: never fully horizontal (camera in the grass), never fully top-down. */
export const PITCH_MIN = 0.15;
export const PITCH_MAX = 1.35;
