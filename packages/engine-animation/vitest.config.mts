import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-animation',
  test: {
    name: 'engine-animation',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-animation',
      provider: 'v8' as const,
    },
  },
});
