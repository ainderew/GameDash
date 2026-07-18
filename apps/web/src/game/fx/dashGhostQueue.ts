import type { MeshBasicMaterial, Object3D, Vector3 } from 'three';

/**
 * A single violet afterimage of an enemy struck by the dash-slash: a frozen-pose clone of
 * its mesh that flies further back than the real body and fades. Emitted by MutantModels the
 * instant a dash hit lands, but OWNED by the world-level <EnemyDashGhosts> renderer — so it
 * survives the enemy dying and unmounting (the "even when they die" requirement).
 */
export interface DashGhost {
  root: Object3D;
  mats: MeshBasicMaterial[];
  /** gameNow() ms at which it starts flying (staggered per afterimage). */
  spawnAt: number;
  base: Vector3;
  dir: [number, number];
  rotY: number;
  scale: Vector3;
  lifeMs: number;
  backDist: number;
  maxOpacity: number;
}

// Hand-off queue: MutantModels pushes, <EnemyDashGhosts> drains each frame.
const pending: DashGhost[] = [];

export const emitDashGhost = (g: DashGhost): void => {
  pending.push(g);
};

/** Drain everything queued since the last call (empties the queue). */
export const takePendingDashGhosts = (): DashGhost[] => pending.splice(0, pending.length);
