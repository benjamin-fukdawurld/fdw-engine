import { EditorShell } from '@fdw/editor-ui';
import '@fdw/editor-ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WebEngine } from './engine';
import { createWebHost } from './host';
import { scenes } from './scenes';

// FDW_BACKEND chooses the backend, FDW_SCENE the first scene.
const engine = new WebEngine({
  backend: import.meta.env.FDW_BACKEND,
  scene: import.meta.env.FDW_SCENE || 'shadows',
  scenes,
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <EditorShell host={createWebHost(engine)} />
  </StrictMode>,
);
