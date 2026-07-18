import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import { gameNow } from '@/game/feel/time';
import { takePendingDashGhosts, type DashGhost } from '@/game/fx/dashGhostQueue';

/**
 * WORLD-LEVEL enemy dash-slash afterimages. Renders the violet frozen-pose clones MutantModels
 * emits on a dash hit, flying each further back than the real body and fading it out. Living
 * here (not inside the per-enemy component) is what lets an afterimage keep flying after a
 * lethal hit removes the enemy. Uses the GAME clock so the fly-back waits out the hitstop freeze.
 */
export const EnemyDashGhosts = () => {
  const groupRef = useRef<Group>(null);
  const active = useRef<DashGhost[]>([]);

  useFrame(() => {
    const parent = groupRef.current;
    if (!parent) return;
    const now = gameNow();

    // Adopt newly-emitted ghosts (start hidden until their staggered spawn time).
    for (const g of takePendingDashGhosts()) {
      g.root.visible = false;
      parent.add(g.root);
      active.current.push(g);
    }

    for (let i = active.current.length - 1; i >= 0; i--) {
      const g = active.current[i]!;
      const age = (now - g.spawnAt) / g.lifeMs;
      if (age < 0) {
        g.root.visible = false; // staggered afterimage not started yet
        continue;
      }
      if (age >= 1) {
        parent.remove(g.root);
        g.mats.forEach((m) => m.dispose());
        active.current.splice(i, 1);
        continue;
      }
      const eased = 1 - (1 - age) * (1 - age); // easeOut fling
      const back = eased * g.backDist;
      g.root.visible = true;
      g.root.position.set(g.base.x + g.dir[0] * back, g.base.y, g.base.z + g.dir[1] * back);
      g.root.rotation.y = g.rotY;
      g.root.scale.copy(g.scale);
      const op = (1 - age) * g.maxOpacity;
      for (const m of g.mats) m.opacity = op;
    }
  });

  return <group ref={groupRef} />;
};
