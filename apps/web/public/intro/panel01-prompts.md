# Scene 01 generation prompts

Mode: built-in image generation with local chroma-key removal and WebP export.

## Master

Use case: stylized-concept. Asset type: 4K motion-comic master frame. Use the supplied promotional images only as rendering, material, palette-continuity, and proportion references; do not copy their compositions. Create a vast ruined Cradle landscape at blue-black predawn: shattered wet earth, overgrown alien flora, drifting low mist, broken ancient structures, and colossal petrified ribs from a long-dead Titan receding across the basin. Stylized painterly 3D fantasy matching the reference material, cinematic rather than photoreal. Wide 16:9 composition with strong foreground/midground/background separation, center-80% safe framing, and generous motion bleed. Restrained cyan and violet energy glimmers against dirty amber remnants and deep shadows. No characters, no city, no text, no logo, no watermark, no UI.

## Background plate

Use the master as an exact edit target. Preserve its camera, perspective, horizon, crop, distant geometry, lighting, palette, and rendering. Produce the clean opaque background plate: sky, distant Cradle basin, far ruins, and far Titan ribs. Remove all close foreground and middle-distance occluders and reconstruct plausible continuous scenery behind them. No characters, text, logo, watermark, or UI.

## Midground isolation

Use the master as an exact alignment reference. Isolate only the middle-distance petrified rib arches, broken structures, rocks, and opaque alien flora. Preserve their exact screen-space positions, perspective, size, lighting, and silhouettes. Replace everything else with perfectly uniform solid `#ff0000`, with no gradient, shadow, texture, or reflection. Do not include sky, distant background, close foreground framing, mist, particles, text, or watermark. Do not use `#ff0000` in the retained artwork.

## Foreground isolation

Use the master as an exact alignment reference. Isolate only the nearest camera-framing elements: close rib fragments, wet leaves, stones, and rubble along the lower and side edges. Preserve their exact screen-space positions, perspective, size, lighting, and silhouettes. Replace everything else with perfectly uniform solid `#ff0000`, with no gradient, shadow, texture, or reflection. Do not include sky, distant scenery, midground structures, mist, particles, text, or watermark. Do not use `#ff0000` in the retained artwork.

## Atmosphere

Use the master for lighting and placement reference. Create only sparse pale blue-gray low mist ribbons, fine drifting dust/spores, and a few faint rain streaks on a perfectly flat black background. Keep the central focal region mostly clear. No landscape, ribs, rocks, flora, characters, text, logo, watermark, or UI. This source is converted locally from black to alpha.
