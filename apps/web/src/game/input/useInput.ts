import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  dodge: boolean;
  /** One-shot: consumed by the weapon system each tick. */
  melee: boolean;
  /** One-shot: consumed by the weapon system each tick. */
  ranged: boolean;
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
  ShiftLeft: 'dodge',
  ShiftRight: 'dodge',
  KeyJ: 'melee',
  KeyK: 'ranged',
};

const initial = (): InputState => ({
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  dodge: false,
  melee: false,
  ranged: false,
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
    const onDown = (e: KeyboardEvent) => set(e.code, true);
    const onUp = (e: KeyboardEvent) => {
      const key = KEY_MAP[e.code];
      // melee/ranged are one-shot edge triggers cleared by the consumer, not on keyup.
      if (key === 'melee' || key === 'ranged') return;
      set(e.code, false);
    };
    const onBlur = () => (state.current = initial());
    const onMouseDown = (e: MouseEvent) => {
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
