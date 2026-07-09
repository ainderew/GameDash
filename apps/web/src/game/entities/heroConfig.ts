/**
 * Live hero placement knobs. The Mixamo→FBX2glTF character carries an odd transform (the
 * `eInheritRrSs` quirk + separate mesh/skeleton roots), so the auto-normalization can land
 * the character floating / mis-scaled / facing the wrong way. Rather than guess blind, these
 * are exposed in the leva "Hero" panel and applied to the avatar group each frame — dial the
 * character into place while playing, then bake the values here.
 */
export const heroTransform = {
  /** Absolute yaw of the avatar model, radians (this export rest-faces +Z; flip ±π if backwards). */
  yaw: 0,
  /** Added to the auto-computed vertical offset, world units (raise/lower to plant the feet).
   * -0.80: the chart_2 clip set animates the hips higher than this rig's rest pose
   * (clips were authored on a different character), which floated the feet — value
   * measured from the skinned mesh's world bounds at spawn (see __scene dev handle). */
  yOffsetAdd: -0.8,
  /** Multiplier on the auto-computed scale (fix over/undersizing from the export quirk). */
  scaleMul: 1,
};
