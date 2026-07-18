import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MapEditorApp } from '@/editor/MapEditorApp';
import '@/index.css';

// Dev-only map editor entry (editor.html). Separate page from the game on purpose:
// saving a map JSON hot-reloads the game's module graph, not this one, so the
// editor never loses camera/selection state on save.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <MapEditorApp />
  </StrictMode>,
);
