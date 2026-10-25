import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/graph-editor',
  test: {
    name: 'graph-editor',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/graph-editor',
      provider: 'v8' as const,
    },
  },
});
