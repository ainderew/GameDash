import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AnimatedCharacter } from '@/game/entities/AnimatedCharacter';
import type { CharState } from '@/game/entities/AnimatedCharacter';
import { PLAYER_CHARACTERS } from '@/game/entities/characters';
import { feel } from '@/game/feel/config';
import { resumeAudio } from '@/game/feel/audio';
import { beginIntroAudio, preloadIntroImages } from '@/ui/intro/introAudio';
import { INTRO_SCENES } from '@/ui/intro/introScenes';
import { useUIStore } from '@/ui/store';

/** How long each idle plays before drifting into the other, ms. */
const IDLE_MS = 7000;
const BORED_MS = 5200;

/**
 * The menu showcase: the player's character rendered HUGE (Paragon-style hero splash),
 * alive on its idle clip and drifting into the bored fidget on a timer. Same
 * AnimatedCharacter as gameplay — one rig pipeline everywhere.
 */
const MenuHero = () => {
  const characterId = useUIStore((s) => s.playerCharacter);
  const charState = useRef<CharState>('idle');
  const nextSwapAt = useRef(performance.now() + IDLE_MS);

  useFrame(() => {
    if (performance.now() < nextSwapAt.current) return;
    const bored = charState.current === 'idle';
    charState.current = bored ? 'idle-bored' : 'idle';
    nextSwapAt.current = performance.now() + (bored ? BORED_MS : IDLE_MS);
  });

  return (
    // Feet well below frame, slight turn toward the menu — a waist-up portrait crop.
    <group position={[0.65, -1.5, 0]} rotation={[0, -0.38, 0]}>
      <AnimatedCharacter
        key={characterId}
        characterPath={PLAYER_CHARACTERS[characterId].modelPath}
        idlePath="/models/hero/anim-idle.glb"
        boredPath="/models/hero/anim-idle-bored.glb"
        walkPath="/models/hero/anim-walk.glb"
        runPath="/models/hero/anim-run.glb"
        jumpPath="/models/hero/anim-jump.glb"
        dodgePath="/models/hero/anim-roll.glb"
        hurtPath="/models/hero/anim-hurt.glb"
        deathPath="/models/hero/anim-death.glb"
        spinPath="/models/hero/anim-spin.glb"
        light1Path="/models/hero/anim-attack-l1.glb"
        light2Path="/models/hero/anim-attack-l2.glb"
        finisherPath="/models/hero/anim-finisher.glb"
        throwPath="/models/hero/anim-throw.glb"
        catchPath="/models/hero/anim-catch.glb"
        targetHeight={1.8}
        stateRef={charState}
      />
    </group>
  );
};

const MENU_BUTTON =
  'group flex w-72 items-center gap-3 border-l-2 border-transparent px-5 py-3 text-left text-lg font-semibold uppercase tracking-[0.25em] text-white/70 transition-all duration-150 hover:border-amber-400 hover:bg-white/5 hover:pl-7 hover:text-white';

/**
 * Initial-load main menu (Paragon-inspired): the key art blurred to a mood backdrop,
 * the hero model towering on the right, and a lean uppercase option list on the left.
 * The game world does not exist until PLAY — GameCanvas mounts on screen change.
 */
export const MainMenu = () => {
  const setScreen = useUIStore((s) => s.setScreen);
  const startIntro = useUIStore((s) => s.startIntro);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioOn, setAudioOn] = useState(feel.audio.enabled);
  const [volume, setVolume] = useState(feel.audio.masterVolume);
  const [quitHint, setQuitHint] = useState(false);

  useEffect(() => {
    for (const scene of INTRO_SCENES) preloadIntroImages(scene);
  }, []);

  const play = () => {
    resumeAudio(); // the click is our WebAudio unlock gesture
    // First-time players get the intro cinematic; afterwards Play goes straight in.
    if (useUIStore.getState().hasSeenIntro) setScreen('playing');
    else {
      beginIntroAudio(INTRO_SCENES[0]!);
      startIntro('playing');
    }
  };

  const previewIntro = () => {
    resumeAudio();
    beginIntroAudio(INTRO_SCENES[0]!);
    startIntro('menu'); // finishing/skipping returns to the menu for easy re-watching
  };

  const quit = () => {
    window.close(); // only works for script-opened windows…
    setTimeout(() => setQuitHint(true), 150); // …otherwise tell the player how
  };

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      {/* Blurred key art backdrop, oversized so the blur never reveals edges. */}
      <img
        src="/menu/keyart.png"
        alt=""
        className="absolute inset-0 h-full w-full scale-110 object-cover blur-lg brightness-[0.55] saturate-[1.1]"
      />
      {/* Readability gradients: darker left column for the menu, vignette at the base. */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/35 to-black/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

      {/* The showcase hero — its own tiny renderer, transparent over the backdrop. */}
      <div className="absolute inset-0">
        <Canvas
          gl={{ alpha: true, antialias: true }}
          camera={{ fov: 30, position: [0, 0.25, 3.6] }}
          dpr={[1, 2]}
        >
          <ambientLight intensity={0.9} />
          <directionalLight position={[2.5, 3, 4]} intensity={2.2} color="#fff2dd" />
          <directionalLight position={[-3, 2, -2]} intensity={1.1} color="#7dd8ff" />
          <Suspense fallback={null}>
            <MenuHero />
          </Suspense>
        </Canvas>
      </div>

      {/* Title + options column. */}
      <div className="absolute inset-y-0 left-0 flex w-[46%] min-w-[380px] flex-col justify-center pl-14">
        <div className="mb-1 text-sm font-semibold uppercase tracking-[0.5em] text-teal-300/80">
          Co-op Relic Roguelite
        </div>
        <h1 className="mb-10 text-6xl font-black uppercase tracking-[0.08em] text-white drop-shadow-[0_2px_12px_rgba(45,212,191,0.35)]">
          Relic <span className="text-amber-400">Relay</span>
        </h1>

        <nav className="flex flex-col gap-1">
          <button className={MENU_BUTTON} onClick={play}>
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">▸</span>
            Play
          </button>
          <button className={`${MENU_BUTTON} cursor-not-allowed opacity-50 hover:border-transparent hover:bg-transparent hover:pl-5`}>
            <span className="opacity-0">▸</span>
            Multiplayer
            <span className="ml-2 rounded-sm border border-teal-400/40 px-1.5 py-0.5 text-[10px] tracking-widest text-teal-300/80">
              Coming soon
            </span>
          </button>
          <button className={MENU_BUTTON} onClick={() => setSettingsOpen((v) => !v)}>
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">▸</span>
            Settings
          </button>
          {settingsOpen && (
            <div className="ml-7 flex w-64 flex-col gap-4 border-l border-white/15 py-3 pl-6 text-sm text-white/80">
              <label className="flex items-center justify-between gap-4">
                <span className="uppercase tracking-widest text-white/60">Audio</span>
                <input
                  type="checkbox"
                  checked={audioOn}
                  onChange={(e) => {
                    setAudioOn(e.target.checked);
                    feel.audio.enabled = e.target.checked;
                  }}
                  className="h-4 w-4 accent-amber-400"
                />
              </label>
              <label className="flex items-center justify-between gap-4">
                <span className="uppercase tracking-widest text-white/60">Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    feel.audio.masterVolume = v;
                  }}
                  className="w-32 accent-amber-400"
                />
              </label>
              <button
                onClick={previewIntro}
                className="self-start text-xs font-semibold uppercase tracking-[0.24em] text-amber-300/80 transition-colors hover:text-amber-200"
              >
                ▸ Preview intro
              </button>
            </div>
          )}
          <button className={MENU_BUTTON} onClick={quit}>
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">▸</span>
            Quit Game
          </button>
          {quitHint && (
            <div className="ml-7 mt-1 text-xs uppercase tracking-widest text-white/40">
              Close the browser tab to exit
            </div>
          )}
        </nav>
      </div>

      {/* Footer strip, Paragon-style. */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between border-t border-white/10 bg-black/40 px-8 py-3 text-[11px] uppercase tracking-[0.3em] text-white/40">
        <span>Pre-alpha · In development</span>
        <span>Relic Relay</span>
      </div>
    </div>
  );
};
