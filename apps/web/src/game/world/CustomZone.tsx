import { useEffect } from 'react';
import type { Object3D } from 'three';
import { Terrain } from '@/game/world/Terrain';
import { GroundMist } from '@/game/world/GroundMist';

interface Props {
  /** Camera de-occlusion landmarks — custom maps have none (props are visual only). */
  obstacles: React.MutableRefObject<Object3D[]>;
}

/**
 * Environment for an editor-authored map: bare terrain + mist. Everything else on
 * a custom map comes from its MapPlacements (rendered by GameCanvas alongside this).
 */
export const CustomZone = ({ obstacles }: Props) => {
  useEffect(() => {
    obstacles.current = [];
    return () => {
      obstacles.current = [];
    };
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <GroundMist />
    </>
  );
};
