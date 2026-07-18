"""Rebuild the GameDash crystal kit as low-poly, art-directed faceted clusters.

Run inside Blender. The script writes the three editable .blend sources, optimized runtime
GLBs, unoptimized archival GLBs, and preview renders. Geometry stays deterministic.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(r"C:\Users\Andrew\Desktop\projects\GameDash")
BLEND_DIR = ROOT / "assets" / "blender"
RUNTIME_DIR = ROOT / "apps" / "web" / "public" / "models" / "crystals"
RAW_DIR = ROOT / "assets" / "raw" / "crystals"
PREVIEW_DIR = ROOT / "assets" / "preview"

for directory in (BLEND_DIR, RUNTIME_DIR, RAW_DIR, PREVIEW_DIR):
    directory.mkdir(parents=True, exist_ok=True)


PALETTE = (
    (0.34, 0.015, 0.72, 1.0),  # violet root
    (0.48, 0.10, 0.94, 1.0),   # saturated lower body
    (0.30, 0.66, 1.00, 1.0),   # cyan upper body
    (0.82, 1.00, 1.00, 1.0),   # icy tip
)


def lerp_color(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))


def crystal_color(height_t: float, facet_t: float):
    if height_t < 0.34:
        color = lerp_color(PALETTE[0], PALETTE[1], height_t / 0.34)
    elif height_t < 0.76:
        color = lerp_color(PALETTE[1], PALETTE[2], (height_t - 0.34) / 0.42)
    else:
        color = lerp_color(PALETTE[2], PALETTE[3], (height_t - 0.76) / 0.24)
    lift = (facet_t - 0.5) * 0.13
    return tuple(max(0.0, min(1.0, c + lift)) for c in color[:3]) + (1.0,)


def append_shard(
    vertices,
    faces,
    colors,
    *,
    location,
    height,
    radius,
    lean=(0.0, 0.0),
    rotation=0.0,
    sides=6,
    shoulder=0.72,
    tip_offset=(0.0, 0.0),
    seed=1,
    squash=(1.0, 0.84),
):
    """Append a broad prism with a faceted crown and controlled asymmetry."""
    rng = random.Random(seed)
    phase = rotation + rng.uniform(-0.055, 0.055)
    radial = [rng.uniform(0.91, 1.09) for _ in range(sides)]
    rings = (
        (0.00, 0.72),
        (0.13, 0.98),
        (shoulder, 1.00),
        (min(0.93, shoulder + 0.15), 0.52),
    )
    ring_indices = []

    for ring_i, (height_t, radius_t) in enumerate(rings):
        ring = []
        center_x = location[0] + lean[0] * height_t
        center_y = location[1] + lean[1] * height_t
        z = location[2] + height * height_t
        ring_twist = (ring_i / (len(rings) - 1)) * rng.uniform(-0.035, 0.035)
        for side in range(sides):
            angle = phase + ring_twist + math.tau * side / sides
            x = center_x + math.cos(angle) * radius * radius_t * radial[side] * squash[0]
            y = center_y + math.sin(angle) * radius * radius_t * radial[side] * squash[1]
            ring.append(len(vertices))
            vertices.append((x, y, z))
            colors.append(crystal_color(height_t, side / max(1, sides - 1)))
        ring_indices.append(ring)

    for lower, upper in zip(ring_indices, ring_indices[1:]):
        for side in range(sides):
            nxt = (side + 1) % sides
            faces.append((lower[side], lower[nxt], upper[nxt], upper[side]))

    tip = len(vertices)
    vertices.append(
        (
            location[0] + lean[0] + tip_offset[0],
            location[1] + lean[1] + tip_offset[1],
            location[2] + height,
        )
    )
    colors.append(PALETTE[3])
    top_ring = ring_indices[-1]
    for side in range(sides):
        faces.append((top_ring[side], top_ring[(side + 1) % sides], tip))
    faces.append(tuple(reversed(ring_indices[0])))


CLUSTERS = {
    "crystal_cluster_small_a": {
        "camera": (4.6, -6.8, 3.25),
        "target_z": 0.8,
        "shards": [
            ((-0.03, 0.08, 0.00), 1.90, 0.39, (0.07, 0.02), 0.08, 0.68, (0.02, -0.01), 11, (1.04, 0.88)),
            ((0.42, 0.18, 0.00), 1.36, 0.25, (0.20, 0.05), -0.22, 0.73, (0.03, 0.00), 12, (0.92, 0.78)),
            ((-0.43, 0.10, 0.00), 1.20, 0.24, (-0.18, 0.04), 0.18, 0.70, (-0.03, 0.00), 13, (0.96, 0.80)),
            ((0.30, -0.31, 0.00), 0.92, 0.21, (0.15, -0.15), 0.34, 0.67, (0.03, -0.02), 14, (0.88, 0.75)),
            ((-0.29, -0.34, 0.00), 0.78, 0.19, (-0.11, -0.13), -0.31, 0.71, (-0.02, -0.02), 15, (0.90, 0.78)),
            ((0.02, -0.48, 0.00), 0.55, 0.15, (0.02, -0.09), 0.12, 0.65, (0.01, -0.01), 16, (0.88, 0.72)),
        ],
        "chips": [((-0.55, -0.20, 0.0), 0.24, 0.18, -0.08, 101), ((0.58, -0.12, 0.0), 0.20, 0.17, 0.22, 102)],
    },
    "crystal_cluster_small_b": {
        "camera": (4.9, -7.2, 3.1),
        "target_z": 0.68,
        "shards": [
            ((0.00, 0.12, 0.00), 1.48, 0.31, (0.03, 0.02), 0.05, 0.70, (0.00, 0.01), 21, (1.08, 0.86)),
            ((-0.34, 0.08, 0.00), 1.18, 0.24, (-0.26, 0.02), 0.14, 0.68, (-0.05, 0.00), 22, (0.95, 0.75)),
            ((-0.62, -0.02, 0.00), 0.86, 0.19, (-0.31, -0.04), -0.20, 0.72, (-0.04, 0.00), 23, (0.92, 0.72)),
            ((0.34, 0.10, 0.00), 1.28, 0.25, (0.27, 0.03), -0.12, 0.72, (0.05, 0.01), 24, (0.96, 0.76)),
            ((0.61, -0.04, 0.00), 0.98, 0.20, (0.38, -0.03), 0.24, 0.69, (0.04, -0.01), 25, (0.90, 0.72)),
            ((0.24, -0.34, 0.00), 0.72, 0.18, (0.14, -0.16), 0.46, 0.66, (0.02, -0.02), 26, (0.86, 0.70)),
            ((-0.22, -0.36, 0.00), 0.62, 0.17, (-0.11, -0.13), -0.42, 0.70, (-0.02, -0.02), 27, (0.88, 0.72)),
        ],
        "chips": [((-0.78, -0.20, 0.0), 0.20, 0.17, -0.18, 111), ((0.78, -0.18, 0.0), 0.24, 0.19, 0.19, 112)],
    },
    "crystal_cluster_large": {
        "camera": (6.2, -9.2, 5.05),
        "target_z": 1.42,
        "shards": [
            ((0.00, 0.18, 0.00), 3.55, 0.72, (0.11, 0.04), 0.06, 0.64, (0.04, 0.01), 31, (1.08, 0.90)),
            ((0.62, 0.35, 0.00), 2.72, 0.43, (0.31, 0.08), -0.17, 0.72, (0.05, 0.01), 32, (0.94, 0.77)),
            ((-0.68, 0.25, 0.00), 2.46, 0.42, (-0.30, 0.06), 0.20, 0.68, (-0.05, 0.01), 33, (0.96, 0.78)),
            ((1.05, 0.03, 0.00), 2.12, 0.34, (0.48, -0.02), 0.28, 0.71, (0.06, 0.00), 34, (0.90, 0.72)),
            ((-1.06, 0.00, 0.00), 1.92, 0.33, (-0.45, -0.03), -0.25, 0.69, (-0.05, 0.00), 35, (0.92, 0.74)),
            ((0.72, -0.55, 0.00), 1.62, 0.30, (0.33, -0.27), 0.40, 0.66, (0.04, -0.04), 36, (0.88, 0.70)),
            ((-0.72, -0.57, 0.00), 1.52, 0.29, (-0.28, -0.24), -0.38, 0.70, (-0.04, -0.03), 37, (0.90, 0.72)),
            ((0.12, -0.72, 0.00), 1.26, 0.27, (0.05, -0.22), 0.12, 0.65, (0.01, -0.04), 38, (0.88, 0.70)),
            ((1.30, -0.32, 0.00), 1.18, 0.24, (0.34, -0.14), -0.32, 0.68, (0.04, -0.02), 39, (0.84, 0.68)),
            ((-1.28, -0.31, 0.00), 1.06, 0.23, (-0.32, -0.13), 0.34, 0.71, (-0.04, -0.02), 40, (0.86, 0.70)),
        ],
        "chips": [
            ((-1.52, -0.42, 0.0), 0.31, 0.25, -0.20, 121),
            ((1.55, -0.38, 0.0), 0.28, 0.24, 0.24, 122),
            ((-0.94, -0.83, 0.0), 0.24, 0.22, 0.08, 123),
            ((1.02, -0.82, 0.0), 0.22, 0.21, -0.12, 124),
        ],
    },
}


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def make_crystal_material():
    material = bpy.data.materials.new("crystal_emissive")
    material.use_nodes = True
    material.diffuse_color = (0.31, 0.08, 0.72, 1.0)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    attribute = nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "crystal_color"
    principled.inputs["Roughness"].default_value = 0.22
    principled.inputs["Metallic"].default_value = 0.0
    if "IOR" in principled.inputs:
        principled.inputs["IOR"].default_value = 1.46
    if "Coat Weight" in principled.inputs:
        principled.inputs["Coat Weight"].default_value = 0.22
    if "Coat Roughness" in principled.inputs:
        principled.inputs["Coat Roughness"].default_value = 0.12
    links.new(attribute.outputs["Color"], principled.inputs["Base Color"])
    emission_name = "Emission Color" if "Emission Color" in principled.inputs else "Emission"
    links.new(attribute.outputs["Color"], principled.inputs[emission_name])
    principled.inputs["Emission Strength"].default_value = 0.28
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    return material


def build_cluster(name, spec):
    vertices, faces, colors = [], [], []
    for index, shard in enumerate(spec["shards"]):
        location, height, radius, lean, rotation, shoulder, tip_offset, seed, squash = shard
        append_shard(
            vertices,
            faces,
            colors,
            location=location,
            height=height,
            radius=radius,
            lean=lean,
            rotation=rotation,
            shoulder=shoulder,
            tip_offset=tip_offset,
            seed=seed,
            squash=squash,
        )
    for location, height, radius, rotation, seed in spec["chips"]:
        append_shard(
            vertices,
            faces,
            colors,
            location=location,
            height=height,
            radius=radius,
            lean=(math.cos(rotation) * 0.07, math.sin(rotation) * 0.07),
            rotation=rotation,
            shoulder=0.50,
            tip_offset=(math.cos(rotation) * 0.03, math.sin(rotation) * 0.03),
            seed=seed,
            squash=(1.18, 0.82),
        )

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update(calc_edges=True)
    color_layer = mesh.color_attributes.new(name="crystal_color", type="FLOAT_COLOR", domain="POINT")
    for index, color in enumerate(colors):
        color_layer.data[index].color = color
    mesh.color_attributes.active_color = color_layer
    for polygon in mesh.polygons:
        polygon.use_smooth = False

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(make_crystal_material())
    obj["asset_role"] = "instanced_environment_crystal"
    obj["triangle_budget"] = 1000
    obj["reference_style"] = "broad faceted cyan-white crown over violet core"
    return obj


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_preview(spec, cluster):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("CrystalPreviewWorld") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.006, 0.001, 0.018, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12

    bpy.ops.mesh.primitive_plane_add(size=16, location=(0, 0, -0.025))
    ground = bpy.context.object
    ground.name = "CRYSTAL_PREVIEW_Ground"
    ground_mat = bpy.data.materials.new("CRYSTAL_PREVIEW_GroundMaterial")
    ground_mat.diffuse_color = (0.018, 0.004, 0.035, 1.0)
    ground.data.materials.append(ground_mat)

    bpy.ops.object.camera_add(location=spec["camera"])
    camera = bpy.context.object
    camera.name = "CRYSTAL_PREVIEW_Camera"
    camera.data.lens = 58
    look_at(camera, (0, 0, spec["target_z"]))
    scene.camera = camera

    for name, location, color, energy, size in (
        ("CRYSTAL_PREVIEW_Key", (-3.2, -4.2, 5.3), (0.48, 0.80, 1.0), 230, 4.0),
        ("CRYSTAL_PREVIEW_Rim", (3.2, 1.8, 4.0), (0.50, 0.08, 1.0), 310, 3.0),
        ("CRYSTAL_PREVIEW_Fill", (0.0, -2.0, 1.2), (0.75, 0.30, 1.0), 95, 2.5),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(light)
        light.location = location
        look_at(light, (0, 0, spec["target_z"] * 0.8))

    cluster.select_set(True)
    bpy.context.view_layer.objects.active = cluster


def export_selected(filepath, *, draco=False):
    bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_draco_mesh_compression_enable=draco,
        export_draco_mesh_compression_level=6,
        export_cameras=False,
        export_lights=False,
    )


def generate_one(name, spec):
    clear_scene()
    cluster = build_cluster(name, spec)
    setup_preview(spec, cluster)

    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_DIR / f"{name}.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    cluster.select_set(True)
    bpy.context.view_layer.objects.active = cluster
    export_selected(RUNTIME_DIR / f"{name}.glb", draco=True)
    export_selected(RAW_DIR / f"{name}_unoptimized.glb")

    bpy.context.scene.render.filepath = str(PREVIEW_DIR / f"{name.replace('_', '-')}.png")
    bpy.ops.render.render(write_still=True)
    triangles = sum(len(poly.vertices) - 2 for poly in cluster.data.polygons)
    print(name, "vertices", len(cluster.data.vertices), "triangles", triangles)


for cluster_name, cluster_spec in CLUSTERS.items():
    generate_one(cluster_name, cluster_spec)

# Leave the large source open for immediate art review.
bpy.ops.wm.open_mainfile(filepath=str(BLEND_DIR / "crystal_cluster_large.blend"))
print("CRYSTAL_KIT_GENERATION_COMPLETE")
