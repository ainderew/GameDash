/** Validate the shipped hero attack clips using the same Three.js bone + weapon hierarchy as runtime. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AnimationMixer,
  Euler,
  Group,
  Vector3,
} from '../../apps/web/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../../apps/web/node_modules/three/examples/jsm/loaders/GLTFLoader.js';

globalThis.self = globalThis;
globalThis.ProgressEvent ??= class ProgressEvent {};

const ROOT = resolve(import.meta.dirname, '..', '..');
const MODEL_DIR = resolve(ROOT, 'apps', 'web', 'public', 'models', 'hero');
const CLIPS = [
  { file: 'anim-attack-l1.glb', trail: [0.22, 0.5] },
  { file: 'anim-attack-l2.glb', trail: [0.21, 0.475] },
  { file: 'anim-spin.glb', trail: [0.215, 0.465] },
  { file: 'anim-finisher.glb', trail: [0.25, 0.47] },
];

const loadGlb = async (path) => {
  const bytes = await readFile(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((accept, reject) => new GLTFLoader().parse(buffer, '', accept, reject));
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const measure = async ({ file, trail }) => {
  const gltf = await loadGlb(resolve(MODEL_DIR, file));
  if (gltf.animations.length !== 1) {
    throw new Error(`${file}: expected exactly one animation, got ${gltf.animations.length}`);
  }
  const clip = gltf.animations[0];
  const hand = gltf.scene.getObjectByName('mixamorigRightHand');
  if (!hand) throw new Error(`${file}: right hand node is missing`);

  const holder = new Group();
  holder.position.set(0.0102, -0.0221, 0.0263);
  holder.rotation.copy(new Euler(3.0908, 0, -1.32));
  holder.scale.setScalar(0.7);
  hand.add(holder);

  const baseSocket = new Group();
  const tipSocket = new Group();
  baseSocket.position.set(0, 0.17, 0);
  tipSocket.position.set(0, 0.92, 0);
  holder.add(baseSocket, tipSocket);

  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  const samples = 81;
  const directions = [];
  const wrists = [];
  const radii = [];
  const bladeLengths = [];
  const base = new Vector3();
  const tip = new Vector3();
  const wrist = new Vector3();

  for (let i = 0; i < samples; i += 1) {
    const normalized = trail[0] + ((trail[1] - trail[0]) * i) / (samples - 1);
    mixer.setTime(clip.duration * normalized);
    gltf.scene.updateMatrixWorld(true);
    baseSocket.getWorldPosition(base);
    tipSocket.getWorldPosition(tip);
    hand.getWorldPosition(wrist);
    directions.push(tip.clone().sub(base).normalize());
    wrists.push(wrist.clone());
    radii.push(tip.distanceTo(wrist));
    bladeLengths.push(tip.distanceTo(base));
  }

  const normal = new Vector3();
  let referenceNormal = null;
  let angularSweep = 0;
  for (let i = 1; i < directions.length; i += 1) {
    const a = directions[i - 1];
    const b = directions[i];
    angularSweep += Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
    const cross = new Vector3().crossVectors(a, b);
    if (cross.lengthSq() < 1e-12) continue;
    cross.normalize();
    referenceNormal ??= cross.clone();
    if (cross.dot(referenceNormal) < 0) cross.negate();
    normal.add(cross);
  }
  normal.normalize();

  const planeErrors = directions.map((direction) => Math.abs(direction.dot(normal)));
  const wristMean = wrists
    .reduce((sum, value) => sum.add(value), new Vector3())
    .multiplyScalar(1 / samples);
  const wristDrift = Math.max(...wrists.map((value) => value.distanceTo(wristMean)));
  const radiusMean = mean(radii);
  const radiusStd = Math.sqrt(mean(radii.map((value) => (value - radiusMean) ** 2)));
  const finite = clip.tracks.every((track) => Array.from(track.values).every(Number.isFinite));

  return {
    file,
    durationSeconds: Number(clip.duration.toFixed(6)),
    tracks: clip.tracks.length,
    finite,
    sweepDegrees: Number(((angularSweep * 180) / Math.PI).toFixed(2)),
    bladePlaneRms: Number(Math.sqrt(mean(planeErrors.map((value) => value ** 2))).toFixed(5)),
    bladePlaneMax: Number(Math.max(...planeErrors).toFixed(5)),
    wristDrift: Number(wristDrift.toFixed(5)),
    radiusStd: Number(radiusStd.toFixed(7)),
    bladeLength: Number(mean(bladeLengths).toFixed(5)),
  };
};

for (const spec of CLIPS) {
  console.log(JSON.stringify(await measure(spec)));
}
