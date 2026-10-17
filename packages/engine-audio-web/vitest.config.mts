import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// WebAudio exists only in a browser: the tests run in headless Chromium,
// mostly on OfflineAudioContexts (the mix rendered into a buffer, faster
// than real time); the streams on an AudioContext, without a gesture.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/engine-audio-web',
  // The sound files of the tests, in engine-audio, served at the root.
  publicDir: '../engine-audio/testing',
  test: {
    name: 'engine-audio-web',
    watch: false,
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
        },
      }),
      instances: [{ browser: 'chromium' }],
    },
    coverage: {
      reportsDirectory: '../../coverage/packages/engine-audio-web',
      provider: 'v8' as const,
    },
  },
});
