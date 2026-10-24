import { EditorShell, levelScene } from '@fdw/editor-ui';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WebEngine } from './engine';
import { createWebHost } from './host';
import { scenes } from './scenes';

// FDW_BACKEND chooses the backend, FDW_SCENE the first scene (the level
// by default).
const engine = new WebEngine({
  backend: import.meta.env.FDW_BACKEND,
  scene: import.meta.env.FDW_SCENE || levelScene,
  scenes,
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <EditorShell host={createWebHost(engine)} />
  </StrictMode>,
);
