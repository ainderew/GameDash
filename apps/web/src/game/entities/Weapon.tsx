import { createPortal, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Object3D,
} from 'three';
import { useGameModel } from '@/lib/loaders';
import type { WeaponDef } from '@/game/combat/weapons';
import { weaponSockets } from '@/game/combat/weaponSockets';

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
interface MountedWeaponProps {
  bone: Object3D;
  def: WeaponDef;
  object: Group;
  /** Selects the hand-local grip calibrated for the current locomotion clip. */
  stateRef?: React.MutableRefObject<string>;
}

const MountedWeapon = ({ bone, def, object, stateRef }: MountedWeaponProps) => {
  const holder = useRef<Group>(null);
  const bladeBase = useMemo(() => new Group(), []);
  const bladeTip = useMemo(() => new Group(), []);
  const target = useMemo(
    () => ({
      position: new Vector3(),
      rotation: new Quaternion(),
      scale: new Vector3(),
      euler: new Euler(),
    }),
    [],
  );
  const initialized = useRef(false);
  useEffect(() => {
    weaponSockets.base = bladeBase;
    weaponSockets.tip = bladeTip;
    return () => {
      if (weaponSockets.base === bladeBase) weaponSockets.base = null;
      if (weaponSockets.tip === bladeTip) weaponSockets.tip = null;
    };
  }, [bladeBase, bladeTip]);
  useFrame((_, delta) => {
    const h = holder.current;
    if (!h) return;
    const a = stateRef?.current === 'run' ? def.runAttach : def.attach;
    target.position.set(a.position[0], a.position[1], a.position[2]);
    target.euler.set(a.rotation[0], a.rotation[1], a.rotation[2]);
    target.rotation.setFromEuler(target.euler);
    target.scale.setScalar(a.scale);

    // A short hand-local blend removes the pop when entering/exiting run while preserving
    // rigid hand ownership—the sword can never drift independently from the animated wrist.
    if (!initialized.current) {
      h.position.copy(target.position);
      h.quaternion.copy(target.rotation);
      h.scale.copy(target.scale);
      initialized.current = true;
    } else {
      const blend = 1 - Math.exp(-Math.min(delta, 1 / 20) * 18);
      h.position.lerp(target.position, blend);
      h.quaternion.slerp(target.rotation, blend);
      h.scale.lerp(target.scale, blend);
    }
    bladeBase.position.set(def.bladeBase[0], def.bladeBase[1], def.bladeBase[2]);
    bladeTip.position.set(def.bladeTip[0], def.bladeTip[1], def.bladeTip[2]);
  });
  return createPortal(
    <group ref={holder}>
      <primitive object={object} />
      <primitive object={bladeBase} />
      <primitive object={bladeTip} />
    </group>,
    bone,
  );
};

interface WeaponMountProps {
  bone: Object3D;
  def: WeaponDef;
  stateRef?: React.MutableRefObject<string>;
}

const ProceduralWeaponMount = ({ bone, def, stateRef }: WeaponMountProps) => {
  const object = useMemo(() => buildProceduralWeapon(def), [def]);
  return <MountedWeapon bone={bone} def={def} object={object} stateRef={stateRef} />;
};

const GlbWeaponMount = ({ bone, def, stateRef }: WeaponMountProps) => {
  const gltf = useGameModel(def.modelPath!);
  const object = useMemo(() => {
    const g = new Group();
    const scene = gltf.scene.clone(true);
    const pivot = def.modelGripPivot ?? [0, 0, 0];
    // Tripo exports are centre-origin. Move the mesh under a grip-centred wrapper so every
    // state rotates around the hand contact point instead of making the hilt orbit the palm.
    scene.position.set(-pivot[0], -pivot[1], -pivot[2]);
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    g.add(scene);
    return g;
  }, [def.modelGripPivot, gltf]);
  return <MountedWeapon bone={bone} def={def} object={object} stateRef={stateRef} />;
};

/**
 * Mount the current weapon under a bone. Chooses the GLB loader (e.g. a Tripo export) or the
 * procedural builder by whether the WeaponDef has a modelPath. Switching between a procedural
 * and a GLB weapon remounts (different component); switching among procedural weapons rebuilds
 * the mesh in place.
 */
export const WeaponMount = ({ bone, def, stateRef }: WeaponMountProps) =>
  def.modelPath ? (
    <GlbWeaponMount bone={bone} def={def} stateRef={stateRef} />
  ) : (
    <ProceduralWeaponMount bone={bone} def={def} stateRef={stateRef} />
  );
