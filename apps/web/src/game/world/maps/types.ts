/** One hand-placed prop in a map, authored in the map editor (/editor.html in dev). */
export interface MapPlacement {
  id: string;
  /** Public URL of the model, e.g. /models/nature/Rock_Medium_2.gltf */
  asset: string;
  position: [number, number, number];
  /** Euler XYZ, radians. */
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface GameMap {
  version: 1;
  placements: MapPlacement[];
}

export const EMPTY_MAP: GameMap = { version: 1, placements: [] };

/** Always-present maps: overlays for the two built scenes. Custom maps are any
 * other JSON file in this folder — created from the editor's "new map" button. */
export const BUILTIN_MAPS = ['hub', 'expedition'] as const;
