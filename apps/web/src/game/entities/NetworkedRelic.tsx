import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color } from 'three';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { localPlayers } from '@/game/ecs/world';
import { relicNet } from '@/net/relicNet';
import { netClient } from '@/net/client';
import { sampleRelicFlight } from '@sim/combat/passTargeting';
import { sampleWithUnderrunPolicy } from '@sim/interp';
import { INTERP_UNDERRUN_DEADRECKON_MS, INTERP_UNDERRUN_HOLD_MS } from '@shared/net/constants';
import { RELIC_CATCH_SOCKET_Y } from '@shared/balance';
import { useGameModel } from '@/lib/loaders';
import { useUIStore } from '@/ui/store';

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

const CORE_PATH = '/models/relic/violet_relic_crystal.glb';
useGameModel.preload(CORE_PATH);

const scratch: [number, number, number] = [0, 0, 0];

export const NetworkedRelic = () => {
  const group = useRef<Group>(null);
  const spinner = useRef<Group>(null);
  const coreMat = useRef<MeshStandardMaterial | null>(null);
  const gltf = useGameModel(CORE_PATH);
  const session = useUIStore((s) => s.session);

  const core = useMemo(() => {
    const scene = gltf.scene.clone(true);
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial) continue;
        sm.emissive = new Color('#c06cff');
        sm.emissiveIntensity = 1.0;
        sm.toneMapped = false;
        coreMat.current = sm;
      }
    });
    return scene;
  }, [gltf.scene]);

  /** Rendered position of the carrier avatar (local transform or remote interp sample). */
  const carrierPos = (): [number, number, number] | null => {
    const carrierPlayerId = useUIStore.getState().relicCarrier;
    if (!carrierPlayerId || !session) return null;
    if (carrierPlayerId === session.playerId) {
      const p = localPlayers.first;
      return p?.transform ? [p.transform.position[0], p.transform.position[1], p.transform.position[2]] : null;
    }
    const buffer = netClient.remoteBuffer(carrierPlayerId);
    const sample = sampleWithUnderrunPolicy(buffer, netClient.serverNow() - netClient.interpDelayMs(), {
      holdMs: INTERP_UNDERRUN_HOLD_MS,
      deadReckonMs: INTERP_UNDERRUN_DEADRECKON_MS,
    });
    return sample ? [sample.pos[0], sample.pos[1], sample.pos[2]] : null;
  };

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const st = relicNet.state;
    if (st.phase === 'absent') {
      g.visible = false;
      return;
    }
    g.visible = true;

    if (st.phase === 'inFlight' && st.flight) {
      // Shared deterministic arc, sampled at the server-tick clock — identical on all screens.
      sampleRelicFlight(st.flight, netClient.serverNow(), scratch);
      g.position.set(scratch[0], scratch[1], scratch[2]);
    } else if (st.phase === 'carried') {
      const cp = carrierPos();
      const target = cp ?? st.pos;
      const ty = (cp ? cp[1] + RELIC_CATCH_SOCKET_Y : st.pos[1]);
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
    if (coreMat.current) coreMat.current.emissiveIntensity = 1.0 + Math.sin(performance.now() * 0.0031) * 0.35;
  });

  return (
    <group ref={group} visible={false}>
      <pointLight color="#a65cff" intensity={5} distance={6.5} decay={2} />
      <group ref={spinner}>
        <primitive object={core} scale={0.72} />
      </group>
    </group>
  );
};
