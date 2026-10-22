import { contextBridge, ipcRenderer } from 'electron';
import type { EditorApi } from './api';

const api: EditorApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  setViewportBounds: (bounds) => ipcRenderer.send('viewport:bounds', bounds),
};

contextBridge.exposeInMainWorld('editor', api);
