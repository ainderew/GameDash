import { create } from 'zustand';

interface UIState {
  /** Player health for the HUD bar. Bridged from the ECS at ~10Hz. */
  health: number;
  maxHealth: number;
  /** Provisional local material count (Phase 3 makes this server-authoritative). */
  materials: number;
  /** Monsters currently alive (for the wave counter). */
  monstersAlive: number;
  /** Current wave number (1-indexed for display). */
  wave: number;
  /** True once the player is downed — shows the "hunt failed" overlay. */
  huntFailed: boolean;
  menuOpen: boolean;

  setHealth: (value: number) => void;
  addMaterials: (n: number) => void;
  setWaveInfo: (wave: number, monstersAlive: number) => void;
  setHuntFailed: (v: boolean) => void;
  reset: () => void;
}

/** UI/meta state only. Game simulation lives in the ECS, never here. */
export const useUIStore = create<UIState>((set) => ({
  health: 100,
  maxHealth: 100,
  materials: 0,
  monstersAlive: 0,
  wave: 1,
  huntFailed: false,
  menuOpen: false,

  setHealth: (value) => set({ health: value }),
  addMaterials: (n) => set((s) => ({ materials: s.materials + n })),
  setWaveInfo: (wave, monstersAlive) => set({ wave, monstersAlive }),
  setHuntFailed: (v) => set({ huntFailed: v }),
  reset: () =>
    set({ health: 100, materials: 0, monstersAlive: 0, wave: 1, huntFailed: false }),
}));
