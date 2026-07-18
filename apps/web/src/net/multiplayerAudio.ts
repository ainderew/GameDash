import type { ServerMessage } from '@shared/net/messages';
import {
  playHit,
  playParry,
  playPassFail,
  playRelicPickup,
  playRelicThrow,
  playSwordHit,
} from '@/game/feel/audio';

export type MultiplayerAudioCue =
  | { type: 'hit'; strength: 'light' | 'heavy'; crit: boolean }
  | { type: 'swordHit'; strength: 'light' | 'heavy'; crit: boolean }
  | { type: 'parry' }
  | { type: 'relicThrow' }
  | { type: 'relicPickup' }
  | { type: 'passFail' };

/** Pure authoritative-message → sound mapping, kept separate so multiplayer cannot drift silent. */
export const multiplayerAudioCuesFor = (
  msg: ServerMessage,
  ownEntityId: number | null,
): MultiplayerAudioCue[] => {
  switch (msg.type) {
    case 'damageDealt':
      return [
        {
          type:
            ownEntityId !== null && msg.sourceId === ownEntityId && msg.targetKind === 'monster'
              ? 'swordHit'
              : 'hit',
          strength: msg.strength,
          crit: msg.crit,
        },
      ];
    case 'parrySuccess':
      return [{ type: 'parry' }];
    case 'relicLaunched':
      return [{ type: 'relicThrow' }];
    case 'relicCaught':
      return msg.carrierId === ownEntityId ? [{ type: 'relicPickup' }] : [];
    case 'relicPassFailed':
    case 'passRejected':
      return [{ type: 'passFail' }];
    default:
      return [];
  }
};

/** Play reliable multiplayer feedback exactly once, when its authoritative message arrives. */
export const playMultiplayerAudio = (msg: ServerMessage, ownEntityId: number | null): void => {
  for (const cue of multiplayerAudioCuesFor(msg, ownEntityId)) {
    switch (cue.type) {
      case 'hit':
        playHit(cue.strength, cue.crit);
        break;
      case 'swordHit':
        playSwordHit(cue.strength, cue.crit);
        break;
      case 'parry':
        playParry();
        break;
      case 'relicThrow':
        playRelicThrow();
        break;
      case 'relicPickup':
        playRelicPickup();
        break;
      case 'passFail':
        playPassFail();
        break;
    }
  }
};
