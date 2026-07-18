"""Create an isolated V2 review of the first one-handed horizontal sword attack.

This intentionally does not overwrite the runtime combo.  The broken first click was made by
extracting only the anticipation of the approved light attack.  This review restores the whole
motion (guard, anticipation, delivery, contact, follow-through, recovery), adds an in-hand sword
proxy, renders animation reviews, and exports one clip-only GLB for validation.

Run from the repository root:

    blender --background assets/blender/sword_swing_vfx.blend \
      --python scripts/vfx/restart_attack_01.py
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[2]
REVIEW_DIR = ROOT / "assets" / "raw" / "hero-anims" / "review-v2"
AUTHORING_FILE = REVIEW_DIR / "attack_01_horizontal_v2_review.blend"
REVIEW_GLB = REVIEW_DIR / "anim-attack-01-horizontal-v2.glb"
SOURCE_ACTION = "GD_Attack_anim-attack-l1_Polished"
ACTION_NAME = "Attack_01_HorizontalSlash_V2"
RIG_NAME = "GD_Hero_TargetRig"
HAND_BONE = "mixamorig:RightHand"
FPS = 30
END_FRAME = 18
POSE_FRAMES = (0, 4, 7, 9, 18)
SWORD_BLADE_AXIS = Vector((0.968718, -0.247852, 0.012600))
SWORD_FLAT_AXIS = Vector((0.248175, 0.967466, -0.049182))


def material(name: str, color: tuple[float, float, float, float], metallic=0.0, roughness=0.5):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = color
        principled.inputs["Metallic"].default_value = metallic
        principled.inputs["Roughness"].default_value = roughness
    return mat


def add_cube(name: str, size: tuple[float, float, float], location: tuple[float, float, float], mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def build_weapon_proxy(rig: bpy.types.Object) -> bpy.types.Object:
    """Display a sword on the calibrated runtime blade axes of the animated hand bone."""
    holder = bpy.data.objects.new("GD_Review_SwordGrip", None)
    bpy.context.scene.collection.objects.link(holder)
    copy_hand = holder.constraints.new("COPY_TRANSFORMS")
    copy_hand.target = rig
    copy_hand.subtarget = HAND_BONE
    copy_hand.target_space = "WORLD"
    copy_hand.owner_space = "WORLD"

    # The calibrated axes are expressed in pose-bone coordinates.  Rotate a child frame so
    # its procedural +Y blade and +X flat axes reproduce the sword used by Three at runtime.
    sword_frame = bpy.data.objects.new("GD_Review_SwordFrame", None)
    bpy.context.scene.collection.objects.link(sword_frame)
    sword_frame.parent = holder
    blade_axis = SWORD_BLADE_AXIS.normalized()
    flat_axis = (SWORD_FLAT_AXIS - blade_axis * SWORD_FLAT_AXIS.dot(blade_axis)).normalized()
    third_axis = flat_axis.cross(blade_axis).normalized()
    sword_frame.rotation_mode = "QUATERNION"
    sword_frame.rotation_quaternion = Matrix((flat_axis, blade_axis, third_axis)).transposed().to_quaternion()

    steel = material("GD_Review_Steel", (0.12, 0.45, 0.72, 1.0), metallic=0.85, roughness=0.2)
    grip_mat = material("GD_Review_Grip", (0.035, 0.02, 0.015, 1.0), metallic=0.05, roughness=0.7)
    guard_mat = material("GD_Review_Guard", (0.34, 0.19, 0.05, 1.0), metallic=0.65, roughness=0.28)

    # Local +Y matches the runtime weapon socket convention in weapons.ts.
    blade = add_cube("GD_Review_Blade", (0.045, 0.75, 0.014), (0, 0.545, 0), steel)
    blade.parent = sword_frame
    guard = add_cube("GD_Review_Guard", (0.18, 0.035, 0.045), (0, 0.14, 0), guard_mat)
    guard.parent = sword_frame
    grip = add_cube("GD_Review_GripMesh", (0.035, 0.22, 0.035), (0, 0.03, 0), grip_mat)
    grip.parent = sword_frame
    return holder


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def look_at(camera: bpy.types.Object, point: Vector) -> None:
    camera.rotation_euler = (point - camera.location).to_track_quat("-Z", "Y").to_euler()


def build_review_scene(rig: bpy.types.Object) -> tuple[bpy.types.Object, Vector, float]:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    scene.frame_start = 0
    scene.frame_end = END_FRAME
    scene.display.shading.light = "STUDIO"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("GD_Review_World")
    scene.world.color = (0.025, 0.03, 0.045)
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.018, 0.025, 0.045, 1.0)
        background.inputs["Strength"].default_value = 0.35

    # Remove the old VFX sphere from the animation-review silhouette.
    old_vfx = bpy.data.objects.get("Icosphere")
    if old_vfx:
        old_vfx.hide_render = True
        old_vfx.hide_viewport = True

    meshes = [obj for obj in rig.children_recursive if obj.type == "MESH"]
    scene.frame_set(0)
    bpy.context.view_layer.update()
    lo, hi = world_bounds(meshes)
    center = (lo + hi) * 0.5
    height = hi.z - lo.z

    ground_mat = material("GD_Review_Ground", (0.035, 0.045, 0.065, 1.0), roughness=0.92)
    bpy.ops.mesh.primitive_plane_add(size=7.0, location=(center.x, center.y, lo.z - 0.008))
    ground = bpy.context.object
    ground.name = "GD_Review_Ground"
    ground.data.materials.append(ground_mat)

    bpy.ops.object.light_add(type="AREA", location=(2.0, -2.4, lo.z + 2.5 * height))
    key = bpy.context.object
    key.name = "GD_Review_Key"
    key.data.energy = 650
    key.data.shape = "DISK"
    key.data.size = 2.4
    look_at(key, center)

    bpy.ops.object.light_add(type="AREA", location=(-2.0, 1.0, lo.z + 1.5 * height))
    rim = bpy.context.object
    rim.name = "GD_Review_Rim"
    rim.data.energy = 450
    rim.data.color = (0.15, 0.45, 1.0)
    rim.data.size = 1.8
    look_at(rim, center)

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "GD_Review_Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(1.28 * height, 1.15)
    scene.camera = camera
    return camera, Vector((center.x, center.y, lo.z + height * 0.52)), height


def set_camera(camera: bpy.types.Object, target: Vector, height: float, view: str) -> None:
    distance = max(3.0 * height, 2.5)
    if view == "front":
        # Gameplay-forward is -Y.  A small X offset exposes torso twist and footwork.
        camera.location = target + Vector((0.55 * height, -distance, 0.18 * height))
    elif view == "side":
        camera.location = target + Vector((distance, 0.0, 0.12 * height))
    else:
        raise ValueError(view)
    look_at(camera, target)


def render_reviews(scene: bpy.types.Scene, camera: bpy.types.Object, target: Vector, height: float) -> None:
    scene.frame_start = 0
    scene.frame_end = END_FRAME + 6  # brief recovery hold makes the one-click move readable
    scene.render.fps = FPS
    scene.render.image_settings.file_format = "PNG"
    for view in ("front", "side"):
        set_camera(camera, target, height, view)
        frame_dir = REVIEW_DIR / f"frames_{view}"
        frame_dir.mkdir(parents=True, exist_ok=True)
        for output_frame in range(scene.frame_start, scene.frame_end + 1):
            # Hold the recovered pose for the final six review frames.
            scene.frame_set(min(output_frame, END_FRAME))
            scene.render.filepath = str(frame_dir / f"frame_{output_frame:03d}.png")
            bpy.ops.render.render(write_still=True)

    set_camera(camera, target, height, "front")
    for frame in POSE_FRAMES:
        scene.frame_set(frame)
        scene.render.filepath = str(REVIEW_DIR / f"pose_{frame:02d}.png")
        bpy.ops.render.render(write_still=True)


def export_review_glb(scene: bpy.types.Scene, rig: bpy.types.Object, action: bpy.types.Action) -> None:
    rig.animation_data.action = action
    scene.frame_start = 0
    scene.frame_end = END_FRAME
    scene.render.fps = FPS
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=str(REVIEW_GLB),
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


def main() -> None:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    rig = bpy.data.objects.get(RIG_NAME)
    if not rig or rig.type != "ARMATURE":
        raise RuntimeError(f"Open assets/blender/sword_swing_vfx.blend; missing {RIG_NAME}")
    source = bpy.data.actions.get(SOURCE_ACTION)
    if not source:
        raise RuntimeError(f"Missing approved source action: {SOURCE_ACTION}")

    stale = bpy.data.actions.get(ACTION_NAME)
    if stale:
        bpy.data.actions.remove(stale)
    action = source.copy()
    action.name = ACTION_NAME
    action.use_fake_user = True
    action.use_frame_range = True
    action.frame_start = 0
    action.frame_end = END_FRAME
    rig.animation_data_create()
    rig.animation_data.action = action

    scene.timeline_markers.clear()
    for name, frame in (
        ("Guard", 0),
        ("Anticipation", 4),
        ("Contact", 7),
        ("Follow-through", 9),
        ("Recovered", 18),
    ):
        scene.timeline_markers.new(name, frame=frame)

    build_weapon_proxy(rig)
    camera, target, height = build_review_scene(rig)
    render_reviews(scene, camera, target, height)
    export_review_glb(scene, rig, action)
    rig.animation_data.action = action
    scene.frame_start = 0
    scene.frame_end = END_FRAME
    scene.frame_set(4)
    bpy.ops.wm.save_as_mainfile(filepath=str(AUTHORING_FILE))

    print(f"REVIEW_BLEND={AUTHORING_FILE}")
    print(f"REVIEW_GLB={REVIEW_GLB}")
    print(f"ACTION={action.name} RANGE={tuple(action.frame_range)} FPS={FPS}")


if __name__ == "__main__":
    main()
