import { useEffect } from 'react';
import { netClient } from '@/net/client';
import { useUIStore } from '@/ui/store';

/**
 * Networked Expedition-Gate control (Phase 6 Task 2). In a connected session the ZONE is
 * server-authoritative: crossing into the gate must NOT flip the scene locally (SocialHub's
 * solo teleport is re-anchored by prediction next tick, and its setScene is a no-op behind the
 * store's session guard) — instead it asks the server to open the shared 5 s countdown that
 * teleports the WHOLE party together. The countdown OPENS ON PROXIMITY, matching the solo gate:
 * we watch the same `hubStation` edge SocialHub publishes and fire once on entry. Pressing E
 * while the countdown runs still cancels it, so any member can call it off. Mounted only in the
 * hub scene of a networked session; needs no scene-graph access and touches no art components.
 */
export const NetGateInteraction = () => {
  // Proximity opens the countdown: fire once when the local player crosses into the gate ring.
  useEffect(() => {
    const unsubscribe = useUIStore.subscribe((state, prev) => {
      if (state.hubStation === prev.hubStation || state.hubStation !== 'expedition') return;
      if (!state.session || state.connectionState !== 'connected') return;
      // Only OPEN here; if one is already in flight (e.g. re-entering the ring), leave it be.
      if (state.zoneCountdown === null) netClient.requestZoneCountdown();
    });
    return unsubscribe;
  }, []);

  // E cancels an in-flight countdown — a deliberate call-off, still a key press.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat) return;
      const s = useUIStore.getState();
      if (!s.session || s.connectionState !== 'connected') return;
      if (s.hubStation !== 'expedition') return;
      if (s.zoneCountdown !== null) netClient.cancelZoneCountdown();
    };
    // Capture phase so we run alongside SocialHub's listener regardless of mount order.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return null;
};
