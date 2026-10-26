import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// End-to-end rendering tests: real frames rendered through the whole engine,
// with the same suite on every backend.
// - WebGPU: Dawn (the WebGPU implementation of Chrome) in Node;
// - WebGL2: headless Chromium, with the SwiftShader software renderer.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tests/rendering',
  test: {
    watch: false,
    reporters: ['default'],
    // The fluids and noises run their CPU references and, on CI, software
    // GPUs: several seconds per test, past the default 5 s.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'rendering-tests',
          environment: 'node',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.browser.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'rendering-tests-browser',
          include: ['src/**/*.browser.spec.ts'],
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright({
              launchOptions: {
                // Software WebGL, without a GPU (CI, headless servers).
                args: [
                  '--use-angle=swiftshader',
                  '--enable-unsafe-swiftshader',
                ],
              },
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
