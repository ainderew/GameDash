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
  const composerKey = `${size.width}x${size.height}@${viewport.dpr}`;

  return (
    <EffectComposer key={composerKey} multisampling={0} enableNormalPass>
      {/* Tight-radius AO: contact shadows for characters/rocks without smothering or
          shimmering the dense grass field (large radii flicker on thin swaying blades). */}
      <N8AO aoRadius={0.65} intensity={1.02} distanceFalloff={1} halfRes quality="medium" />
      {/* Threshold > 1 so only true HDR emitters (pickups, projectiles, sun disc) bloom —
          at 0.75 the whole Preetham sky crossed it and washed out to white. */}
      <Bloom
        intensity={0.62}
        luminanceThreshold={1.08}
        luminanceSmoothing={0.24}
        mipmapBlur
        radius={0.6}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <HueSaturation saturation={0.02} />
      <BrightnessContrast brightness={0.02} contrast={0.035} />
      <Vignette offset={0.34} darkness={0.28} />
      <SMAA />
    </EffectComposer>
  );
};
