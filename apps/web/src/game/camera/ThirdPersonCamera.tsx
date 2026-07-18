import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Vector3, Raycaster } from 'three';
import type { Object3D } from 'three';
import { CAMERA_DAMPING } from '@shared/balance';
import {
  cameraRig,
  MOUSE_SENS,
  PITCH_MAX,
  PITCH_MIN,
  resetCameraRig,
} from '@/game/camera/cameraRig';
import { shakeOffset } from '@/game/feel/screenShake';
import { passAim } from '@/game/combat/passAim';

/** Pass-aim framing: lateral shift toward the Relic (left) shoulder + mild FOV squeeze. */
const AIM_SHOULDER_SHIFT = 0.35;
const AIM_FOV_DELTA = -5;
const AIM_SENS_SCALE = 0.85;
/** Blend rate toward/away from aim framing, 1/s (~120 ms transitions). */
const AIM_BLEND_RATE = 8.5;

interface Props {
  /** The object the camera should follow (the player group). */
  target: React.RefObject<Object3D | null>;
  /** Static obstacles to de-occlude against. */
  obstacles: React.RefObject<Object3D[]>;
  /** Expedition starts lower on the orbit so its moon and layered skyline stay in frame. */
  mode: 'hub' | 'expedition';
}

const desired = new Vector3();
const targetPos = new Vector3();
const lookAt = new Vector3();
const dir = new Vector3();
const raycaster = new Raycaster();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Mouse-look orbit follow camera (pointer lock) with obstruction pull-in.
 *
 * Clicking the canvas locks the pointer (the same click still attacks); the mouse then
 * orbits the rig — X spins yaw, Y pitches (clamped), wheel zooms the boom. Esc releases
 * the pointer, restoring the visible cursor (and cursor-aimed attacks). WASD is rotated
 * into this camera's yaw in SystemRunner, so "forward" is always away from the camera.
 */
export const ThirdPersonCamera = ({ target, obstacles, mode }: Props) => {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const initialized = useRef(false);
  /** The un-shaken follow position; shake is layered on top so it never feeds back. */
  const base = useRef(new Vector3());
  /** 0 = normal framing, 1 = full pass-aim framing; smoothed each frame. */
  const aimBlend = useRef(0);

  // The rig is shared so input and aiming can read it without React churn. Reset that
  // singleton before the first painted gameplay frame so re-entering never inherits the
  // previous session's orbit or zoom.
  useLayoutEffect(() => {
    resetCameraRig();
    if (mode === 'expedition') cameraRig.pitch = 0.24;
    initialized.current = false;
  }, [mode]);

  useEffect(() => {
    const canvas = gl.domElement;
    const locked = () => document.pointerLockElement === canvas;

    // Standard AAA web pattern: the first click captures the mouse. It's the same click
    // that attacks — one gesture to get into the action. Esc (browser-native) releases.
    const onMouseDown = () => {
      if (!locked()) canvas.requestPointerLock();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!locked()) return;
      // Aiming a pass slightly slows the look — finer target selection under pressure.
      const sens = passAim.aiming ? MOUSE_SENS * AIM_SENS_SCALE : MOUSE_SENS;
      cameraRig.yaw -= e.movementX * sens;
      // Mouse up → look up (camera dips); mouse down → look down (camera rises).
      cameraRig.pitch = clamp(cameraRig.pitch + e.movementY * sens, PITCH_MIN, PITCH_MAX);
    };
    const onWheel = (e: WheelEvent) => {
      // While pass-aiming the wheel cycles receivers. Zoom is locked, so the wheel does
      // nothing otherwise — the entry boom length is the fixed framing for the session.
      if (passAim.aiming) {
        passAim.cycle += Math.sign(e.deltaY);
      }
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('wheel', onWheel);
    };
  }, [gl]);

  useFrame((_, dt) => {
    const obj = target.current;
    if (!obj) return;

    obj.getWorldPosition(targetPos);

    // Spherical boom around the look-at point (player chest height).
    const horiz = Math.cos(cameraRig.pitch) * cameraRig.dist;
    const vert = Math.sin(cameraRig.pitch) * cameraRig.dist;
    desired.set(
      targetPos.x + Math.sin(cameraRig.yaw) * horiz,
      targetPos.y + 1 + vert,
      targetPos.z + Math.cos(cameraRig.yaw) * horiz,
    );

    // De-occlude: if something sits between the player and the desired cam pos, pull in.
    dir.copy(desired).sub(targetPos);
    const maxDist = dir.length();
    dir.normalize();
    raycaster.set(targetPos, dir);
    raycaster.far = maxDist;
    const hits = raycaster.intersectObjects(obstacles.current ?? [], false);
    if (hits.length > 0 && hits[0]) {
      const pulled = Math.max(hits[0].distance - 0.3, 1);
      desired.copy(targetPos).add(dir.multiplyScalar(pulled));
    }

    if (!initialized.current) {
      base.current.copy(desired);
      initialized.current = true;
    } else {
      const t = 1 - Math.exp(-CAMERA_DAMPING * dt);
      base.current.lerp(desired, t);
    }

    // PASS-AIM FRAMING: blend toward a slight left-shoulder shift + FOV squeeze while
    // aiming (~120 ms each way). The sim never slows — this is presentation only.
    const blendK = 1 - Math.exp(-AIM_BLEND_RATE * dt);
    aimBlend.current += ((passAim.aiming ? 1 : 0) - aimBlend.current) * blendK;
    const b = aimBlend.current;
    // Camera-right on XZ; the Relic rides the LEFT shoulder, so shift by -right.
    const shiftX = -Math.cos(cameraRig.yaw) * AIM_SHOULDER_SHIFT * b;
    const shiftZ = Math.sin(cameraRig.yaw) * AIM_SHOULDER_SHIFT * b;
    const persp = camera as typeof camera & { fov: number; updateProjectionMatrix: () => void };
    if ('fov' in camera) {
      const wantFov = 55 + AIM_FOV_DELTA * b;
      if (Math.abs(persp.fov - wantFov) > 0.01) {
        persp.fov = wantFov;
        persp.updateProjectionMatrix();
      }
    }

    // SCREEN SHAKE: sample trauma on REAL dt so it keeps kicking during hitstop, then
    // layer it onto the follow position and roll. Zero-cost when there's no trauma.
    const shake = shakeOffset(dt);
    camera.position.set(
      base.current.x + shake.x + shiftX,
      base.current.y + shake.y,
      base.current.z + shiftZ,
    );
    lookAt.set(targetPos.x + shiftX, targetPos.y + 1, targetPos.z + shiftZ);
    camera.lookAt(lookAt);
    if (shake.roll !== 0) camera.rotateZ(shake.roll);
  });

  return null;
};
