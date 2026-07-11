import type { CharacterId } from '@shared/net/character';
import { heroTransform } from '@/game/entities/heroConfig';

/**
 * Playable character registry. Every entry is a Mixamo-rigged (`mixamorig:`) skinned GLB,
 * so the ONE hero clip set (models/hero/anim-*.glb) binds to any of them by bone name —
 * no per-character animations. Rigs may lack bones the clips animate (the druid has no
 * thumb joints); prepareClip drops those tracks, so they just don't move.
 *
 * The id set is the WIRE enum (@shared/net/character) — adding a character means adding
 * it there first, so the protocol, the server and this registry can never drift.
 */
export type PlayerCharacterId = CharacterId;

/**
 * Layer for the player-only fill light: the light has ONLY this layer, character meshes
 * enable it IN ADDITION to the default render layer 0 — so the fill illuminates the
 * playable character and nothing else in the scene.
 */
export const CHARACTER_FILL_LAYER = 1;

export interface PlayerCharacterDef {
  label: string;
  modelPath: string;
  /**
   * Baked per-model vertical correction (see heroTransform.yOffsetAdd): the shared clips
   * animate hips at a height authored for another rig, so each model needs its own
   * foot-planting offset — measure via skinned-mesh world bounds at spawn (≈0).
   */
  yOffsetAdd: number;
}

export const PLAYER_CHARACTERS: Record<PlayerCharacterId, PlayerCharacterDef> = {
  hero: { label: 'Hero', modelPath: '/models/hero/hero.glb', yOffsetAdd: -0.8 },
  druid: { label: 'Druid', modelPath: '/models/druid/druid.glb', yOffsetAdd: -0.8 },
};

/** Push a character's baked placement into the live-tunable transform on switch. */
export const applyCharacterTransform = (id: PlayerCharacterId): void => {
  heroTransform.yOffsetAdd = PLAYER_CHARACTERS[id].yOffsetAdd;
};
