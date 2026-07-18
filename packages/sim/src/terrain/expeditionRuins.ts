/** Shared placement data for the authored ruins in the expedition combat clearing. */

export type ExpeditionRuinAsset =
  | 'wallTallA'
  | 'wallLowB'
  | 'archBroken'
  | 'columnIntact'
  | 'columnBroken'
  | 'rubbleLarge'
  | 'rubbleSmall'
  | 'foundationSlab';

export interface ExpeditionRuinPlacement {
  id: string;
  asset: ExpeditionRuinAsset;
  position: readonly [number, number];
  rotationY: number;
  scale?: number;
  /** Buries low foundations/rubble into the terrain or lifts architecture onto them. */
  yOffset?: number;
}

/**
 * Frames the negative-Z side seen ahead of the expedition spawn. The central combat lane
 * stays open. Wall modules overlap by 0.35-0.6m and rubble hides their joins, while the
 * broken arch sits off-axis and remains non-interactive scenery.
 */
export const EXPEDITION_RUIN_PLACEMENTS: readonly ExpeditionRuinPlacement[] = [
  { id: 'west-wall-tall', asset: 'wallTallA', position: [-18.8, -14.7], rotationY: 0.32 },
  { id: 'west-wall-low', asset: 'wallLowB', position: [-15.45, -15.75], rotationY: 0.32 },
  {
    id: 'west-wall-seam-rubble',
    asset: 'rubbleSmall',
    position: [-17, -15.22],
    rotationY: -0.42,
    yOffset: -0.04,
  },
  {
    id: 'west-arch-foundation',
    asset: 'foundationSlab',
    position: [-8.25, -18.15],
    rotationY: 0.38,
    yOffset: -0.28,
  },
  {
    id: 'west-architectural-arch',
    asset: 'archBroken',
    position: [-8.25, -18.15],
    rotationY: 0.38,
    yOffset: 0.1,
  },
  {
    id: 'west-column-intact',
    asset: 'columnIntact',
    position: [-11.5, -19.15],
    rotationY: -0.08,
    scale: 0.96,
    yOffset: -0.03,
  },
  {
    id: 'west-column-broken',
    asset: 'columnBroken',
    position: [-5.15, -18.6],
    rotationY: 0.24,
    yOffset: -0.05,
  },
  {
    id: 'west-sanctuary-rubble',
    asset: 'rubbleSmall',
    position: [-6.05, -17.4],
    rotationY: 0.7,
    scale: 0.92,
    yOffset: -0.06,
  },
  {
    id: 'west-rubble-landmark',
    asset: 'rubbleLarge',
    position: [-6.8, -12.8],
    rotationY: 1.9,
    scale: 0.78,
    yOffset: -0.08,
  },
  { id: 'east-wall-low', asset: 'wallLowB', position: [18.1, -15.5], rotationY: -0.3 },
  {
    id: 'east-wall-tall',
    asset: 'wallTallA',
    position: [21.57, -16.57],
    rotationY: Math.PI - 0.3,
  },
  {
    id: 'east-wall-seam-rubble',
    asset: 'rubbleSmall',
    position: [19.73, -16.02],
    rotationY: 0.48,
    scale: 1.04,
    yOffset: -0.05,
  },
  {
    id: 'east-rubble-landmark',
    asset: 'rubbleLarge',
    position: [7.35, -14.6],
    rotationY: -0.34,
    scale: 0.96,
    yOffset: -0.08,
  },
  {
    id: 'east-column-foundation',
    asset: 'foundationSlab',
    position: [12.5, -19.2],
    rotationY: -0.12,
    yOffset: -0.3,
  },
  {
    id: 'east-column-intact',
    asset: 'columnIntact',
    position: [12, -19.25],
    rotationY: 0.14,
    scale: 0.9,
    yOffset: 0.08,
  },
  {
    id: 'east-column-broken',
    asset: 'columnBroken',
    position: [14.85, -18.65],
    rotationY: -0.36,
    scale: 0.94,
    yOffset: -0.02,
  },
  {
    id: 'east-column-rubble',
    asset: 'rubbleSmall',
    position: [13.7, -18.05],
    rotationY: -0.64,
    scale: 0.88,
    yOffset: -0.06,
  },
] as const;

export type ExpeditionRuinCollider =
  | { shape: 'circle'; id: string; position: readonly [number, number]; radius: number }
  | {
      shape: 'box';
      id: string;
      position: readonly [number, number];
      halfExtents: readonly [number, number];
      rotationY: number;
    };

const rotatedPoint = (
  center: readonly [number, number],
  localX: number,
  localZ: number,
  rotationY: number,
): readonly [number, number] => [
  center[0] + localX * Math.cos(rotationY) + localZ * Math.sin(rotationY),
  center[1] - localX * Math.sin(rotationY) + localZ * Math.cos(rotationY),
];

const ARCH_POSITION = [-8.25, -18.15] as const;
const ARCH_ROTATION = 0.38;

/** Simplified authoritative collision for the dominant structural masses. */
export const EXPEDITION_RUIN_COLLIDERS: readonly ExpeditionRuinCollider[] = [
  {
    shape: 'box',
    id: 'west-wall-run',
    position: [-17.12, -15.22],
    halfExtents: [3.9, 0.72],
    rotationY: 0.32,
  },
  {
    shape: 'box',
    id: 'east-wall-run',
    position: [19.84, -16.03],
    halfExtents: [3.95, 0.72],
    rotationY: -0.3,
  },
  {
    shape: 'box',
    id: 'west-arch-left-pier',
    position: rotatedPoint(ARCH_POSITION, -1.32, 0, ARCH_ROTATION),
    halfExtents: [0.58, 0.9],
    rotationY: ARCH_ROTATION,
  },
  {
    shape: 'box',
    id: 'west-arch-right-pier',
    position: rotatedPoint(ARCH_POSITION, 1.32, 0, ARCH_ROTATION),
    halfExtents: [0.58, 0.9],
    rotationY: ARCH_ROTATION,
  },
  { shape: 'circle', id: 'west-column-intact', position: [-11.5, -19.15], radius: 0.82 },
  { shape: 'circle', id: 'west-column-broken', position: [-5.15, -18.6], radius: 0.9 },
  { shape: 'circle', id: 'west-rubble-landmark', position: [-6.8, -12.8], radius: 1.34 },
  { shape: 'circle', id: 'east-rubble-landmark', position: [7.35, -14.6], radius: 1.62 },
  { shape: 'circle', id: 'east-column-intact', position: [12, -19.25], radius: 0.78 },
  { shape: 'circle', id: 'east-column-broken', position: [14.85, -18.65], radius: 0.86 },
] as const;

/** Clears large random rocks/trees out of the authored ruin clusters. */
export const EXPEDITION_RUIN_KEEPOUTS: readonly (readonly [number, number, number])[] = [
  [-17.12, -15.22, 4.4],
  [-8.25, -18.15, 4.9],
  [-6.8, -12.8, 2.4],
  [19.84, -16.03, 4.45],
  [7.35, -14.6, 2.75],
  [12.75, -18.95, 4.35],
] as const;

export const inExpeditionRuinKeepout = (x: number, z: number): boolean =>
  EXPEDITION_RUIN_KEEPOUTS.some(
    ([cx, cz, radius]) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < radius * radius,
  );
