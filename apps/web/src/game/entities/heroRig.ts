import type { Object3D } from 'three';

/**
 * Shared handle to the local hero's live rig root (the skinned character + skeleton),
 * published by Player.tsx's onRigReady. VFX that need the character's current pose —
 * e.g. the dash ghost/afterimage trail — read it here instead of drilling props through
 * the scene graph. Mirrors the weaponSockets pattern. Null until the rig loads / after
 * the player unmounts; consumers must null-check every frame (character swaps replace it).
 */
export const heroRig: { root: Object3D | null } = { root: null };
