import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-behavior',
  test: {
    name: 'engine-behavior',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-behavior',
      provider: 'v8' as const,
    },
  },
});
