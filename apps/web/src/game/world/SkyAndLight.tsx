import { Sky } from '@react-three/drei';

/** Sun direction shared by the Sky and the shadow-casting directional light. */
export const SUN_POSITION: [number, number, number] = [38, 28, 18];

/**
 * Stylized-fantasy sky + lighting: warm daytime sun, sky/ground hemisphere bounce,
 * and soft distance fog tinted to the horizon so hills fade gently.
 */
export const SkyAndLight = () => {
  return (
    <>
      <Sky
        sunPosition={SUN_POSITION}
        turbidity={6}
        rayleigh={1.2}
        mieCoefficient={0.006}
        mieDirectionalG={0.85}
      />
      <fogExp2 attach="fog" args={['#bfe0ef', 0.011]} />

      {/* Sky-blue key from above, warm earthy bounce from below. */}
      <hemisphereLight args={['#bfe3ff', '#6b7a3a', 0.9]} />

      {/* Warm sun. */}
      <directionalLight
        castShadow
        position={SUN_POSITION}
        intensity={2.6}
        color="#fff2d0"
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-38}
        shadow-camera-right={38}
        shadow-camera-top={38}
        shadow-camera-bottom={-38}
        shadow-camera-near={1}
        shadow-camera-far={140}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {/* Subtle cool fill from the opposite side to open up shadows. */}
      <directionalLight position={[-20, 12, -16]} intensity={0.35} color="#cfe0ff" />
    </>
  );
};
