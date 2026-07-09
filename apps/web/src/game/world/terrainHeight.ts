/**
 * Pure terrain height field — no three/react imports so the sim (movementSystem)
 * and the mesh builder (Terrain.tsx) can share one source of truth, and it stays
 * unit-testable headless.
 */

/** Play area stays flat within this radius so spawns/combat never sit on a slope. */
const FLAT_RADIUS = 24;
const HILL_START = 30;

/** Cheap layered value-ish noise from sines — deterministic, no textures. */
const noise = (x: number, z: number): number =>
  Math.sin(x * 0.08) * Math.cos(z * 0.1) * 0.6 +
  Math.sin(x * 0.041 + 1.7) * Math.cos(z * 0.037 - 0.4) * 1.1 +
  Math.sin(x * 0.021 - 0.6) * Math.cos(z * 0.026 + 2.1) * 1.9;

/** Radius within which the ground is flat (spawn-safe). Exported for scatter placement. */
export const PLAY_RADIUS = FLAT_RADIUS;

/** Ridge cap: uncapped, perimeter hills reach ~70 units — a wall ~31° above the horizon
 *  from the play area that buries the sky entirely (the camera tops out ~19° up).
 *  Capped near 14, the skyline sits ~7° up and the sky dome shows above it. */
const HILL_MAX = 14;

/** Height field: flat valley floor, rolling hills rising toward the perimeter. */
export const heightAt = (x: number, z: number): number => {
  const r = Math.hypot(x, z);
  const raw = r > HILL_START ? Math.pow((r - HILL_START) / 22, 1.9) * 6 : 0;
  // tanh cap: identical slope near the valley, asymptotes to HILL_MAX at the perimeter.
  const hill = HILL_MAX * Math.tanh(raw / HILL_MAX);
  // Undulation masked to ~0 in the flat play area, growing outward.
  const mask = Math.min(1, Math.max(0, (r - FLAT_RADIUS) / 18));
  return hill + noise(x, z) * mask;
};

// ── Dirt path ────────────────────────────────────────────────────────────────
// A wavy trail running roughly north–south through the arena. Terrain.tsx tints
// the ground with it; GrassField/Scatter keep vegetation off it. Purely visual —
// the physics ground is flat either way.
const PATH_HALF_WIDTH = 1.8;
const PATH_EDGE = 1.6;

const pathCenterX = (z: number) => 10 * Math.sin(z * 0.042) + 5 * Math.sin(z * 0.019 + 1.7);

/** 1 on the trail, softly falling to 0 at its grassy edges; fades out past the hills. */
export const pathMask = (x: number, z: number): number => {
  const d = Math.abs(x - pathCenterX(z));
  const t = Math.min(1, Math.max(0, (d - PATH_HALF_WIDTH) / PATH_EDGE));
  const edge = 1 - t * t * (3 - 2 * t); // smoothstep, ascending
  const r = Math.hypot(x, z);
  const fade = Math.min(1, Math.max(0, 1 - (r - 66) / 10));
  return edge * fade;
};
