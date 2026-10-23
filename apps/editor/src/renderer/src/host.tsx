import { RemoteViewport, type EditorHost } from '@fdw/editor-ui';
import { engine } from './engine';

const { platform, versions } = window.editor;

/** The host of the Electron editor: the engine in a utility process. */
export const host: EditorHost = {
  engine,
  Viewport: () => <RemoteViewport engine={engine} />,
  about: `Electron ${versions.electron} · Chrome ${versions.chrome} · Node ${versions.node} · ${platform}`,
};
