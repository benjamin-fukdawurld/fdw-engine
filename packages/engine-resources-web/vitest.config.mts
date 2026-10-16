import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-resources-web',
  test: {
    name: 'engine-resources-web',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-resources-web',
      provider: 'v8' as const,
    },
  },
});
