"""Retarget and rebuild clip-only hero combat GLBs from raw Mixamo FBXs.

The previous pass guessed phase boundaries and accidentally pushed both light contacts into
their recovery tails. These maps are based on the measured world-space Tripo sword-tip path.
Lights and spin keep the raw mocap phase ratios while their total duration is compressed; the
finisher gets a bespoke map that gives its main cut a readable anticipation and a fast delivery.
Runtime phase metadata in packages/sim/src/combat/combo.ts mirrors these exported beats.

Clip exports are deliberately opt-in so revising one move cannot overwrite approved siblings:
  blender --background --factory-startup --python scripts/vfx/polish_hero_attacks.py -- --only spin
Use ``--all`` only when intentionally rebuilding every attack and the authoring .blend.
"""

from __future__ import annotations

import bisect
import argparse
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "assets" / "raw" / "hero-anims"
OUTPUT_DIR = ROOT / "apps" / "web" / "public" / "models" / "hero"
HERO_MODEL = OUTPUT_DIR / "hero.glb"
FPS = 30
DELIVERY_BAKE_SUBSTEPS = 4
HIPS = "mixamorig:Hips"
RIGHT_ARM = "mixamorig:RightArm"
RIGHT_FOREARM = "mixamorig:RightForeArm"
RIGHT_HAND = "mixamorig:RightHand"

# The default Tripo sword's runtime blade/flat axes expressed in the imported Blender pose-bone
# coordinate system. glTF/Three is Y-up while Blender is Z-up, and a Blender PoseBone's matrix
# uses its edit-bone basis rather than the raw glTF node basis. These converted axes were solved
# from the exact weapons.ts attachment and verified after a Blender -> glTF -> Three round-trip.
SWORD_BLADE_AXIS = (0.968718, -0.247852, 0.012600)
SWORD_FLAT_AXIS = (0.248175, 0.967466, -0.049182)


@dataclass(frozen=True)
class CircularArc:
    """A hand-authored delivery whose blade rotates in one stable vertical plane."""

    start_frame: int
    end_frame: int
    start_degrees: float
    end_degrees: float
    wrist_sample_frames: tuple[int, ...]
    settle_recovery: bool = True


@dataclass(frozen=True)
class ClipSpec:
    source: str
    output: str
    target_end: int
    source_beats: tuple[float, ...]
    target_beats: tuple[float, ...]
    circular_arc: CircularArc | None = None


CLIPS = (
    # Raw sword-tip delivery: 30-43% / 24-41% / 26-40%. Uniform time compression keeps
    # those genuine mocap arcs intact instead of sliding contact into the recovery.
    ClipSpec(
        "attack-l1.fbx",
        "anim-attack-l1.glb",
        18,
        (0, 1),
        (0, 1),
        CircularArc(4, 9, 140, -78, (5, 6)),
    ),
    ClipSpec(
        "attack-l2.fbx",
        "anim-attack-l2.glb",
        19,
        (0, 1),
        (0, 1),
        CircularArc(4, 9, 38, 252, (5, 6)),
    ),
    ClipSpec(
        "spin.fbx",
        "anim-spin.glb",
        28,
        (0, 1),
        (0, 1),
        # Keep the mocap body turn, but replace its low/noisy hand delivery with one complete
        # vertical circle. The full 2pi VFX now reads as a standing halo instead of a floor decal.
        CircularArc(6, 13, 100, -260, (6, 7), settle_recovery=False),
    ),
    # Raw main cut is 41-48% with contact at 46%. Preserve the early load-up, compress the
    # blade delivery to ~110ms, then leave enough follow-through to sell the heavy weight.
    ClipSpec(
        "finisher.fbx",
        "anim-finisher.glb",
        30,
        (0, .30, .408, .481, 1),
        (0, .25, .31, .42, 1),
    ),
)


def action_curves(action: bpy.types.Action):
    """Yield Blender 4.4+/5.x curves from a slotted Action."""
    for layer in action.layers:
        for strip in layer.strips:
            for channel_bag in getattr(strip, "channelbags", ()):
                yield from channel_bag.fcurves


def retime(action: bpy.types.Action, spec: ClipSpec) -> None:
    source_start, source_end = map(float, action.frame_range)

    def warp(frame: float) -> float:
        normalized = max(0.0, min(1.0, (frame - source_start) / (source_end - source_start)))
        index = max(0, min(len(spec.source_beats) - 2, bisect.bisect_right(spec.source_beats, normalized) - 1))
        source_span = spec.source_beats[index + 1] - spec.source_beats[index]
        local = (normalized - spec.source_beats[index]) / source_span
        target = spec.target_beats[index] + local * (spec.target_beats[index + 1] - spec.target_beats[index])
        return spec.target_end * target

    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.co.x = warp(float(key.co.x))
            key.handle_left.x = warp(float(key.handle_left.x))
            key.handle_right.x = warp(float(key.handle_right.x))
            # Dense mocap keys are intentionally linear during the time warp. Blender then
            # force-samples a clean 30fps result; automatic Bezier handles here introduce
            # overshoot in the wrist and are a major source of sloppy secondary blade arcs.
            key.interpolation = "LINEAR"
        curve.update()


def clear_scene(scene: bpy.types.Scene) -> None:
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def import_target_rig() -> bpy.types.Object:
    """Load the exact rest pose used by the game rather than exporting the FBX rig directly."""
    bpy.ops.import_scene.gltf(filepath=str(HERO_MODEL))
    target = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    target.name = "GD_Hero_TargetRig"
    if target.animation_data:
        target.animation_data_clear()
    return target


def import_source_action(spec: ClipSpec) -> tuple[bpy.types.Object, bpy.types.Action]:
    existing = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(
        filepath=str(SOURCE_DIR / spec.source),
        use_anim=True,
        automatic_bone_orientation=False,
    )
    source = next(
        obj for obj in bpy.context.scene.objects
        if obj not in existing and obj.type == "ARMATURE"
    )
    source.name = "GD_Mixamo_SourceRig"
    action = source.animation_data.action
    action.name = f"GD_Source_{Path(spec.output).stem}_Retimed"
    retime(action, spec)
    return source, action


def matching_bones(source: bpy.types.Object, target: bpy.types.Object):
    """Match Mixamo bones while excluding FBX-only end markers absent from the game rig."""
    for target_pose_bone in target.pose.bones:
        source_pose_bone = source.pose.bones.get(target_pose_bone.name)
        if source_pose_bone:
            yield source_pose_bone, target_pose_bone


def bake_to_game_rig(
    scene: bpy.types.Scene,
    source: bpy.types.Object,
    target: bpy.types.Object,
    spec: ClipSpec,
) -> bpy.types.Action:
    """Visually bake the source world pose onto the game's own rest pose.

    The raw FBX armature is centimetre-scaled and X-rotated, while hero.glb is metre-scaled
    and Z-up. Exporting the FBX action directly therefore produced 30-180 metre hip offsets.
    World-space Copy Transforms constraints let Blender solve every local transform against the
    target hierarchy before NLA's visual bake records it. This also preserves the smooth source
    wrist path; manually keying only rotations caused large frame-to-frame sword jumps because
    the two bind poses have slightly different joint offsets.
    """
    action = bpy.data.actions.new(f"GD_Attack_{Path(spec.output).stem}_Polished")
    action.use_fake_user = True
    target.animation_data_create()
    target.animation_data.action = action

    pairs = list(matching_bones(source, target))
    for source_bone, target_bone in pairs:
        # Quaternion baking avoids the +/-180-degree Euler wraps that made the previous export
        # violently shake between otherwise-correct 30fps poses.
        target_bone.rotation_mode = "QUATERNION"
        if target_bone.name == HIPS:
            location = target_bone.constraints.new("COPY_LOCATION")
            location.name = "GD_Retarget_WorldLocation"
            location.target = source
            location.subtarget = source_bone.name
            location.target_space = "WORLD"
            location.owner_space = "WORLD"

        rotation = target_bone.constraints.new("COPY_ROTATION")
        rotation.name = "GD_Retarget_WorldRotation"
        rotation.target = source
        rotation.subtarget = source_bone.name
        rotation.target_space = "WORLD"
        rotation.owner_space = "WORLD"
        rotation.mix_mode = "REPLACE"

    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(
        frame_start=0,
        frame_end=spec.target_end,
        step=1,
        only_selected=True,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=True,
        clean_curves=False,
        bake_types={"POSE"},
        channel_types={"LOCATION", "ROTATION"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")

    # A runtime retarget clip needs joint rotations and one root translation—not animated local
    # positions for every joint. NLA visual baking keys selected channels uniformly, so strip the
    # constant/non-root location curves before export to prevent double-transform jitter.
    hips_path = f'pose.bones["{HIPS}"].location'
    for layer in action.layers:
        for strip in layer.strips:
            for channel_bag in getattr(strip, "channelbags", ()):
                for curve in list(channel_bag.fcurves):
                    if curve.data_path.endswith(".location") and curve.data_path != hips_path:
                        channel_bag.fcurves.remove(curve)
                    elif curve.data_path.endswith(".scale"):
                        channel_bag.fcurves.remove(curve)

    # Dense 30fps mocap samples do not benefit from Bezier tangents. Linear keys preserve the
    # measured blade path, avoid interpolation overshoot, and let glTF omit cubic tangent data.
    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
        curve.update()

    return action


def _set_linear_keys(action: bpy.types.Action | None) -> None:
    if not action:
        return
    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
        curve.update()


def _scale_action_frames(action: bpy.types.Action | None, factor: float) -> None:
    if not action:
        return
    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.co.x *= factor
            key.handle_left.x *= factor
            key.handle_right.x *= factor
        curve.update()


def _constraint_weight(frame: float, arc: CircularArc) -> float:
    """Two-frame ease into/out of the authored arm without popping from the mocap."""
    if arc.start_frame <= frame <= arc.end_frame:
        return 1.0
    if frame < arc.start_frame:
        return max(0.0, min(1.0, (frame - (arc.start_frame - 2.0)) / 2.0))
    return max(0.0, min(1.0, ((arc.end_frame + 2.0) - frame) / 2.0))


def _rotation_mapping(local_blade: Vector, local_side: Vector, desired_blade: Vector) -> Matrix:
    """Map the sword's local blade/flat axes onto a radial direction and swing-plane normal."""
    local_blade = local_blade.normalized()
    local_side = (local_side - local_blade * local_side.dot(local_blade)).normalized()
    local_third = local_side.cross(local_blade).normalized()

    # Blender is Z-up and the warrior faces along -Y. Holding the sword's flat axis on +Y makes
    # the blade rotate in the X/Z plane, producing the broad circular silhouette seen in the
    # reference instead of a ground decal or a diagonal ribbon drifting behind the hand.
    desired_side = Vector((0.0, 1.0, 0.0))
    desired_blade = desired_blade.normalized()
    desired_third = desired_side.cross(desired_blade).normalized()

    local_basis = Matrix((local_side, local_blade, local_third)).transposed()
    desired_basis = Matrix((desired_side, desired_blade, desired_third)).transposed()
    return desired_basis @ local_basis.transposed()


def author_circular_delivery(
    scene: bpy.types.Scene,
    target: bpy.types.Object,
    action: bpy.types.Action,
    spec: ClipSpec,
) -> None:
    """Replace the noisy mocap delivery with a shoulder-driven, circular sword cut.

    A two-bone IK constraint holds the wrist in a readable hilt position while a world-space
    rotation target turns the sword through the authored arc. Blender visually bakes the result
    back onto the exact game rig, so the runtime still receives ordinary bone rotations only.
    """
    arc = spec.circular_arc
    if not arc:
        return

    target.animation_data.action = action
    upper_arm = target.pose.bones[RIGHT_ARM]
    forearm = target.pose.bones[RIGHT_FOREARM]
    hand = target.pose.bones[RIGHT_HAND]

    wrist_samples: list[Vector] = []
    for frame in arc.wrist_sample_frames:
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        wrist_samples.append((target.matrix_world @ hand.matrix).translation.copy())
    wrist_center = sum(wrist_samples, Vector()) / len(wrist_samples)

    wrist_target = bpy.data.objects.new(f"GD_{spec.output}_WristTarget", None)
    pole_target = bpy.data.objects.new(f"GD_{spec.output}_ElbowPole", None)
    hand_target = bpy.data.objects.new(f"GD_{spec.output}_HandRotationTarget", None)
    scene.collection.objects.link(wrist_target)
    scene.collection.objects.link(pole_target)
    scene.collection.objects.link(hand_target)
    wrist_target.empty_display_type = "SPHERE"
    wrist_target.empty_display_size = 0.025
    wrist_target.location = wrist_center
    hand_target.rotation_mode = "QUATERNION"

    # Keep the two-bone solve on one side of its singularity. Without a pole, Blender may choose
    # equivalent elbow solutions on adjacent subframes; the integer poses look right but glTF
    # interpolation briefly corkscrews the wrist between them.
    scene.frame_set(arc.wrist_sample_frames[0])
    bpy.context.view_layer.update()
    shoulder_world = target.matrix_world @ upper_arm.head
    elbow_world = target.matrix_world @ forearm.head
    line = wrist_center - shoulder_world
    projected = shoulder_world + line * (
        (elbow_world - shoulder_world).dot(line) / max(line.length_squared, 1e-8)
    )
    pole_direction = elbow_world - projected
    if pole_direction.length_squared < 1e-8:
        pole_direction = Vector((0.0, -1.0, 0.0))
    pole_target.location = elbow_world + pole_direction.normalized() * 0.3
    pole_target.empty_display_type = "CUBE"
    pole_target.empty_display_size = 0.02

    ik = forearm.constraints.new("IK")
    ik.name = "GD_CircularSword_WristIK"
    ik.target = wrist_target
    ik.pole_target = pole_target
    ik.chain_count = 2
    ik.use_rotation = False

    copy_rotation = hand.constraints.new("COPY_ROTATION")
    copy_rotation.name = "GD_CircularSword_HandRotation"
    copy_rotation.target = hand_target
    copy_rotation.target_space = "WORLD"
    copy_rotation.owner_space = "WORLD"
    copy_rotation.mix_mode = "REPLACE"

    local_blade = Vector(SWORD_BLADE_AXIS)
    local_side = Vector(SWORD_FLAT_AXIS)

    previous_target_rotation = None
    for tick in range(0, spec.target_end * DELIVERY_BAKE_SUBSTEPS + 1):
        frame = tick / DELIVERY_BAKE_SUBSTEPS
        influence = _constraint_weight(frame, arc)
        ik.influence = influence
        ik.keyframe_insert(data_path="influence", frame=frame)
        copy_rotation.influence = influence
        copy_rotation.keyframe_insert(data_path="influence", frame=frame)

        # Continue the authored angular velocity through the half-weight transition frames. This
        # gives the wind-up and follow-through a tangent that naturally enters/exits the circle.
        progress = (frame - arc.start_frame) / (arc.end_frame - arc.start_frame)
        progress = max(-0.2, min(1.2, progress))
        angle = math.radians(
            arc.start_degrees + (arc.end_degrees - arc.start_degrees) * progress
        )
        desired_blade = Vector((math.cos(angle), 0.0, math.sin(angle)))
        rotation = _rotation_mapping(
            local_blade,
            local_side,
            desired_blade,
        ).to_quaternion()
        # q and -q describe the same orientation, but a sign jump can send linear glTF
        # interpolation through a full unwanted turn. Keep every authored sample continuous.
        if previous_target_rotation and rotation.dot(previous_target_rotation) < 0.0:
            rotation.negate()
        previous_target_rotation = rotation.copy()
        hand_target.rotation_quaternion = rotation
        hand_target.keyframe_insert(data_path="rotation_quaternion", frame=frame)

    _set_linear_keys(target.animation_data.action)
    _set_linear_keys(hand_target.animation_data.action)

    # World-space hand targets can produce equivalent local bone quaternions with very different
    # twists as the IK parent changes. Integer-only keys then interpolate through a bad in-between
    # even though both frame endpoints are correct. Temporarily stretch time and visually bake at
    # 120 Hz; scaling the keys back preserves the 30 fps duration with stable subframe rotations.
    _scale_action_frames(action, DELIVERY_BAKE_SUBSTEPS)
    _scale_action_frames(hand_target.animation_data.action, DELIVERY_BAKE_SUBSTEPS)

    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.nla.bake(
        frame_start=0,
        frame_end=spec.target_end * DELIVERY_BAKE_SUBSTEPS,
        step=1,
        # Blender 5.1 no longer exposes writable pose-bone selection through the old Bone API.
        # Baking the complete pose is deterministic; only the sword-arm bones have constraints,
        # while the remaining visual transforms are simply resampled onto their existing keys.
        only_selected=False,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=True,
        clean_curves=False,
        bake_types={"POSE"},
        channel_types={"ROTATION"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    _scale_action_frames(action, 1.0 / DELIVERY_BAKE_SUBSTEPS)

    for helper in (wrist_target, pole_target, hand_target):
        helper_action = helper.animation_data.action if helper.animation_data else None
        bpy.data.objects.remove(helper, do_unlink=True)
        if helper_action and helper_action.users == 0:
            bpy.data.actions.remove(helper_action)

    # Constraint influence curves have no meaning once the visual result has been baked.
    for layer in action.layers:
        for strip in layer.strips:
            for channel_bag in getattr(strip, "channelbags", ()):
                for curve in list(channel_bag.fcurves):
                    if ".constraints[" in curve.data_path:
                        channel_bag.fcurves.remove(curve)
    _set_linear_keys(action)


def settle_to_guard(
    scene: bpy.types.Scene,
    target: bpy.types.Object,
    action: bpy.types.Action,
    spec: ClipSpec,
) -> None:
    """Remove the raw file's second flourish and resolve the authored cut back to guard."""
    arc = spec.circular_arc
    if not arc or not arc.settle_recovery:
        return

    target.animation_data.action = action
    scene.frame_set(arc.end_frame)
    bpy.context.view_layer.update()
    delivery_rotations = {
        bone.name: bone.rotation_quaternion.copy()
        for bone in target.pose.bones
    }
    delivery_hips = target.pose.bones[HIPS].location.copy()

    scene.frame_set(spec.target_end)
    bpy.context.view_layer.update()
    guard_rotations = {
        bone.name: bone.rotation_quaternion.copy()
        for bone in target.pose.bones
    }
    guard_hips = target.pose.bones[HIPS].location.copy()
    settled_frame = min(spec.target_end, arc.end_frame + 5)

    for frame in range(arc.end_frame + 1, spec.target_end + 1):
        linear = min(1.0, (frame - arc.end_frame) / (settled_frame - arc.end_frame))
        progress = linear * linear * (3.0 - 2.0 * linear)
        for bone in target.pose.bones:
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = delivery_rotations[bone.name].copy().slerp(
                guard_rotations[bone.name],
                progress,
            )
            bone.keyframe_insert(data_path="rotation_quaternion", frame=frame)

        hips = target.pose.bones[HIPS]
        hips.location = delivery_hips.copy().lerp(guard_hips, progress)
        hips.keyframe_insert(data_path="location", frame=frame)

    _set_linear_keys(action)


def export_clip(target: bpy.types.Object, spec: ClipSpec) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT_DIR / spec.output),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIVE_ACTIONS",
        export_frame_range=True,
        export_force_sampling=False,
        export_frame_step=1,
        export_optimize_animation_size=True,
        export_anim_slide_to_zero=True,
        export_materials="NONE",
    )


def rebuild(clips: tuple[ClipSpec, ...], *, save_authoring: bool) -> None:
    scene = bpy.data.scenes.get("AttackAnimationPolish") or bpy.data.scenes.new("AttackAnimationPolish")
    bpy.context.window.scene = scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    scene.frame_start = 0
    polished_actions: dict[str, bpy.types.Action] = {}

    for spec in clips:
        clear_scene(scene)
        target = import_target_rig()
        source, _ = import_source_action(spec)
        action = bake_to_game_rig(scene, source, target, spec)
        author_circular_delivery(scene, target, action, spec)
        settle_to_guard(scene, target, action, spec)
        polished_actions[spec.output] = action
        scene.frame_end = spec.target_end

        # The source rig must be gone before glTF export. `use_selection` limits nodes, but the
        # exporter can still serialize active actions from an unselected armature, yielding a
        # second clip that Three.js may bind instead of the corrected game-rig animation.
        bpy.data.objects.remove(source, do_unlink=True)
        export_clip(target, spec)

    if not save_authoring:
        return

    # Make the .blend an immediately useful authoring file, not merely an export by-product:
    # opening it lands on the corrected first normal attack with its important beats marked.
    preview = CLIPS[0]
    target.animation_data.action = polished_actions[preview.output]
    scene.name = "Warrior_Circular_Sword_Attacks"
    scene.frame_start = 0
    scene.frame_end = preview.target_end
    scene.timeline_markers.clear()
    scene.timeline_markers.new("Guard", frame=0)
    scene.timeline_markers.new("Circular delivery starts", frame=preview.circular_arc.start_frame)
    scene.timeline_markers.new("Contact", frame=round(preview.target_end * 0.361))
    scene.timeline_markers.new("Circular delivery ends", frame=preview.circular_arc.end_frame)
    scene.timeline_markers.new("Guard recovered", frame=preview.target_end)
    scene.frame_set(preview.circular_arc.start_frame)

    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "assets" / "blender" / "sword_swing_vfx.blend"))


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--only",
        action="append",
        choices=("light1", "light2", "spin", "finisher"),
        help="Rebuild only this clip; repeat to select multiple clips. Does not overwrite the .blend.",
    )
    selection.add_argument(
        "--all",
        action="store_true",
        help="Intentionally rebuild all four clips and the authoring .blend.",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    clip_by_key = {
        "light1": CLIPS[0],
        "light2": CLIPS[1],
        "spin": CLIPS[2],
        "finisher": CLIPS[3],
    }
    selected = CLIPS if args.all else tuple(clip_by_key[key] for key in args.only)
    rebuild(selected, save_authoring=args.all)
