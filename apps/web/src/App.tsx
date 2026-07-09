import { GameCanvas } from '@/game/GameCanvas';
import { CombatHUD } from '@/ui/CombatHUD';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { FeelControls } from '@/game/fx/FeelControls';
import { WeaponControls } from '@/game/fx/WeaponControls';

const DEV = import.meta.env.DEV;

/** Composes the 3D canvas and the DOM HUD overlay — the two-layer architecture. */
export const App = () => {
  return (
    <div className="relative h-full w-full">
      <ErrorBoundary>
        <GameCanvas />
      </ErrorBoundary>
      <CombatHUD />
      {/* Live combat-feel + weapon tuning panels (dev only). */}
      {DEV && <FeelControls />}
      {DEV && <WeaponControls />}
    </div>
  );
};
