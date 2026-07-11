/**
 * @friendslop/sim — the headless, transport-agnostic gameplay simulation.
 * Runs identically inside the browser client (prediction) and the Node room server
 * (authority). No three/react/DOM in here — ever (lint- and lib-enforced).
 */

export * from './components';
export * from './world';
export * from './events';
export * from './hooks';
export * from './step';
export * from './loop';
export * from './interp';

export * from './terrain/terrainHeight';
export * from './terrain/hubCollision';

export * from './combat/combo';
export * from './combat/passTargeting';

export * from './systems/movementSystem';
export * from './systems/weaponSystem';
export * from './systems/projectileSystem';
export * from './systems/relicSystem';
export * from './systems/teammateSystem';
export * from './systems/aiSystem';
export * from './systems/knockbackSystem';
export * from './systems/separationSystem';
export * from './systems/combatHelpers';
export * from './systems/impactFxSystem';
export * from './systems/healthSystem';
export * from './systems/lootSystem';
export * from './systems/spawnSystem';
