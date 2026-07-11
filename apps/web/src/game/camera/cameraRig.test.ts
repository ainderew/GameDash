import { beforeEach, describe, expect, it } from 'vitest';
import { cameraRig, ENTRY_CAMERA_RIG, resetCameraRig } from './cameraRig';

describe('camera entry preset', () => {
  beforeEach(() => {
    resetCameraRig();
  });

  it('uses the authored elevated, wide hub framing', () => {
    expect(cameraRig).toEqual({ yaw: 0, pitch: 0.5, dist: 20 / 1.5 });
  });

  it('restores the entry framing after free-camera movement', () => {
    cameraRig.yaw = 1.2;
    cameraRig.pitch = 0.9;
    cameraRig.dist = 7;

    resetCameraRig();

    expect(cameraRig).toEqual(ENTRY_CAMERA_RIG);
  });
});
