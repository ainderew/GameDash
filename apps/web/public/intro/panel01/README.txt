Drop the Scene 1 parallax layers here (exact names — the intro references these paths):

  far.png    ← starfield / sky backdrop        (opaque, no keying)
  mid.png    ← distant rib-arches + crystals    (may ship on a solid RED matte)
  near.png   ← foreground framing + rubble      (may ship on a solid RED matte)

Specs: 16:9, 4K preferred (2560x1440 min), ~15% overscan past the frame so parallax
never reveals an edge. The RED matte on mid/near is keyed to transparent automatically
at load time; clean alpha PNGs later remove any edge fringing.

Until these files exist the intro plays with gradient placeholders, so it is always
previewable. Configure layers/caption/timing in src/ui/intro/introScenes.ts.
