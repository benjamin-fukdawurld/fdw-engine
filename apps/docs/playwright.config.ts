// The reference images of the live examples (design/ci.md §4): each example
// is rendered in headless Chromium, on SwiftShader (software WebGL2 and
// WebGPU), with its clock stopped, and its canvas compared to a reference.
// `npx nx run docs:visual` (builds the site first); `-- --update-snapshots`
// writes new references.
import { defineConfig } from '@playwright/test';

const port = 4395;

// SwiftShader: the same pixels on every machine, GPU or not.
const swiftshader = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

// WebGPU on SwiftShader (Dawn). Under Windows, Chromium hands WebGPU the
// D3D11 device of ANGLE: ANGLE on SwiftShader (Vulkan) leaves it no adapter
// ("Failed to query ID3D11Device from ANGLE") and the pages fall back to
// WebGL2. ANGLE on WARP there, as the tests of apps/editor-web.
const webgpu = [
  ...(process.platform === 'win32'
    ? ['--use-angle=d3d11-warp', '--enable-unsafe-swiftshader']
    : [...swiftshader, '--enable-features=Vulkan', '--use-vulkan=swiftshader']),
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=swiftshader',
];

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
      // One page at a time: SwiftShader spreads its WebGPU work on every
      // core, two browsers of it share a runner of 4 vCPU and time out.
      workers: 1,
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: webgpu,
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
