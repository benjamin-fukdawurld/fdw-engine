import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/editor-plugin-material-graph',
  test: {
    name: 'editor-plugin-material-graph',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/editor-plugin-material-graph',
      provider: 'v8' as const,
    },
  },
});
