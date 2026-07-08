import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { world } from '@/game/ecs/world';
import { applyPlayerIntent, movementSystem } from '@/game/ecs/systems/movementSystem';
import { fireRanged, startMelee, weaponSystem } from '@/game/ecs/systems/weaponSystem';
import { projectileSystem } from '@/game/ecs/systems/projectileSystem';
import { aiSystem } from '@/game/ecs/systems/aiSystem';
import { separationSystem } from '@/game/ecs/systems/separationSystem';
import { floatingNumberSystem } from '@/game/ecs/systems/combatHelpers';
import { healthSystem } from '@/game/ecs/systems/healthSystem';
import { pickupSystem, spawnPickupsFromEvents } from '@/game/ecs/systems/lootSystem';
import { createSpawnState, spawnSystem } from '@/game/ecs/systems/spawnSystem';
import { drainEvents } from '@/game/events';
import { useInput } from '@/game/input/useInput';
import { useUIStore } from '@/ui/store';

const players = world.with('transform', 'velocity', 'playerControlled');

/** Bridge ECS player HP → store at ~10Hz, not every frame. */
const HP_BRIDGE_INTERVAL = 0.1;

/**
 * The single per-frame tick. Runs game systems in explicit, deterministic order.
 * ANTI-PATTERN: don't scatter useFrame across entities — order must be deterministic.
 */
export const SystemRunner = () => {
  const input = useInput();
  const spawnState = useRef(createSpawnState());
  const hpBridgeAcc = useRef(0);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    const now = performance.now();
    const i = input.current;

    // 1. Spawning.
    spawnSystem(world, now, spawnState.current);

    // 2. Player intent (movement + attacks).
    let moveX = (i.right ? 1 : 0) - (i.left ? 1 : 0);
    let moveZ = (i.backward ? 1 : 0) - (i.forward ? 1 : 0);
    const len = Math.hypot(moveX, moveZ);
    if (len > 0) {
      moveX /= len;
      moveZ /= len;
    }
    const intent = { moveX, moveZ, jump: i.jump, dodge: i.dodge };
    for (const player of players) {
      applyPlayerIntent(player, intent, now);
      if (i.melee) startMelee(player, now);
      if (i.ranged) fireRanged(world, player, now);
    }
    i.jump = false;
    i.melee = false;
    i.ranged = false;

    // 3. AI → 4. weapons → 5. projectiles → 6. movement.
    aiSystem(world, dt, now);
    weaponSystem(world, now);
    projectileSystem(world, dt, now);
    movementSystem(world, dt);
    separationSystem(world); // resolve overlaps after integration

    // 7. Death resolution (emits LootDropped / PlayerDowned).
    healthSystem(world);
    floatingNumberSystem(world, now);

    // 8. Pickups (collect → emits MaterialCollected).
    pickupSystem(world);

    // 9. Drain events: spawn pickups, tally materials, handle player death.
    const events = drainEvents();
    if (events.length > 0) {
      spawnPickupsFromEvents(world, events);
      const store = useUIStore.getState();
      let gained = 0;
      for (const ev of events) {
        if (ev.type === 'MaterialCollected') gained += 1;
        else if (ev.type === 'PlayerDowned') store.setHuntFailed(true);
      }
      if (gained > 0) store.addMaterials(gained);
    }

    // 10. HUD bridge (throttled): player HP + wave counter.
    hpBridgeAcc.current += dt;
    if (hpBridgeAcc.current >= HP_BRIDGE_INTERVAL) {
      hpBridgeAcc.current = 0;
      const store = useUIStore.getState();
      const player = players.first;
      if (player?.health) store.setHealth(player.health.current);
      store.setWaveInfo(spawnState.current.wave, world.with('monster').entities.length);
    }
  });

  return null;
};
