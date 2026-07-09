import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { resumeAudio } from '@/game/feel/audio';

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  dodge: boolean;
  /** Held: WASD moves at run speed instead of the default walk. */
  sprint: boolean;
  /** One-shot: consumed by the weapon system each tick. */
  melee: boolean;
  /** One-shot: consumed by the weapon system each tick. */
  ranged: boolean;
  /** One-shot: opens the parry/block window; consumed each tick. */
  parry: boolean;
}

const KEY_MAP: Record<string, keyof InputState> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'dodge',
  ControlRight: 'dodge',
  KeyJ: 'melee',
  KeyK: 'ranged',
  KeyF: 'parry',
  KeyL: 'parry',
};

/** One-shot edge-triggered actions — cleared by their consumer, not on keyup. */
const ONE_SHOT: ReadonlySet<keyof InputState> = new Set(['melee', 'ranged', 'parry']);

const initial = (): InputState => ({
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  dodge: false,
  sprint: false,
  melee: false,
  ranged: false,
  parry: false,
});

/**
 * Keyboard + mouse input as a stable ref, read inside useFrame — never React state.
 * ANTI-PATTERN: don't useState per keypress; that re-renders every frame.
 * Melee = left click / J, Ranged = right click / K.
 */
export const useInput = (): MutableRefObject<InputState> => {
  const state = useRef<InputState>(initial());

  useEffect(() => {
    const set = (code: string, value: boolean) => {
      const key = KEY_MAP[code];
      if (key) state.current[key] = value;
    };
    const onDown = (e: KeyboardEvent) => {
      resumeAudio(); // first keypress is a valid gesture to unlock WebAudio
      set(e.code, true);
    };
    const onUp = (e: KeyboardEvent) => {
      const key = KEY_MAP[e.code];
      // One-shot edge triggers are cleared by their consumer, not on keyup.
      if (key && ONE_SHOT.has(key)) return;
      set(e.code, false);
    };
    const onBlur = () => (state.current = initial());
    const onMouseDown = (e: MouseEvent) => {
      resumeAudio();
      if (e.button === 0) state.current.melee = true;
      if (e.button === 2) state.current.ranged = true;
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  return state;
};
