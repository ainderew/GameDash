export interface ExpeditionPuddle {
  id: string;
  position: readonly [number, number];
  radius: readonly [number, number];
  rotation: number;
  seed: number;
}

/** Authored low spots that create a wet visual rhythm through the expedition combat lane. */
export const EXPEDITION_PUDDLES: readonly ExpeditionPuddle[] = [
  { id: 'southwest-path', position: [-5.8, -7.2], radius: [3.4, 1.35], rotation: 0.42, seed: 3.1 },
  { id: 'southeast-path', position: [7.2, -4.8], radius: [2.6, 1.1], rotation: -0.3, seed: 7.7 },
  { id: 'west-ruin', position: [-13.8, -1.8], radius: [2.8, 1.45], rotation: -0.52, seed: 12.4 },
  { id: 'east-tree', position: [13.2, 3.4], radius: [3.1, 1.3], rotation: 0.24, seed: 18.9 },
  { id: 'north-path', position: [2.8, 10.8], radius: [3.6, 1.25], rotation: -0.18, seed: 24.2 },
  { id: 'northwest-hollow', position: [-12.6, 14.6], radius: [2.45, 1.05], rotation: 0.65, seed: 31.6 },
  { id: 'east-outer', position: [18.4, -14.8], radius: [2.3, 0.95], rotation: -0.7, seed: 38.3 },
] as const;

export interface ExpeditionLanternPlacement {
  id: string;
  model: 'ground' | 'post';
  position: readonly [number, number];
  rotationY: number;
  height: number;
  phase: number;
  light: boolean;
}

/** Warm navigation points alternate down the lane and illuminate authored ruin entrances. */
export const EXPEDITION_LANTERNS: readonly ExpeditionLanternPlacement[] = [
  { id: 'southwest-entry', model: 'ground', position: [-11.8, -14.8], rotationY: 0.35, height: 1.25, phase: 0.2, light: true },
  { id: 'southeast-entry', model: 'ground', position: [12.2, -13.6], rotationY: -0.45, height: 1.2, phase: 1.7, light: true },
  { id: 'west-path-post', model: 'post', position: [-8.4, -2.2], rotationY: 0.75, height: 2.65, phase: 3.1, light: true },
  { id: 'east-path-post', model: 'post', position: [9.2, 3.3], rotationY: -0.8, height: 2.75, phase: 4.8, light: true },
  { id: 'northwest-ruin', model: 'ground', position: [-14.4, 10.7], rotationY: 1.1, height: 1.15, phase: 6.2, light: false },
  { id: 'north-path-post', model: 'post', position: [5.8, 14.5], rotationY: -0.25, height: 2.55, phase: 8.4, light: true },
] as const;

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** CPU twin of the terrain puddle mask, used to keep dense grass out of standing water. */
export const expeditionWetnessAt = (x: number, z: number): number => {
  let wetness = 0;
  for (const puddle of EXPEDITION_PUDDLES) {
    const dx = x - puddle.position[0];
    const dz = z - puddle.position[1];
    const c = Math.cos(puddle.rotation);
    const s = Math.sin(puddle.rotation);
    const qx = (c * dx - s * dz) / puddle.radius[0];
    const qz = (s * dx + c * dz) / puddle.radius[1];
    const distance = Math.hypot(qx, qz);
    wetness = Math.max(wetness, 1 - smoothstep(0.74, 1.08, distance));
  }
  return wetness;
};

