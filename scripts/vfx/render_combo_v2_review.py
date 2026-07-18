"""Render the rebuilt combo actions for technical-animation review.

Run after export_hero_combo.py, opening the generated authoring blend:

    blender --background assets/raw/hero-anims/hero_sword_combo.blend \
      --python scripts/vfx/render_combo_v2_review.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from restart_attack_01 import build_review_scene, build_weapon_proxy, set_camera  # noqa: E402


OUTPUT_DIR = ROOT / "assets" / "raw" / "hero-anims" / "review-v2" / "combo"
RIG_NAME = "GD_Hero_TargetRig"


@dataclass(frozen=True)
class ReviewSpec:
    slug: str
    action: str
    end: int
    poses: tuple[int, ...]
    contact: int


REVIEWS = (
    ReviewSpec("attack_02_reverse", "Attack_02_ReverseSlash", 19, (0, 4, 7, 9, 19), 7),
    ReviewSpec("attack_03_overhead", "Attack_03_OverheadStrike", 22, (0, 5, 8, 11, 22), 10),
    ReviewSpec("attack_04_thrust", "Attack_04_ForwardThrust", 20, (0, 5, 10, 12, 20), 10),
)


def render_frame(scene: bpy.types.Scene, path: Path, frame: int) -> None:
    scene.frame_set(frame)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    rig = bpy.data.objects.get(RIG_NAME)
    if not rig or rig.type != "ARMATURE":
        raise RuntimeError(f"Missing {RIG_NAME}; open assets/raw/hero-anims/hero_sword_combo.blend")

    build_weapon_proxy(rig)
    camera, target, height = build_review_scene(rig)
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100

    for spec in REVIEWS:
        action = bpy.data.actions.get(spec.action)
        if not action:
            raise RuntimeError(f"Missing action {spec.action}")
        rig.animation_data.action = action
        scene.frame_start = 0
        scene.frame_end = spec.end

        set_camera(camera, target, height, "front")
        frame_dir = OUTPUT_DIR / f"frames_{spec.slug}"
        frame_dir.mkdir(parents=True, exist_ok=True)
        for output_frame in range(0, spec.end + 7):
            render_frame(
                scene,
                frame_dir / f"frame_{output_frame:03d}.png",
                min(output_frame, spec.end),
            )

        for frame in spec.poses:
            render_frame(scene, OUTPUT_DIR / f"{spec.slug}_pose_{frame:02d}.png", frame)

        set_camera(camera, target, height, "side")
        render_frame(scene, OUTPUT_DIR / f"{spec.slug}_side_contact.png", spec.contact)

        print(f"RENDERED {spec.action} 0-{spec.end} contact={spec.contact}")


if __name__ == "__main__":
    main()
