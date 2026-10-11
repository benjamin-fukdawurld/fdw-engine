import { expect, test } from '@playwright/test';

// The page of each live example (the first page showing it).
const examples: Record<string, string> = {
  'first-scene': 'getting-started/first-scene/',
  materials: 'tutorials/materials/',
  'lights-and-shadows': 'tutorials/lights-and-shadows/',
  'toon-shading': 'tutorials/custom-shading-model/',
  'post-processing': 'tutorials/post-processing/',
  'compute-waves': 'tutorials/compute/',
  'scene-forest': 'tutorials/scene/',
  'maze-1': 'game/maze/',
  'maze-2': 'game/character/',
  'maze-3': 'game/flashlight/',
  'maze-4': 'game/the-game/',
};

// The clock of the examples, stopped: the same image at every run.
const time = 1.5;
// Frames rendered before the capture: the shadows, the caches and the
// smoothed cameras settle.
const frames = 10;

for (const [name, page] of Object.entries(examples)) {
  test(name, async ({ page: browser }, info) => {
    const backend = info.project.name;
    const query = `time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`;
    await browser.goto(`/fdw-engine/${page}?${query}`);
    const example = browser.locator(`[data-example="${name}"]`).first();
    await example.scrollIntoViewIfNeeded();
    const canvas = example.locator('canvas');
    const status = example.locator('.fdw-example-status');
    // The backend it runs on: the WebGPU project needs WebGPU, not the
    // fallback to WebGL2.
    await expect(status).toContainText(
      backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    );
    await expect(status).not.toHaveAttribute('data-error');
    await expect
      .poll(
        async () => Number((await canvas.getAttribute('data-frames')) ?? 0),
        {
          timeout: 30_000,
        }
      )
      .toBeGreaterThanOrEqual(frames);
    await expect(canvas).toHaveScreenshot(`${name}-${backend}.png`);
  });
}
