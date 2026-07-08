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
      camera={{ fov: 55, near: 0.1, far: 200, position: [0, 3, 7] }}
      gl={{ powerPreference: 'high-performance', antialias: true }}
    >
      {DEV && <Perf position="top-right" />}

      <Suspense fallback={null}>
        <SkyAndLight />
        <Physics>
          <Zone obstacles={obstacles} />
          <Player playerRef={playerRef} />
          <SlashFX />
          <MonsterModels />
          <MonsterHealthBars />
          <Projectiles />
          <Pickups />
          <DamageNumbers />
          {/* Systems tick first (mounted before camera); camera reads resulting transforms. */}
          <SystemRunner />
          <ThirdPersonCamera target={playerRef} obstacles={obstacles} />
        </Physics>
        <PostFX />
      </Suspense>
    </Canvas>
  );
};
