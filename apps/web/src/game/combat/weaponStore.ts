import { create } from 'zustand';
import { DEFAULT_WEAPON_ID, WEAPON_IDS, getWeapon, type WeaponDef } from '@/game/combat/weapons';

/**
 * Which weapon the player is currently wielding. Separate from the ECS (it's loadout/meta,
 * not simulation) and from the feel config (it's not a tuning value). The renderer reads
 * `current()` to mount the mesh; the weapon system reads it for reach.
 */
interface WeaponState {
  currentId: string;
  setWeapon: (id: string) => void;
  cycle: (dir: number) => void;
}

export const useWeaponStore = create<WeaponState>((set) => ({
  currentId: DEFAULT_WEAPON_ID,
  setWeapon: (id) => set({ currentId: id }),
  cycle: (dir) =>
    set((s) => {
      const i = WEAPON_IDS.indexOf(s.currentId);
      const next = (i + dir + WEAPON_IDS.length) % WEAPON_IDS.length;
      return { currentId: WEAPON_IDS[next]! };
    }),
}));

/** Non-reactive accessor for the current WeaponDef (use inside useFrame/systems). */
export const currentWeapon = (): WeaponDef => getWeapon(useWeaponStore.getState().currentId);
