import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';

/**
 * Dev-only backend for the map editor (/editor.html):
 *   GET  /__map-editor/assets       → every .glb/.gltf under public/models
 *   GET  /__map-editor/maps/<name>  → src/game/world/maps/<name>.json (empty map if absent)
 *   POST /__map-editor/maps/<name>  → validate + pretty-write the map JSON into src/
 *
 * Maps are written into src/ on purpose: the game imports them statically
 * (MapPlacements.tsx), so saved layouts ship in the production build.
 */

const MAPS_DIR = 'src/game/world/maps';
const MODELS_DIR = 'public/models';
const MODELS_URL_PREFIX = '/models';
const NAME_RE = /^[a-z0-9-]{1,40}$/;

const EMPTY_MAP = { version: 1, placements: [] };

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Reject anything that isn't a well-formed map so a buggy editor can't corrupt src/. */
const validateMap = (data: unknown): string | null => {
  const map = data as { version?: unknown; placements?: unknown };
  if (typeof map !== 'object' || map === null) return 'map must be an object';
  if (map.version !== 1) return 'unsupported map version';
  if (!Array.isArray(map.placements)) return 'placements must be an array';
  for (const p of map.placements as unknown[]) {
    const pl = p as Record<string, unknown>;
    if (typeof pl.id !== 'string' || pl.id.length === 0) return 'placement missing id';
    if (typeof pl.asset !== 'string' || !pl.asset.startsWith(MODELS_URL_PREFIX + '/'))
      return `placement ${pl.id}: asset must be a ${MODELS_URL_PREFIX}/ URL`;
    if (!isVec3(pl.position)) return `placement ${pl.id}: bad position`;
    if (!isVec3(pl.rotation)) return `placement ${pl.id}: bad rotation`;
    if (!isVec3(pl.scale)) return `placement ${pl.id}: bad scale`;
  }
  return null;
};

/** Recursively collect model URLs. Files named anim-* are animation-only clips — skipped. */
const listModels = async (dir: string, urlBase: string): Promise<string[]> => {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const url = `${urlBase}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listModels(abs, url)));
    } else if (/\.(glb|gltf)$/i.test(entry.name) && !entry.name.startsWith('anim-')) {
      out.push(url);
    }
  }
  return out.sort();
};

const readBody = (req: Connect.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

export const mapEditorPlugin = (): Plugin => ({
  name: 'map-editor',
  apply: 'serve',
  configureServer(server) {
    const root = server.config.root;
    server.middlewares.use('/__map-editor', (req, res) => {
      const respond = (status: number, data: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      };

      const handle = async () => {
        const url = (req.url ?? '').split('?')[0]!;

        if (req.method === 'GET' && url === '/assets') {
          const assets = await listModels(path.join(root, MODELS_DIR), MODELS_URL_PREFIX);
          return respond(200, { assets });
        }

        if (req.method === 'GET' && url === '/maps') {
          let names: string[] = [];
          try {
            const files = await fs.readdir(path.join(root, MAPS_DIR));
            names = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
          } catch {
            /* maps dir missing — fall through to builtins */
          }
          const maps = [...new Set(['hub', 'expedition', ...names])].sort();
          return respond(200, { maps });
        }

        const mapMatch = url.match(/^\/maps\/([^/]+)$/);
        if (mapMatch) {
          const name = mapMatch[1]!;
          if (!NAME_RE.test(name)) return respond(400, { error: 'bad map name' });
          const file = path.join(root, MAPS_DIR, `${name}.json`);

          if (req.method === 'GET') {
            try {
              return respond(200, JSON.parse(await fs.readFile(file, 'utf8')));
            } catch {
              return respond(200, EMPTY_MAP);
            }
          }
          if (req.method === 'POST') {
            let data: unknown;
            try {
              data = JSON.parse(await readBody(req));
            } catch {
              return respond(400, { error: 'invalid JSON' });
            }
            const problem = validateMap(data);
            if (problem) return respond(400, { error: problem });
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
            return respond(200, { ok: true });
          }
        }

        respond(404, { error: 'not found' });
      };

      handle().catch((err: Error) => respond(500, { error: err.message }));
    });
  },
});
