import { expect, test } from '@playwright/test';

// The page of each live example (the first page showing it).
const examples: Record<string, string> = {
  'first-scene': 'getting-started/first-scene/',
  materials: 'tutorials/materials/',
  'lights-and-shadows': 'tutorials/lights-and-shadows/',
  'toon-shading': 'tutorials/custom-shading-model/',
  'post-processing': 'tutorials/post-processing/',
  'scene-outputs': 'tutorials/scene-outputs/',
  picking: 'tutorials/picking/',
  'ambient-occlusion': 'tutorials/ambient-occlusion/',
  'deferred-rendering': 'tutorials/deferred-rendering/',
  'surface-details': 'tutorials/surface-details/',
  transparency: 'tutorials/transparency/',
  reflections: 'tutorials/reflections/',
  'compute-waves': 'tutorials/compute/',
  'scene-forest': 'tutorials/scene/',
  'maze-1': 'game/maze/',
  'maze-2': 'game/character/',
  'maze-3': 'game/flashlight/',
  'maze-4': 'game/the-game/',
};

// The examples that need compute shaders: on WebGL2, they say so.
const needsCompute = new Set(['compute-waves']);

// The clock of the examples, stopped: the same image at every run.
const time = 1.5;
// Frames rendered before the capture, then the rendering stops: the
// shadows, the caches and the smoothed cameras settle, and the image stays.
const frames = 10;

for (const [name, page] of Object.entries(examples)) {
  test(name, async ({ page: browser }, info) => {
    const backend = info.project.name;
    const query = `time=${time}&frames=${frames}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`;
    await browser.goto(`/fdw-engine/${page}?${query}`);
    const example = browser.locator(`[data-example="${name}"]`).first();
    await example.scrollIntoViewIfNeeded();
    const canvas = example.locator('canvas');
    const status = example.locator('.fdw-example-status');
    if (backend === 'webgl2' && needsCompute.has(name)) {
      await expect(status).toContainText('needs compute shaders');
      return;
    }
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
      .toBe(frames);
    await expect(canvas).toHaveScreenshot(`${name}-${backend}.png`);
  });
}

// Picking in the browser: the identifiers under the mouse, read back.
test('picking under the mouse', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/picking/?time=${time}&frames=${frames}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`
  );
  const example = browser.locator('[data-example="picking"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBe(frames);
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('The canvas is not visible');
  }
  // The cube at the center: the 8th of the 5 × 3.
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await browser.mouse.move(center.x, center.y);
  await expect(status).toContainText('hover 8 ·');
  // Between the cubes: nothing.
  await browser.mouse.move(box.x + 4, box.y + 4);
  await expect(status).toContainText('hover — ·');
  // A click selects the cube under the mouse.
  await browser.mouse.click(center.x, center.y);
  await expect(status).toContainText('selected 8');
  // A rectangle over the middle row, dragged from the right.
  await browser.mouse.move(box.x + box.width - 4, center.y);
  await browser.mouse.down();
  await browser.mouse.move(box.x + 4, center.y + 4, { steps: 4 });
  await browser.mouse.up();
  await expect(status).toContainText('selected 6, 7, 8, 9, 10');
});

// Ambient occlusion: two clicks show the occlusion alone. The clock is
// stopped but the frames are not limited: the frames after the clicks show
// it.
test('ambient occlusion alone', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/ambient-occlusion/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`
  );
  const example = browser.locator('[data-example="ambient-occlusion"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect(status).toContainText('with occlusion');
  await canvas.click();
  await canvas.click();
  await expect(status).toContainText('occlusion alone');
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(
    `ambient-occlusion-alone-${backend}.png`,
    { timeout: 20_000 }
  );
});

// The other modes of the examples, reached by clicks on the canvas, as
// above.
const modes = [
  {
    example: 'deferred-rendering',
    page: 'tutorials/deferred-rendering/',
    clicks: 3,
    status: 'G-buffer: normals',
    shot: 'deferred-rendering-normals',
  },
  {
    example: 'reflections',
    page: 'tutorials/reflections/',
    clicks: 1,
    status: 'planar mirror',
    shot: 'reflections-mirror',
  },
  {
    example: 'reflections',
    page: 'tutorials/reflections/',
    clicks: 2,
    status: 'screen space reflections',
    shot: 'reflections-screen-space',
  },
];
for (const mode of modes) {
  test(mode.shot, async ({ page: browser }, info) => {
    const backend = info.project.name;
    await browser.goto(
      `/fdw-engine/${mode.page}?time=${time}${
        backend === 'webgl2' ? '&backend=webgl2' : ''
      }`
    );
    const example = browser.locator(`[data-example="${mode.example}"]`).first();
    await example.scrollIntoViewIfNeeded();
    const canvas = example.locator('canvas');
    const status = example.locator('.fdw-example-status');
    await expect(status).toContainText('click to switch');
    for (let i = 0; i < mode.clicks; i++) {
      await canvas.click();
    }
    await expect(status).toContainText(mode.status);
    await expect(status).not.toHaveAttribute('data-error');
    const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
    await expect
      .poll(
        async () => Number((await canvas.getAttribute('data-frames')) ?? 0),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(after + frames);
    await expect(canvas).toHaveScreenshot(`${mode.shot}-${backend}.png`, {
      timeout: 20_000,
    });
  });
}
