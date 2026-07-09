import { create } from 'zustand';

/** How long the combo chain stays alive between landed player hits, ms (game time). */
export const COMBO_WINDOW_MS = 1600;

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

  // ── HUD juice: combo counter ──────────────────────────────────────────────
  /** Consecutive landed hits within the combo window. */
  comboCount: number;
  /** gameNow() of the last landed hit (drives the expiry). */
  comboLastAt: number;
  /** Bumps on every landed hit so the HUD can re-trigger its pop animation. */
  comboBumpId: number;

  setHealth: (value: number) => void;
  addMaterials: (n: number) => void;
  setWaveInfo: (wave: number, monstersAlive: number) => void;
  setHuntFailed: (v: boolean) => void;
  /** Register a landed player hit — extends or restarts the combo chain. */
  registerComboHit: (now: number) => void;
  resetCombo: () => void;
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
  comboCount: 0,
  comboLastAt: 0,
  comboBumpId: 0,

  setHealth: (value) => set({ health: value }),
  addMaterials: (n) => set((s) => ({ materials: s.materials + n })),
  setWaveInfo: (wave, monstersAlive) => set({ wave, monstersAlive }),
  setHuntFailed: (v) => set({ huntFailed: v }),
  registerComboHit: (now) =>
    set((s) => {
      const chaining = now - s.comboLastAt <= COMBO_WINDOW_MS;
      return {
        comboCount: chaining ? s.comboCount + 1 : 1,
        comboLastAt: now,
        comboBumpId: s.comboBumpId + 1,
      };
    }),
  resetCombo: () => set({ comboCount: 0 }),
  reset: () =>
    set({
      health: 100,
      materials: 0,
      monstersAlive: 0,
      wave: 1,
      huntFailed: false,
      comboCount: 0,
      comboLastAt: 0,
      comboBumpId: 0,
    }),
}));
