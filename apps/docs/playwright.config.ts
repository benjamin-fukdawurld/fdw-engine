// The reference images of the live examples (design/ci.md §4): each example
// is rendered in headless Chromium, on SwiftShader (software WebGL2 and
// WebGPU), with its clock stopped, and its canvas compared to a reference.
// `npx nx run docs:visual` (builds the site first); `-- --update-snapshots`
// writes new references.
import { defineConfig } from '@playwright/test';

const port = 4395;

// SwiftShader: the same pixels on every machine, GPU or not.
const swiftshader = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export default defineConfig({
  testDir: 'tests',
  snapshotPathTemplate: '{testDir}/screenshots/{arg}{ext}',
  outputDir: 'out-tsc/playwright',
  reporter: process.env['CI']
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      // Software rasterizers round a few pixels differently from one CPU to
      // another.
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'webgl2',
      use: { browserName: 'chromium', launchOptions: { args: swiftshader } },
    },
    {
      name: 'webgpu',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            ...swiftshader,
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-vulkan=swiftshader',
            '--use-webgpu-adapter=swiftshader',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npx astro preview --port ${port} --host 127.0.0.1 --ignore-lock`,
    url: `http://127.0.0.1:${port}/fdw-engine/`,
    reuseExistingServer: !process.env['CI'],
  },
});
