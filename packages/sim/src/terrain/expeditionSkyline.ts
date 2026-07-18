import { PLAY_RADIUS } from './terrainHeight';

export type ExpeditionSkylineAsset = 'towerA' | 'towerB' | 'distantArch';

export interface ExpeditionSkylinePlacement {
  id: string;
  asset: ExpeditionSkylineAsset;
  position: readonly [number, number];
  rotationY: number;
  scale: number;
  depthBand: 'mid' | 'far';
  /** Sink broad foundations into the uneven perimeter hill. */
  yOffset: number;
}

/**
 * Two architectural depth bands around the expedition valley. The mid band sits just beyond
 * the authored foreground ruins; the far band rises behind the ridge and dissolves into fog.
 * Every façade faces approximately toward the arena, with small yaw offsets to avoid a
 * mechanically radial arrangement. Six instances per source still render as three batches.
 */
export const EXPEDITION_SKYLINE_PLACEMENTS: readonly ExpeditionSkylinePlacement[] = [
  {
    id: 'north-mid-arch',
    asset: 'distantArch',
    depthBand: 'mid',
    position: [0, -43],
    rotationY: 0.03,
    scale: 1.05,
    yOffset: -0.38,
  },
  {
    id: 'northwest-mid-watchtower',
    asset: 'towerA',
    depthBand: 'mid',
    position: [-24, -45],
    rotationY: 0.55,
    scale: 1.05,
    yOffset: -0.48,
  },
  {
    id: 'northeast-mid-belfry',
    asset: 'towerB',
    depthBand: 'mid',
    position: [27, -46],
    rotationY: -0.5808,
    scale: 0.95,
    yOffset: -0.42,
  },
  {
    id: 'west-mid-belfry',
    asset: 'towerB',
    depthBand: 'mid',
    position: [-43, -30],
    rotationY: 1.0316,
    scale: 0.84,
    yOffset: -0.4,
  },
  {
    id: 'east-mid-arch',
    asset: 'distantArch',
    depthBand: 'mid',
    position: [42, -34],
    rotationY: -0.9503,
    scale: 0.86,
    yOffset: -0.36,
  },
  {
    id: 'east-mid-watchtower',
    asset: 'towerA',
    depthBand: 'mid',
    position: [47, -20],
    rotationY: -1.1285,
    scale: 0.78,
    yOffset: -0.42,
  },

  {
    id: 'north-far-watchtower',
    asset: 'towerA',
    depthBand: 'far',
    position: [-12, -72],
    rotationY: 0.1251,
    scale: 0.82,
    yOffset: -0.62,
  },
  {
    id: 'north-far-arch',
    asset: 'distantArch',
    depthBand: 'far',
    position: [20, -76],
    rotationY: -0.2073,
    scale: 0.78,
    yOffset: -0.58,
  },
  {
    id: 'northwest-far-belfry',
    asset: 'towerB',
    depthBand: 'far',
    position: [-54, -54],
    rotationY: 0.8254,
    scale: 0.72,
    yOffset: -0.58,
  },
  {
    id: 'northeast-far-watchtower',
    asset: 'towerA',
    depthBand: 'far',
    position: [59, -55],
    rotationY: -0.8605,
    scale: 0.75,
    yOffset: -0.62,
  },
  {
    id: 'west-far-arch',
    asset: 'distantArch',
    depthBand: 'far',
    position: [-72, -13],
    rotationY: 1.4522,
    scale: 0.7,
    yOffset: -0.56,
  },
  {
    id: 'east-far-belfry',
    asset: 'towerB',
    depthBand: 'far',
    position: [74, 4],
    rotationY: -1.6748,
    scale: 0.75,
    yOffset: -0.58,
  },
  {
    id: 'southeast-far-watchtower',
    asset: 'towerA',
    depthBand: 'far',
    position: [58, 57],
    rotationY: -2.2975,
    scale: 0.68,
    yOffset: -0.56,
  },
  {
    id: 'south-far-arch',
    asset: 'distantArch',
    depthBand: 'far',
    position: [-8, 76],
    rotationY: 2.9967,
    scale: 0.72,
    yOffset: -0.58,
  },
  {
    id: 'southwest-far-belfry',
    asset: 'towerB',
    depthBand: 'far',
    position: [-61, 52],
    rotationY: 2.3267,
    scale: 0.73,
    yOffset: -0.6,
  },
  {
    id: 'west-far-watchtower',
    asset: 'towerA',
    depthBand: 'far',
    position: [-76, 14],
    rotationY: 1.703,
    scale: 0.7,
    yOffset: -0.58,
  },
  {
    id: 'south-far-belfry',
    asset: 'towerB',
    depthBand: 'far',
    position: [30, 75],
    rotationY: -2.7211,
    scale: 0.7,
    yOffset: -0.58,
  },
  {
    id: 'southwest-far-arch',
    asset: 'distantArch',
    depthBand: 'far',
    position: [-70, 35],
    rotationY: 1.9844,
    scale: 0.68,
    yOffset: -0.56,
  },
] as const;

/** Minimum radial separation between combat space and every skyline footprint. */
export const EXPEDITION_SKYLINE_MIN_RADIUS = PLAY_RADIUS + 14;

const keepoutRadius: Readonly<Record<ExpeditionSkylineAsset, number>> = {
  towerA: 4.6,
  towerB: 4.2,
  distantArch: 7.0,
};

/** Prevent random trees and large rocks from intersecting the authored architecture. */
export const inExpeditionSkylineKeepout = (x: number, z: number): boolean =>
  EXPEDITION_SKYLINE_PLACEMENTS.some((placement) => {
    const dx = x - placement.position[0];
    const dz = z - placement.position[1];
    const radius = keepoutRadius[placement.asset] * placement.scale;
    return dx * dx + dz * dz < radius * radius;
  });
