import type { GameMap } from '@/game/world/maps/types';

/**
 * Every JSON in this folder is a map, keyed by filename. 'hub' and 'expedition'
 * overlay the built scenes; any other name is a standalone destination selectable
 * at the Expedition Gate (rendered via CustomZone).
 */
const modules = import.meta.glob('./*.json', { eager: true });

export const MAPS: Record<string, GameMap> = {};
for (const [path, mod] of Object.entries(modules)) {
  const name = path.replace(/^\.\//, '').replace(/\.json$/, '');
  MAPS[name] = (mod as { default: GameMap }).default;
}

/** Maps a player can pick as an expedition destination (everything but the hub overlay). */
export const expeditionDestinations = (): string[] =>
  Object.keys(MAPS)
    .filter((n) => n !== 'hub')
    .sort((a, b) => (a === 'expedition' ? -1 : b === 'expedition' ? 1 : a.localeCompare(b)));
