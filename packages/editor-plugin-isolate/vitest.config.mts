import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/editor-plugin-isolate',
  test: {
    name: 'editor-plugin-isolate',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/editor-plugin-isolate',
      provider: 'v8' as const,
    },
  },
});
