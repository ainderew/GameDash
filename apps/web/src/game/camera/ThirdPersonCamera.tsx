import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, Raycaster } from 'three';
import type { Object3D } from 'three';
import { CAMERA_DAMPING } from '@shared/balance';
import {
  cameraRig,
  DIST_MAX,
  DIST_MIN,
  MOUSE_SENS,
  PITCH_MAX,
  PITCH_MIN,
} from '@/game/camera/cameraRig';
import { shakeOffset } from '@/game/feel/screenShake';

interface Props {
  /** The object the camera should follow (the player group). */
  target: React.RefObject<Object3D | null>;
  /** Static obstacles to de-occlude against. */
  obstacles: React.RefObject<Object3D[]>;
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
export const ThirdPersonCamera = ({ target, obstacles }: Props) => {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const initialized = useRef(false);
  /** The un-shaken follow position; shake is layered on top so it never feeds back. */
  const base = useRef(new Vector3());

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
      cameraRig.yaw -= e.movementX * MOUSE_SENS;
      // Mouse up → look up (camera dips); mouse down → look down (camera rises).
      cameraRig.pitch = clamp(cameraRig.pitch + e.movementY * MOUSE_SENS, PITCH_MIN, PITCH_MAX);
    };
    const onWheel = (e: WheelEvent) => {
      cameraRig.dist = clamp(cameraRig.dist * (1 + e.deltaY * 0.0009), DIST_MIN, DIST_MAX);
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

    // SCREEN SHAKE: sample trauma on REAL dt so it keeps kicking during hitstop, then
    // layer it onto the follow position and roll. Zero-cost when there's no trauma.
    const shake = shakeOffset(dt);
    camera.position.set(
      base.current.x + shake.x,
      base.current.y + shake.y,
      base.current.z,
    );
    lookAt.set(targetPos.x, targetPos.y + 1, targetPos.z);
    camera.lookAt(lookAt);
    if (shake.roll !== 0) camera.rotateZ(shake.roll);
  });

  return null;
};
