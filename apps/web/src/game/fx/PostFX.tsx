import {
  EffectComposer,
  Bloom,
  BrightnessContrast,
  HueSaturation,
  N8AO,
  Vignette,
  ToneMapping,
  SMAA,
} from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useThree } from '@react-three/fiber';
import { moodForScene } from '@/game/world/worldLighting';
import { useUIStore } from '@/ui/store';

/**
 * Post-processing that does most of the "graphics" lift on top of grey-box geometry:
 * ambient occlusion for grounded contact shadows, gentle bloom on emissive things
 * (pickups, projectiles, sun), filmic tone-mapping, and a soft vignette.
 */
export const PostFX = () => {
  // Rebuild the composer whenever the canvas size or pixel ratio changes: the composer's
  // resize path sizes its buffers in CSS pixels (missing the DPR multiply), which leaves
  // the scene rendered into a corner and the rest of the screen black after a window
  // resize. Recreating it re-runs the (correct) init path; resizes are rare, cost is ~ms.
  const { size, viewport } = useThree();
  const scene = useUIStore((state) => state.scene);
  const composerKey = `${size.width}x${size.height}@${viewport.dpr}`;
  // The colour grade is the biggest "flat → punch" lever, so it comes from the active mood:
  // deep blacks (contrast), warm/cool balance (saturation) and focus (vignette) all shift
  // together per preset. See worldLighting.ts.
  const grade = moodForScene(scene).grade;

  return (
    <EffectComposer key={composerKey} multisampling={0} enableNormalPass>
      {/* Soft local AO seats the embedded stones in the soil without spreading a dark
          halo across the path or smothering the thin, swaying grass field. Keep this
          full-resolution so contact shadows do not pixelate terrain or character edges. */}
      <N8AO
        aoRadius={grade.aoRadius}
        intensity={grade.aoIntensity}
        distanceFalloff={grade.aoDistanceFalloff}
        quality="medium"
      />
      {/* No global depth-of-field: atmospheric fog provides skyline separation without
          downsampling and blurring the playable terrain, characters, or nearby ruins. */}
      {/* Threshold > 1 so only true HDR emitters (pickups, projectiles, sun disc) bloom —
          at 0.75 the whole Preetham sky crossed it and washed out to white. */}
      <Bloom
        intensity={grade.bloomIntensity}
        luminanceThreshold={grade.bloomThreshold}
        luminanceSmoothing={grade.bloomSmoothing}
        mipmapBlur
        radius={grade.bloomRadius}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <HueSaturation saturation={grade.saturation} />
      <BrightnessContrast brightness={grade.brightness} contrast={grade.contrast} />
      <Vignette offset={grade.vignetteOffset} darkness={grade.vignetteDarkness} />
      <SMAA />
    </EffectComposer>
  );
};
