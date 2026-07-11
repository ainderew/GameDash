import { useControls } from 'leva';
import { useEffect } from 'react';
import { WEAPON_IDS, WEAPONS, getWeapon } from '@/game/combat/weapons';
import { useWeaponStore } from '@/game/combat/weaponStore';
import { heroTransform } from '@/game/entities/heroConfig';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { useUIStore } from '@/ui/store';

/**
 * WEAPON picker + grip tuning (leva, dev-only). Swap the wielded weapon and dial its grip
 * transform in the R_Hand bone's local space — Tripo rig bone axes aren't knowable ahead of
 * time, so tune here live, then paste the values back into the WeaponDef.attach in weapons.ts.
 *
 * Keyboard: Q cycles weapons; 1/2/3 select directly.
 */
export const WeaponControls = () => {
  const currentId = useWeaponStore((s) => s.currentId);
  const setWeapon = useWeaponStore((s) => s.setWeapon);
  const cycle = useWeaponStore((s) => s.cycle);
  const def = getWeapon(currentId);

  // Hero placement — corrects the Mixamo/FBX2glTF export transform (float / facing / size).
  useControls('Hero', {
    character: {
      value: useUIStore.getState().playerCharacter,
      options: Object.keys(PLAYER_CHARACTERS) as PlayerCharacterId[],
      onChange: (v: PlayerCharacterId) => useUIStore.getState().setPlayerCharacter(v),
    },
    yaw: { value: heroTransform.yaw, min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (heroTransform.yaw = v) },
    yOffset: { value: heroTransform.yOffsetAdd, min: -2, max: 2, step: 0.02, onChange: (v: number) => (heroTransform.yOffsetAdd = v) },
    scale: { value: heroTransform.scaleMul, min: 0.1, max: 4, step: 0.05, onChange: (v: number) => (heroTransform.scaleMul = v) },
  });

  // NOTE (Phase 3): the "Attack · speed" (ATTACK_TIMESCALE) and "Attack · lunge"
  // (COMBO_MOVES[].lungeDist) leva panels are GONE — they live-mutated SIM data that the
  // room server also simulates; a client-side tweak would make prediction diverge from
  // authority and reconciliation would fight it (the no-rubberband contract treats that
  // as a correctness bug). Tune those numbers in packages/sim/src/combat/combo.ts.

  useControls(
    'Weapon',
    {
      weapon: {
        value: currentId,
        options: Object.fromEntries(WEAPON_IDS.map((id) => [WEAPONS[id]!.name, id])),
        onChange: (id: string) => {
          if (id !== useWeaponStore.getState().currentId) setWeapon(id);
        },
      },
    },
    [currentId],
  );

  // Grip transform for the CURRENT weapon — writes into the mutable registry entry.
  useControls(
    'Weapon · grip',
    {
      posX: { value: def.attach.position[0], min: -0.5, max: 0.5, step: 0.005, onChange: (v: number) => (def.attach.position[0] = v) },
      posY: { value: def.attach.position[1], min: -0.5, max: 0.5, step: 0.005, onChange: (v: number) => (def.attach.position[1] = v) },
      posZ: { value: def.attach.position[2], min: -0.5, max: 0.5, step: 0.005, onChange: (v: number) => (def.attach.position[2] = v) },
      rotX: { value: def.attach.rotation[0], min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (def.attach.rotation[0] = v) },
      rotY: { value: def.attach.rotation[1], min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (def.attach.rotation[1] = v) },
      rotZ: { value: def.attach.rotation[2], min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (def.attach.rotation[2] = v) },
      scale: { value: def.attach.scale, min: 0.05, max: 5, step: 0.05, onChange: (v: number) => (def.attach.scale = v) },
    },
    [currentId],
  );

  // The sword remains parented to RightHand; this calibrates only its hand-local transform
  // for the Mixamo sword-run pose. Tune while Shift-running, then bake values into weapons.ts.
  useControls(
    'Weapon run grip',
    {
      runPosX: { value: def.runAttach.position[0], min: -0.6, max: 0.8, step: 0.005, onChange: (v: number) => (def.runAttach.position[0] = v) },
      runPosY: { value: def.runAttach.position[1], min: -0.6, max: 0.8, step: 0.005, onChange: (v: number) => (def.runAttach.position[1] = v) },
      runPosZ: { value: def.runAttach.position[2], min: -0.6, max: 0.8, step: 0.005, onChange: (v: number) => (def.runAttach.position[2] = v) },
      runRotX: { value: def.runAttach.rotation[0], min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (def.runAttach.rotation[0] = v) },
      runRotY: { value: def.runAttach.rotation[1], min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (def.runAttach.rotation[1] = v) },
      runRotZ: { value: def.runAttach.rotation[2], min: -Math.PI, max: Math.PI, step: 0.02, onChange: (v: number) => (def.runAttach.rotation[2] = v) },
      runScale: { value: def.runAttach.scale, min: 0.05, max: 5, step: 0.05, onChange: (v: number) => (def.runAttach.scale = v) },
    },
    [currentId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Tab (not Q — Q throws the Relic); prevent the browser's focus traversal.
      if (e.code === 'Tab') {
        e.preventDefault();
        cycle(1);
      } else if (e.code === 'Digit1' && WEAPON_IDS[0]) setWeapon(WEAPON_IDS[0]);
      else if (e.code === 'Digit2' && WEAPON_IDS[1]) setWeapon(WEAPON_IDS[1]);
      else if (e.code === 'Digit3' && WEAPON_IDS[2]) setWeapon(WEAPON_IDS[2]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle, setWeapon]);

  return null;
};
