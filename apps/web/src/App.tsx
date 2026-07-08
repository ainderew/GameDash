import { GameCanvas } from '@/game/GameCanvas';
import { CombatHUD } from '@/ui/CombatHUD';
import { ErrorBoundary } from '@/ui/ErrorBoundary';

/** Composes the 3D canvas and the DOM HUD overlay — the two-layer architecture. */
export const App = () => {
  return (
    <div className="relative h-full w-full">
      <ErrorBoundary>
        <GameCanvas />
      </ErrorBoundary>
      <CombatHUD />
    </div>
  );
};
