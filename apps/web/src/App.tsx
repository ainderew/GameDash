import { GameCanvas } from '@/game/GameCanvas';
import { CombatHUD } from '@/ui/CombatHUD';
import { DebugMenu } from '@/ui/DebugMenu';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { FeelControls } from '@/game/fx/FeelControls';
import { WeaponControls } from '@/game/fx/WeaponControls';
import { HubHUD } from '@/ui/HubHUD';
import { useUIStore } from '@/ui/store';

const DEV = import.meta.env.DEV;

/** Composes the 3D canvas and the DOM HUD overlay — the two-layer architecture. */
export const App = () => {
  const scene = useUIStore((state) => state.scene);

  return (
    <div className="relative h-full w-full">
      <ErrorBoundary>
        <GameCanvas />
      </ErrorBoundary>
      {scene === 'hub' ? <HubHUD /> : <CombatHUD />}
      {/* Live combat-feel + weapon tuning panels + debug menu (dev only). */}
      {DEV && scene === 'expedition' && <FeelControls />}
      {DEV && scene === 'expedition' && <WeaponControls />}
      {DEV && scene === 'expedition' && <DebugMenu />}
    </div>
  );
};
