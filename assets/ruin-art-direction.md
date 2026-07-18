# GameDash Ruin Kit Art Direction

Status: persistent production standard  
Research date: 2026-07-16  
Applies to: the outside-town ruins, expedition approach, ruined streets, walls, arches, pillars, rubble, and related props

## Production decision

The current generated `ruin_stone` maps are useful for blockout and layout review, but they are not the final realism target. Future modules must be built around these rules:

1. Use geometry for silhouettes, broken corners, displaced stones, deep cracks, mortar gaps, and other medium-sized forms.
2. Use a scanned or carefully authored PBR material for mineral grain, pores, shallow fissures, color variation, and microsurface roughness.
3. Reuse one physically scaled shared ruin material across the modular kit. Do not create a different generic noise texture for every wall.
4. Use high-to-low baking for hero ruins and any module the camera can approach closely.
5. Review every asset in neutral lighting and in the actual purple night environment before approval.

## Why the current walls still look synthetic

- Most stones begin as similarly proportioned cubes with a uniform bevel.
- Small random vertex movement does not create convincing fractured planes or chipped corners.
- Procedural noise has no captured real-world material scale or correlation between color, height, and roughness.
- The wall lacks a readable mortar or compacted-earth layer behind the stones.
- The gaps are uniformly dark and the courses are too mechanically regular.
- Surface detail is present, but the geometry underneath still reads as repeated blocks.

Texture resolution alone will not fix these issues. Better textures and better geometry must be developed together.

## Approved texture sources

Use sources with explicit, project-compatible licensing and record the exact asset URL in `assets/asset-ledger.json`.

### First choice: Poly Haven

- Poly Haven states that its textures, HDRIs, and models are CC0 and may be used commercially without attribution.
- Search its rock-wall, old-stone-wall, rustic-stone-wall, granite-wall, and weathered masonry materials.
- Start from the 2K maps; retain the higher-resolution source only when it is genuinely useful for authoring.

Links:

- [Poly Haven asset license](https://polyhaven.com/license)
- [Poly Haven rock-wall texture search](https://polyhaven.com/textures?s=rock+wall)

### Second choice: ambientCG

- ambientCG also publishes its material library under CC0.
- Prefer assets identified as surface photogrammetry with physical dimensions recorded.
- `Rocks025` is an example photogrammetry set with a measured area of about 1.9 m by 1.9 m and downloadable 1K-8K PBR packages. It is a candidate, not an automatic final choice; it must be compared visually with Poly Haven's old-stone materials.

Links:

- [ambientCG library and license statement](https://ambientcg.com/)
- [ambientCG Rocks025](https://ambientcg.com/view?id=Rocks025)

### Source-ingest rule

For every downloaded material, retain:

- the original asset name and URL;
- the license and download date;
- the physical scan dimensions when provided;
- original base color, normal, roughness, AO, and height maps;
- notes about normal-map orientation and any color grading performed.

Store authoring originals under `assets/raw/materials/`. Runtime copies belong under `apps/web/public/textures/ruins/`.

## PBR material rules

The project ships glTF metallic-roughness materials.

- Stone is a dielectric: metallic must be `0`.
- Base color contains surface color only. Do not bake directional lighting, highlights, or deep ambient shadows into it.
- Base-color RGB is stored as sRGB.
- Roughness, metallic, AO, height, and normal data are non-color data.
- glTF packs roughness in the green channel and metallic in the blue channel of the metallic-roughness texture. AO may share the red channel as an ORM texture.
- Normal maps must be tangent-space maps connected through Blender's Normal Map node. Use the glTF/OpenGL `+Y` convention.
- Keep roughness variation broad enough to react under moonlight and lanterns; avoid a uniformly matte wall.
- AO should reinforce contact and cavities subtly. It must not replace runtime lighting.
- Preserve the material's physical scale. Default shared ruin target: a 2K tile representing roughly 2 m of surface.
- Height/displacement is an authoring source. Bake or convert it to geometry/normal detail instead of depending on runtime tessellation.
- Match the material source to the modeling strategy. A scan that already contains blocks, mortar, or horizontal masonry courses must not be projected onto separately modeled stones; doing so creates doubled seams and a miniature stacked-brick appearance. Use a homogeneous rock surface for individually modeled monoliths and let geometry define every joint.

References:

- [Khronos glTF 2.0 material specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [Blender glTF material/export guidance](https://docs.blender.org/manual/en/3.3/addons/import_export/scene_gltf2.html)
- [Adobe Substance glossary](https://helpx.adobe.com/in/substance-3d-designer/using/glossary.html)
- [Google Filament material reference](https://google.github.io/filament/Materials.md.html)

## Modeling rules

### Proven reference: Low B irregular-masonry revision

`ruin_wall_low_b.blend`, revision `production-irregular-masonry-v3`, is the current quality reference for the modular ruin family. Use it beside new models to compare scale, stone language, material response, and the amount of geometric variation.

What made the revision successful:

- The wall was rebuilt from 31 individually warped stones in six staggered courses instead of several straight continuous slabs.
- Seven angular fractured chunks add restrained rubble without hiding the wall's main shape.
- The modular bounds remain exact at 4 m wide by 1.4 m high, with a bottom-center ground pivot.
- Stone width and joint positions change between courses. Vertical joints do not continue mechanically through the wall.
- Each stone varies independently in height, depth, front/back offset, lean, and corner shape. Variation is applied to the stones, not merely to an entire straight row.
- Missing upper stones form three unequal silhouette clusters: a surviving left shoulder, a central dip, and a lower collapsed right end.
- The 1.9 m physically scaled `ruin_granite_scanned` material supplies microdetail; geometric warping supplies silhouette and medium-scale damage.

Low B authoring ranges, suitable as starting values for similar masonry:

| Property | Reference range |
| --- | ---: |
| Stone height | 0.205-0.265 m |
| Stone depth | 0.49-0.64 m |
| Per-stone course-height offset | up to +/-0.022 m |
| Front/back offset | up to +/-0.065 m |
| Local X lean | up to +/-1.8 degrees |
| Local Y lean | up to +/-2.0 degrees |
| Local Z rotation | up to +/-2.6 degrees |
| Corner-plane warp | up to approximately 0.035 m |
| Deliberate top-corner chip | 0.025-0.065 m |
| Edge bevel | 0.018-0.032 m, one segment |

These values are a controlled range, not a random-noise mandate. Preserve broad load-bearing faces, keep the bottom course grounded, and concentrate stronger damage around a readable collapse story.

The Low B runtime reference is 1,504 triangles, one material, three embedded 2K WebP textures, and approximately 1.87 MB after Draco compression. Its detailed render mesh must not be used as collision; use simplified stepped boxes.

#### Three-scale variation rule

Every new ruin must contain purposeful variation at all three scales:

1. **Large:** asymmetric silhouette, collapse direction, negative spaces, and unequal surviving masses.
2. **Medium:** different stone widths/heights, staggered joints, depth offsets, chipped corners, displaced blocks, and angular rubble.
3. **Small:** scanned base color, normal, roughness, AO, pores, shallow fissures, and mineral variation at the recorded physical scale.

If only the small-scale texture is noisy, the model will still read as a straight or synthetic wall. Check the untextured silhouette and flat-shaded geometry before relying on the material.

#### Straight-wall rejection checks

Reject or revise the model when any of these are visible from the gameplay camera:

- a horizontal seam runs ruler-straight through most of the module;
- several courses use the same joint positions;
- the front faces occupy one common plane;
- the broken crown looks like a staircase made from intact boxes;
- rubble begins as smooth spheres or repeats the same chunk shape;
- all damage is evenly distributed instead of supporting a collapse direction;
- the model looks convincing only after the normal map or purple night lighting is enabled.
- the material already contains masonry joints that duplicate the mesh's real joints.
- integrated flat green moss patches read as paint chips in neutral light; prefer separate vegetation scatter assets unless moss is texture-masked or has convincing volume and edge breakup.

### Proven reference: massive broken gate v2

`ruin_arch_broken.blend`, revision `massive-gate-fragment-v2`, is the hero-landmark reference derived from the improved outside-town environment. It replaces the rejected v1 arch, which used too many small blocks, thin disconnected piers, floating wedge stones, and a masonry texture that duplicated the modeled joints.

The approved gate uses:

- few large monolithic stones instead of many short brick courses;
- thick supports and broad spandrel masses that feel partially buried in the terrain;
- a nearly continuous arch curve with one localized upper-right failure;
- simple-subdivided, faceted geometric displacement for broad weathered planes;
- a homogeneous 2.4 m `ruin_dark_rock` scan for surface fissures, not architectural seams;
- six large grounded rubble masses rather than a spray of small debris;
- sparse moss only on sheltered ledges;
- an exact 4 m by 3.8 m module, 8,464 runtime triangles, two materials, and a 1.15 MB optimized GLB.

For hero ruins, compare the untextured silhouette against this gate before surface work. It should read as an ancient architectural mass at gameplay distance, not as a collection of individually noticeable bricks.

### Silhouette and medium forms

- Make at least five to eight genuinely different stone shapes for a wall family.
- Change length, height, depth, face angle, chipped corners, and fracture planes—not only rotation and scale.
- Keep the modular footprint exact, but let broken stones and rubble vary within the recorded footprint.
- Use actual geometry for any break larger than roughly 3-5 cm at gameplay scale.
- Avoid evenly distributed damage. Collapse should have a cause and direction: failed end, impact zone, eroded footing, or missing support.
- Add recessed mortar, compacted earth, or dark backing where gaps expose the wall interior. Prefer an atlas region or baked material mask so the runtime model can remain one material where practical.
- Keep the front and back faces believable; the player may walk around these modules.
- For rubble clusters, use a 70/25/5 visual hierarchy: a few dominant masses, supporting bridge fragments, and very little chip scatter. Set the ground plane from the dominant masses—not an isolated pebble—and sink or clip buried undersides so the pile cannot appear suspended in neutral light.

### Edge treatment and shading

- Use a bevel width appropriate to physical scale, with controlled variation between dressed blocks and shattered rubble.
- Harden or weight normals where broad faces should remain visually flat.
- Do not smooth across deliberate fracture boundaries.
- Check shading after triangulation because the shipped GLB uses triangles.

Blender's bevel modifier can harden normals and assign face strength for use with weighted normals: [Blender Bevel Modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html).

### High-to-low workflow

For hero walls, arches, pillars, gates, and close-up ruins:

1. Build a clean low-poly modular mesh at the correct meter scale.
2. Duplicate it for a high-poly sculpt or multiresolution pass.
3. Sculpt chipped corners, fractured planes, compression cracks, erosion, and damaged mortar.
4. UV unwrap the low mesh with consistent scale and sufficient bake padding.
5. Bake tangent-space normal, AO, curvature, world-space normal, and position maps from high to low.
6. Use the baked maps to place dirt, moss, edge wear, and cavity darkening logically.
7. Keep only silhouette-critical geometry in the runtime mesh.

Adobe describes the high-to-low bake as the way to retain high-resolution detail on a low-cost game mesh, and identifies normal, AO, curvature, position, and thickness as useful mesh maps: [Substance 3D Painter baking guide](https://helpx.adobe.com/in/substance-3d-painter/using/baking.html).

Blender also supports normal/AO baking and multiresolution-to-normal workflows:

- [Blender Cycles texture baking](https://docs.blender.org/manual/pt/4.2/render/cycles/baking.html)
- [Blender Multiresolution baking](https://docs.blender.org/manual/ja/latest/modeling/modifiers/generate/multiresolution.html)

## Module budgets

These are targets rather than reasons to remove visible quality:

| Module class | Runtime triangles | Materials | Texture strategy |
| --- | ---: | ---: | --- |
| Low wall / rubble cluster | 1,500-3,000 | 1 preferred | Shared 2K ruin material |
| Tall wall / arch / pillar | 2,500-5,000 | 1 preferred, 2 maximum | Shared 2K ruin material plus atlas masks if needed |
| Hero gate / landmark ruin | 5,000-12,000 | 1-2 | Shared material plus baked unique mask/detail when justified |

Create simplified collision separately. Never use every chipped stone triangle as the physics collider.

## UV and texture-scale standard

- Maintain a consistent physical texture scale across every module.
- Avoid Smart UV as the final solution for highly visible modules when it rotates or scales neighboring faces inconsistently.
- Use marked seams and deliberate unwraps for hero modules.
- Keep island padding appropriate for mipmaps and compressed textures.
- Avoid mirrored UVs where unique directional damage, moss, text, or normal-map asymmetry would become obvious.
- A tileable scan provides the shared base. A compact second UV/mask or vertex color may add module-scale moss and dirt variation if the exporter path is verified.

## Runtime delivery

The GameDash loader already configures Three.js `KTX2Loader`, and the project optimization script already prefers KTX2 when `toktx` is installed.

- Author and archive lossless PNG/TIFF source maps.
- Ship KTX2/Basis Universal when the KTX tools are available.
- Prefer high-quality UASTC for normal maps and quality-sensitive masks; use an appropriate smaller encoding for base color/ORM after visual comparison.
- Generate mipmaps.
- Use Meshopt/Draco only after checking that normals, UV seams, and silhouettes remain acceptable.
- Until `toktx` is installed, the existing pipeline falls back to WebP. This is a temporary delivery fallback, not the authoring source.

Khronos documents KTX2/Basis as a way to reduce both download size and GPU memory, and Three.js provides the runtime transcoder already used by this project:

- [Khronos KTX overview](https://www.khronos.org/ktx/)
- [Khronos glTF and KTX2](https://www.khronos.org/gltf/)
- [Three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)

## Review checklist

Every new ruin module must pass all of these checks:

- Silhouette reads clearly at gameplay distance.
- Broken edges are geometry, not only painted lines.
- Stone shapes do not look cloned.
- Mortar/interior construction is visible where appropriate.
- Texture scale matches neighboring modules.
- Base color contains no baked lighting.
- Normal map is tangent-space `+Y` and marked Non-Color in Blender.
- Roughness responds under both neutral and game lighting.
- Neutral-light preview exposes material problems instead of hiding them with purple lighting.
- Night-game preview confirms the asset belongs in the scene.
- Back and side faces withstand player inspection.
- Pivot, scale, bounds, collision hint, GLB contents, and source/license metadata are recorded.

## Immediate kit actions

1. Use Low B revision `production-irregular-masonry-v3` as the geometry and delivery reference for the next module.
2. Use `ruin_granite_scanned` only where its existing masonry pattern matches the modeled surface; use homogeneous `ruin_dark_rock` at its 2.4 m span for individually modeled monoliths and hero ruins.
3. Treat the older `ruin_stone` maps still embedded in Tall A as provisional and upgrade Tall A in a later pass.
4. Block out the next module's large silhouette and collapse direction before creating individual stones.
5. Apply the three-scale variation rule and run the straight-wall rejection checks in flat shading.
6. Review the model under neutral lighting and the game lighting before export.
7. Use a high-to-low bake for the broken arch, hero ruins, and any module the camera can approach closely.
