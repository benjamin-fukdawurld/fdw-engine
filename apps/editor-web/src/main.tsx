import {
  docks,
  EditorShell,
  type EditorRuntime,
  levelScene,
} from '@fdw/editor-ui';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WebEngine } from './engine';
import { createWebHost } from './host';
import { scenes } from './scenes';
import { indexedDbStorage, memoryStorage } from './storage';

// FDW_BACKEND chooses the backend, FDW_SCENE the first scene (the level
// by default). The page may choose them too (?backend=, ?scene=), and a
// panel to show at the start (?view=, an editor of graphs) and the docks
// shown (?docks=); with ?embed,
// as in the pages of the documentation, nothing is kept: the default
// layout at each load.
const query = new URLSearchParams(window.location.search);
const engine = new WebEngine({
  backend: query.get('backend') ?? import.meta.env.FDW_BACKEND,
  scene: query.get('scene') ?? (import.meta.env.FDW_SCENE || levelScene),
  scenes,
});
const storage = query.has('embed') ? memoryStorage() : indexedDbStorage();
const view = query.get('view');
// The docks shown, when the page chooses (?docks=bottom, ?docks=).
const shownDocks = query.get('docks')?.split(',');

// The docks and the panel asked for, once the workbench has its panels
// laid out.
function showView(runtime: EditorRuntime): void {
  if (shownDocks) {
    for (const dock of docks) {
      runtime.editor.trigger.setDock({
        dock,
        shown: shownDocks.includes(dock),
      });
    }
  }
  if (!view) return;
  const { workbench } = runtime;
  const stop = workbench.subscribe(() => {
    stop();
    workbench.openView(view);
  });
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <EditorShell host={createWebHost(engine, storage)} onRuntime={showView} />
  </StrictMode>,
);
