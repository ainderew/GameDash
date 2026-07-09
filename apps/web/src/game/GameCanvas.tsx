import { Canvas } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { Perf } from 'r3f-perf';
import { Suspense, useRef } from 'react';
import type { Object3D } from 'three';
import { SkyAndLight } from '@/game/world/SkyAndLight';
import { Zone } from '@/game/world/Zone';
import { PostFX } from '@/game/fx/PostFX';
import { Player } from '@/game/entities/Player';
import { SlashFX } from '@/game/fx/SlashFX';
import { AttackArcIndicator } from '@/game/fx/AttackArcIndicator';
import { ImpactFX } from '@/game/fx/ImpactFX';
import { MonsterModels } from '@/game/entities/MonsterModels';
import { MonsterHealthBars } from '@/game/entities/MonsterHealthBars';
import { Projectiles } from '@/game/entities/Projectiles';
import { Pickups } from '@/game/entities/Pickups';
import { DamageNumbers } from '@/game/entities/DamageNumbers';
import { SystemRunner } from '@/game/ecs/SystemRunner';
import { ThirdPersonCamera } from '@/game/camera/ThirdPersonCamera';

const DEV = import.meta.env.DEV;

/** The 3D game: renderer, physics, systems, scene. All game logic runs inside here. */
export const GameCanvas = () => {
  const playerRef = useRef<Object3D | null>(null);
  const obstacles = useRef<Object3D[]>([]);

  return (
    <Canvas
      shadows
      dpr={[1, 1.5]}
      // far must exceed the Sky dome radius (500) or the sky gets clipped and never draws;
      // fog hides everything past ~300 anyway, so the big far plane costs nothing visually.
      camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 3, 7] }}
      gl={{ powerPreference: 'high-performance', antialias: true }}
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
      {DEV && <Perf position="bottom-left" />}

      <Suspense fallback={null}>
        <SkyAndLight />
        <Physics>
          <Zone obstacles={obstacles} />
          <Player playerRef={playerRef} />
          <SlashFX />
          <AttackArcIndicator />
          <ImpactFX />
          <MonsterModels />
          <MonsterHealthBars />
          <Projectiles />
          <Pickups />
          <DamageNumbers />
          {/* Ticks BEFORE all renderer useFrames via negative priority (see SIM_PRIORITY) —
              same-frame input → ECS → animation, no one-frame lag. */}
          <SystemRunner />
          <ThirdPersonCamera target={playerRef} obstacles={obstacles} />
        </Physics>
        <PostFX />
      </Suspense>
    </Canvas>
  );
};
