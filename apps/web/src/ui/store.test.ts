import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore, type SessionUI } from '@/ui/store';

/**
 * Phase 6 store contracts: the networked scene guard (server owns the zone in a session),
 * the expedition countdown mirror, teammate HP, and the relic-carrier icon source.
 */

const session: SessionUI = {
  code: 'ABC123',
  playerId: 'p_self',
  members: [
    { id: 'p_self', name: 'Me', character: 'hero', entityId: 1, ping: 20, connected: true },
    { id: 'p_two', name: 'Pal', character: 'druid', entityId: 2, ping: 40, connected: true },
  ],
};

beforeEach(() => {
  useUIStore.setState({ session: undefined, scene: 'hub', zoneCountdown: null, relicCarrier: null });
});

describe('scene guard (server-authoritative zone in a session)', () => {
  it('setScene applies in solo (no session)', () => {
    useUIStore.getState().setScene('expedition');
    expect(useUIStore.getState().scene).toBe('expedition');
  });

  it('setScene is IGNORED while in a session (the server drives the zone)', () => {
    useUIStore.setState({ session });
    useUIStore.getState().setScene('expedition');
    expect(useUIStore.getState().scene).toBe('hub');
  });

  it('setSceneAuthoritative always applies, even in a session', () => {
    useUIStore.setState({ session });
    useUIStore.getState().setSceneAuthoritative('expedition');
    expect(useUIStore.getState().scene).toBe('expedition');
  });
});

describe('expedition countdown mirror', () => {
  it('tracks seconds-left and clears', () => {
    useUIStore.getState().setZoneCountdown(5);
    expect(useUIStore.getState().zoneCountdown).toBe(5);
    useUIStore.getState().setZoneCountdown(null);
    expect(useUIStore.getState().zoneCountdown).toBeNull();
  });
});

describe('teammate HP + relic carrier', () => {
  it('setMemberHp updates only the addressed member', () => {
    useUIStore.setState({ session });
    useUIStore.getState().setMemberHp('p_two', 42);
    const members = useUIStore.getState().session!.members;
    expect(members.find((m) => m.id === 'p_two')!.hp).toBe(42);
    expect(members.find((m) => m.id === 'p_self')!.hp).toBeUndefined();
  });

  it('setRelicCarrier records who holds the relic', () => {
    useUIStore.getState().setRelicCarrier('p_two');
    expect(useUIStore.getState().relicCarrier).toBe('p_two');
    useUIStore.getState().setRelicCarrier(null);
    expect(useUIStore.getState().relicCarrier).toBeNull();
  });
});
