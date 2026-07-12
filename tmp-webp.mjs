import sharp from 'sharp';
import { statSync } from 'fs';
const src = 'apps/web/public/menu/keyart.png';
const orig = statSync(src).size;
for (const q of [80, 88, 92]) {
  const out = `./tmp-keyart-q${q}.webp`;
  await sharp(src).webp({ quality: q, effort: 6 }).toFile(out);
  console.log(`q${q}:`, (statSync(out).size/1024).toFixed(0), 'KB');
}
console.log('original PNG:', (orig/1024).toFixed(0), 'KB');
