import { useEffect, useMemo } from 'react';
import { Box3, Color, Matrix4, MeshStandardMaterial, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';

/**
 * Titan-rib backdrop — the giant curved bones arcing over Heartwood Haven in the
 * concept art. A single Tripo "rib" mesh is the building block, but its authored
 * axes are arbitrary, so we first CANONICALIZE it: a PCA of the mesh (run offline)
 * gives its length axis, its flat-blade thickness axis, and the direction its arc
 * bows. We bake a rotation that maps
 *     length → +Y,  concave (inside of the arc) → +Z,  thickness → +X,
 * so every rib stands upright as a flat blade whose concave face points +Z. In the
 * scene we then just yaw each rib to face the hub centre — so opposing ribs cup
 * toward one another like a real ribcage — lean the tops inward, and stretch them
 * tall. Two concentric rings plus `fogExp2` (SkyAndLight) give the receding, hazed
 * depth of the reference.
 *
 * Pure scenery: it sits well beyond the play area / treeline, casts no shadow
 * (outside the sun's shadow frustum anyway) and has no collider.
 */
const MODEL_PATH = '/models/backdrop/rib-spire.glb';

// Principal axes of the rib mesh, measured offline (PCA of the POSITION buffer).
// e1 = length (largest spread), e3 = thickness (smallest — the blade is flat in X),
// and the arc bows toward +e2, so its concave "inside" is -e2. These three form a
// right-handed frame (E_THICK × E_LENGTH = E_CONCAVE), i.e. a proper rotation.
const E_LENGTH: [number, number, number] = [0.0965, 0.8759, 0.4728];
const E_THICK: [number, number, number] = [0.9618, 0.0402, -0.2708];
const E_CONCAVE: [number, number, number] = [0.2562, -0.4809, 0.8385];

/**
 * Yaw added after a rib is turned to face the hub. With canonicalization the concave
 * side faces the centre at 0; flip to `Math.PI` if the ribs should bow the other way.
 */
const CURVE_FACE_OFFSET = 0;

/** Deterministic PRNG so the skyline is identical every load. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Spire {
  x: number;
  z: number;
  baseY: number;
  /** World height along the rib's length before it arcs over. */
  height: number;
  /** Cross-section as a fraction of height — kept chunky so the rib is a solid mass. */
  girth: number;
  /** Yaw so the concave inner face points at the hub centre. */
  rotY: number;
  /** Inward lean components (top tips toward the hub), in world axes. */
  tiltX: number;
  tiltZ: number;
  /** false = near titan ribs, true = far hazed peak line — picks the material tint. */
  far: boolean;
}

interface RingSpec {
  count: number;
  rMin: number;
  rMax: number;
  hMin: number;
  hMax: number;
  girthMin: number;
  girthMax: number;
  leanMin: number;
  leanMax: number;
  /** Sink the root below the ground so the fat base is buried behind the hills. */
  embedMin: number;
  embedMax: number;
  far: boolean;
}

const RINGS: RingSpec[] = [
  // The titan's ribs: huge chunky bones leaning hard inward so the cage closes over the hub.
  { count: 18, rMin: 66, rMax: 88, hMin: 54, hMax: 92, girthMin: 0.42, girthMax: 0.66, leanMin: 0.5, leanMax: 0.86, embedMin: 12, embedMax: 20, far: false },
  // Distant peak/rib line: shorter, denser, leaning less — fog carries the depth.
  { count: 22, rMin: 98, rMax: 122, hMin: 40, hMax: 70, girthMin: 0.5, girthMax: 0.8, leanMin: 0.18, leanMax: 0.36, embedMin: 14, embedMax: 22, far: true },
];

const placeSpires = (): Spire[] => {
  const rng = mulberry32(51720260);
  const spires: Spire[] = [];
  for (const ring of RINGS) {
    // Even angular spokes plus jitter → a ribcage rhythm with no gaps or hard cadence.
    for (let i = 0; i < ring.count; i += 1) {
      const angle = ((i + rng() * 0.5) / ring.count) * Math.PI * 2;
      const r = ring.rMin + rng() * (ring.rMax - ring.rMin);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const lean = ring.leanMin + rng() * (ring.leanMax - ring.leanMin);
      const rx = x / r;
      const rz = z / r;
      spires.push({
        x,
        z,
        baseY: heightAt(x, z) - (ring.embedMin + rng() * (ring.embedMax - ring.embedMin)),
        height: ring.hMin + rng() * (ring.hMax - ring.hMin),
        girth: ring.girthMin + rng() * (ring.girthMax - ring.girthMin),
        // Face the hub centre (concave inner face points inward), with a little jitter.
        rotY: Math.atan2(-x, -z) + CURVE_FACE_OFFSET + (rng() - 0.5) * 0.3,
        // Tip the top toward the centre. Signs: rotX by -rz*lean pulls the top's z
        // toward 0, rotZ by +rx*lean pulls its x toward 0 → an inward lean.
        tiltX: -rz * lean,
        tiltZ: rx * lean,
        far: ring.far,
      });
    }
  }
  return spires;
};

export const SpireBackdrop = () => {
  const source = useGameModel(MODEL_PATH).scene;

  // Two flat rock materials — the far line is lighter/cooler so aerial perspective
  // reads even before fog. Near-silhouette dark violet, high roughness, no map.
  const materials = useMemo(() => {
    const near = new MeshStandardMaterial({ color: new Color('#2b2940'), roughness: 0.98, metalness: 0, envMapIntensity: 0.2 });
    const far = new MeshStandardMaterial({ color: new Color('#413f5c'), roughness: 0.98, metalness: 0, envMapIntensity: 0.2 });
    return { near, far };
  }, []);

  // Bake the canonicalizing rotation into a copy of the geometry, then normalize the
  // rib to unit height with its base on the group origin. Clones share this baked
  // geometry + material (Object3D.clone reuses buffers), so the whole cage is cheap.
  const { nearRoot, farRoot } = useMemo(() => {
    // Rows map the measured axes onto X/Y/Z: thickness→X, length→Y, concave→Z.
    const canon = new Matrix4().set(
      E_THICK[0], E_THICK[1], E_THICK[2], 0,
      E_LENGTH[0], E_LENGTH[1], E_LENGTH[2], 0,
      E_CONCAVE[0], E_CONCAVE[1], E_CONCAVE[2], 0,
      0, 0, 0, 1,
    );
    const build = (material: MeshStandardMaterial) => {
      const root = source.clone(true);
      root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(canon);
        mesh.geometry = geometry;
        mesh.material = material;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
      const box = new Box3().setFromObject(root);
      const size = box.getSize(new Vector3());
      const center = box.getCenter(new Vector3());
      const s = 1 / (size.y || 1);
      root.scale.setScalar(s);
      root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      return root;
    };
    return { nearRoot: build(materials.near), farRoot: build(materials.far) };
  }, [source, materials]);

  const spires = useMemo(placeSpires, []);

  const clones = useMemo(
    () => spires.map((sp) => (sp.far ? farRoot : nearRoot).clone(true) as Object3D),
    [spires, nearRoot, farRoot],
  );

  useEffect(
    () => () => {
      materials.near.dispose();
      materials.far.dispose();
    },
    [materials],
  );

  return (
    <group>
      {spires.map((sp, i) => (
        // Outer group: root + inward lean (world axes). Inner group: yaw the concave
        // face at the hub + stretch, pivoting at the rooted base so the top tilts in
        // while the foot stays planted.
        <group key={i} position={[sp.x, sp.baseY, sp.z]} rotation={[sp.tiltX, 0, sp.tiltZ]}>
          <group rotation={[0, sp.rotY, 0]} scale={[sp.height * sp.girth, sp.height, sp.height * sp.girth]}>
            <primitive object={clones[i]!} />
          </group>
        </group>
      ))}
    </group>
  );
};

useGameModel.preload(MODEL_PATH);
