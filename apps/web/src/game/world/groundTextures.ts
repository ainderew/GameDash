import { CanvasTexture, RepeatWrapping } from 'three';

/**
 * Procedural, seamlessly-tiling stylized DIRT texture. This is a richly hand-painted
 * base: broad soil variation, visible directional brushwork, dry scuffs, compacted
 * patches and shallow clay grit. Stones are real instanced meshes in Scatter.tsx so they
 * can receive the scene lighting and AO instead of being repeated, baked-lit stamps.
 *
 * Sampled by Terrain.tsx on the dirt roads/trail; wraps (RepeatWrapping) at DIRT_TILE
 * world units. Every discrete mark is drawn with wrap-around copies so the tile is seamless.
 */

/** World-units covered by one repeat of the dirt tile. Keep in sync with uDirtTile. */
export const DIRT_TILE = 9;
/** World-units covered by one repeat of the painterly grass tile. */
export const GRASS_TILE = 7.5;
/** World-units covered by the low-frequency RGB grass biome mask. */
export const GRASS_MACRO_TILE = 64;

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const createDirtTexture = (): CanvasTexture => {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d')!;
  const rand = mulberry32(20260712);

  // Call `fn(px, py)` at every wrapped position within `r` of the tile border, so any
  // mark straddling a seam is completed on the opposite edge → seamless tiling.
  const wrap = (x: number, y: number, r: number, fn: (px: number, py: number) => void) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const px = x + dx;
        const py = y + dy;
        if (px > -r && px < size + r && py > -r && py < size + r) fn(px, py);
      }
    }
  };

  // Warm packed-earth base. Most of the perceived detail comes from hue shifts rather
  // than hard value noise, which keeps characters and authored props visually dominant.
  c.fillStyle = '#a87342';
  c.fillRect(0, 0, size, size);

  const softEllipse = (
    px: number,
    py: number,
    rx: number,
    ry: number,
    rot: number,
    rgb: string,
    alpha: number,
  ) => {
    c.save();
    c.translate(px, py);
    c.rotate(rot);
    c.scale(1, ry / rx);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(0.58, `rgba(${rgb},${alpha * 0.58})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, rx, 0, Math.PI * 2);
    c.fill();
    c.restore();
  };

  // Large, overlapping soil regions establish the broad warm/cool rhythm seen in
  // hand-painted RPG terrain. Low opacity prevents any one gradient reading as a spot.
  for (let i = 0; i < 34; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 110 + rand() * 210;
    const ry = r * (0.42 + rand() * 0.42);
    const rot = rand() * Math.PI;
    const light = rand() > 0.47;
    const col = light ? '220,157,88' : '92,64,39';
    const alpha = 0.11 + rand() * 0.1;
    wrap(x, y, r, (px, py) => softEllipse(px, py, r, ry, rot, col, alpha));
  }

  // Directional translucent dabs leave readable painterly strokes without becoming
  // high-frequency grit. Groups share a direction like strokes laid down by one brush.
  for (let i = 0; i < 94; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const angle = rand() * Math.PI;
    const length = 28 + rand() * 95;
    const dabs = 3 + Math.floor(rand() * 5);
    const width = 13 + rand() * 29;
    const light = rand() > 0.52;
    const color = light ? '224,164,99' : '105,70,39';
    const alpha = 0.07 + rand() * 0.055;
    for (let d = 0; d < dabs; d += 1) {
      const along = (d / Math.max(1, dabs - 1) - 0.5) * length;
      const bx = x + Math.cos(angle) * along + (rand() - 0.5) * width;
      const by = y + Math.sin(angle) * along + (rand() - 0.5) * width;
      const rx = width * (0.8 + rand() * 0.9);
      const ry = width * (0.18 + rand() * 0.18);
      wrap(bx, by, rx + 2, (px, py) => {
        c.save();
        c.translate(px, py);
        c.rotate(angle + (rand() - 0.5) * 0.16);
        c.fillStyle = `rgba(${color},${alpha})`;
        c.beginPath();
        c.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      });
    }
  }

  // Broken dry-brush scuffs are the crisp mid-scale marks that survive the top-down
  // camera. Each is a short family of imperfect parallel strokes, never a clean line.
  for (let i = 0; i < 62; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const angle = rand() * Math.PI;
    const length = 42 + rand() * 105;
    const strands = 2 + Math.floor(rand() * 3);
    const color = rand() > 0.48 ? '235,181,116' : '86,55,32';
    for (let strand = 0; strand < strands; strand += 1) {
      const side = (strand - (strands - 1) * 0.5) * (4 + rand() * 5);
      const ox = x - Math.sin(angle) * side;
      const oy = y + Math.cos(angle) * side;
      wrap(ox, oy, length + 12, (px, py) => {
        c.save();
        c.translate(px, py);
        c.rotate(angle);
        c.strokeStyle = `rgba(${color},${0.075 + rand() * 0.075})`;
        c.lineWidth = 2.5 + rand() * 5;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(-length * 0.5, (rand() - 0.5) * 4);
        c.quadraticCurveTo(
          -length * 0.08,
          (rand() - 0.5) * 11,
          length * (0.12 + rand() * 0.13),
          (rand() - 0.5) * 7,
        );
        // Leave a small broken gap before the tail so it reads as dry pigment.
        c.stroke();
        c.beginPath();
        c.moveTo(length * (0.2 + rand() * 0.08), (rand() - 0.5) * 7);
        c.lineTo(length * (0.38 + rand() * 0.12), (rand() - 0.5) * 5);
        c.stroke();
        c.restore();
      });
    }
  }

  // Soft-edged irregular compressed-earth shapes provide medium-scale structure. They
  // are intentionally much lower contrast than the old pebble stamps.
  for (let i = 0; i < 58; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = 24 + rand() * 62;
    const points = 7 + Math.floor(rand() * 4);
    const rotation = rand() * Math.PI * 2;
    const radii = Array.from({ length: points }, () => radius * (0.62 + rand() * 0.48));
    const color = rand() > 0.5 ? '226,168,105' : '91,61,37';
    const alpha = 0.055 + rand() * 0.055;
    wrap(x, y, radius * 1.2, (px, py) => {
      const verts = radii.map((r, n): [number, number] => {
        const a = rotation + (n / points) * Math.PI * 2;
        return [px + Math.cos(a) * r, py + Math.sin(a) * r * 0.72];
      });
      const first = verts[0]!;
      const last = verts[verts.length - 1]!;
      c.beginPath();
      c.moveTo((last[0] + first[0]) * 0.5, (last[1] + first[1]) * 0.5);
      for (let n = 0; n < verts.length; n += 1) {
        const current = verts[n]!;
        const next = verts[(n + 1) % verts.length]!;
        c.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) * 0.5, (current[1] + next[1]) * 0.5);
      }
      c.closePath();
      c.fillStyle = `rgba(${color},${alpha})`;
      c.fill();
    });
  }

  // Small flat clay inclusions add readable surface information between the broad
  // strokes. They stay within the dirt palette and have no baked highlight or shadow,
  // so they do not masquerade as the real lit stones placed by Scatter.tsx.
  for (let i = 0; i < 165; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const rx = 4 + rand() * 12;
    const ry = rx * (0.28 + rand() * 0.48);
    const rot = rand() * Math.PI;
    const color = rand() > 0.48 ? '218,151,87' : '92,58,33';
    wrap(x, y, rx + 2, (px, py) => {
      c.save();
      c.translate(px, py);
      c.rotate(rot);
      c.fillStyle = `rgba(${color},${0.12 + rand() * 0.14})`;
      c.beginPath();
      c.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    });
  }

  // Only a few short, worn surface marks. Repeated graphic cracks were the most obvious
  // giveaway that the old ground was a small procedural tile.
  for (let i = 0; i < 4; i += 1) {
    const steps = 2 + Math.floor(rand() * 3);
    const seg = 13 + rand() * 19;
    const width = 0.65 + rand() * 0.65;
    let a = rand() * Math.PI * 2;
    const pts: [number, number][] = [[rand() * size, rand() * size]];
    for (let s = 0; s < steps; s += 1) {
      a += (rand() - 0.5) * 1.3;
      const [lx, ly] = pts[pts.length - 1]!;
      pts.push([lx + Math.cos(a) * seg, ly + Math.sin(a) * seg]);
    }
    const [ox, oy] = pts[0]!;
    wrap(ox, oy, seg * steps, (px, py) => {
      const sx = px - ox;
      const sy = py - oy;
      c.strokeStyle = 'rgba(61,40,24,0.12)';
      c.lineWidth = width;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(ox + sx, oy + sy);
      for (const [qx, qy] of pts) c.lineTo(qx + sx, qy + sy);
      c.stroke();
    });
  }

  // Restrained fine grain: enough to avoid a digital-flat fill at close range, but too
  // quiet to compete with the medium and broad painted forms.
  const grain = c.getImageData(0, 0, size, size);
  const d = grain.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 9;
    d[i] = Math.min(255, Math.max(0, d[i]! + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1]! + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2]! + n));
  }
  c.putImageData(grain, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8; // stays sharp at the shallow gameplay camera angle
  return texture;
};

/** Seamless structured grass detail beneath the 3D tuft silhouettes. */
export const createGrassTexture = (): CanvasTexture => {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d')!;
  const rand = mulberry32(20260718);
  const wrap = (x: number, y: number, r: number, fn: (px: number, py: number) => void) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const px = x + dx;
        const py = y + dy;
        if (px > -r && px < size + r && py > -r && py < size + r) fn(px, py);
      }
    }
  };

  c.fillStyle = '#6d8b35';
  c.fillRect(0, 0, size, size);

  // Broad cool hollows and sun-warmed sweeps.
  for (let i = 0; i < 32; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const rx = 105 + rand() * 210;
    const ry = rx * (0.38 + rand() * 0.46);
    const rot = rand() * Math.PI;
    const color = rand() > 0.54 ? '194,181,72' : '50,103,39';
    const alpha = 0.1 + rand() * 0.12;
    wrap(x, y, rx, (px, py) => {
      c.save();
      c.translate(px, py);
      c.rotate(rot);
      c.scale(1, ry / rx);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(${color},${alpha})`);
      g.addColorStop(0.58, `rgba(${color},${alpha * 0.55})`);
      g.addColorStop(1, `rgba(${color},0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, rx, 0, Math.PI * 2);
      c.fill();
      c.restore();
    });
  }

  // Curved blade-like brush marks, grouped into directional clumps.
  for (let i = 0; i < 145; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const angle = rand() * Math.PI;
    const blades = 3 + Math.floor(rand() * 6);
    const color = rand() > 0.48 ? '188,199,82' : '43,92,32';
    for (let blade = 0; blade < blades; blade += 1) {
      const bx = x + (rand() - 0.5) * 58;
      const by = y + (rand() - 0.5) * 38;
      const length = 18 + rand() * 55;
      wrap(bx, by, length + 5, (px, py) => {
        c.save();
        c.translate(px, py);
        c.rotate(angle + (rand() - 0.5) * 0.42);
        c.strokeStyle = `rgba(${color},${0.08 + rand() * 0.1})`;
        c.lineWidth = 2 + rand() * 5;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(-length * 0.5, 0);
        c.quadraticCurveTo(0, (rand() - 0.5) * 13, length * 0.48, (rand() - 0.5) * 6);
        c.stroke();
        c.restore();
      });
    }
  }

  // Medium clump footprints.
  for (let i = 0; i < 78; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = 22 + rand() * 58;
    const color = rand() > 0.5 ? '175,181,70' : '48,100,35';
    wrap(x, y, radius + 3, (px, py) => {
      c.save();
      c.translate(px, py);
      c.rotate(rand() * Math.PI);
      c.fillStyle = `rgba(${color},${0.05 + rand() * 0.08})`;
      c.beginPath();
      c.ellipse(0, 0, radius, radius * (0.34 + rand() * 0.38), 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    });
  }

  // Small flat leaf shapes for close camera views.
  for (let i = 0; i < 210; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const rx = 3 + rand() * 8;
    const color = rand() > 0.5 ? '199,193,79' : '40,88,30';
    wrap(x, y, rx + 2, (px, py) => {
      c.save();
      c.translate(px, py);
      c.rotate(rand() * Math.PI);
      c.fillStyle = `rgba(${color},${0.1 + rand() * 0.12})`;
      c.beginPath();
      c.ellipse(0, 0, rx, rx * (0.22 + rand() * 0.26), 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    });
  }

  const pixels = c.getImageData(0, 0, size, size);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const n = (rand() - 0.5) * 6;
    pixels.data[i] = Math.min(255, Math.max(0, pixels.data[i]! + n));
    pixels.data[i + 1] = Math.min(255, Math.max(0, pixels.data[i + 1]! + n));
    pixels.data[i + 2] = Math.min(255, Math.max(0, pixels.data[i + 2]! + n));
  }
  c.putImageData(pixels, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
};

/**
 * Low-frequency terrain control map. Red = dry/warm meadow, green = lush growth,
 * blue = cool moss. It is data rather than visible albedo, so one tiny texture can
 * drive large authored-looking regions without baking those colours into every tile.
 */
export const createGrassMacroTexture = (): CanvasTexture => {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d')!;
  const rand = mulberry32(20260721);
  const wrap = (x: number, y: number, r: number, fn: (px: number, py: number) => void) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const px = x + dx;
        const py = y + dy;
        if (px > -r && px < size + r && py > -r && py < size + r) fn(px, py);
      }
    }
  };

  c.fillStyle = 'rgb(18,24,16)';
  c.fillRect(0, 0, size, size);
  const channels = ['232,42,12', '22,230,38', '12,38,235'] as const;
  for (let i = 0; i < 34; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = 28 + rand() * 68;
    const ry = radius * (0.48 + rand() * 0.48);
    const color = channels[Math.floor(rand() * channels.length)]!;
    const alpha = 0.28 + rand() * 0.32;
    const rot = rand() * Math.PI;
    wrap(x, y, radius, (px, py) => {
      c.save();
      c.translate(px, py);
      c.rotate(rot);
      c.scale(1, ry / radius);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, radius);
      g.addColorStop(0, `rgba(${color},${alpha})`);
      g.addColorStop(0.55, `rgba(${color},${alpha * 0.58})`);
      g.addColorStop(1, `rgba(${color},0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, radius, 0, Math.PI * 2);
      c.fill();
      c.restore();
    });
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
};
