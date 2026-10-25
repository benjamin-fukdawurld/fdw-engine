import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/editor-plugin-behavior-graph',
  test: {
    name: 'editor-plugin-behavior-graph',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/editor-plugin-behavior-graph',
      provider: 'v8' as const,
    },
  },
});
