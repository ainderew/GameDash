import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { mapEditorPlugin } from './mapEditorPlugin';

export default defineConfig({
  // editor.html (the map editor) is dev-only and intentionally NOT a build input.
  plugins: [react(), mapEditorPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
      '@sim': fileURLToPath(new URL('../../packages/sim/src', import.meta.url)),
    },
  },
});
