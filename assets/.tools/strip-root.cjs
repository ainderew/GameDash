const fs = require('fs');
const dir = process.argv[2];
const PAD = (n, to = 4) => (to - (n % to)) % to;

function stripFile(path) {
  const buf = fs.readFileSync(path);
  // header
  const total = buf.readUInt32LE(8);
  let off = 12;
  const chunks = [];
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 8 + len;
  }
  const jsonChunk = chunks.find(c => c.type === 0x4E4F534A);
  const binChunk = chunks.find(c => c.type === 0x004E4942);
  const json = JSON.parse(jsonChunk.data.toString('utf8'));

  const hipsIdx = (json.nodes || []).findIndex(n => /Hips$/.test(n.name || ''));
  let removed = 0;
  for (const anim of json.animations || []) {
    const before = anim.channels.length;
    anim.channels = anim.channels.filter(
      ch => !(ch.target && ch.target.node === hipsIdx && ch.target.path === 'translation'),
    );
    removed += before - anim.channels.length;
  }

  // re-serialize
  let jsonStr = JSON.stringify(json);
  jsonStr += ' '.repeat(PAD(Buffer.byteLength(jsonStr)));
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const binBuf = binChunk ? binChunk.data : Buffer.alloc(0);
  const binPad = PAD(binBuf.length);
  const binPadded = Buffer.concat([binBuf, Buffer.alloc(binPad)]);

  const totalLen = 12 + 8 + jsonBuf.length + (binChunk ? 8 + binPadded.length : 0);
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0); // glTF
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  let p = 12;
  out.writeUInt32LE(jsonBuf.length, p); out.writeUInt32LE(0x4E4F534A, p + 4);
  jsonBuf.copy(out, p + 8); p += 8 + jsonBuf.length;
  if (binChunk) {
    out.writeUInt32LE(binPadded.length, p); out.writeUInt32LE(0x004E4942, p + 4);
    binPadded.copy(out, p + 8);
  }
  fs.writeFileSync(path, out);
  console.log(path.split(/[\/]/).pop(), '- removed', removed, 'Hips translation channels (hipsIdx', hipsIdx + ')');
}

for (const f of fs.readdirSync(dir).filter(f => /^anim-.*\.glb$/.test(f))) {
  stripFile(dir + '/' + f);
}
