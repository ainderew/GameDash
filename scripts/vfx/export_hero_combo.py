"""Build the four-hit game combo from the approved, retargeted sword mocap.

Run from the repository root with Blender 5.x:

    blender --background assets/blender/sword_swing_vfx.blend \
      --python scripts/vfx/export_hero_combo.py

The earlier combo pass incorrectly extracted only the first light attack's anticipation
and made that non-damaging fragment consume click one.  Every action below is now a complete
attack with its own anticipation, delivery, contact, follow-through, and recovery.  The first
two preserve the polished opposing Mixamo cuts, the third uses the committed finisher body
mechanics, and the fourth replaces the arm delivery with a forward two-bone IK thrust.  All
exports remain clip-only GLBs bound to the exact runtime rig.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "apps" / "web" / "public" / "models" / "hero"
AUTHORING_FILE = ROOT / "assets" / "raw" / "hero-anims" / "hero_sword_combo.blend"
EXCHANGE_FILE = ROOT / "assets" / "raw" / "hero-anims" / "hero_sword_combo.fbx"
FPS = 30
RIG = "GD_Hero_TargetRig"
RIGHT_ARM = "mixamorig:RightArm"
RIGHT_FOREARM = "mixamorig:RightForeArm"
RIGHT_HAND = "mixamorig:RightHand"

# Weapon axes in the Blender pose-bone coordinate system.  These are the calibrated
# axes used by the runtime Tripo sword attachment (see polish_hero_attacks.py).
SWORD_BLADE_AXIS = Vector((0.968718, -0.247852, 0.012600))
SWORD_FLAT_AXIS = Vector((0.248175, 0.967466, -0.049182))


@dataclass(frozen=True)
class ClipSpec:
    action: str
    output: str
    end_frame: int


CLIPS = (
    ClipSpec("Attack_01_HorizontalSlash", "anim-combo-horizontal.glb", 18),
    ClipSpec("Attack_02_ReverseSlash", "anim-combo-reverse.glb", 19),
    ClipSpec("Attack_03_OverheadStrike", "anim-combo-overhead.glb", 22),
    ClipSpec("Attack_04_ForwardThrust", "anim-combo-thrust.glb", 20),
)


def action_curves(action: bpy.types.Action):
    """Yield Blender 4.4+/5.x f-curves from a slotted Action."""
    for layer in action.layers:
        for strip in layer.strips:
            for channel_bag in getattr(strip, "channelbags", ()):
                yield from channel_bag.fcurves


def set_linear(action: bpy.types.Action | None) -> None:
    if not action:
        return
    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
        curve.update()


def set_range(action: bpy.types.Action, end_frame: int) -> None:
    action.use_fake_user = True
    action.use_frame_range = True
    action.frame_start = 0
    action.frame_end = end_frame


def copy_retimed(
    source_name: str,
    output_name: str,
    *,
    source_end: float,
    target_end: int,
) -> bpy.types.Action:
    """Copy the leading source range and linearly retime it to the target duration."""
    action = bpy.data.actions[source_name].copy()
    action.name = output_name
    scale = target_end / source_end
    for curve in action_curves(action):
        for index in reversed(range(len(curve.keyframe_points))):
            key = curve.keyframe_points[index]
            if key.co.x < -1e-4 or key.co.x > source_end + 1e-4:
                curve.keyframe_points.remove(key, fast=True)
        for key in curve.keyframe_points:
            key.co.x *= scale
            key.handle_left.x *= scale
            key.handle_right.x *= scale
        curve.update()
    set_range(action, target_end)
    set_linear(action)
    return action


def remove_bone_rotation(action: bpy.types.Action, bone_names: set[str]) -> None:
    for layer in action.layers:
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", ()):
                for curve in list(bag.fcurves):
                    if not curve.data_path.endswith((".rotation_quaternion", ".rotation_euler")):
                        continue
                    if any(f'pose.bones["{name}"]' in curve.data_path for name in bone_names):
                        bag.fcurves.remove(curve)


def rotation_mapping(
    local_blade: Vector,
    local_side: Vector,
    desired_blade: Vector,
    desired_side: Vector,
) -> Quaternion:
    local_blade = local_blade.normalized()
    local_side = (local_side - local_blade * local_side.dot(local_blade)).normalized()
    local_third = local_side.cross(local_blade).normalized()
    desired_blade = desired_blade.normalized()
    desired_side = (desired_side - desired_blade * desired_side.dot(desired_blade)).normalized()
    desired_third = desired_side.cross(desired_blade).normalized()
    local_basis = Matrix((local_side, local_blade, local_third)).transposed()
    desired_basis = Matrix((desired_side, desired_blade, desired_third)).transposed()
    return (desired_basis @ local_basis.transposed()).to_quaternion()


def author_forward_thrust(
    scene: bpy.types.Scene,
    target: bpy.types.Object,
    action: bpy.types.Action,
) -> None:
    """Replace the second slash's arm arc with a readable, forward sword thrust."""
    target.animation_data.action = action
    remove_bone_rotation(action, {RIGHT_ARM, RIGHT_FOREARM, RIGHT_HAND})
    scene.frame_set(0)
    bpy.context.view_layer.update()

    arm = target.pose.bones[RIGHT_ARM]
    forearm = target.pose.bones[RIGHT_FOREARM]
    hand = target.pose.bones[RIGHT_HAND]
    start_hand = (target.matrix_world @ hand.matrix).translation.copy()
    elbow = target.matrix_world @ forearm.head

    wrist_target = bpy.data.objects.new("GD_Combo_ThrustWrist", None)
    pole_target = bpy.data.objects.new("GD_Combo_ThrustPole", None)
    rotation_target = bpy.data.objects.new("GD_Combo_ThrustRotation", None)
    for helper in (wrist_target, pole_target, rotation_target):
        scene.collection.objects.link(helper)
    wrist_target.empty_display_type = "SPHERE"
    wrist_target.empty_display_size = 0.025
    pole_target.empty_display_type = "CUBE"
    pole_target.empty_display_size = 0.025
    rotation_target.rotation_mode = "QUATERNION"

    # Negative Y is gameplay-forward.  Pull the hilt beside the chest, then drive it
    # more than half a character-width forward before recovering to the opening guard.
    keyed_positions = (
        (0, start_hand),
        (2, start_hand),
        (5, Vector((-0.22, 0.10, 0.49))),
        (7, Vector((-0.18, 0.02, 0.52))),
        (10, Vector((-0.07, -0.43, 0.55))),
        (12, Vector((-0.08, -0.38, 0.54))),
        (15, Vector((-0.16, -0.08, 0.48))),
        (18, start_hand),
        (20, start_hand),
    )
    for frame, position in keyed_positions:
        wrist_target.location = position
        wrist_target.keyframe_insert(data_path="location", frame=frame)

    # Keep the elbow outside the torso and away from the IK chain's singularity.
    pole_target.location = elbow + Vector((-0.42, -0.04, 0.10))
    thrust_rotation = rotation_mapping(
        SWORD_BLADE_AXIS,
        SWORD_FLAT_AXIS,
        Vector((0.0, -1.0, 0.0)),
        Vector((0.0, 0.0, 1.0)),
    )
    for frame in (0, 2, 5, 7, 10, 12, 15, 18, 20):
        rotation_target.rotation_quaternion = thrust_rotation
        rotation_target.keyframe_insert(data_path="rotation_quaternion", frame=frame)

    ik = forearm.constraints.new("IK")
    ik.name = "GD_Combo_ForwardThrustIK"
    ik.target = wrist_target
    ik.pole_target = pole_target
    ik.chain_count = 2
    ik.use_rotation = False
    copy_rotation = hand.constraints.new("COPY_ROTATION")
    copy_rotation.name = "GD_Combo_ForwardThrustRotation"
    copy_rotation.target = rotation_target
    copy_rotation.target_space = "WORLD"
    copy_rotation.owner_space = "WORLD"
    copy_rotation.mix_mode = "REPLACE"

    # Ease the procedural delivery into and out of the mocap shoulders/body.
    for frame, influence in ((0, 0.0), (2, 1.0), (14, 1.0), (18, 0.0), (20, 0.0)):
        ik.influence = influence
        ik.keyframe_insert(data_path="influence", frame=frame)
        copy_rotation.influence = influence
        copy_rotation.keyframe_insert(data_path="influence", frame=frame)
    set_linear(wrist_target.animation_data.action)
    set_linear(rotation_target.animation_data.action)

    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.nla.bake(
        frame_start=0,
        frame_end=20,
        step=1,
        only_selected=False,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=True,
        clean_curves=False,
        bake_types={"POSE"},
        channel_types={"ROTATION"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")

    for helper in (wrist_target, pole_target, rotation_target):
        helper_action = helper.animation_data.action if helper.animation_data else None
        bpy.data.objects.remove(helper, do_unlink=True)
        if helper_action and helper_action.users == 0:
            bpy.data.actions.remove(helper_action)
    set_range(action, 20)
    set_linear(action)


def author_overhead_strike(
    scene: bpy.types.Scene,
    target: bpy.types.Object,
    action: bpy.types.Action,
) -> None:
    """Replace the horizontal arm arc with a grounded, readable overhead delivery."""
    target.animation_data.action = action
    remove_bone_rotation(action, {RIGHT_ARM, RIGHT_FOREARM, RIGHT_HAND})
    scene.frame_set(0)
    bpy.context.view_layer.update()

    forearm = target.pose.bones[RIGHT_FOREARM]
    hand = target.pose.bones[RIGHT_HAND]
    start_hand = (target.matrix_world @ hand.matrix).translation.copy()
    elbow = target.matrix_world @ forearm.head

    wrist_target = bpy.data.objects.new("GD_Combo_OverheadWrist", None)
    pole_target = bpy.data.objects.new("GD_Combo_OverheadPole", None)
    rotation_target = bpy.data.objects.new("GD_Combo_OverheadRotation", None)
    for helper in (wrist_target, pole_target, rotation_target):
        scene.collection.objects.link(helper)
    rotation_target.rotation_mode = "QUATERNION"

    # Keep both feet on the grounded light-attack body mechanics. The hilt rises behind
    # the head, snaps through the vertical contact plane, and finishes below the waist.
    keyed_positions = (
        (0, start_hand),
        (2, start_hand),
        (5, Vector((-0.17, 0.03, 0.73))),
        (8, Vector((-0.07, 0.02, 0.90))),
        (10, Vector((-0.08, -0.25, 0.58))),
        (12, Vector((-0.10, -0.38, 0.34))),
        (15, Vector((-0.12, -0.27, 0.24))),
        (19, Vector((-0.17, -0.08, 0.47))),
        (22, start_hand),
    )
    for frame, position in keyed_positions:
        wrist_target.location = position
        wrist_target.keyframe_insert(data_path="location", frame=frame)

    pole_target.location = elbow + Vector((-0.44, -0.05, 0.04))
    keyed_directions = (
        (0, Vector((0.0, 0.25, 0.97))),
        (2, Vector((0.0, 0.25, 0.97))),
        (5, Vector((0.0, 0.30, 0.95))),
        (8, Vector((0.0, 0.08, 1.0))),
        (10, Vector((0.0, -0.30, -0.95))),
        (12, Vector((0.0, -0.35, -0.94))),
        (15, Vector((0.0, -0.42, -0.91))),
        (19, Vector((-0.20, -0.45, 0.87))),
        (22, Vector((-0.45, -0.36, 0.82))),
    )
    for frame, blade_direction in keyed_directions:
        rotation_target.rotation_quaternion = rotation_mapping(
            SWORD_BLADE_AXIS,
            SWORD_FLAT_AXIS,
            blade_direction,
            Vector((1.0, 0.0, 0.0)),
        )
        rotation_target.keyframe_insert(data_path="rotation_quaternion", frame=frame)

    ik = forearm.constraints.new("IK")
    ik.name = "GD_Combo_GroundedOverheadIK"
    ik.target = wrist_target
    ik.pole_target = pole_target
    ik.chain_count = 2
    ik.use_rotation = False
    copy_rotation = hand.constraints.new("COPY_ROTATION")
    copy_rotation.name = "GD_Combo_GroundedOverheadRotation"
    copy_rotation.target = rotation_target
    copy_rotation.target_space = "WORLD"
    copy_rotation.owner_space = "WORLD"
    copy_rotation.mix_mode = "REPLACE"

    for frame, influence in ((0, 0.0), (2, 1.0), (16, 1.0), (21, 0.0), (22, 0.0)):
        ik.influence = influence
        ik.keyframe_insert(data_path="influence", frame=frame)
        copy_rotation.influence = influence
        copy_rotation.keyframe_insert(data_path="influence", frame=frame)
    set_linear(wrist_target.animation_data.action)
    set_linear(rotation_target.animation_data.action)

    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.nla.bake(
        frame_start=0,
        frame_end=22,
        step=1,
        only_selected=False,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=True,
        clean_curves=False,
        bake_types={"POSE"},
        channel_types={"ROTATION"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")

    for helper in (wrist_target, pole_target, rotation_target):
        helper_action = helper.animation_data.action if helper.animation_data else None
        bpy.data.objects.remove(helper, do_unlink=True)
        if helper_action and helper_action.users == 0:
            bpy.data.actions.remove(helper_action)
    set_range(action, 22)
    set_linear(action)


def build_actions(scene: bpy.types.Scene, target: bpy.types.Object) -> dict[str, bpy.types.Action]:
    horizontal = copy_retimed(
        "GD_Attack_anim-attack-l1_Polished",
        "Attack_01_HorizontalSlash",
        source_end=18,
        target_end=18,
    )
    reverse = copy_retimed(
        "GD_Attack_anim-attack-l2_Polished",
        "Attack_02_ReverseSlash",
        source_end=19,
        target_end=19,
    )
    overhead = copy_retimed(
        "GD_Attack_anim-attack-l1_Polished",
        "Attack_03_OverheadStrike",
        source_end=18,
        target_end=22,
    )
    author_overhead_strike(scene, target, overhead)
    thrust = copy_retimed(
        "GD_Attack_anim-attack-l2_Polished",
        "Attack_04_ForwardThrust",
        source_end=19,
        target_end=20,
    )
    author_forward_thrust(scene, target, thrust)
    return {action.name: action for action in (horizontal, reverse, overhead, thrust)}


def export_clip(
    scene: bpy.types.Scene,
    target: bpy.types.Object,
    action: bpy.types.Action,
    spec: ClipSpec,
) -> None:
    target.animation_data.action = action
    scene.frame_start = 0
    scene.frame_end = spec.end_frame
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


def export_exchange(target: bpy.types.Object) -> None:
    """Write an editable FBX containing the runtime rig and every authored combo action."""
    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    for child in target.children_recursive:
        if child.type == "MESH":
            child.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.export_scene.fbx(
        filepath=str(EXCHANGE_FILE),
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0,
    )


def main() -> None:
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    target = bpy.data.objects.get(RIG)
    if not target or target.type != "ARMATURE":
        raise RuntimeError("Open assets/blender/sword_swing_vfx.blend before running this exporter")
    target.animation_data_create()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Remove stale actions if the exporter is run repeatedly in the saved authoring file.
    for spec in CLIPS:
        old = bpy.data.actions.get(spec.action)
        if old:
            bpy.data.actions.remove(old)
    actions = build_actions(scene, target)
    for spec in CLIPS:
        export_clip(scene, target, actions[spec.action], spec)
        print(f"Exported {spec.action}: frames 0-{spec.end_frame} -> {spec.output}")
    export_exchange(target)

    target.animation_data.action = actions["Attack_01_HorizontalSlash"]
    scene.frame_start = 0
    scene.frame_end = 18
    scene.frame_set(4)
    scene.timeline_markers.clear()
    scene.timeline_markers.new("Wind-up", frame=0)
    scene.timeline_markers.new("Delivery", frame=4)
    scene.timeline_markers.new("Contact", frame=7)
    scene.timeline_markers.new("Recovery", frame=13)
    bpy.ops.wm.save_as_mainfile(filepath=str(AUTHORING_FILE))


if __name__ == "__main__":
    main()
