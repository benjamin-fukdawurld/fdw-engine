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
    // On CI, the durations in a JUnit report too (an artifact of the run):
    // to follow them, rather than lengthen the timeouts.
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-output/junit.xml' },
    // Each file drives a software GPU (Dawn, lavapipe, WARP, SwiftShader)
    // that spreads on every core: two at a time, not one per core.
    maxWorkers: 2,
    // Measured on 24 cores: the HLSL programs take 4 s (13 s before they
    // ran side by side), but the rays and fluids on Dawn still take 3 to
    // 16 s under load, past the default 5 s. Follow the JUnit durations
    // before lowering it again.
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
