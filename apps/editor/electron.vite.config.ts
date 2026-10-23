import { defineConfig } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Imported by @fdw/engine-native for its Dawn engine, which the
        // editor does not use: a native module, left out of the bundle.
        external: ['webgpu'],
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    // @fdw/editor-ui would otherwise import the React of the repository.
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      rollupOptions: {
        // The empty page of the popouts (EditorHost.popoutUrl).
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          popout: resolve(__dirname, 'src/renderer/popout.html'),
        },
      },
    },
  },
});
