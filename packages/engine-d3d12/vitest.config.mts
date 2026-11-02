import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-d3d12',
  test: {
    name: 'engine-d3d12',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // On CI, the durations in a JUnit report too (tools/ci/durations.mjs).
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-output/junit.xml' },
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-d3d12',
      provider: 'v8' as const,
    },
  },
});
