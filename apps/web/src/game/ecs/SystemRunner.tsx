import { useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useRef } from 'react';
import { Vector2, Vector3 } from 'three';
import { cameraRig } from '@/game/camera/cameraRig';
import { world } from '@/game/ecs/world';
import { applyPlayerIntent, movementSystem } from '@/game/ecs/systems/movementSystem';
import { fireRanged, MELEE_BUFFER_MS, startMelee, weaponSystem } from '@/game/ecs/systems/weaponSystem';
import { projectileSystem } from '@/game/ecs/systems/projectileSystem';
import { aiSystem } from '@/game/ecs/systems/aiSystem';
import { knockbackSystem } from '@/game/ecs/systems/knockbackSystem';
import { separationSystem } from '@/game/ecs/systems/separationSystem';
import { floatingNumberSystem } from '@/game/ecs/systems/combatHelpers';
import { impactFxSystem } from '@/game/ecs/systems/impactFxSystem';
import { healthSystem } from '@/game/ecs/systems/healthSystem';
import { pickupSystem, spawnPickupsFromEvents } from '@/game/ecs/systems/lootSystem';
import { createSpawnState, spawnSystem } from '@/game/ecs/systems/spawnSystem';
import { drainEvents } from '@/game/events';
import { useInput } from '@/game/input/useInput';
import { useUIStore, COMBO_WINDOW_MS } from '@/ui/store';
import { advanceTime, gameNow } from '@/game/feel/time';
import { feel } from '@/game/feel/config';

const players = world.with('transform', 'velocity', 'playerControlled');

/** Bridge ECS player HP → store at ~10Hz, not every frame. */
const HP_BRIDGE_INTERVAL = 0.1;

/**
 * The single per-frame tick. Runs game systems in explicit, deterministic order.
 * ANTI-PATTERN: don't scatter useFrame across entities — order must be deterministic.
 *
 * TIME: the sim runs on the game clock (`gameNow`), advanced here by the SCALED delta.
 * During hitstop the scale is 0 → every system below effectively freezes on one frame,
 * while the feel FX (sparks, shake, audio) keep animating on real time in their own hooks.
 */

/**
 * Run the sim BEFORE every renderer useFrame (negative r3f priority; auto-render is only
 * disabled for priorities > 0). Without this, components mounted before SystemRunner
 * (Player, AnimatedCharacter, FX) read last frame's ECS state — a full frame of input lag
 * between pressing attack and the animation starting.
 */
const SIM_PRIORITY = -100;

const aimVec = new Vector3();
const CENTER_NDC = new Vector2(0, 0);

/**
 * World-space ground point (XZ) attacks aim at: the camera ray through the mouse cursor
 * intersected with the horizontal plane at the player's feet. While the pointer is LOCKED
 * (mouse-look mode) there is no cursor — aim through the screen center instead, i.e.
 * attacks fire where the camera looks, AAA style.
 */
const cursorGroundPoint = (state: RootState, groundY: number): [number, number] | undefined => {
  const ndc = document.pointerLockElement ? CENTER_NDC : state.pointer;
  state.raycaster.setFromCamera(ndc, state.camera);
  const { origin, direction } = state.raycaster.ray;
  if (Math.abs(direction.y) < 1e-6) return undefined; // ray parallel to the ground
  const t = (groundY - origin.y) / direction.y;
  if (t <= 0) return undefined; // plane is behind the camera
  aimVec.copy(direction).multiplyScalar(t).add(origin);
  return [aimVec.x, aimVec.z];
};

export const SystemRunner = () => {
  const input = useInput();
  const spawnState = useRef(createSpawnState());
  const hpBridgeAcc = useRef(0);
  // A melee press during the swing lockout is held here and fired the moment the lockout
  // ends (input buffering) — mashing never drops a press that lands within the buffer.
  const meleeBufferedAt = useRef(-Infinity);

  useFrame((state, rawDt) => {
    // Advance the game clock; hitstop/slow-mo live inside advanceTime.
    const { scaledDt } = advanceTime(Math.min(rawDt, 1 / 20));
    const dt = scaledDt;
    const now = gameNow();
    const realNow = performance.now();
    const i = input.current;

    // 1. Spawning.
    spawnSystem(world, now, spawnState.current);

    // 2. Player intent (movement + attacks + parry).
    // WASD is CAMERA-RELATIVE: rotate the input axes by the orbit yaw so "forward" is
    // always away from the camera, wherever the mouse has spun it.
    const ix = (i.right ? 1 : 0) - (i.left ? 1 : 0);
    const iz = (i.forward ? 1 : 0) - (i.backward ? 1 : 0);
    const fwdX = -Math.sin(cameraRig.yaw); // ground-projected camera forward
    const fwdZ = -Math.cos(cameraRig.yaw);
    const rightX = -fwdZ; // forward × up
    const rightZ = fwdX;
    let moveX = rightX * ix + fwdX * iz;
    let moveZ = rightZ * ix + fwdZ * iz;
    const len = Math.hypot(moveX, moveZ);
    if (len > 0) {
      moveX /= len;
      moveZ /= len;
    }
    const intent = { moveX, moveZ, jump: i.jump, dodge: i.dodge, sprint: i.sprint };
    for (const player of players) {
      applyPlayerIntent(player, intent, now);
      // Attacks aim at the cursor: the swing/projectile fires toward the ground point
      // under the mouse, snapping the facing the instant the attack starts.
      const aim = cursorGroundPoint(state, player.transform.position[1]);
      if (i.melee) meleeBufferedAt.current = now;
      if (now - meleeBufferedAt.current <= MELEE_BUFFER_MS && startMelee(world, player, now, aim)) {
        meleeBufferedAt.current = -Infinity;
      }
      if (i.ranged) fireRanged(world, player, now, aim);
      // Parry: open a brief block window at will; a hit inside it is negated + punished.
      if (i.parry && feel.parry.enabled) player.blockingUntil = now + feel.parry.windowMs;
    }
    i.jump = false;
    i.melee = false;
    i.ranged = false;
    i.parry = false;

    // 3. AI → 4. weapons → 5. knockback → 6. projectiles → 7. movement.
    aiSystem(world, dt, now);
    weaponSystem(world, now);
    knockbackSystem(world, dt, now); // drives staggered targets before integration
    projectileSystem(world, dt, now);
    movementSystem(world, dt);
    separationSystem(world); // resolve overlaps after integration

    // 8. Death resolution (emits LootDropped / PlayerDowned).
    healthSystem(world);
    floatingNumberSystem(world, now);
    impactFxSystem(world, realNow); // real-time cleanup so FX finish during hitstop

    // 9. Pickups (collect → emits MaterialCollected).
    pickupSystem(world);

    // 10. Drain events: spawn pickups, tally materials, handle player death.
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

    // 11. HUD bridge (throttled): player HP + wave counter + combo expiry.
    hpBridgeAcc.current += Math.min(rawDt, 1 / 20);
    if (hpBridgeAcc.current >= HP_BRIDGE_INTERVAL) {
      hpBridgeAcc.current = 0;
      const store = useUIStore.getState();
      const player = players.first;
      if (player?.health) store.setHealth(player.health.current);
      store.setWaveInfo(spawnState.current.wave, world.with('monster').entities.length);
      // Drop the combo when the window lapses (uses game time so hitstop doesn't count).
      if (store.comboCount > 0 && now - store.comboLastAt > COMBO_WINDOW_MS) store.resetCombo();
    }
  }, SIM_PRIORITY);

  return null;
};
