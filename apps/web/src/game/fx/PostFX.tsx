import { EffectComposer, Bloom, N8AO, Vignette, ToneMapping, SMAA } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';

/**
 * Post-processing that does most of the "graphics" lift on top of grey-box geometry:
 * ambient occlusion for grounded contact shadows, gentle bloom on emissive things
 * (pickups, projectiles, sun), filmic tone-mapping, and a soft vignette.
 */
export const PostFX = () => {
  return (
    <EffectComposer multisampling={0} enableNormalPass>
      <N8AO aoRadius={1.0} intensity={1.3} distanceFalloff={1} halfRes quality="low" />
      <Bloom
        intensity={0.5}
        luminanceThreshold={0.75}
        luminanceSmoothing={0.3}
        mipmapBlur
        radius={0.6}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette offset={0.3} darkness={0.5} />
      <SMAA />
    </EffectComposer>
  );
};
