import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-webgl2',
  test: {
    name: 'engine-webgl2',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-webgl2',
      provider: 'v8' as const,
    },
  },
});
