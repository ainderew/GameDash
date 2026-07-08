import { useGLTF } from '@react-three/drei';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Central GLTF loader configuration: Draco geometry, KTX2 textures, meshopt.
 * Phase 6 assets flow through here. Decoders are fetched from CDN for now;
 * self-host under public/ before launch (Phase 8).
 */
const DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const KTX2_PATH = 'https://cdn.jsdelivr.net/gh/pmndrs/drei-assets/basis/';

const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
const ktx2 = new KTX2Loader().setTranscoderPath(KTX2_PATH);

/** Minimal structural type — drei's GLTFLoader and three/examples' differ only nominally. */
interface ConfigurableLoader {
  setDRACOLoader: (loader: DRACOLoader) => unknown;
  setKTX2Loader: (loader: KTX2Loader) => unknown;
  setMeshoptDecoder: (decoder: typeof MeshoptDecoder) => unknown;
}

const extendLoader = (loader: unknown) => {
  const l = loader as ConfigurableLoader;
  l.setDRACOLoader(draco);
  l.setKTX2Loader(ktx2);
  l.setMeshoptDecoder(MeshoptDecoder);
};

/** Typed wrapper over drei useGLTF with our decoders wired in. */
export const useGameModel = (path: string): GLTF => {
  return useGLTF(path, true, true, extendLoader) as unknown as GLTF;
};

/** Warm the cache for a critical asset (call behind the loading screen). */
useGameModel.preload = (path: string) => useGLTF.preload(path, true, true, extendLoader);
