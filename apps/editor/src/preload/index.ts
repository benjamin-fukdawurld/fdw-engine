import { contextBridge, ipcRenderer } from 'electron';
import type { EditorApi } from './api';

// The port to the engine process: ports only cross the context isolation
// through window.postMessage.
ipcRenderer.on('engine:port', (event) => {
  window.postMessage('engine:port', '*', event.ports);
});

const api: EditorApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  connectEngine: () => ipcRenderer.send('engine:connect'),
};

contextBridge.exposeInMainWorld('editor', api);
