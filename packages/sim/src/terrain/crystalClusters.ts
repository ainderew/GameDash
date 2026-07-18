export type CrystalClusterAsset = 'smallA' | 'smallB' | 'large';

export interface CrystalClusterPlacement {
  id: string;
  asset: CrystalClusterAsset;
  position: readonly [number, number];
  rotationY: number;
  scale: number;
  yOffset?: number;
}

/** Authored replacements for the social hub's temporary procedural octahedrons. */
export const HUB_CRYSTAL_PLACEMENTS: readonly CrystalClusterPlacement[] = [
  {
    id: 'hub-west-gate-large',
    asset: 'large',
    position: [-19, -13.5],
    rotationY: 0.22,
    scale: 0.56,
    yOffset: -0.02,
  },
  {
    id: 'hub-east-gate-large',
    asset: 'large',
    position: [19, -13.5],
    rotationY: -0.32,
    scale: 0.56,
    yOffset: -0.02,
  },
  {
    id: 'hub-northwest-small-a',
    asset: 'smallA',
    position: [-17.5, 12],
    rotationY: 0.7,
    scale: 0.78,
  },
  {
    id: 'hub-northeast-small-b',
    asset: 'smallB',
    position: [17.5, 12],
    rotationY: -0.55,
    scale: 0.9,
  },
] as const;

/**
 * Purple focal accents around the authored expedition ruins. The combat lane remains clear;
 * the clusters concentrate at ruin feet and the outer side paths visible in the concept.
 */
export const EXPEDITION_CRYSTAL_PLACEMENTS: readonly CrystalClusterPlacement[] = [
  {
    id: 'west-ruin-large',
    asset: 'large',
    position: [-14.2, -11.3],
    rotationY: 0.3,
    scale: 0.58,
    yOffset: -0.04,
  },
  {
    id: 'east-ruin-large',
    asset: 'large',
    position: [14.8, -11.8],
    rotationY: -0.4,
    scale: 0.56,
    yOffset: -0.04,
  },
  {
    id: 'southwest-large',
    asset: 'large',
    position: [-15.8, 8.8],
    rotationY: 1.1,
    scale: 0.48,
    yOffset: -0.04,
  },
  {
    id: 'southeast-large',
    asset: 'large',
    position: [16.5, 9.8],
    rotationY: -0.8,
    scale: 0.5,
    yOffset: -0.04,
  },

  {
    id: 'west-wall-small-a',
    asset: 'smallA',
    position: [-19.5, -13],
    rotationY: 0.45,
    scale: 0.86,
  },
  {
    id: 'west-arch-small-a',
    asset: 'smallA',
    position: [-10.2, -15.3],
    rotationY: -0.2,
    scale: 0.76,
  },
  {
    id: 'west-path-small-a',
    asset: 'smallA',
    position: [-5.6, -10.2],
    rotationY: 0.9,
    scale: 0.68,
  },
  { id: 'east-path-small-a', asset: 'smallA', position: [7, -10.7], rotationY: -0.7, scale: 0.74 },
  {
    id: 'east-wall-small-a',
    asset: 'smallA',
    position: [19.2, -13.4],
    rotationY: -0.45,
    scale: 0.88,
  },
  { id: 'west-field-small-a', asset: 'smallA', position: [-9.6, 5.8], rotationY: 1.3, scale: 0.66 },
  { id: 'east-field-small-a', asset: 'smallA', position: [11.5, 4.8], rotationY: -1.1, scale: 0.7 },

  {
    id: 'west-outer-small-b',
    asset: 'smallB',
    position: [-17.5, -18.2],
    rotationY: 0.6,
    scale: 0.82,
  },
  {
    id: 'west-rubble-small-b',
    asset: 'smallB',
    position: [-12.5, -9],
    rotationY: -0.8,
    scale: 0.78,
  },
  {
    id: 'east-arch-small-b',
    asset: 'smallB',
    position: [4.8, -15.2],
    rotationY: 0.35,
    scale: 0.72,
  },
  {
    id: 'east-rubble-small-b',
    asset: 'smallB',
    position: [10.8, -13.8],
    rotationY: -0.2,
    scale: 0.84,
  },
  {
    id: 'east-outer-small-b',
    asset: 'smallB',
    position: [18.4, -18],
    rotationY: -0.65,
    scale: 0.8,
  },
  {
    id: 'northwest-field-small-b',
    asset: 'smallB',
    position: [-12.2, 12.4],
    rotationY: 1.5,
    scale: 0.74,
  },
  {
    id: 'northeast-field-small-b',
    asset: 'smallB',
    position: [12.8, 13.3],
    rotationY: -1.35,
    scale: 0.76,
  },
] as const;

const keepoutRadius: Readonly<Record<CrystalClusterAsset, number>> = {
  smallA: 0.85,
  smallB: 0.95,
  large: 1.65,
};

/** Keeps random trees and large rocks from swallowing authored expedition crystals. */
export const inExpeditionCrystalKeepout = (x: number, z: number): boolean =>
  EXPEDITION_CRYSTAL_PLACEMENTS.some((placement) => {
    const dx = x - placement.position[0];
    const dz = z - placement.position[1];
    const radius = keepoutRadius[placement.asset] * placement.scale + 0.25;
    return dx * dx + dz * dz < radius * radius;
  });
