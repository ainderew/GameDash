import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Color } from 'three';
import type { Group, MeshStandardMaterial, PointLight } from 'three';
import { localPlayers } from '@/game/ecs/world';
import { relicNet } from '@/net/relicNet';
import { netClient } from '@/net/client';
import { sampleRelicFlight } from '@sim/combat/passTargeting';
import { sampleWithUnderrunPolicy } from '@sim/interp';
import { INTERP_UNDERRUN_DEADRECKON_MS, INTERP_UNDERRUN_HOLD_MS } from '@shared/net/constants';
import { RELIC_CATCH_SOCKET_Y, RELIC_CORRUPTION_TUNING } from '@shared/balance';
import { useUIStore } from '@/ui/store';
import { CorruptRelicLayer } from '@/game/entities/CorruptRelicLayer';
import { CorruptionPowerVFX } from '@/game/fx/CorruptionPowerVFX';
import { RelicModel } from '@/game/entities/Relic';

/**
 * NETWORKED relic renderer (Phase 6 client presentation). In a connected session the relic is
 * server-authoritative: its phase / carrier / flight arrive as reliable events into `relicNet`,
 * and the whole relay renders from THAT here — never the local sim. This is the double-spawn
 * guard the guardrail calls for: `GameCanvas` mounts the solo `<Relic/>` (which spawns a LOCAL
 * relic ECS entity) only in solo mode and mounts THIS in a networked session, so the server
 * relic is the only one, without editing the art component `Relic.tsx`.
 *
 * Positioning:
 *  - inFlight  → sample the deterministic Bézier/lob at the shared server-tick clock (identical
 *                arc on every screen — `sampleRelicFlight`, the same fn the server homes with).
 *  - carried   → follow the carrier avatar's rendered position (local player transform, or the
 *                remote's interp sample) lifted to the chest socket.
 *  - grounded  → sit at the last known ground position.
 */

const scratch: [number, number, number] = [0, 0, 0];
const CLEAN_GLOW = new Color('#c06cff');
const CORRUPT_GLOW = new Color('#f0008c');

export const NetworkedRelic = () => {
  const group = useRef<Group>(null);
  const spinner = useRef<Group>(null);
  const cleanModel = useRef<Group>(null);
  const shards = useRef<Group>(null);
  const coreMat = useRef<MeshStandardMaterial | null>(null);
  const corruption = useRef(0);
  const held = useRef(false);
  const powerAnchor = useRef<Group>(null);
  const glowLight = useRef<PointLight>(null);
  const session = useUIStore((s) => s.session);

  /** Rendered position of the carrier avatar (local transform or remote interp sample). */
  const carrierPos = (): [number, number, number] | null => {
    const carrierPlayerId = useUIStore.getState().relicCarrier;
    if (!carrierPlayerId || !session) return null;
    if (carrierPlayerId === session.playerId) {
      const p = localPlayers.first;
      return p?.transform
        ? [p.transform.position[0], p.transform.position[1], p.transform.position[2]]
        : null;
    }
    const buffer = netClient.remoteBuffer(carrierPlayerId);
    const sample = sampleWithUnderrunPolicy(
      buffer,
      netClient.renderServerTime(),
      {
        holdMs: INTERP_UNDERRUN_HOLD_MS,
        deadReckonMs: INTERP_UNDERRUN_DEADRECKON_MS,
      },
    );
    return sample ? [sample.pos[0], sample.pos[1], sample.pos[2]] : null;
  };

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const st = relicNet.state;
    if (st.phase === 'absent') {
      corruption.current = 0;
      held.current = false;
      g.visible = false;
      return;
    }
    g.visible = true;
    held.current = st.phase === 'carried';
    const corruptionProgress = Math.max(
      0,
      Math.min(1, st.corruption / RELIC_CORRUPTION_TUNING.max),
    );
    corruption.current = corruptionProgress;
    const corruptionEase = corruptionProgress * corruptionProgress * (3 - 2 * corruptionProgress);

    let holderPosition: [number, number, number] | null = null;
    if (st.phase === 'inFlight' && st.flight) {
      // Shared deterministic arc, sampled at the server-tick clock — identical on all screens.
      sampleRelicFlight(st.flight, netClient.serverNow(), scratch);
      g.position.set(scratch[0], scratch[1], scratch[2]);
    } else if (st.phase === 'carried') {
      const cp = carrierPos();
      holderPosition = cp;
      const target = cp ?? st.pos;
      const ty = cp ? cp[1] + RELIC_CATCH_SOCKET_Y : st.pos[1];
      // Chase the carrier so it drifts like it's held rather than snapping each frame.
      const k = 1 - Math.exp(-12 * dt);
      g.position.x += (target[0] - g.position.x) * k;
      g.position.y += (ty - g.position.y) * k;
      g.position.z += (target[2] - g.position.z) * k;
    } else {
      // grounded
      const k = 1 - Math.exp(-10 * dt);
      g.position.x += (st.pos[0] - g.position.x) * k;
      g.position.y += (st.pos[1] + Math.sin(performance.now() * 0.0022) * 0.07 - g.position.y) * k;
      g.position.z += (st.pos[2] - g.position.z) * k;
    }

    const inFlight = st.phase === 'inFlight';
    if (spinner.current) spinner.current.rotation.y += dt * (inFlight ? 6 : 1.3);
    if (shards.current) shards.current.rotation.y -= dt * (inFlight ? 8 : 2.1);
    if (coreMat.current) {
      coreMat.current.opacity = 1 - corruptionEase * 0.86;
      coreMat.current.emissive.copy(CLEAN_GLOW).lerp(CORRUPT_GLOW, corruptionEase);
      coreMat.current.emissiveIntensity =
        1 + Math.sin(performance.now() * 0.0031) * 0.35 + corruptionEase * 0.65;
    }
    if (cleanModel.current) cleanModel.current.scale.setScalar(1 - corruptionEase * 0.12);
    if (glowLight.current) {
      glowLight.current.color.copy(CLEAN_GLOW).lerp(CORRUPT_GLOW, corruptionEase);
      glowLight.current.intensity = 5 + corruptionEase * 6;
    }
    if (powerAnchor.current && holderPosition) {
      powerAnchor.current.position.set(
        holderPosition[0] - g.position.x,
        holderPosition[1] - g.position.y,
        holderPosition[2] - g.position.z,
      );
    }
  });

  return (
    <group ref={group} visible={false}>
      <pointLight ref={glowLight} color="#a65cff" intensity={5} distance={6.5} decay={2} />
      <group ref={spinner}>
        <group ref={cleanModel}>
          <RelicModel shardsRef={shards} coreMat={coreMat} />
        </group>
        <CorruptRelicLayer progressRef={corruption} />
      </group>
      <group ref={powerAnchor}>
        <CorruptionPowerVFX progressRef={corruption} heldRef={held} groundOffset={0} />
      </group>
    </group>
  );
};
