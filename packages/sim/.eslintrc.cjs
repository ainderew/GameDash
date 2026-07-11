/**
 * HARD RULE for the headless sim (see feature-plans/multiplayer/01-phase-sim-extraction.md):
 * the identical code must run inside a Node room server, so nothing under packages/sim may
 * import three/react/r3f or touch DOM globals. Client-only concerns (VFX, audio, hitstop,
 * sockets) enter through the injected SimHooks seam instead.
 */
/** @type {import('eslint').Linter.Config} */
module.exports = {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['three', 'three/*'], message: 'The sim is headless — no three.js. Route render concerns through SimHooks.' },
          { group: ['react', 'react-dom', 'react-dom/*', 'react/*'], message: 'The sim is headless — no React.' },
          { group: ['@react-three/*'], message: 'The sim is headless — no r3f.' },
          { group: ['@/*'], message: 'The sim must not reach into apps/web. Move the code or inject it via SimHooks.' },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'window', message: 'No DOM globals in the sim — inject time/input instead.' },
      { name: 'document', message: 'No DOM globals in the sim.' },
      { name: 'navigator', message: 'No DOM globals in the sim.' },
      { name: 'localStorage', message: 'No DOM globals in the sim.' },
      { name: 'sessionStorage', message: 'No DOM globals in the sim.' },
      { name: 'requestAnimationFrame', message: 'No frame callbacks in the sim — the driver owns time (loop.ts).' },
      { name: 'performance', message: 'No wall-clock reads in the sim — time is injected (`now`, `dt`).' },
    ],
  },
};
