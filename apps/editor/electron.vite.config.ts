import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

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
    plugins: [react()],
  },
});
