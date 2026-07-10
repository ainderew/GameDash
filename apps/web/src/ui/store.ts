import { create } from 'zustand';
import type { PlayerCharacterId } from '@/game/entities/characters';
import type { HubStationId } from '@/game/world/hubLayout';

export type GameScene = 'hub' | 'expedition';

/** How long the combo chain stays alive between landed player hits, ms (game time). */
export const COMBO_WINDOW_MS = 1600;

interface UIState {
  /** Current high-level play space. The hub is the default session entry point. */
  scene: GameScene;
  /** Nearby hub landmark, bridged at render rate only when the id changes. */
  hubStation?: HubStationId;
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
  /** Which playable model the avatar uses (all share the hero clip set). */
  playerCharacter: PlayerCharacterId;

  // ── HUD juice: combo counter ──────────────────────────────────────────────
  /** Consecutive landed hits within the combo window. */
  comboCount: number;
  /** gameNow() of the last landed hit (drives the expiry). */
  comboLastAt: number;
  /** Bumps on every landed hit so the HUD can re-trigger its pop animation. */
  comboBumpId: number;

  setHealth: (value: number) => void;
  setScene: (scene: GameScene) => void;
  setHubStation: (station?: HubStationId) => void;
  addMaterials: (n: number) => void;
  setWaveInfo: (wave: number, monstersAlive: number) => void;
  setHuntFailed: (v: boolean) => void;
  setPlayerCharacter: (id: PlayerCharacterId) => void;
  /** Register a landed player hit — extends or restarts the combo chain. */
  registerComboHit: (now: number) => void;
  resetCombo: () => void;
  reset: () => void;
}

/** UI/meta state only. Game simulation lives in the ECS, never here. */
export const useUIStore = create<UIState>((set) => ({
  scene: 'hub',
  hubStation: undefined,
  health: 100,
  maxHealth: 100,
  materials: 0,
  monstersAlive: 0,
  wave: 1,
  huntFailed: false,
  menuOpen: false,
  playerCharacter: 'hero',
  comboCount: 0,
  comboLastAt: 0,
  comboBumpId: 0,

  setHealth: (value) => set({ health: value }),
  setScene: (scene) => set({ scene, hubStation: undefined }),
  setHubStation: (hubStation) => set({ hubStation }),
  addMaterials: (n) => set((s) => ({ materials: s.materials + n })),
  setWaveInfo: (wave, monstersAlive) => set({ wave, monstersAlive }),
  setHuntFailed: (v) => set({ huntFailed: v }),
  setPlayerCharacter: (id) => set({ playerCharacter: id }),
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

// Dev-only console handle (same pattern as window.__world / __cameraRig).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __uiStore?: typeof useUIStore }).__uiStore = useUIStore;
}
