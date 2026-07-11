import type { IntroScene } from '@/ui/intro/introScenes';

export interface IntroAudioSession {
  sceneId: string;
  voice?: HTMLAudioElement;
  bgm?: HTMLAudioElement;
  startedAt: number;
  started: Promise<boolean>;
  voiceStarted: Promise<boolean>;
  voiceTimer?: number;
  sfx?: HTMLAudioElement[];
  sfxTimers?: number[];
}

let activeSession: IntroAudioSession | undefined;

const makeAudio = (src: string | undefined, loop = false) => {
  if (!src) return undefined;
  const audio = new Audio(src);
  audio.preload = 'auto';
  audio.loop = loop;
  return audio;
};

export const stopIntroAudio = () => {
  if (!activeSession) return;
  if (activeSession.voiceTimer !== undefined) window.clearTimeout(activeSession.voiceTimer);
  for (const timer of activeSession.sfxTimers ?? []) window.clearTimeout(timer);
  for (const audio of [activeSession.voice, activeSession.bgm, ...(activeSession.sfx ?? [])]) {
    if (!audio) continue;
    audio.pause();
    audio.currentTime = 0;
  }
  activeSession = undefined;
};

/**
 * Start the cinematic media from the menu click. Calling play here, while the browser
 * still has the user's activation, avoids an extra "enable sound" interstitial.
 */
export const beginIntroAudio = (scene: IntroScene, muted = false): IntroAudioSession => {
  const previous = activeSession;
  const canReuseBgm = Boolean(
    previous?.bgm && scene.bgm && previous.bgm.src === new URL(scene.bgm, window.location.href).href,
  );
  const canReuseVoice = Boolean(scene.continueVoice && previous?.voice && !previous.voice.ended);
  if (previous) {
    if (previous.voiceTimer !== undefined) window.clearTimeout(previous.voiceTimer);
    for (const timer of previous.sfxTimers ?? []) window.clearTimeout(timer);
    for (const audio of [...(canReuseVoice ? [] : [previous.voice]), ...(previous.sfx ?? [])]) {
      audio?.pause();
    }
    if (!canReuseBgm) previous.bgm?.pause();
  }

  const voice = canReuseVoice ? previous?.voice : makeAudio(scene.vo);
  const bgm = canReuseBgm ? previous?.bgm : makeAudio(scene.bgm, true);
  const sfx = (scene.sfx ?? []).map((cue) => makeAudio(cue.src)!).filter(Boolean);
  if (voice) {
    voice.muted = muted;
    voice.volume = 1;
  }
  if (bgm) {
    bgm.muted = muted;
    bgm.volume = scene.bgmVolume;
  }

  const startedAt = performance.now();
  const bgmStart = canReuseBgm
    ? Promise.resolve(true)
    : bgm?.play().then(() => true) ?? Promise.resolve(true);
  const started = bgmStart.catch(() => false);
  let voiceTimer: number | undefined;
  const voiceStarted = voice && !canReuseVoice
    ? new Promise<boolean>((resolve) => {
        voiceTimer = window.setTimeout(() => {
          void voice.play().then(() => resolve(true)).catch(() => resolve(false));
        }, scene.voiceDelayMs);
      })
    : Promise.resolve(true);
  const sfxTimers = (scene.sfx ?? []).map((cue, index) => window.setTimeout(() => {
    const effect = sfx[index];
    if (!effect) return;
    effect.muted = muted;
    effect.volume = cue.volume;
    void effect.play().catch(() => undefined);
  }, cue.atMs));

  activeSession = {
    sceneId: scene.id,
    voice,
    bgm,
    startedAt,
    started,
    voiceStarted,
    voiceTimer,
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
