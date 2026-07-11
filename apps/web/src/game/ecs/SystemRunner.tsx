import { useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useRef } from 'react';
import { Vector2, Vector3 } from 'three';
import { cameraRig } from '@/game/camera/cameraRig';
import { events, localPlayers, world } from '@/game/ecs/world';
import { stepSim, type PlayerIntent } from '@sim/step';
import type { Entity } from '@sim/components';
import { impactFxSystem } from '@sim/systems/impactFxSystem';
import { stereoPanFor } from '@sim/combat/passTargeting';
import { updatePassControl } from '@/game/combat/passControl';
import { passAim } from '@/game/combat/passAim';
import { currentWeapon } from '@/game/combat/weaponStore';
import { clientSimHooks } from '@/game/feel/simHooks';
import { playPassChime, playPassFail, playRelicPickup, playWhoosh } from '@/game/feel/audio';
import { RELIC_AIM_MOVE_SCALE } from '@shared/balance';
import { useInput } from '@/game/input/useInput';
import { useUIStore, COMBO_WINDOW_MS, type GameScene } from '@/ui/store';
import { advanceTime, gameNow, syncGameTime } from '@/game/feel/time';
import { createSimStepper } from '@sim/loop';
import { MS_PER_TICK, SIM_HZ } from '@shared/net/constants';
import { netGame } from '@/net/netGame';
import { netClient } from '@/net/client';

/** Bridge ECS player HP → store at ~10Hz, not every frame. */
const HP_BRIDGE_INTERVAL = 0.1;

/**
 * THE CLIENT ADAPTER around the headless sim. The tick itself — system order, combat,
 * relic, spawning — lives in @sim/step (stepSim, the same code a room server runs);
 * this component only:
 *   1. gathers local input into a PlayerIntent (camera-relative WASD, cursor aim),
 *   2. advances the game clock (hitstop/slow-mo still freeze the LOCAL sim — behavior
 *      Phase 4 flips to presentation-only for multiplayer),
 *   3. calls stepSim with the client feel hooks,
 *   4. feeds drained events to audio/UI and bridges HP/wave state to the HUD store.
 *
 * TIME: the sim runs on the game clock (`gameNow`), advanced here by the SCALED delta.
 * During hitstop the scale is 0 → stepSim freezes on one frame, while the feel FX
 * (sparks, shake, audio) keep animating on real time in their own hooks.
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
 * Local input → world-space movement intent. WASD is CAMERA-RELATIVE: rotate the input
 * axes by the orbit yaw so "forward" is always away from the camera, wherever the mouse
 * spun it. The vector is pre-normalized (or zero). Shared by BOTH drivers — networked
 * play quantizes exactly this vector onto the wire.
 */
const buildMoveIntent = (i: {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  dodge: boolean;
  sprint: boolean;
}): { moveX: number; moveZ: number; jump: boolean; dodge: boolean; sprint: boolean } => {
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
  return { moveX, moveZ, jump: i.jump, dodge: i.dodge, sprint: i.sprint };
};

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

export const SystemRunner = ({ mode = 'expedition' }: { mode?: GameScene }) => {
  const input = useInput();
  const hpBridgeAcc = useRef(0);
  // Reused per frame — one local player, one intent. (Melee buffering lives ON the
  // entity inside the sim now, so a pressed-but-locked-out swing still never drops.)
  const intents = useRef(new Map<Entity, PlayerIntent>());
  // Networked driver state: fixed 30 Hz stepper (same code the server ticks with).
  const stepper = useRef(createSimStepper({ hz: SIM_HZ }));
  const wasNetworked = useRef(false);

  useFrame((state, rawDt) => {
    // ── DRIVER SPLIT (Phase 3, Task 7) ─────────────────────────────────────────
    // 'networked': in a connected session (hub scope for now) the server owns the sim;
    // this client sends InputCmds at a fixed 30 Hz and PREDICTS the local player through
    // the same stepSim. 'local': solo play keeps the exact per-frame variable-dt path
    // below — same sim, no transport.
    const session = useUIStore.getState().session;
    const networked =
      mode === 'hub' && session !== undefined && useUIStore.getState().connectionState === 'connected';

    if (networked) {
      const player = localPlayers.first;
      if (!player) return;
      if (!netGame.active) {
        netGame.start(world, events, player, netClient.sendInput);
        stepper.current.reset();
        wasNetworked.current = true;
      }
      const i = input.current;
      stepper.current.advance(Math.min(rawDt, 1 / 20), () => {
        // Movement intent (camera-relative, pre-normalized) — combat verbs are hub-muted.
        const intent = buildMoveIntent(i);
        i.jump = false;
        i.pass = false;
        i.melee = false;
        i.ranged = false;
        i.parry = false;
        i.drop = false;
        netGame.clientTick(intent);
      });
      // Renderers read gameNow(): keep it on the tick timeline (+ remainder for smoothness).
      syncGameTime(netGame.tickTimeMs + stepper.current.alpha * MS_PER_TICK);
      return;
    }
    if (wasNetworked.current) {
      wasNetworked.current = false;
      netGame.stop();
    }

    // Advance the game clock; hitstop/slow-mo live inside advanceTime. LOCAL-ONLY:
    // freezing the sim clock is single-player juice — a shared world must never stop
    // (Phase 4 moves hitstop to the presentation layer; the server ticks via @sim/loop).
    const { scaledDt } = advanceTime(Math.min(rawDt, 1 / 20));
    const dt = scaledDt;
    const now = gameNow();
    const realNow = performance.now();
    const i = input.current;

    const player = localPlayers.first;
    if (!player) return;

    // Loadout sync: the sim reads melee reach from the entity, not the zustand store.
    player.weaponReachMul = currentWeapon().reachMul;

    // Local input → PlayerIntent (camera-relative WASD via the shared helper).
    const move = buildMoveIntent(i);
    // Aiming a pass steadies the carrier: 80% speed, still fully mobile.
    if (passAim.aiming) {
      move.moveX *= RELIC_AIM_MOVE_SCALE;
      move.moveZ *= RELIC_AIM_MOVE_SCALE;
    }

    const intent: PlayerIntent = move;

    if (mode === 'hub') {
      // The hub is the safe social space — combat/relic inputs are swallowed here and
      // ignored by stepSim's hub branch either way.
      i.pass = false;
    } else {
      // Attacks aim at the cursor: the swing/projectile fires toward the ground point
      // under the mouse, snapping the facing the instant the attack starts.
      intent.aimAt = cursorGroundPoint(state, player.transform.position[1]);
      intent.melee = i.melee;
      intent.ranged = i.ranged;
      intent.parry = i.parry;
      intent.drop = i.drop;
      // Relic pass: E tap = quick pass, hold = soft-lock aim mode, release = throw.
      // The state machine is client UI (camera cone, markers); its OUTPUT — "pass to
      // this receiver now" — is the intent the sim executes.
      intent.passTo = updatePassControl(world, player, i.pass, now);
      intent.passAiming = passAim.aiming;
    }
    i.jump = false;
    i.melee = false;
    i.ranged = false;
    i.parry = false;
    i.drop = false;

    intents.current.clear();
    intents.current.set(player, intent);

    // THE tick — identical code to what the room server will run.
    const drained = stepSim(world, events, intents.current, dt, now, mode, clientSimHooks);

    // Impact FX age on REAL time so they finish bursting during hitstop (render concern,
    // so it stays outside stepSim — the server never has impactFx entities).
    impactFxSystem(world, realNow);

    if (mode === 'hub') return;

    // Event feedback: audio + HUD reactions to what the sim decided this tick.
    if (drained.length > 0) {
      const store = useUIStore.getState();
      let gained = 0;
      for (const ev of drained) {
        if (ev.type === 'MaterialCollected') gained += 1;
        else if (ev.type === 'PlayerDowned') store.setHuntFailed(true);
        else if (ev.type === 'RelicPassLaunched') {
          // Thrower/world feedback: every launch whooshes. Receiver feedback: a soft
          // chime panned toward where the throw came from (only when WE receive).
          playWhoosh('light');
          if (ev.toLocalPlayer && player.transform) {
            playPassChime(stereoPanFor(player.transform.position, ev.from, cameraRig.yaw));
          }
        } else if (ev.type === 'RelicPassFailed') {
          playPassFail();
        } else if (ev.type === 'RelicCaught' && ev.byLocalPlayer) {
          // Reward stinger for the local player claiming the Relic — teammate/enemy
          // catches stay silent so the sound always means "you have it".
          playRelicPickup();
        }
      }
      if (gained > 0) store.addMaterials(gained);
    }

    // HUD bridge (throttled): player HP + wave counter + combo expiry.
    hpBridgeAcc.current += Math.min(rawDt, 1 / 20);
    if (hpBridgeAcc.current >= HP_BRIDGE_INTERVAL) {
      hpBridgeAcc.current = 0;
      const store = useUIStore.getState();
      if (player.health) store.setHealth(player.health.current);
      store.setWaveInfo(world.spawn.wave, world.with('monster').entities.length);
      // Drop the combo when the window lapses (uses game time so hitstop doesn't count).
      if (store.comboCount > 0 && now - store.comboLastAt > COMBO_WINDOW_MS) store.resetCombo();
    }
  }, SIM_PRIORITY);

  return null;
};
