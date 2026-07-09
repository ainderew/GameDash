import { createPortal, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
} from 'three';
import { useGameModel } from '@/lib/loaders';
import type { WeaponDef } from '@/game/combat/weapons';

/**
 * Build a procedural weapon (blade + guard + grip) as a THREE.Group whose ORIGIN is the
 * base of the grip — i.e. where the hand holds it — with the blade pointing up (+Y). The
 * attach transform in the WeaponDef then lays it into the hand.
 */
export const buildProceduralWeapon = (def: WeaponDef): Group => {
  const g = new Group();

  const gripMat = new MeshStandardMaterial({ color: def.grip.color, roughness: 0.85, metalness: 0.1 });
  const grip = new Mesh(
    new CylinderGeometry(def.grip.radius, def.grip.radius * 0.9, def.grip.length, 10),
    gripMat,
  );
  grip.position.y = def.grip.length / 2;

  const guardMat = new MeshStandardMaterial({ color: def.guard.color, roughness: 0.5, metalness: 0.6 });
  const guard = new Mesh(new BoxGeometry(def.guard.width, 0.025, def.guard.depth), guardMat);
  guard.position.y = def.grip.length;

  const steelMat = new MeshStandardMaterial({
    color: def.blade.color,
    metalness: def.blade.metalness,
    roughness: 0.22,
    emissive: def.blade.color,
    emissiveIntensity: 0.04,
  });
  const blade = new Mesh(
    new BoxGeometry(def.blade.width, def.blade.length, def.blade.thickness),
    steelMat,
  );
  blade.position.y = def.grip.length + def.blade.length / 2;
  // A small angled tip so it reads as a point, not a brick.
  const tip = new Mesh(new BoxGeometry(def.blade.width, def.blade.width * 1.3, def.blade.thickness), steelMat);
  tip.position.y = def.grip.length + def.blade.length;
  tip.rotation.z = Math.PI / 4;

  for (const m of [grip, guard, blade, tip]) {
    m.castShadow = true;
    m.receiveShadow = false;
    g.add(m);
  }
  return g;
};

/** Local-space blade-tip offset (from grip origin), for trails/contact math. */
export const bladeTipLocalY = (def: WeaponDef): number => def.grip.length + def.blade.length;

/**
 * Portal `object` under `bone` and drive its grip transform from the (mutable) WeaponDef
 * each frame — so leva edits to the attach transform update live. Shared by both variants.
 */
const MountedWeapon = ({ bone, def, object }: { bone: Object3D; def: WeaponDef; object: Group }) => {
  const holder = useRef<Group>(null);
  useFrame(() => {
    const h = holder.current;
    if (!h) return;
    const a = def.attach;
    h.position.set(a.position[0], a.position[1], a.position[2]);
    h.rotation.set(a.rotation[0], a.rotation[1], a.rotation[2]);
    h.scale.setScalar(a.scale);
  });
  return createPortal(
    <group ref={holder}>
      <primitive object={object} />
    </group>,
    bone,
  );
};

const ProceduralWeaponMount = ({ bone, def }: { bone: Object3D; def: WeaponDef }) => {
  const object = useMemo(() => buildProceduralWeapon(def), [def]);
  return <MountedWeapon bone={bone} def={def} object={object} />;
};

const GlbWeaponMount = ({ bone, def }: { bone: Object3D; def: WeaponDef }) => {
  const gltf = useGameModel(def.modelPath!);
  const object = useMemo(() => {
    const g = new Group();
    const scene = gltf.scene.clone(true);
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    g.add(scene);
    return g;
  }, [gltf]);
  return <MountedWeapon bone={bone} def={def} object={object} />;
};

/**
 * Mount the current weapon under a bone. Chooses the GLB loader (e.g. a Tripo export) or the
 * procedural builder by whether the WeaponDef has a modelPath. Switching between a procedural
 * and a GLB weapon remounts (different component); switching among procedural weapons rebuilds
 * the mesh in place.
 */
export const WeaponMount = ({ bone, def }: { bone: Object3D; def: WeaponDef }) =>
  def.modelPath ? <GlbWeaponMount bone={bone} def={def} /> : <ProceduralWeaponMount bone={bone} def={def} />;
