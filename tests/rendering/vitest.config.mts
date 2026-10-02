import { defineConfig } from 'vitest/config';

// End-to-end rendering tests: real frames rendered with Dawn (the WebGPU
// implementation of Chrome) in Node, through the whole engine.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tests/rendering',
  test: {
    name: 'rendering-tests',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
  },
});
