import { GameCanvas } from '@/game/GameCanvas';
import { CombatHUD } from '@/ui/CombatHUD';
import { DebugMenu } from '@/ui/DebugMenu';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { FeelControls } from '@/game/fx/FeelControls';
import { WeaponControls } from '@/game/fx/WeaponControls';
import { HubHUD } from '@/ui/HubHUD';
import { MainMenu } from '@/ui/MainMenu';
import { NetDebugOverlay } from '@/ui/NetDebugOverlay';
import { PingCard } from '@/ui/PingCard';
import { PartyHUD } from '@/ui/PartyHUD';
import { ReconnectOverlay } from '@/ui/ReconnectOverlay';
import { IntroSequence } from '@/ui/intro/IntroSequence';
import { ExpeditionResults } from '@/ui/ExpeditionResults';
import { useUIStore } from '@/ui/store';
import { CorruptionVignette } from '@/game/fx/CorruptionVignette';

const DEV = import.meta.env.DEV;

/** Composes the 3D canvas and the DOM HUD overlay — the two-layer architecture.
 * The main menu gates it all: the game world doesn't mount until PLAY. */
export const App = () => {
  const screen = useUIStore((state) => state.screen);
  const scene = useUIStore((state) => state.scene);

  if (screen === 'menu') {
    return (
      <div className="relative h-full w-full">
        <ErrorBoundary>
          <MainMenu />
        </ErrorBoundary>
      </div>
    );
  }

  if (screen === 'intro') {
    return (
      <div className="relative h-full w-full">
        <ErrorBoundary>
          <IntroSequence />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <ErrorBoundary>
        <GameCanvas />
      </ErrorBoundary>
      {scene === 'hub' ? <HubHUD /> : <CombatHUD />}
      {scene === 'expedition' && <CorruptionVignette />}
      {/* Party roster: teammate names, HP, relic carrier, live ping (self-hides when solo). */}
      <PartyHUD />
      {/* Session ping card (DOM overlay, self-hides when not in a session). */}
      <PingCard />
      {/* Mid-game reconnect scrim (self-hides unless reconnecting inside a session). */}
      <ReconnectOverlay />
      {/* Server-authored multiplayer standings + MVP, retained across the hub transition. */}
      <ExpeditionResults />
      {/* F3 netcode telemetry (ping/interp/snapshot/corrections KPI). */}
      <NetDebugOverlay />
      {/* Live combat-feel + weapon tuning panels + debug menu (dev only). */}
      {DEV && scene === 'expedition' && <FeelControls />}
      {DEV && scene === 'expedition' && <WeaponControls />}
      {DEV && scene === 'expedition' && <DebugMenu />}
    </div>
  );
};
