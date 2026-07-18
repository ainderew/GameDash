import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { multiplayerAudioCuesFor } from '@/net/multiplayerAudio';

const cues = (msg: ServerMessage, ownEntityId = 7) => multiplayerAudioCuesFor(msg, ownEntityId);

describe('multiplayer audio feedback', () => {
  it('maps confirmed combat outcomes to hit and parry sounds', () => {
    expect(
      cues({
        type: 'damageDealt',
        serverTick: 1,
        targetId: 2,
        targetKind: 'monster',
        sourceId: 7,
        amount: 12,
        strength: 'heavy',
        crit: true,
        point: [0, 0, 0],
        dir: [1, 0],
      }),
    ).toEqual([{ type: 'swordHit', strength: 'heavy', crit: true }]);
    expect(
      cues({
        type: 'damageDealt',
        serverTick: 2,
        targetId: 7,
        targetKind: 'player',
        sourceId: 9,
        amount: 8,
        strength: 'light',
        crit: false,
        point: [0, 0, 0],
        dir: [1, 0],
      }),
    ).toEqual([{ type: 'hit', strength: 'light', crit: false }]);
    expect(cues({ type: 'parrySuccess', serverTick: 1, playerId: 'p1' })).toEqual([
      { type: 'parry' },
    ]);
  });

  it('plays launch/failure cues and only rewards the local catcher', () => {
    const flight = {
      mode: 'pass' as const,
      from: [0, 0, 0] as [number, number, number],
      control: [1, 1, 1] as [number, number, number],
      to: [2, 0, 2] as [number, number, number],
      arcHeight: 1,
      startedAt: 0,
      flightMs: 400,
    };
    expect(cues({ type: 'relicLaunched', serverTick: 1, flight })).toEqual([
      { type: 'relicThrow' },
    ]);
    expect(
      cues({ type: 'relicCaught', serverTick: 2, carrierId: 7, pos: [2, 0, 2], corruption: 0 }),
    ).toEqual([{ type: 'relicPickup' }]);
    expect(
      cues({ type: 'relicCaught', serverTick: 2, carrierId: 9, pos: [2, 0, 2], corruption: 0 }),
    ).toEqual([]);
    expect(cues({ type: 'passRejected', serverTick: 3, reason: 'not_carrier' })).toEqual([
      { type: 'passFail' },
    ]);
  });
});
