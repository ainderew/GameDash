import { CAMERA_DISTANCE, CAMERA_HEIGHT } from '@shared/balance';

/**
 * ORBIT RIG — the mouse-driven third-person camera state (AAA-style mouse look).
 *
 * Mutable module singleton, written by ThirdPersonCamera's pointer-lock handlers and read
 * by both the camera (position) and SystemRunner (camera-relative WASD + aim fallback).
 * yaw 0 = camera behind the player on +Z (the old fixed view); pitch is the look-down
 * angle above the horizon; dist is the boom length from the look-at point (player + 1y).
 */
export const cameraRig = {
  yaw: 0,
  pitch: Math.atan2(CAMERA_HEIGHT - 1, CAMERA_DISTANCE),
  dist: Math.hypot(CAMERA_DISTANCE, CAMERA_HEIGHT - 1),
};

// Dev-only console handle (same pattern as window.__scene) so tooling can aim the camera.
if (import.meta.env.DEV) {
  (window as unknown as { __cameraRig?: typeof cameraRig }).__cameraRig = cameraRig;
}

/** Radians of orbit per pixel of mouse travel. */
export const MOUSE_SENS = 0.0025;
/** Pitch limits: never fully horizontal (camera in the grass), never fully top-down. */
export const PITCH_MIN = 0.15;
export const PITCH_MAX = 1.35;
/** Wheel-zoom boom limits, world units. */
export const DIST_MIN = 6;
export const DIST_MAX = 20;
