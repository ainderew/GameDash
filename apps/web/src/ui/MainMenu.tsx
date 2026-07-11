import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AnimatedCharacter } from '@/game/entities/AnimatedCharacter';
import type { CharState } from '@/game/entities/AnimatedCharacter';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { feel } from '@/game/feel/config';
import { resumeAudio, syncAudioSettings } from '@/game/feel/audio';
import { beginIntroAudio, preloadIntroImages } from '@/ui/intro/introAudio';
import { startMenuMusic, stopMenuMusic, syncMenuMusic } from '@/ui/menuMusic';
import { INTRO_SCENES } from '@/ui/intro/introScenes';
import { useSession } from '@/net/useSession';
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
const NAME_KEY = 'gd_player_name_v1';
const readPlayerName = (): string => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? 'Adventurer';
  } catch {
    return 'Adventurer';
  }
};

/**
 * Lightweight profanity filter for user-entered party names (Phase 6 Task 1). A small
 * substring blocklist masked to asterisks — deliberately conservative (this is friend-group
 * co-op, not a public lobby), and the real guardrail is the server's length/shape validation.
 */
const PROFANITY = ['fuck', 'shit', 'cunt', 'bitch', 'nigger', 'faggot', 'retard', 'rape'];
const filterName = (raw: string): string => {
  let out = raw;
  for (const word of PROFANITY) {
    const re = new RegExp(word, 'gi');
    out = out.replace(re, '*'.repeat(word.length));
  }
  return out;
};

export const MainMenu = () => {
  const setScreen = useUIStore((s) => s.setScreen);
  const setScene = useUIStore((s) => s.setScene);
  const startIntro = useUIStore((s) => s.startIntro);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioOn, setAudioOn] = useState(feel.audio.enabled);
  const [volume, setVolume] = useState(feel.audio.masterVolume);
  const [quitHint, setQuitHint] = useState(false);

  // ── Multiplayer: Play Together (Phase 6 Task 1) ────────────────────────────
  const { session, connectionState, netError, createSession, joinSession, leaveSession } =
    useSession();
  const character = useUIStore((s) => s.playerCharacter);
  const setPlayerCharacter = useUIStore((s) => s.setPlayerCharacter);
  const [mpOpen, setMpOpen] = useState(false);
  const [playerName, setPlayerName] = useState(readPlayerName);
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const busy = connectionState === 'connecting' || connectionState === 'reconnecting';
  // A profanity-lite scrub of the entered name, stored with the guest identity.
  const cleanName = () => filterName(playerName).trim() || 'Adventurer';

  const rememberName = () => {
    try {
      window.localStorage.setItem(NAME_KEY, playerName);
    } catch {
      /* storage disabled — non-fatal */
    }
  };

  const cycleCharacter = (dir: number) => {
    const ids = Object.keys(PLAYER_CHARACTERS) as PlayerCharacterId[];
    const next = ids[(ids.indexOf(character) + dir + ids.length) % ids.length];
    if (next) setPlayerCharacter(next);
  };

  const mpCreate = () => {
    resumeAudio(); // the click doubles as our WebAudio unlock gesture
    rememberName();
    createSession(cleanName());
  };

  const mpJoin = () => {
    if (joinCode.trim().length < 6) return;
    resumeAudio();
    rememberName();
    joinSession(joinCode, cleanName());
  };

  const copyCode = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is on screen to type by hand */
    }
  };

  const enterHub = () => {
    resumeAudio();
    setScene('hub');
    setScreen('playing'); // multiplayer skips the intro
  };

  useEffect(() => {
    for (const scene of INTRO_SCENES) preloadIntroImages(scene);
  }, []);

  // The looping harp theme under the menu: fade in on mount, out whenever we leave the
  // menu (Play, intro, or entering the hub all unmount MainMenu, so cleanup covers them).
  useEffect(() => {
    startMenuMusic();
    return () => stopMenuMusic();
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
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">
              ▸
            </span>
            Play
          </button>
          <button className={MENU_BUTTON} onClick={() => setMpOpen((v) => !v)}>
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">
              ▸
            </span>
            Play Together
          </button>
          {mpOpen && (
            <div className="ml-7 flex w-80 flex-col gap-3 border-l border-white/15 py-3 pl-6 text-sm text-white/80">
              {!session ? (
                <>
                  {/* Identity: name + character select (honored per member in the shared world). */}
                  <label className="flex items-center justify-between gap-3">
                    <span className="text-xs uppercase tracking-widest text-white/60">Name</span>
                    <input
                      type="text"
                      maxLength={24}
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      className="w-44 rounded border border-white/20 bg-black/40 px-2 py-1 text-sm text-white outline-none focus:border-teal-400/60"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs uppercase tracking-widest text-white/60">Hero</span>
                    <div className="flex items-center gap-2">
                      <button
                        aria-label="previous hero"
                        onClick={() => cycleCharacter(-1)}
                        className="rounded border border-white/20 px-2 text-white/70 hover:bg-white/10"
                      >
                        ‹
                      </button>
                      <span className="w-24 text-center text-sm font-semibold text-teal-200">
                        {PLAYER_CHARACTERS[character].label}
                      </span>
                      <button
                        aria-label="next hero"
                        onClick={() => cycleCharacter(1)}
                        className="rounded border border-white/20 px-2 text-white/70 hover:bg-white/10"
                      >
                        ›
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={mpCreate}
                    disabled={busy}
                    className="mt-1 self-stretch rounded border border-teal-400/50 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-teal-200 transition-colors hover:bg-teal-400/10 disabled:cursor-wait disabled:opacity-50"
                  >
                    Create Party
                  </button>

                  <div className="my-1 flex items-center gap-2 text-[0.6rem] uppercase tracking-[0.3em] text-white/30">
                    <span className="h-px flex-1 bg-white/15" /> or{' '}
                    <span className="h-px flex-1 bg-white/15" />
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="CODE"
                      maxLength={6}
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === 'Enter' && mpJoin()}
                      className="w-32 rounded border border-white/20 bg-black/40 px-2 py-1 font-mono text-sm uppercase tracking-[0.25em] text-white outline-none focus:border-amber-400/60"
                    />
                    <button
                      onClick={mpJoin}
                      disabled={busy || joinCode.trim().length < 6}
                      className="flex-1 rounded border border-amber-400/50 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Join Party
                    </button>
                  </div>
                  {busy && (
                    <div className="text-xs uppercase tracking-widest text-white/50">
                      Connecting…
                    </div>
                  )}
                  {netError && <div className="text-xs text-red-400">{netError}</div>}
                </>
              ) : (
                // ── Party lobby: share the code, see who's in, then enter the hub. ──
                <div className="flex flex-col gap-3">
                  <div className="text-[0.6rem] uppercase tracking-[0.3em] text-white/45">
                    Party code
                  </div>
                  <button
                    onClick={copyCode}
                    title="Copy code"
                    className="group/code flex items-center justify-between gap-3 rounded-lg border border-teal-400/40 bg-teal-950/40 px-4 py-3 transition-colors hover:bg-teal-900/40"
                  >
                    <span className="font-mono text-3xl font-black tracking-[0.35em] text-teal-200">
                      {session.code}
                    </span>
                    <span className="text-[0.6rem] uppercase tracking-widest text-teal-300/70">
                      {copied ? 'Copied!' : 'Copy'}
                    </span>
                  </button>
                  <div className="text-[0.6rem] uppercase tracking-[0.3em] text-white/45">
                    Members · {session.members.length}/4
                  </div>
                  <ul className="flex flex-col gap-1">
                    {session.members.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between text-xs text-white/80"
                      >
                        <span className="truncate">
                          {m.name}
                          {m.id === session.playerId && (
                            <span className="text-white/40"> (you)</span>
                          )}
                        </span>
                        <span className="text-white/40">
                          {PLAYER_CHARACTERS[m.character as PlayerCharacterId]?.label ??
                            m.character}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 flex gap-2">
                    <button
                      onClick={enterHub}
                      className="flex-1 rounded border border-amber-400/60 bg-amber-400/10 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
                    >
                      Enter Hub
                    </button>
                    <button
                      onClick={() => leaveSession()}
                      className="rounded border border-white/20 px-3 py-2 text-xs uppercase tracking-widest text-white/60 transition-colors hover:bg-white/10"
                    >
                      Leave
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <button className={MENU_BUTTON} onClick={() => setSettingsOpen((v) => !v)}>
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">
              ▸
            </span>
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
                    syncMenuMusic();
                    syncAudioSettings();
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
                    syncMenuMusic();
                    syncAudioSettings();
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
            <span className="text-amber-400 opacity-0 transition-opacity group-hover:opacity-100">
              ▸
            </span>
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
