import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EditorScene,
  getBaseOffset,
  getDefaultScale,
  type GizmoMode,
  type PlacementTransform,
} from '@/editor/EditorScene';
import { BUILTIN_MAPS, type MapPlacement } from '@/game/world/maps/types';
import { heightAt } from '@sim/terrain/terrainHeight';
import { useUIStore } from '@/ui/store';

const MAP_NAME_RE = /^[a-z0-9-]{1,40}$/;

/** Compact unique id — maps are hand-mergeable JSON, so keep ids short and readable. */
const newId = () =>
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const assetLabel = (url: string) => url.split('/').pop()!.replace(/\.(glb|gltf)$/i, '');
const assetGroup = (url: string) => {
  const parts = url.split('/');
  return parts.length > 3 ? parts.slice(2, -1).join('/') : 'models';
};

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Numeric input that commits on blur/Enter (not per keystroke, to keep undo sane). */
const NumField = ({
  label,
  value,
  step = 0.1,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  onCommit: (n: number) => void;
}) => (
  <label className="flex min-w-0 items-center gap-1">
    <span className="shrink-0 text-neutral-500">{label}</span>
    <input
      // Remount when the outside value changes (gizmo drags) so defaultValue refreshes.
      key={value}
      type="number"
      step={step}
      defaultValue={fmt(value)}
      onBlur={(e) => {
        const n = parseFloat(e.currentTarget.value);
        if (Number.isFinite(n) && n !== value) onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="w-full min-w-0 rounded bg-neutral-800 px-1 py-0.5 text-xs outline-none"
    />
  </label>
);

/**
 * Dev-only map editor (editor.html). Browse assets, click them into the world,
 * adjust with the gizmo, Ctrl+S writes src/game/world/maps/<map>.json — which the
 * game renders via MapPlacements.
 */
export const MapEditorApp = () => {
  const [mapName, setMapName] = useState<string>('expedition');
  const [mapList, setMapList] = useState<string[]>([...BUILTIN_MAPS]);
  const [placements, setPlacements] = useState<MapPlacement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placingAsset, setPlacingAsset] = useState<string | null>(null);
  const [placeYOffset, setPlaceYOffset] = useState(0);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [snapToGround, setSnapToGround] = useState(true);
  const [assets, setAssets] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');

  const undoStack = useRef<MapPlacement[][]>([]);
  const redoStack = useRef<MapPlacement[][]>([]);
  const dragSnapshot = useRef<MapPlacement[] | null>(null);

  // Refs so the single window keydown handler always sees current state.
  const stateRef = useRef({ placements, selectedId, placingAsset, dirty, mapName });
  stateRef.current = { placements, selectedId, placingAsset, dirty, mapName };

  /** Every mutation goes through here: snapshot for undo, mark dirty. */
  const apply = useCallback((next: MapPlacement[], snapshot?: MapPlacement[]) => {
    undoStack.current.push(snapshot ?? stateRef.current.placements);
    redoStack.current = [];
    setPlacements(next);
    setDirty(true);
  }, []);

  // ── Backend I/O ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/__map-editor/assets')
      .then((r) => r.json())
      .then((d: { assets: string[] }) => setAssets(d.assets))
      .catch(() => setStatus('Failed to list assets — is this the vite dev server?'));
    fetch('/__map-editor/maps')
      .then((r) => r.json())
      .then((d: { maps: string[] }) => setMapList(d.maps))
      .catch(() => {
        /* builtin fallback list already set */
      });
  }, []);

  const createMap = useCallback(async () => {
    const name = window
      .prompt('New map name (lowercase letters, digits, dashes):', 'my-arena')
      ?.trim();
    if (!name) return;
    if (!MAP_NAME_RE.test(name)) {
      setStatus('Bad name — use lowercase letters, digits, dashes.');
      return;
    }
    if (mapList.includes(name)) {
      setMapName(name);
      return;
    }
    try {
      const res = await fetch(`/__map-editor/maps/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, placements: [] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMapList((list) => [...list, name].sort());
      setMapName(name);
      setStatus(`Created ${name}.json`);
    } catch (err) {
      setStatus(`Create failed: ${(err as Error).message}`);
    }
  }, [mapList]);

  useEffect(() => {
    let stale = false;
    fetch(`/__map-editor/maps/${mapName}`)
      .then((r) => r.json())
      .then((d: { placements: MapPlacement[] }) => {
        if (stale) return;
        setPlacements(d.placements);
        setSelectedId(null);
        setDirty(false);
        undoStack.current = [];
        redoStack.current = [];
      })
      .catch(() => setStatus(`Failed to load map "${mapName}"`));
    // Match the game's lighting mood: custom maps light like the expedition zone.
    useUIStore.setState({ scene: mapName === 'hub' ? 'hub' : 'expedition' });
    return () => {
      stale = true;
    };
  }, [mapName]);

  const save = useCallback(async () => {
    const { placements: current, mapName: name } = stateRef.current;
    try {
      const res = await fetch(`/__map-editor/maps/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, placements: current }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDirty(false);
      setStatus(`Saved ${name}.json ✓`);
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(''), 3000);
    return () => clearTimeout(t);
  }, [status]);

  // ── Edits ──────────────────────────────────────────────────────────────────
  const placeAt = useCallback(
    (point: [number, number, number], scale: number) => {
      const asset = stateRef.current.placingAsset;
      if (!asset) return;
      const p: MapPlacement = {
        id: newId(),
        asset,
        position: point,
        rotation: [0, 0, 0],
        scale: [scale, scale, scale],
      };
      apply([...stateRef.current.placements, p]);
      setSelectedId(p.id);
    },
    [apply],
  );

  const updateSelected = useCallback(
    (patch: Partial<MapPlacement>) => {
      const { placements: current, selectedId: id } = stateRef.current;
      if (!id) return;
      apply(current.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    [apply],
  );

  const deleteSelected = useCallback(() => {
    const { placements: current, selectedId: id } = stateRef.current;
    if (!id) return;
    apply(current.filter((p) => p.id !== id));
    setSelectedId(null);
  }, [apply]);

  const duplicateSelected = useCallback(() => {
    const { placements: current, selectedId: id } = stateRef.current;
    const src = current.find((p) => p.id === id);
    if (!src) return;
    const copy: MapPlacement = {
      ...src,
      id: newId(),
      position: [src.position[0] + 1.5, src.position[1], src.position[2] + 1.5],
    };
    apply([...current, copy]);
    setSelectedId(copy.id);
  }, [apply]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(stateRef.current.placements);
    setPlacements(prev);
    setSelectedId(null);
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(stateRef.current.placements);
    setPlacements(next);
    setSelectedId(null);
    setDirty(true);
  }, []);

  const onDragStart = useCallback(() => {
    dragSnapshot.current = stateRef.current.placements;
  }, []);

  const onDragEnd = useCallback(
    (id: string, t: PlacementTransform) => {
      const snapshot = dragSnapshot.current ?? undefined;
      dragSnapshot.current = null;
      apply(
        stateRef.current.placements.map((p) => (p.id === id ? { ...p, ...t } : p)),
        snapshot,
      );
    },
    [apply],
  );

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (ctrl && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (ctrl && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelected();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected();
      } else if (e.key === 'Escape') {
        if (stateRef.current.placingAsset) setPlacingAsset(null);
        else setSelectedId(null);
      } else if (e.key === 'w' || e.key === 'W') {
        setGizmoMode('translate');
      } else if (e.key === 'e' || e.key === 'E') {
        setGizmoMode('rotate');
      } else if (e.key === 'r' || e.key === 'R') {
        setGizmoMode('scale');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, undo, redo, duplicateSelected, deleteSelected]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (stateRef.current.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ── Palette data ───────────────────────────────────────────────────────────
  const grouped = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = assets.filter((a) => a.toLowerCase().includes(q));
    const groups = new Map<string, string[]>();
    for (const a of filtered) {
      const g = assetGroup(a);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(a);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [assets, search]);

  const selected = placements.find((p) => p.id === selectedId);

  const modeButton = (mode: GizmoMode, label: string, key: string) => (
    <button
      key={mode}
      onClick={() => setGizmoMode(mode)}
      className={`rounded px-2 py-1 text-xs ${
        gizmoMode === mode ? 'bg-emerald-600 text-white' : 'bg-neutral-800 hover:bg-neutral-700'
      }`}
      title={`${label} (${key})`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full w-full select-none bg-neutral-950 text-neutral-200">
      {/* ── Asset palette ── */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
        <div className="border-b border-neutral-800 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h1 className="text-sm font-bold tracking-wide">MAP EDITOR</h1>
            <select
              value={mapName}
              onChange={(e) => {
                if (stateRef.current.dirty && !window.confirm('Discard unsaved changes?')) {
                  e.target.value = mapName;
                  return;
                }
                if (e.target.value === '__new') {
                  e.target.value = mapName;
                  void createMap();
                  return;
                }
                setMapName(e.target.value);
              }}
              className="rounded bg-neutral-800 px-2 py-1 text-xs"
            >
              {mapList.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="__new">＋ new map…</option>
            </select>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assets…"
            className="w-full rounded bg-neutral-800 px-2 py-1.5 text-xs outline-none placeholder:text-neutral-500"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {grouped.map(([group, urls]) => (
            <div key={group} className="mb-3">
              <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                {group} · {urls.length}
              </div>
              {urls.map((url) => (
                <button
                  key={url}
                  onClick={() => setPlacingAsset(placingAsset === url ? null : url)}
                  className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                    placingAsset === url
                      ? 'bg-emerald-600 text-white'
                      : 'text-neutral-300 hover:bg-neutral-800'
                  }`}
                  title={url}
                >
                  {assetLabel(url)}
                </button>
              ))}
            </div>
          ))}
          {assets.length === 0 && (
            <div className="p-2 text-xs text-neutral-500">Loading assets…</div>
          )}
        </div>
        <div className="border-t border-neutral-800 p-2 text-[10px] leading-relaxed text-neutral-500">
          Click asset → click terrain to place (Esc stops). Click a prop to select. W/E/R
          move·rotate·scale, Ctrl+D duplicate, Del delete, Ctrl+Z undo, Ctrl+S save.
        </div>
      </aside>

      {/* ── Viewport ── */}
      <main className="relative min-w-0 flex-1">
        <EditorScene
          placements={placements}
          selectedId={selectedId}
          placingAsset={placingAsset}
          placeYOffset={placeYOffset}
          gizmoMode={gizmoMode}
          snapToGround={snapToGround}
          onSelect={setSelectedId}
          onPlace={placeAt}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />

        {/* Toolbar */}
        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-neutral-900/90 p-2 shadow-lg">
          {modeButton('translate', 'Move', 'W')}
          {modeButton('rotate', 'Rotate', 'E')}
          {modeButton('scale', 'Scale', 'R')}
          <label className="ml-2 flex items-center gap-1 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={snapToGround}
              onChange={(e) => setSnapToGround(e.target.checked)}
            />
            snap to ground
          </label>
          <button
            onClick={() => void save()}
            className={`ml-2 rounded px-3 py-1 text-xs font-semibold ${
              dirty ? 'bg-amber-500 text-black hover:bg-amber-400' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            {dirty ? 'Save*' : 'Saved'}
          </button>
          <span className="text-xs text-neutral-500">{placements.length} props</span>
        </div>

        {status && (
          <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded bg-neutral-900/90 px-3 py-1.5 text-xs shadow-lg">
            {status}
          </div>
        )}

        {placingAsset && (
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded bg-emerald-700/90 px-3 py-1.5 text-xs text-white shadow-lg">
            <span>
              Placing <b>{assetLabel(placingAsset)}</b> — click terrain · Esc to stop
            </span>
            <label className="flex items-center gap-1">
              Y offset
              <input
                type="number"
                step={0.5}
                value={placeYOffset}
                onChange={(e) => setPlaceYOffset(parseFloat(e.target.value) || 0)}
                className="w-16 rounded bg-emerald-900/70 px-1 py-0.5 outline-none"
              />
            </label>
          </div>
        )}

        {/* Selected-prop panel */}
        {selected && (
          <div className="absolute right-3 top-3 w-56 rounded-lg bg-neutral-900/90 p-3 text-xs shadow-lg">
            <div className="mb-2 truncate font-semibold" title={selected.asset}>
              {assetLabel(selected.asset)}
            </div>
            <div className="space-y-1.5">
              <div className="grid grid-cols-3 gap-1">
                {([0, 1, 2] as const).map((axis) => (
                  <NumField
                    key={'xyz'[axis]}
                    label={'xyz'[axis]!}
                    value={selected.position[axis]}
                    onCommit={(n) => {
                      const position = [...selected.position] as [number, number, number];
                      position[axis] = n;
                      updateSelected({ position });
                    }}
                  />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <NumField
                  label="rot°"
                  step={5}
                  value={(selected.rotation[1] * 180) / Math.PI}
                  onCommit={(deg) =>
                    updateSelected({
                      rotation: [selected.rotation[0], (deg * Math.PI) / 180, selected.rotation[2]],
                    })
                  }
                />
                <NumField
                  label="scale"
                  value={selected.scale[0]}
                  onCommit={(n) => updateSelected({ scale: [n, n, n] })}
                />
              </div>
            </div>
            <button
              onClick={() => {
                const s = getDefaultScale(selected.asset);
                // Re-seat on the ground for the new size (keeps x/z where you put it).
                const [x, , z] = selected.position;
                updateSelected({
                  scale: [s, s, s],
                  position: [x, heightAt(x, z) + getBaseOffset(selected.asset) * s, z],
                });
              }}
              className="mt-2 w-full rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
              title="Resize to match how the game scales this model"
            >
              Set game-default scale
            </button>
            <div className="mt-2 flex gap-2">
              <button
                onClick={duplicateSelected}
                className="flex-1 rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
              >
                Duplicate
              </button>
              <button
                onClick={deleteSelected}
                className="flex-1 rounded bg-red-900/70 px-2 py-1 text-red-200 hover:bg-red-800"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
