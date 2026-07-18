/**
 * Default world sizes for placed assets. The source GLBs use wildly different
 * native units, so the game never renders them raw — SocialHub/Trees/etc.
 * normalize each model to a target size via its bounding box. These targets
 * mirror the game's numbers so a prop placed in the editor matches its in-game
 * counterpart. Unlisted assets place at scale 1.
 */
export interface SizeTarget {
  /** Normalize by bbox height (Y). */
  height?: number;
  /** Normalize by bbox width (X). */
  width?: number;
  /** Normalize by the longest horizontal axis — benches/tables whose long axis varies. */
  span?: number;
}

const TREE_HEIGHT = 8; // Trees.tsx BASE_HEIGHT
const packTrees = Object.fromEntries(
  [
    'CommonTree_1',
    'CommonTree_2',
    'CommonTree_3',
    'CommonTree_4',
    'CommonTree_5',
    'Pine_1',
    'Pine_3',
    'Pine_5',
    'DeadTree_2',
    'TwistedTree_1',
    'TwistedTree_2',
  ].map((n) => [`/models/nature/${n}.gltf`, { height: TREE_HEIGHT }]),
);

export const DEFAULT_TARGETS: Record<string, SizeTarget> = {
  // Hub props — targets from SocialHub.tsx HubModel usage.
  '/models/hub/bench.glb': { span: 2.15 },
  '/models/hub/banner.glb': { height: 3.35 },
  '/models/hub/rest_house.glb': { width: 9.4 },
  '/models/hub/summoning-shrine.glb': { height: 3.65 },
  '/models/hub/expedition-gate.glb': { height: 5.65 },
  '/models/hub/lamp_1.glb': { height: 2.4 },
  '/models/hub/lamp_2.glb': { height: 2.9 },
  '/models/hub/campfire.glb': { width: 1.7 },
  '/models/hub/lantern-straight.glb': { height: 2.65 }, // ExpeditionLanterns 'post'
  // Trees — pack trees normalize to BASE_HEIGHT, the ancient landmarks to ~12m.
  ...packTrees,
  '/models/nature/dead_tree.glb': { height: 12 },
  '/models/nature/dead_tree_2.glb': { height: 12 },
};

/** Uniform scale that brings a model (with the given raw bbox size) to its target. */
export const defaultScaleFor = (
  asset: string,
  size: { x: number; y: number; z: number },
): number => {
  const target = DEFAULT_TARGETS[asset];
  if (!target) return 1;
  if (target.span !== undefined) return target.span / Math.max(size.x, size.z, 0.001);
  if (target.width !== undefined) return target.width / Math.max(size.x, 0.001);
  return (target.height ?? 1) / Math.max(size.y, 0.001);
};
