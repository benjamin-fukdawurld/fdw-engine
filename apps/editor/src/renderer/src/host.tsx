import { isolatePlugin } from '@fdw/editor-plugin-isolate';
import { samplePlugin } from '@fdw/editor-plugin-sample';
import { RemoteViewport, type EditorHost } from '@fdw/editor-ui';
import { engine } from './engine';

const { platform, versions } = window.editor;

/**
 * The host of the Electron editor: the engine in a utility process, the
 * storage and the files through the main process (src/main/host.ts); the
 * sample plugin and that of the tutorial of the documentation (isolate),
 * their code in chunks loaded at their first event.
 */
export const host: EditorHost = {
  engine,
  Viewport: () => <RemoteViewport engine={engine} />,
  files: {
    open: async (filters) => {
      const file = await window.editor.openFile(filters);
      // Copied out of the buffer of the message.
      return file && { name: file.name, data: new Uint8Array(file.data) };
    },
    save: (name, data, filters) => window.editor.saveFile(name, data, filters),
  },
  storage: {
    read: (key) => window.editor.readStorage(key),
    write: (key, value) => window.editor.writeStorage(key, value),
  },
  popoutUrl: new URL('popout.html', location.href).href,
  about: `Electron ${versions.electron} · Chrome ${versions.chrome} · Node ${versions.node} · ${platform}`,
  plugins: [samplePlugin, isolatePlugin],
};
