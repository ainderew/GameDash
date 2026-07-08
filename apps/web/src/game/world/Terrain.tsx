import { useMemo } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { PlaneGeometry, Color, BufferAttribute } from 'three';
import { heightAt, PLAY_RADIUS } from '@/game/world/terrainHeight';

// Re-exported so existing world modules keep importing these from Terrain.
export { heightAt, PLAY_RADIUS };

const SIZE = 220;
const SEG = 128;

const grassLow = new Color('#4f7d33');
const grassHigh = new Color('#7bab48');
const rock = new Color('#8a8172');

/**
 * The stylized ground. Visual terrain undulates and rings the arena with hills;
 * a flat physics collider at y=0 keeps gameplay on level ground.
 */
export const Terrain = () => {
  const geometry = useMemo(() => {
    const geo = new PlaneGeometry(SIZE, SIZE, SEG, SEG);
    const pos = geo.attributes.position!;
    const colors: number[] = [];
    const tmp = new Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // plane is in XY until we rotate it flat
      const h = heightAt(x, y);
      pos.setZ(i, h);
      // Colour by height: grass gradient, rocky tint on the tall hills.
      const t = Math.min(1, Math.max(0, h / 6));
      tmp.copy(grassLow).lerp(grassHigh, Math.min(1, Math.max(0, (h + 1) / 4)));
      if (h > 4) tmp.lerp(rock, Math.min(1, (h - 4) / 4));
      colors.push(tmp.r, tmp.g, tmp.b);
      void t;
    }
    geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }, []);

  return (
    <>
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} metalness={0} />
      </mesh>
      {/* Flat gameplay ground. */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[SIZE / 2, 0.1, SIZE / 2]} position={[0, -0.1, 0]} />
      </RigidBody>
    </>
  );
};
