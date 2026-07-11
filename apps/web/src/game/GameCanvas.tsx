import { Canvas } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { Perf } from 'r3f-perf';
import { Suspense, useRef } from 'react';
import type { Object3D } from 'three';
import { SkyAndLight } from '@/game/world/SkyAndLight';
import { Zone } from '@/game/world/Zone';
import { PostFX } from '@/game/fx/PostFX';
import { Player } from '@/game/entities/Player';
import { RemotePlayers } from '@/game/entities/RemotePlayers';
import { NetworkedWorld } from '@/game/entities/NetworkedWorld';
import { NetGateInteraction } from '@/game/net/NetGateInteraction';
import { SlashFX } from '@/game/fx/SlashFX';
import { BladeTrail } from '@/game/fx/BladeTrail';
import { AttackArcIndicator } from '@/game/fx/AttackArcIndicator';
import { ImpactFX } from '@/game/fx/ImpactFX';
import { MonsterModels } from '@/game/entities/MonsterModels';
import { MonsterHealthBars } from '@/game/entities/MonsterHealthBars';
import { Projectiles } from '@/game/entities/Projectiles';
import { Relic } from '@/game/entities/Relic';
import { NetworkedRelic } from '@/game/entities/NetworkedRelic';
import { Teammates } from '@/game/entities/Teammates';
import { PassAimUI } from '@/game/fx/PassAimUI';
import { RelicDrainVFX } from '@/game/fx/RelicDrainVFX';
import { Pickups } from '@/game/entities/Pickups';
import { DamageNumbers } from '@/game/entities/DamageNumbers';
import { SystemRunner } from '@/game/ecs/SystemRunner';
import { ThirdPersonCamera } from '@/game/camera/ThirdPersonCamera';
import { SocialHub } from '@/game/world/SocialHub';
import { useUIStore } from '@/ui/store';

const DEV = import.meta.env.DEV;

/** The 3D game: renderer, physics, systems, scene. All game logic runs inside here. */
export const GameCanvas = () => {
  const playerRef = useRef<Object3D | null>(null);
  const obstacles = useRef<Object3D[]>([]);
  const scene = useUIStore((state) => state.scene);
  // In a session the relic is server-authoritative: render it from the network (NetworkedRelic
  // → relicNet) and DON'T mount the solo <Relic/> (which spawns a local relic entity) — the
  // double-spawn guard, done without touching the art component Relic.tsx. Keyed on session
  // presence (not the connection state) so a brief reconnect blip doesn't flap the mount.
  const networked = useUIStore((state) => state.session !== undefined);

  return (
    <Canvas
      shadows="soft"
      flat
      dpr={[1, 1.5]}
      // far must exceed the Sky dome radius (500) or the sky gets clipped and never draws;
      // fog hides everything past ~300 anyway, so the big far plane costs nothing visually.
      camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 3, 7] }}
      gl={{ powerPreference: 'high-performance', antialias: false }}
      // Dev-only scene handle for console/tooling inspection (e.g. measuring placement).
      onCreated={(state) => {
        if (DEV) {
          const w = window as unknown as { __scene?: unknown; __r3f?: unknown };
          w.__scene = state.scene;
          w.__r3f = state;
        }
      }}
    >
      {/* Bottom-left so it doesn't cover the leva panel (top-right). */}
      {DEV && scene === 'expedition' && <Perf position="bottom-left" />}

      <Suspense fallback={null}>
        <SkyAndLight />
        <Physics>
          {scene === 'hub' ? <SocialHub obstacles={obstacles} /> : <Zone obstacles={obstacles} />}
          <Player playerRef={playerRef} />
          {/* Session peers — rendered in BOTH the shared hub and the shared expedition. */}
          {networked && <RemotePlayers />}
          {/* Networked expedition-gate countdown control (self-gates to a live session). */}
          {scene === 'hub' && <NetGateInteraction />}
          {scene === 'expedition' && (
            <>
              {/* Server-authoritative monsters (networked) replace the local sim's spawns. */}
              {networked && <NetworkedWorld />}
              {/* AI stand-in teammates only in solo; humans fill those slots in a session. */}
              {!networked && <Teammates />}
              {networked ? <NetworkedRelic /> : <Relic />}
              <PassAimUI />
              <RelicDrainVFX />
              <SlashFX />
              <BladeTrail />
              <AttackArcIndicator />
              <ImpactFX />
              <MonsterModels />
              <MonsterHealthBars />
              <Projectiles />
              <Pickups />
              <DamageNumbers />
            </>
          )}
          {/* Ticks BEFORE all renderer useFrames via negative priority (see SIM_PRIORITY) —
              same-frame input → ECS → animation, no one-frame lag. */}
          <SystemRunner mode={scene} />
          <ThirdPersonCamera target={playerRef} obstacles={obstacles} />
        </Physics>
        <PostFX />
      </Suspense>
    </Canvas>
  );
};
