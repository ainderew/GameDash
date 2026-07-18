import { Suspense, useLayoutEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { Box3, type Group, type Ray } from 'three';
import { heightAt } from '@sim/terrain/terrainHeight';
import { Terrain } from '@/game/world/Terrain';
import { SkyAndLight } from '@/game/world/SkyAndLight';
import { ModelInstance } from '@/game/world/MapPlacements';
import { useGameModel } from '@/lib/loaders';
import { defaultScaleFor } from '@/editor/assetDefaults';
import type { MapPlacement } from '@/game/world/maps/types';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Per-asset measurements taken from the raw GLTF: distance from pivot down to the
 * bbox bottom (many packs pivot at the mesh CENTER — grounding uses
 * pivot + baseOffset·scaleY), and the raw bbox size (drives default scale).
 */
interface AssetInfo {
  baseOffset: number;
  size: { x: number; y: number; z: number };
}
const assetInfo = new Map<string, AssetInfo>();
export const getBaseOffset = (asset: string): number => assetInfo.get(asset)?.baseOffset ?? 0;

/** Uniform scale a new placement starts at: the game-matching target size, if known. */
export const getDefaultScale = (asset: string): number => {
  const info = assetInfo.get(asset);
  return info ? defaultScaleFor(asset, info.size) : 1;
};

/** Measures an asset once, then renders it like the game does. */
const EditorModel = ({ asset }: { asset: string }) => {
  const gltf = useGameModel(asset);
  useLayoutEffect(() => {
    if (!assetInfo.has(asset)) {
      const box = new Box3().setFromObject(gltf.scene);
      assetInfo.set(asset, {
        baseOffset: box.min.y < 0 ? -box.min.y : 0,
        size: {
          x: box.max.x - box.min.x,
          y: box.max.y - box.min.y,
          z: box.max.z - box.min.z,
        },
      });
    }
  }, [asset, gltf.scene]);
  return <ModelInstance asset={asset} />;
};

/** Ground height for a placement: terrain + the model's own base offset. */
export const groundedY = (asset: string, x: number, z: number, scaleY: number): number =>
  heightAt(x, z) + getBaseOffset(asset) * scaleY;

export interface PlacementTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

interface Props {
  placements: MapPlacement[];
  selectedId: string | null;
  /** Asset URL currently being placed (palette selection), or null. */
  placingAsset: string | null;
  /** Extra height added while placing (float props, sink rocks…). */
  placeYOffset: number;
  gizmoMode: GizmoMode;
  snapToGround: boolean;
  onSelect: (id: string | null) => void;
  /** point is grounded; scale is the asset's game-matching default (uniform). */
  onPlace: (point: [number, number, number], scale: number) => void;
  /** Gizmo drag lifecycle — the app snapshots for undo on start, commits on end. */
  onDragStart: () => void;
  onDragEnd: (id: string, transform: PlacementTransform) => void;
}

/**
 * Find where a pointer ray meets the terrain height field: coarse march along
 * the ray until it dips under heightAt, then bisect. No mesh raycast needed.
 */
const pickGround = (ray: Ray): [number, number, number] | null => {
  const o = ray.origin;
  const d = ray.direction;
  if (o.y - heightAt(o.x, o.z) <= 0) return null;
  let tPrev = 0;
  for (let t = 2; t <= 600; t += 2) {
    const f = o.y + d.y * t - heightAt(o.x + d.x * t, o.z + d.z * t);
    if (f <= 0) {
      let lo = tPrev;
      let hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const fm = o.y + d.y * mid - heightAt(o.x + d.x * mid, o.z + d.z * mid);
        if (fm > 0) lo = mid;
        else hi = mid;
      }
      const tHit = (lo + hi) / 2;
      const x = o.x + d.x * tHit;
      const z = o.z + d.z * tHit;
      return [x, heightAt(x, z), z];
    }
    tPrev = t;
  }
  return null;
};

/** The editor viewport: real terrain + sky, placed props, ghost preview, gizmo. */
export const EditorScene = ({
  placements,
  selectedId,
  placingAsset,
  placeYOffset,
  gizmoMode,
  snapToGround,
  onSelect,
  onPlace,
  onDragStart,
  onDragEnd,
}: Props) => {
  const groupRefs = useRef(new Map<string, Group>());
  const ghostRef = useRef<Group>(null);

  const selectedObject = selectedId ? groupRefs.current.get(selectedId) : undefined;
  const selectedAsset = placements.find((p) => p.id === selectedId)?.asset;

  const commitDrag = () => {
    if (!selectedId) return;
    const obj = groupRefs.current.get(selectedId);
    if (!obj) return;
    if (snapToGround && gizmoMode === 'translate' && selectedAsset) {
      obj.position.y = groundedY(selectedAsset, obj.position.x, obj.position.z, obj.scale.y);
    }
    onDragEnd(selectedId, {
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z],
    });
  };

  return (
    <Canvas shadows="soft" flat camera={{ position: [26, 22, 26], fov: 50 }}>
      <Suspense fallback={null}>
        <SkyAndLight />
        {/* Terrain mounts RigidBody colliders — give it a (paused) physics world. */}
        <Physics paused>
          <Terrain />
        </Physics>

        {placements.map((p) => (
          <group
            key={p.id}
            ref={(g) => {
              if (g) groupRefs.current.set(p.id, g);
              else groupRefs.current.delete(p.id);
            }}
            position={p.position}
            rotation={p.rotation}
            scale={p.scale}
            onClick={(e) => {
              // While placing, clicks fall through to the ground plane instead.
              if (placingAsset || e.delta > 4) return;
              e.stopPropagation();
              onSelect(p.id);
            }}
          >
            <Suspense fallback={null}>
              <EditorModel asset={p.asset} />
            </Suspense>
          </group>
        ))}

        {/* Ghost preview of the asset about to be placed, tracking the cursor. */}
        {placingAsset && (
          <group ref={ghostRef} visible={false}>
            <Suspense fallback={null}>
              <EditorModel asset={placingAsset} />
            </Suspense>
          </group>
        )}

        {/* Invisible event-catcher: ground picking runs on the analytic height
            field via the event ray, so this plane only needs to catch pointers. */}
        <mesh
          rotation-x={-Math.PI / 2}
          position-y={-0.02}
          onPointerMove={(e) => {
            if (!placingAsset || !ghostRef.current) return;
            const point = pickGround(e.ray);
            if (!point) return;
            const scale = getDefaultScale(placingAsset);
            ghostRef.current.visible = true;
            ghostRef.current.scale.setScalar(scale);
            const y = groundedY(placingAsset, point[0], point[2], scale) + placeYOffset;
            ghostRef.current.position.set(point[0], y, point[2]);
          }}
          onClick={(e) => {
            if (e.delta > 4) return;
            if (placingAsset) {
              const point = pickGround(e.ray);
              if (point) {
                const scale = getDefaultScale(placingAsset);
                const y = groundedY(placingAsset, point[0], point[2], scale) + placeYOffset;
                onPlace([point[0], y, point[2]], scale);
              }
            } else {
              onSelect(null);
            }
          }}
        >
          <planeGeometry args={[600, 600]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </Suspense>

      {selectedObject && (
        <TransformControls
          object={selectedObject}
          mode={gizmoMode}
          onMouseDown={onDragStart}
          onMouseUp={commitDrag}
        />
      )}
      <OrbitControls makeDefault maxPolarAngle={Math.PI / 2 - 0.05} maxDistance={220} />
    </Canvas>
  );
};
