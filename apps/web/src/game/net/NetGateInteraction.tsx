import { useEffect } from 'react';
import { netClient } from '@/net/client';
import { useUIStore } from '@/ui/store';

/**
 * Networked Expedition-Gate control (Phase 6 Task 2). In a connected session the ZONE is
 * server-authoritative: pressing E at the gate must NOT flip the scene locally (SocialHub's
 * solo handler is neutralized by the store's scene guard, and its local teleport is re-anchored
 * by prediction next tick) — instead it asks the server to open the shared 5 s countdown that
 * teleports the WHOLE party together. Pressing E again while the countdown runs cancels it, so
 * any member can call it off. Mounted only in the hub scene of a networked session.
 *
 * The gate proximity itself is read off `hubStation` (SocialHub already publishes it to the
 * store), so this needs no scene-graph access and touches none of the art components.
 */
export const NetGateInteraction = () => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat) return;
      const s = useUIStore.getState();
      if (!s.session || s.connectionState !== 'connected') return;
      if (s.hubStation !== 'expedition') return;
      // Toggle: an in-flight countdown cancels; otherwise open one.
      if (s.zoneCountdown !== null) netClient.cancelZoneCountdown();
      else netClient.requestZoneCountdown();
    };
    // Capture phase so we run alongside SocialHub's listener regardless of mount order.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return null;
};
