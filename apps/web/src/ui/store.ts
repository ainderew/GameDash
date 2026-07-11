import { create } from 'zustand';
import type { PlayerCharacterId } from '@/game/entities/characters';
import type { HubStationId } from '@/game/world/hubLayout';

export type GameScene = 'hub' | 'expedition';

/** Top-level app screen: menu → (first-time) intro → playing. */
export type AppScreen = 'menu' | 'intro' | 'playing';

const INTRO_SEEN_KEY = 'gd_intro_seen_v1';
const readIntroSeen = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
};

/** How long the combo chain stays alive between landed player hits, ms (game time). */
export const COMBO_WINDOW_MS = 1600;

// ── Multiplayer session (UI mirror only — net GAMEPLAY state goes to the ECS) ─
export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface SessionMemberUI {
  id: string;
  name: string;
  /** CharacterId string from the wire (validated at render time). */
  character: string;
  /** The member's avatar entity id in the session world (snapshot records address it). */
  entityId: number;
  /** EWMA RTT ms; null until the first heartbeat round-trip / while unknown. */
  ping: number | null;
  connected: boolean;
}

export interface SessionUI {
  code: string;
  /** OUR playerId within the session. */
  playerId: string;
  members: SessionMemberUI[];
}

interface UIState {
  /** Main menu vs in-game. The 3D world only mounts once the player hits PLAY. */
  screen: AppScreen;
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

  /** True once the first-time intro cinematic has played (persisted). */
  hasSeenIntro: boolean;
  /** Where finishing/skipping the intro should land — 'playing' for the real first-time
   * flow, 'menu' when replayed from Settings so tuning loops back to the menu. */
  introReturnTo: AppScreen;

  // ── Multiplayer session (Phase 2). Updates are inherently throttled: roster at
  // ~1 Hz (sessionState broadcast), own ping every 2 s heartbeat — never per frame. ──
  connectionState: ConnectionState;
  session?: SessionUI;
  /** Last net-layer error for the menu/session UI (join failed, server down…). */
  netError?: string;

  // ── HUD juice: combo counter ──────────────────────────────────────────────
  /** Consecutive landed hits within the combo window. */
  comboCount: number;
  /** gameNow() of the last landed hit (drives the expiry). */
  comboLastAt: number;
  /** Bumps on every landed hit so the HUD can re-trigger its pop animation. */
  comboBumpId: number;

  setConnectionState: (state: ConnectionState) => void;
  setSession: (session?: SessionUI) => void;
  setSessionMembers: (members: SessionMemberUI[]) => void;
  addSessionMember: (member: SessionMemberUI) => void;
  removeSessionMember: (id: string) => void;
  /** Own EWMA ping, updated from every heartbeat ping's `yourPing` echo. */
  setOwnPing: (ping: number | null) => void;
  setNetError: (message?: string) => void;

  setHealth: (value: number) => void;
  setScreen: (screen: AppScreen) => void;
  setScene: (scene: GameScene) => void;
  setHubStation: (station?: HubStationId) => void;
  addMaterials: (n: number) => void;
  setWaveInfo: (wave: number, monstersAlive: number) => void;
  setHuntFailed: (v: boolean) => void;
  setPlayerCharacter: (id: PlayerCharacterId) => void;
  /** Enter the intro cinematic; `returnTo` is where finishing/skipping lands. */
  startIntro: (returnTo: AppScreen) => void;
  /** Mark the intro seen and advance to wherever it was told to return. */
  finishIntro: () => void;
  /** Register a landed player hit — extends or restarts the combo chain. */
  registerComboHit: (now: number) => void;
  resetCombo: () => void;
  reset: () => void;
}

/** UI/meta state only. Game simulation lives in the ECS, never here. */
export const useUIStore = create<UIState>((set) => ({
  screen: 'menu',
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
  hasSeenIntro: readIntroSeen(),
  introReturnTo: 'playing',
  comboCount: 0,
  comboLastAt: 0,
  comboBumpId: 0,
  connectionState: 'offline',
  session: undefined,
  netError: undefined,

  setConnectionState: (connectionState) => set({ connectionState }),
  setSession: (session) => set({ session, netError: undefined }),
  setSessionMembers: (members) =>
    set((s) => (s.session ? { session: { ...s.session, members } } : {})),
  addSessionMember: (member) =>
    set((s) => {
      if (!s.session) return {};
      const others = s.session.members.filter((m) => m.id !== member.id);
      return { session: { ...s.session, members: [...others, member] } };
    }),
  removeSessionMember: (id) =>
    set((s) =>
      s.session
        ? { session: { ...s.session, members: s.session.members.filter((m) => m.id !== id) } }
        : {},
    ),
  setOwnPing: (ping) =>
    set((s) => {
      if (!s.session) return {};
      const members = s.session.members.map((m) =>
        m.id === s.session!.playerId ? { ...m, ping } : m,
      );
      return { session: { ...s.session, members } };
    }),
  setNetError: (netError) => set({ netError }),

  setHealth: (value) => set({ health: value }),
  setScreen: (screen) => set({ screen }),
  setScene: (scene) => set({ scene, hubStation: undefined }),
  setHubStation: (hubStation) => set({ hubStation }),
  addMaterials: (n) => set((s) => ({ materials: s.materials + n })),
  setWaveInfo: (wave, monstersAlive) => set({ wave, monstersAlive }),
  setHuntFailed: (v) => set({ huntFailed: v }),
  setPlayerCharacter: (id) => set({ playerCharacter: id }),
  startIntro: (returnTo) => set({ screen: 'intro', introReturnTo: returnTo }),
  finishIntro: () =>
    set((s) => {
      try {
        window.localStorage.setItem(INTRO_SEEN_KEY, '1');
      } catch {
        /* private mode / storage disabled — non-fatal */
      }
      return { screen: s.introReturnTo, hasSeenIntro: true };
    }),
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
