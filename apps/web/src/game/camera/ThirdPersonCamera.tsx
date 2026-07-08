import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { Vector3, Raycaster } from 'three';
import type { Object3D } from 'three';
import { CAMERA_DAMPING, CAMERA_DISTANCE, CAMERA_HEIGHT } from '@shared/balance';

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

/**
 * Fixed-orientation follow camera with obstruction pull-in.
 * Raycasts from the player toward the desired camera position and shortens on a hit.
 */
export const ThirdPersonCamera = ({ target, obstacles }: Props) => {
  const camera = useThree((s) => s.camera);
  const initialized = useRef(false);

  useFrame((_, dt) => {
    const obj = target.current;
    if (!obj) return;

    obj.getWorldPosition(targetPos);
    desired.set(targetPos.x, targetPos.y + CAMERA_HEIGHT, targetPos.z + CAMERA_DISTANCE);

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
      camera.position.copy(desired);
      initialized.current = true;
    } else {
      const t = 1 - Math.exp(-CAMERA_DAMPING * dt);
      camera.position.lerp(desired, t);
    }

    lookAt.set(targetPos.x, targetPos.y + 1, targetPos.z);
    camera.lookAt(lookAt);
  });

  return null;
};
