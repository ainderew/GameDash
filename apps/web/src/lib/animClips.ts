import type { AnimationClip, Object3D } from 'three';

/**
 * Shared prep for Mixamo clip-only GLBs (hero + monsters). Clips bind to a rig by
 * bone name at runtime; these helpers make any Mixamo export drop-in safe.
 */

/** Names of every node in a rig — used to drop clip tracks that can't bind. */
export const collectNodeNames = (root: Object3D): Set<string> => {
  const names = new Set<string>();
  root.traverse((o) => names.add(o.name));
  return names;
};

/**
 * Make a clip in-place: Mixamo clips exported without "In Place" carry the world
 * travel on the Hips position track, but the ECS moves the entity — stacked, the mesh
 * drifts ahead and snaps back on every loop. Pin the horizontal channels to their
 * first keyframe (Y keeps the bob/landing weight). Mutates the clip.
 */
export const stripRootMotion = (clip: AnimationClip): void => {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/.test(track.name)) continue;
    const v = track.values; // xyz keyframe triples
    const x0 = v[0]!;
    const z0 = v[2]!;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
};

/**
 * Clone a cached loader clip and make it safe for `rig`: rename to `name`, drop
 * tracks targeting bones the rig doesn't have (e.g. finger tracks from a
 * hand-rigged export — dead bindings spam PropertyBinding warnings), and strip
 * horizontal root motion.
 */
export const prepareClip = (
  clip: AnimationClip,
  name: string,
  rigBones: Set<string>,
): AnimationClip => {
  const c = clip.clone();
  c.name = name;
  c.tracks = c.tracks.filter((t) => rigBones.has(t.name.split('.')[0] ?? ''));
  stripRootMotion(c);
  return c;
};
