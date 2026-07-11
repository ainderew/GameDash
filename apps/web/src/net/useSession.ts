import { useCallback } from 'react';
import { normalizeSessionCode } from '@shared/net/ids';
import { netClient } from '@/net/client';
import { useUIStore } from '@/ui/store';

/**
 * React glue over the net client: session/connection state from the store plus
 * stable action callbacks. Components never touch netClient directly.
 */
export const useSession = () => {
  const session = useUIStore((s) => s.session);
  const connectionState = useUIStore((s) => s.connectionState);
  const netError = useUIStore((s) => s.netError);
  const character = useUIStore((s) => s.playerCharacter);

  const createSession = useCallback(
    (name: string) => netClient.createSession(name, character),
    [character],
  );

  const joinSession = useCallback(
    (code: string, name: string) => netClient.joinSession(normalizeSessionCode(code), name, character),
    [character],
  );

  const leaveSession = useCallback(() => netClient.leaveSession(), []);

  return { session, connectionState, netError, createSession, joinSession, leaveSession };
};
