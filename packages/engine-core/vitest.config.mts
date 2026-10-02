import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-core',
  test: {
    name: 'engine-core',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // No tests yet: don't fail the test target until they are written.
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-core',
      provider: 'v8' as const,
    },
  },
});
