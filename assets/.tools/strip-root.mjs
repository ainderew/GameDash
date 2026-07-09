import { NodeIO } from '@gltf-transform/core';
import { readdirSync } from 'fs';
const io = new NodeIO();
const dir = process.argv[2];
for (const f of readdirSync(dir).filter(f => /^anim-.*\.glb$/.test(f))) {
  const path = dir + '/' + f;
  const doc = await io.read(path);
  let removed = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const n = ch.getTargetNode();
      if (n && /Hips$/.test(n.getName() || '') && ch.getTargetPath() === 'translation') {
        ch.dispose(); removed++;
      }
    }
  }
  await io.write(path, doc);
  console.log(f, '- stripped Hips translation channels:', removed);
}
