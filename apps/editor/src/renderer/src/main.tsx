import { EditorShell } from '@fdw/editor-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { host } from './host';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <EditorShell host={host} />
  </StrictMode>,
);
