import { useEffect } from 'react';
import { startAmbient, stopAmbient } from '@/game/feel/ambientScheduler';

/**
 * Drives the periodic ambient world bed for as long as the game world is mounted — the hub and
 * the expedition, never the menu (GameCanvas only mounts once you've pressed PLAY). Renders
 * nothing and lives OUTSIDE <Canvas>: it touches only WebAudio + timers, no three.js.
 */
export const AmbientAudio = (): null => {
  useEffect(() => {
    startAmbient();
    return () => stopAmbient();
  }, []);
  return null;
};
