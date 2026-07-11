import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  Box3,
  CanvasTexture,
  Color,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Group, Mesh, Object3D as Object3DType, PointLight } from 'three';
import { players } from '@/game/ecs/world';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { useGameModel } from '@/lib/loaders';
import { useUIStore } from '@/ui/store';
import { HUB_SPAWN, nearestHubStation, type HubStationId } from '@/game/world/hubLayout';
import { Terrain } from '@/game/world/Terrain';
import { GrassField } from '@/game/world/GrassField';
import { Trees } from '@/game/world/Trees';
import { Scatter } from '@/game/world/Scatter';
import { SummoningShrineRelic } from '@/game/world/SummoningShrineRelic';
import { ExpeditionPortalVFX } from '@/game/world/ExpeditionPortalVFX';

interface Props {
  obstacles: React.MutableRefObject<Object3DType[]>;
}

const MODEL_PATHS = {
  lodge: '/models/hub/roster-lodge.glb',
  shrine: '/models/hub/summoning-shrine.glb',
  gate: '/models/hub/expedition-gate.glb',
  curvedLamp: '/models/hub/lantern-curved.glb',
  straightLamp: '/models/hub/lantern-straight.glb',
  campfire: '/models/hub/campfire.glb',
} as const;

interface HubModelProps {
  path: string;
  targetHeight?: number;
  targetWidth?: number;
  position: [number, number, number];
  rotationY?: number;
  /** Corrects a model's authored front axis after applying gameplay-facing rotation. */
  faceOffset?: number;
}

/** Normalizes arbitrary Tripo export scale/pivot while preserving the authored proportions. */
const HubModel = ({ path, targetHeight, targetWidth, position, rotationY = 0, faceOffset = 0 }: HubModelProps) => {
  const gltf = useGameModel(path);
  const { object, scale, offset } = useMemo(() => {
    const clone = gltf.scene.clone(true);
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const s = targetWidth ? targetWidth / Math.max(size.x, 0.001) : (targetHeight ?? 1) / Math.max(size.y, 0.001);

    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const multipleMaterials = Array.isArray(mesh.material);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const clonedMaterials = materials.map((source) => {
        const material = source.clone() as MeshStandardMaterial;
        if (material.isMeshStandardMaterial) {
          material.roughness = Math.max(0.55, material.roughness);
          material.envMapIntensity = 0.35;
        }
        return material;
      });
      mesh.material = multipleMaterials ? clonedMaterials : clonedMaterials[0]!;
    });

    return {
      object: clone,
      scale: s,
      offset: [-center.x * s, -box.min.y * s, -center.z * s] as [number, number, number],
    };
  }, [gltf.scene, targetHeight, targetWidth]);

  return (
    <group position={position} rotation={[0, rotationY + faceOffset, 0]}>
      <primitive object={object} scale={scale} position={offset} />
    </group>
  );
};

/** Deterministic PRNG so the plaza paving is identical every session. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Converts a blurred height canvas into a tangent-space normal map via central differences. */
const heightToNormal = (heightCanvas: HTMLCanvasElement, strength: number) => {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d')!.getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const outCtx = out.getContext('2d')!;
  const img = outCtx.createImageData(size, size);
  const heightAt = (x: number, y: number) => src[(((y + size) % size) * size + ((x + size) % size)) * 4]! / 255;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
      const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  outCtx.putImageData(img, 0, 0);
  return out;
};

/**
 * Paints concentric rings of cobblestones — albedo plus a height-derived normal map so the
 * stones catch light like real rock. Irregular silhouettes, per-stone shading, mottled noise
 * and grout moss keep it from reading as a uniform pattern.
 */
const createCobblestoneMaps = () => {
  const size = 2048;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const a = albedo.getContext('2d')!;
  const heightCanvas = document.createElement('canvas');
  heightCanvas.width = size;
  heightCanvas.height = size;
  const h = heightCanvas.getContext('2d')!;
  const rand = mulberry32(20260711);
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size / 2;
  const grout = 9;

  // Grout base — recessed dark mortar in color, low in the height field.
  a.fillStyle = '#453e34';
  a.fillRect(0, 0, size, size);
  h.fillStyle = '#333333';
  h.fillRect(0, 0, size, size);

  // Slightly irregular ring boundaries so the pattern doesn't feel machined.
  const rings = 8;
  const radii = [0];
  for (let i = 1; i < rings; i += 1) radii.push((i / rings) * maxRadius * (1 + (rand() - 0.5) * 0.03));
  radii.push(maxRadius);

  const stones: { path: Path2D; px: number; py: number; r: number }[] = [];
  const corners: { x: number; y: number; ring: number }[] = [];

  const buildStone = (ring: number, a0: number, a1: number, r0: number, r1: number) => {
    const path = new Path2D();
    const jitter = grout * 0.55;
    const steps = 5;
    if (ring === 0) {
      // Hearthstone: irregular round slab under the campfire.
      const blob = Array.from({ length: 16 }, () => (rand() - 0.5) * jitter * 2);
      for (let i = 0; i <= 16; i += 1) {
        const angle = (i / 16) * Math.PI * 2;
        const radius = r1 - grout + blob[i % 16]!;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      return path;
    }
    const gapInner = (grout * 0.5) / Math.max(r0, 1);
    const gapOuter = (grout * 0.5) / Math.max(r1, 1);
    for (let i = 0; i <= steps; i += 1) {
      const angle = a0 + gapOuter + ((a1 - a0 - gapOuter * 2) * i) / steps + ((rand() - 0.5) * jitter) / r1;
      const radius = r1 - grout * 0.5 + (rand() - 0.5) * jitter;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i -= 1) {
      const angle = a0 + gapInner + ((a1 - a0 - gapInner * 2) * i) / steps + ((rand() - 0.5) * jitter) / Math.max(r0, 40);
      const radius = r0 + grout * 0.5 + (rand() - 0.5) * jitter;
      path.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
    path.closePath();
    return path;
  };

  for (let ring = 0; ring < rings; ring += 1) {
    const r0 = radii[ring]!;
    const r1 = radii[ring + 1]!;
    const rMid = (r0 + r1) / 2;
    const segments = ring === 0 ? 1 : Math.max(7, Math.round((Math.PI * 2 * rMid) / ((r1 - r0) * 1.25)));
    const angleStep = (Math.PI * 2) / segments;
    const startOffset = rand() * Math.PI * 2;

    for (let s = 0; s < segments; s += 1) {
      const a0 = startOffset + s * angleStep;
      const a1 = a0 + angleStep;
      const path = buildStone(ring, a0, a1, r0, r1);
      const aMid = (a0 + a1) / 2;
      const px = ring === 0 ? cx : cx + Math.cos(aMid) * rMid;
      const py = ring === 0 ? cy : cy + Math.sin(aMid) * rMid;
      const stoneR = ring === 0 ? r1 : Math.max((r1 - r0) / 2, (rMid * angleStep) / 2);
      stones.push({ path, px, py, r: stoneR });
      if (ring > 0) corners.push({ x: cx + Math.cos(a0) * r0, y: cy + Math.sin(a0) * r0, ring });

      // Albedo: warm gray with per-stone hue/value drift, lit from the upper-left.
      const hue = 30 + rand() * 18;
      const sat = 6 + rand() * 11;
      const lit = 38 + rand() * 24;
      const grad = a.createRadialGradient(px - stoneR * 0.35, py - stoneR * 0.35, stoneR * 0.1, px, py, stoneR * 1.5);
      grad.addColorStop(0, `hsl(${hue} ${sat}% ${lit + 7}%)`);
      grad.addColorStop(1, `hsl(${hue} ${sat}% ${lit - 7}%)`);
      a.fillStyle = grad;
      a.fill(path);

      // Bevel: offset strokes clipped to the stone read as a lit top edge + shadowed base.
      a.save();
      a.clip(path);
      a.lineWidth = 7;
      a.strokeStyle = 'rgba(20,15,10,0.38)';
      a.translate(-3, -3);
      a.stroke(path);
      a.strokeStyle = 'rgba(255,240,215,0.16)';
      a.translate(6, 6);
      a.stroke(path);
      a.translate(-3, -3);
      // Weathering blotches so no two stones share a surface.
      for (let b = 0; b < 3; b += 1) {
        const bx = px + (rand() - 0.5) * stoneR * 1.4;
        const by = py + (rand() - 0.5) * stoneR * 1.4;
        a.fillStyle = rand() > 0.45 ? `rgba(25,20,14,${0.05 + rand() * 0.08})` : `rgba(255,244,225,${0.04 + rand() * 0.06})`;
        a.beginPath();
        a.ellipse(bx, by, stoneR * (0.2 + rand() * 0.4), stoneR * (0.15 + rand() * 0.3), rand() * Math.PI, 0, Math.PI * 2);
        a.fill();
      }
      a.restore();

      // Height: each stone is a raised, gently domed slab with its own elevation.
      const elevation = 150 + rand() * 72;
      h.fillStyle = `rgb(${elevation},${elevation},${elevation})`;
      h.fill(path);
      const dome = h.createRadialGradient(px, py, 0, px, py, stoneR * 1.35);
      dome.addColorStop(0, 'rgba(255,255,255,0.30)');
      dome.addColorStop(1, 'rgba(0,0,0,0.22)');
      h.save();
      h.clip(path);
      h.fillStyle = dome;
      h.fill(path);
      h.restore();
    }
  }

  // Cracks across a handful of stones — into both color and height so they relight.
  for (let i = 0; i < 16; i += 1) {
    const stone = stones[Math.floor(rand() * stones.length)]!;
    const angle = rand() * Math.PI * 2;
    for (const [ctx2, style, width] of [
      [a, 'rgba(20,15,10,0.4)', 2.5],
      [h, 'rgba(0,0,0,0.5)', 3],
    ] as const) {
      ctx2.save();
      ctx2.clip(stone.path);
      ctx2.strokeStyle = style;
      ctx2.lineWidth = width;
      ctx2.beginPath();
      let x = stone.px - Math.cos(angle) * stone.r;
      let y = stone.py - Math.sin(angle) * stone.r;
      ctx2.moveTo(x, y);
      for (let seg = 0; seg < 4; seg += 1) {
        x += Math.cos(angle) * stone.r * 0.55 + (rand() - 0.5) * stone.r * 0.4;
        y += Math.sin(angle) * stone.r * 0.55 + (rand() - 0.5) * stone.r * 0.4;
        ctx2.lineTo(x, y);
      }
      ctx2.stroke();
      ctx2.restore();
    }
  }

  // Mottle: layered value noise breaks up every flat fill (stones and grout alike).
  const noisePass = (cells: number, alpha: number, mode: GlobalCompositeOperation, target: CanvasRenderingContext2D) => {
    const n = document.createElement('canvas');
    n.width = cells;
    n.height = cells;
    const nCtx = n.getContext('2d')!;
    const img = nCtx.createImageData(cells, cells);
    for (let i = 0; i < cells * cells; i += 1) {
      const v = Math.floor(rand() * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    nCtx.putImageData(img, 0, 0);
    target.globalAlpha = alpha;
    target.globalCompositeOperation = mode;
    target.imageSmoothingEnabled = true;
    target.drawImage(n, 0, 0, size, size);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
  };
  noisePass(48, 0.16, 'overlay', a);
  noisePass(200, 0.13, 'overlay', a);
  noisePass(900, 0.1, 'soft-light', a);
  noisePass(700, 0.12, 'overlay', h);

  // Moss: clustered growth out of grout junctions, denser toward the rim.
  const mossClump = (x: number, y: number, scale: number) => {
    const blobs = 5 + Math.floor(rand() * 8);
    for (let b = 0; b < blobs; b += 1) {
      const bx = x + (rand() - 0.5) * 26 * scale;
      const by = y + (rand() - 0.5) * 26 * scale;
      const hue = 78 + rand() * 32;
      a.fillStyle = `hsla(${hue}, ${34 + rand() * 22}%, ${26 + rand() * 14}%, ${0.22 + rand() * 0.3})`;
      a.beginPath();
      a.ellipse(bx, by, (3 + rand() * 9) * scale, (2 + rand() * 6) * scale, rand() * Math.PI, 0, Math.PI * 2);
      a.fill();
    }
  };
  for (const corner of corners) {
    if (rand() < 0.12 + 0.3 * (corner.ring / rings)) mossClump(corner.x, corner.y, 0.8 + rand() * 0.9);
  }
  for (let i = 0; i < 46; i += 1) {
    const angle = rand() * Math.PI * 2;
    const radius = maxRadius * (0.9 + rand() * 0.08);
    mossClump(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0.9 + rand() * 1.1);
  }

  // Rim vignette anchors the circle into the dirt.
  const vignette = a.createRadialGradient(cx, cy, maxRadius * 0.72, cx, cy, maxRadius);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(20,14,8,0.28)');
  a.fillStyle = vignette;
  a.fillRect(0, 0, size, size);

  // Soften the height field before differentiation so bevels are rounded, not aliased.
  const blurred = document.createElement('canvas');
  blurred.width = size;
  blurred.height = size;
  const bCtx = blurred.getContext('2d')!;
  bCtx.filter = 'blur(2.5px)';
  bCtx.drawImage(heightCanvas, 0, 0);

  const map = new CanvasTexture(albedo);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  const normalMap = new CanvasTexture(heightToNormal(blurred, 2.6));
  normalMap.anisotropy = 8;
  return { map, normalMap };
};

/** The cobbled heart of the plaza, matching the concentric stonework in the concept art. */
const CobblestoneCircle = ({ radius = 5.85 }: { radius?: number }) => {
  const { map, normalMap } = useMemo(createCobblestoneMaps, []);
  useEffect(
    () => () => {
      map.dispose();
      normalMap.dispose();
    },
    [map, normalMap],
  );
  return (
    <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[radius, 72]} />
      <meshStandardMaterial map={map} normalMap={normalMap} normalScale={[0.8, 0.8]} roughness={0.94} />
    </mesh>
  );
};

/** Warm, flickering firelight — two out-of-phase sines read as flame, not strobe. */
const CampfireGlow = ({ position }: { position: [number, number, number] }) => {
  const light = useRef<PointLight>(null);
  useFrame(({ clock }) => {
    if (!light.current) return;
    const t = clock.elapsedTime;
    light.current.intensity = 8 + Math.sin(t * 9.3) * 1.1 + Math.sin(t * 23.7) * 0.7;
  });
  return <pointLight ref={light} position={position} color="#ff9448" intensity={8} distance={10} decay={2} />;
};

/**
 * The plaza is now just the cobbled hearth ring sitting directly in the grass — the
 * old brown dirt disk and stone paving are gone; green terrain, grass fill and the
 * shader-baked dirt roads (Terrain.tsx / terrainHeight.ts) carry the ground instead.
 */
const HavenPlaza = () => (
  <group>
    <CobblestoneCircle radius={5.85} />
  </group>
);

const StationRing = ({ position, color, radius = 1.75 }: { position: [number, number, number]; color: string; radius?: number }) => {
  const ref = useRef<Mesh>(null);
  const material = useMemo(
    () => new MeshStandardMaterial({ color, emissive: new Color(color), emissiveIntensity: 0.42, roughness: 0.72 }),
    [color],
  );
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 1.8) * 0.025;
    ref.current.scale.setScalar(pulse);
    material.emissiveIntensity = 0.34 + Math.sin(clock.elapsedTime * 1.8) * 0.08;
  });
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh ref={ref} position={position} rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <ringGeometry args={[radius - 0.1, radius, 48]} />
    </mesh>
  );
};

const HubInteractions = () => {
  const initialized = useRef(false);
  const activeStation = useRef<HubStationId | undefined>(undefined);
  const setHubStation = useUIStore((s) => s.setHubStation);
  const setScene = useUIStore((s) => s.setScene);

  useFrame(() => {
    const player = players.first;
    if (!player?.transform) return;
    if (!initialized.current) {
      player.transform.position = [...HUB_SPAWN];
      player.transform.rotationY = Math.PI;
      initialized.current = true;
    }
    const station = nearestHubStation(player.transform.position[0], player.transform.position[2]);
    if (station?.id !== activeStation.current) {
      activeStation.current = station?.id;
      setHubStation(station?.id);
    }
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat) return;
      const station = activeStation.current;
      if (station === 'roster') {
        const store = useUIStore.getState();
        const ids = Object.keys(PLAYER_CHARACTERS) as PlayerCharacterId[];
        const next = ids[(ids.indexOf(store.playerCharacter) + 1) % ids.length];
        if (next) store.setPlayerCharacter(next);
      } else if (station === 'expedition') {
        const player = players.first;
        if (player?.transform && player.velocity) {
          player.transform.position = [0, 0, 0];
          player.transform.rotationY = Math.PI;
          player.velocity.linear = [0, 0, 0];
        }
        setHubStation(undefined);
        setScene('expedition');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setHubStation, setScene]);

  return null;
};

/** Heartwood Haven: a compact social hub built from the first production asset set. */
export const SocialHub = ({ obstacles }: Props) => {
  const landmarks = useRef<Group>(null);

  useEffect(() => {
    const meshes: Mesh[] = [];
    landmarks.current?.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
    obstacles.current = meshes;
    return () => {
      obstacles.current = [];
    };
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <GrassField clearRadius={20.5} plazaFill />
      <Scatter clearRadius={24} groundClearRadius={21} plazaFill />
      <Trees clearRadius={21.5} />
      <HavenPlaza />
      <group ref={landmarks}>
        <HubModel path={MODEL_PATHS.lodge} targetWidth={9.4} position={[-10.5, 0, -10.5]} rotationY={0} />
        <HubModel path={MODEL_PATHS.shrine} targetHeight={3.35} position={[10.5, 0.08, -7.4]} rotationY={-0.35} />
        <HubModel
          path={MODEL_PATHS.gate}
          targetHeight={4.5}
          position={[0, 0.08, -17]}
          rotationY={Math.PI}
          faceOffset={-Math.PI / 2}
        />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.55} position={[-6.8, 0.04, 7]} rotationY={0.45} />
        <HubModel path={MODEL_PATHS.straightLamp} targetHeight={3.05} position={[6.8, 0.04, 7]} rotationY={-0.45} />
        <HubModel path={MODEL_PATHS.curvedLamp} targetHeight={2.3} position={[-14.8, 0.04, -1.5]} rotationY={0.9} />
        <HubModel path={MODEL_PATHS.straightLamp} targetHeight={2.7} position={[14.8, 0.04, -1.5]} rotationY={-0.9} />
        <HubModel path={MODEL_PATHS.campfire} targetWidth={1.7} position={[0, 0.06, 0]} rotationY={0.6} />
      </group>
      <CampfireGlow position={[0, 1.1, 0]} />

      <StationRing position={[0, 0.105, -17]} color="#42c8c7" radius={2.05} />
      <ExpeditionPortalVFX position={[0, 2.02, -17.03]} radius={1.56} />
      <SummoningShrineRelic position={[10.5, 1.7, -7.4]} rotationY={-0.35} />

      {[
        [-6.8, 2.1, 7],
        [6.8, 2.5, 7],
        [-14.8, 1.9, -1.5],
        [14.8, 2.25, -1.5],
      ].map((position, i) => (
        <pointLight key={i} position={position as [number, number, number]} color="#ffb55f" intensity={5} distance={5.5} decay={2} />
      ))}
      <pointLight position={[0, 2, -17]} color="#66e1dc" intensity={9} distance={7} decay={2} />
      <directionalLight position={[2, 9, 12]} color="#ffe0b8" intensity={1.35} />

      <Html position={[-10.5, 3.55, -9.75]} center distanceFactor={13} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-full border border-amber-100/20 bg-[#21170f]/75 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.24em] text-amber-100 shadow-lg backdrop-blur-sm">
          Roster Lodge
        </div>
      </Html>
      <HubInteractions />
    </>
  );
};

Object.values(MODEL_PATHS).forEach((path) => useGameModel.preload(path));
