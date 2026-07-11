// Production build for the realtime room server: esbuild bundles src/index.ts and its
// workspace sources (@friendslop/sim, @friendslop/shared — reached through the @sim/@shared
// tsconfig path aliases, which esbuild resolves natively) plus the `ws`/`zod` runtime deps
// into ONE self-contained ESM file. The runtime image is then a bare node:22-alpine with no
// node_modules — `node dist/index.js` and nothing else. Mirrors how tsx runs the sources in
// dev, so dev and prod execute identical code with no separate compile step to drift.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: [`${here}src/index.ts`],
  outfile: `${here}dist/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Bundle EVERYTHING (incl. ws + zod) so the runtime image needs zero installs. `ws`'s
  // optional native accelerators (bufferutil/utf-8-validate) are best-effort — mark them
  // external so their absence is a graceful runtime fallback, not a bundle-time failure.
  external: ['bufferutil', 'utf-8-validate'],
  // ESM `import.meta`/`require` shim for the few CJS deps (ws) pulled into an ESM bundle.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.BUILD_VERSION': JSON.stringify(pkg.version) },
});

// eslint-disable-next-line no-console
console.log('realtime bundled → dist/index.js');
