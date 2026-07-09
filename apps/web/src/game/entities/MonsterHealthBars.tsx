import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Color, DynamicDrawUsage, InstancedBufferAttribute, Object3D, PlaneGeometry, ShaderMaterial } from 'three';
import type { InstancedMesh } from 'three';
import type { Entity } from '@/game/ecs/components';
import { monsters } from '@/game/ecs/world';
import { gameNow } from '@/game/feel/time';
import {
  HP_BAR_FADE_MS,
  HP_BAR_GHOST_DRAIN,
  HP_BAR_GHOST_HOLD_MS,
  HP_BAR_LINGER_MS,
  MAX_MONSTERS,
} from '@shared/balance';

const BAR_W = 0.9;
const BAR_H = 0.14;

/**
 * Bar anchor height per archetype: model display height + clearance. Display heights
 * live in the renderers (MutantModels HEIGHT for the chaser, MonsterModels ARCHES
 * for the rest) — keep in sync if a model is rescaled.
 */
const BAR_Y: Record<string, number> = { chaser: 2.75, spitter: 1.65, brute: 3.05 };

const dummy = new Object3D();

/**
 * Per-monster presentation state (chip-segment drain). Keyed weakly so dead
 * entities are GC'd with their state; never stored in the ECS — it's render-only.
 */
const barState = new WeakMap<Entity, { ghost: number }>();

// One instanced quad; fill / chip / fade / rounded corners all live in the shader,
// packed into a single per-instance vec4 so the whole HUD layer is ONE draw call.
const geometry = new PlaneGeometry(1, 1);
const aBar = new InstancedBufferAttribute(new Float32Array(MAX_MONSTERS * 4), 4);
aBar.setUsage(DynamicDrawUsage);
geometry.setAttribute('aBar', aBar);

const vertexShader = /* glsl */ `
  attribute vec4 aBar; // x: fill, y: chip (ghost), z: alpha, w: aspect (w/h)
  varying vec2 vUv;
  varying vec4 vBar;

  void main() {
    vUv = uv;
    vBar = aBar;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uFill;
  uniform vec3 uGhost;
  uniform vec3 uBack;
  varying vec2 vUv;
  varying vec4 vBar;

  // Signed distance to a rounded rectangle (p in units of bar half-height).
  float sdRoundRect(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    float fill = vBar.x;
    float ghost = vBar.y;
    float alpha = vBar.z;
    float aspect = vBar.w;

    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float dOut = sdRoundRect(p, vec2(aspect * 0.5, 0.5), 0.18);
    float outerA = 1.0 - smoothstep(-fwidth(dOut), fwidth(dOut), dOut);
    if (outerA <= 0.003) discard;

    // Inner trough, inset from the dark backing so the bar has a readable rim.
    float inset = 0.16;
    float dIn = sdRoundRect(p, vec2(aspect * 0.5 - inset, 0.5 - inset), 0.10);
    float innerA = 1.0 - smoothstep(-fwidth(dIn), fwidth(dIn), dIn);

    // Map uv.x into the trough's 0..1 range, then carve fill and chip regions.
    float bx = inset / aspect;
    float t = clamp((vUv.x - bx) / max(1.0 - 2.0 * bx, 1e-4), 0.0, 1.0);
    float e = max(fwidth(t), 1e-4);
    float fillM = (1.0 - smoothstep(fill - e, fill + e, t)) * innerA;
    float ghostM = (1.0 - smoothstep(ghost - e, ghost + e, t)) * innerA * (1.0 - fillM);

    vec3 col = mix(uBack, uFill, fillM);
    col = mix(col, uGhost, ghostM);
    float opacity = mix(0.8, 1.0, max(fillM, ghostM)); // empty trough slightly translucent
    gl_FragColor = vec4(col, outerA * opacity * alpha);
  }
`;

// Colors stay well below the bloom luminanceThreshold (1.05) so bars never glow.
const material = new ShaderMaterial({
  uniforms: {
    uFill: { value: new Color('#e23b3b') },
    uGhost: { value: new Color('#f2ead8') },
    uBack: { value: new Color('#101014') },
  },
  vertexShader,
  fragmentShader,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});

/**
 * Overhead monster HP bars, AAA-style presentation:
 *  - hidden while idle; appears INSTANTLY on first damage (it's hit feedback),
 *    lingers HP_BAR_LINGER_MS after the last hit, then fades out over HP_BAR_FADE_MS.
 *  - two-stage drain: red fill snaps down on the impact frame, a pale "chip" segment
 *    holds the just-lost amount for HP_BAR_GHOST_HOLD_MS, then drains to meet it.
 *  - billboarded against the mouse-look orbit camera (instance rotation = camera
 *    quaternion; the old fixed-yaw +Z assumption is gone).
 * Runs on gameNow() so bars freeze correctly during hitstop. Untouched monsters cost
 * one `continue`; the whole layer is a single instanced draw call, zero when idle.
 */
export const MonsterHealthBars = () => {
  const ref = useRef<InstancedMesh>(null);
  const prevNow = useRef(0);

  useEffect(() => {
    ref.current?.instanceMatrix.setUsage(DynamicDrawUsage);
  }, []);

  useFrame(({ camera }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const now = gameNow();
    const gDt = Math.max(0, now - prevNow.current) / 1000;
    prevNow.current = now;

    let i = 0;
    for (const m of monsters) {
      if (i >= MAX_MONSTERS) break;
      const last = m.lastDamagedAt;
      if (last === undefined) continue; // never damaged — no bar, no work

      const since = now - last;
      let alpha = since < HP_BAR_LINGER_MS ? 1 : 1 - (since - HP_BAR_LINGER_MS) / HP_BAR_FADE_MS;
      const frac = Math.max(0, Math.min(1, m.health.current / m.health.max));

      let s = barState.get(m);
      if (!s) {
        // The first hit ever lands from full HP, so the chip segment starts at 1.
        s = { ghost: 1 };
        barState.set(m, s);
      }
      if (frac > s.ghost) s.ghost = frac;
      if (since >= HP_BAR_GHOST_HOLD_MS && s.ghost > frac) {
        s.ghost += (frac - s.ghost) * (1 - Math.exp(-HP_BAR_GHOST_DRAIN * gDt));
        if (s.ghost - frac < 0.004) s.ghost = frac;
      }

      if (alpha <= 0) continue; // fully faded — free the slot (state kept for re-show)
      alpha = alpha * alpha * (3 - 2 * alpha); // ease the fade tail

      const r = m.radius ?? 0.5;
      const w = BAR_W + (r - 0.5) * 1.2; // bigger body ⇒ wider bar (brute ≈ 1.3)
      const [x, , z] = m.transform.position;
      dummy.position.set(x, BAR_Y[m.monster] ?? r * 2 + 0.5, z);
      dummy.quaternion.copy(camera.quaternion);
      dummy.scale.set(w, BAR_H, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const o = i * 4;
      const arr = aBar.array as Float32Array;
      arr[o] = frac;
      arr[o + 1] = s.ghost;
      arr[o + 2] = alpha;
      arr[o + 3] = w / BAR_H;
      i++;
    }

    mesh.count = i;
    if (i > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      aBar.needsUpdate = true;
    }
  });

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, MAX_MONSTERS]}
      frustumCulled={false}
      renderOrder={999}
    />
  );
};
