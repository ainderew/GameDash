/**
 * Shared authoritative landmark geometry for the social hub. Rendering, UX triggers,
 * roads, and server collision all consume these coordinates so layout revisions cannot
 * leave multiplayer walking against invisible copies of the old buildings.
 */
export const HUB_LANDMARK_POSITIONS = {
  lodge: [-15, -10.5],
  shrine: [15, -8.5],
  gate: [0, -21.5],
} as const;

export const HUB_CLEARING_RADIUS = 31;
