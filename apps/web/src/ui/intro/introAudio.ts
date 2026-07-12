import type { IntroScene } from '@/ui/intro/introScenes';

const MASTER_VOICE_SRC = '/intro/audio/intro-voice.mp3';
const MASTER_MUSIC_VOLUME = 0.46;
const MUSIC_ONE_STOP_SECONDS = 55;
const MUSIC_TWO_START_SECONDS = 60;
const MUSIC_SYNC_TOLERANCE_SECONDS = 0.25;

const MASTER_MUSIC = [
  '/intro/audio/intro-bgm-1.mp3',
  '/intro/audio/intro-bgm-2.mp3',
] as const;

interface IntroAudioMaster {
  voice: HTMLAudioElement;
  music: HTMLAudioElement[];
  startedAt: number;
  started: Promise<boolean>;
  voiceStarted: Promise<boolean>;
  /** Music-only lead-in, in seconds, before the narration is released. */
  prerollSeconds: number;
  voiceReleased: boolean;
  releaseVoice: (started: boolean) => void;
  schedulerFrame?: number;
}

export interface IntroAudioSession {
  sceneId: string;
  voice: HTMLAudioElement;
  music: HTMLAudioElement[];
  /** Scene-local visual clock. The master voice has its own uninterrupted clock. */
  startedAt: number;
  started: Promise<boolean>;
  voiceStarted: Promise<boolean>;
  sfx?: HTMLAudioElement[];
  sfxTimers?: number[];
}

let activeMaster: IntroAudioMaster | undefined;
let activeSession: IntroAudioSession | undefined;

const makeAudio = (src: string, loop = false) => {
  const audio = new Audio(src);
  audio.preload = 'auto';
  audio.loop = loop;
  return audio;
};

const setPlaying = (audio: HTMLAudioElement, shouldPlay: boolean) => {
  if (!shouldPlay) {
    if (!audio.paused) audio.pause();
    return;
  }
  if (audio.paused) void audio.play().catch(() => undefined);
};

const syncTrack = (
  audio: HTMLAudioElement,
  desiredTime: number,
  shouldPlay: boolean,
) => {
  if (Math.abs(audio.currentTime - desiredTime) > MUSIC_SYNC_TOLERANCE_SECONDS) {
    audio.currentTime = Math.max(0, desiredTime);
  }
  setPlaying(audio, shouldPlay);
};

const startMusicScheduler = (master: IntroAudioMaster) => {
  const update = () => {
    if (activeMaster !== master) return;
    const elapsed = (performance.now() - master.startedAt) / 1000;

    // Hold the narration through a music-only pre-roll so the fade-from-black can
    // breathe while the score builds tension, then release the voice exactly once.
    if (!master.voiceReleased && elapsed >= master.prerollSeconds) {
      master.voiceReleased = true;
      void master.voice
        .play()
        .then(() => master.releaseVoice(true))
        .catch(() => master.releaseVoice(false));
    }

    const musicOne = master.music[0]!;
    const musicTwo = master.music[1]!;

    // The music rides its own wall-clock (independent of the delayed voice) so the
    // score's internal cross-fade still lands at the song's natural seam.
    syncTrack(
      musicOne,
      Math.min(elapsed, MUSIC_ONE_STOP_SECONDS),
      elapsed < MUSIC_ONE_STOP_SECONDS,
    );
    syncTrack(
      musicTwo,
      Math.max(0, elapsed - MUSIC_TWO_START_SECONDS),
      elapsed >= MUSIC_TWO_START_SECONDS,
    );

    master.schedulerFrame = window.requestAnimationFrame(update);
  };
  master.schedulerFrame = window.requestAnimationFrame(update);
};

const createMaster = (muted: boolean, prerollMs: number): IntroAudioMaster => {
  const voice = makeAudio(MASTER_VOICE_SRC);
  const music = MASTER_MUSIC.map((src) => makeAudio(src));
  voice.muted = muted;
  voice.volume = 1;
  for (const track of music) {
    track.muted = muted;
    track.volume = MASTER_MUSIC_VOLUME;
  }

  // The narration is released later by the scheduler, once the pre-roll elapses.
  // We hand back a promise so callers can still await the voice actually starting.
  let releaseVoice: (started: boolean) => void = () => undefined;
  const voiceStarted = new Promise<boolean>((resolve) => {
    releaseVoice = resolve;
  });

  // bgm-1 starts immediately so the song builds tension under the fade-from-black.
  const musicOneStarted = music[0]!.play().then(() => true).catch(() => false);
  const master: IntroAudioMaster = {
    voice,
    music,
    startedAt: performance.now(),
    // The cinematic clock is gated on the music, not the delayed voice, so the
    // fade-in and rising score begin together at t0.
    started: musicOneStarted,
    voiceStarted,
    prerollSeconds: Math.max(0, prerollMs / 1000),
    voiceReleased: false,
    releaseVoice,
  };
  activeMaster = master;
  startMusicScheduler(master);
  return master;
};

export const stopIntroAudio = () => {
  if (activeMaster?.schedulerFrame !== undefined) {
    window.cancelAnimationFrame(activeMaster.schedulerFrame);
  }
  for (const timer of activeSession?.sfxTimers ?? []) window.clearTimeout(timer);
  for (const audio of activeSession?.sfx ?? []) {
    audio.pause();
    audio.currentTime = 0;
  }
  if (activeMaster) {
    for (const audio of [activeMaster.voice, ...activeMaster.music]) {
      audio.pause();
      audio.currentTime = 0;
    }
  }
  activeSession = undefined;
  activeMaster = undefined;
};

/**
 * The voice and music belong to the complete intro and survive scene changes.
 * Scene sessions only provide a fresh visual clock and scene-local sound effects.
 */
export const beginIntroAudio = (scene: IntroScene, muted = false): IntroAudioSession => {
  for (const timer of activeSession?.sfxTimers ?? []) window.clearTimeout(timer);
  for (const audio of activeSession?.sfx ?? []) audio.pause();

  const master = activeMaster ?? createMaster(muted, scene.voiceDelayMs);
  master.voice.muted = muted;
  for (const track of master.music) track.muted = muted;

  const sfx = (scene.sfx ?? []).map((cue) => makeAudio(cue.src));
  const sfxTimers = (scene.sfx ?? []).map((cue, index) => window.setTimeout(() => {
    const effect = sfx[index];
    if (!effect) return;
    effect.muted = muted;
    effect.volume = cue.volume;
    void effect.play().catch(() => undefined);
  }, cue.atMs));

  activeSession = {
    sceneId: scene.id,
    voice: master.voice,
    music: master.music,
    startedAt: performance.now(),
    started: master.started,
    voiceStarted: master.voiceStarted,
    sfx,
    sfxTimers,
  };
  return activeSession;
};

export const getIntroAudio = (sceneId: string) =>
  activeSession?.sceneId === sceneId ? activeSession : undefined;

export const preloadIntroImages = (scene: IntroScene) => {
  for (const layer of scene.layers) {
    const image = new Image();
    image.src = layer.src;
  }
};
