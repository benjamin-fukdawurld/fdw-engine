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
  'gpu-particles': 'tutorials/gpu-particles/',
  'scene-forest': 'tutorials/scene/',
  'occlusion-culling': 'tutorials/occlusion-culling/',
  tessellation: 'tutorials/tessellation/',
  'camera-operators': 'tutorials/camera-operators/',
  'first-person': 'tutorials/first-person/',
  systems: 'tutorials/systems/',
  'loading-models': 'tutorials/loading-models/',
  resources: 'tutorials/resources/',
  'city-walk': 'tutorials/city-walk/',
  'character-animation': 'tutorials/character-animation/',
  physics: 'tutorials/physics/',
  audio: 'tutorials/audio/',
  'maze-1': 'game/maze/',
  'maze-2': 'game/character/',
  'maze-3': 'game/flashlight/',
  'maze-4': 'game/the-game/',
  fps: 'game/fps/',
  'shadow-cascades': 'tutorials/shadow-cascades/',
  'levels-of-detail': 'tutorials/levels-of-detail/',
  'third-person-camera': 'tutorials/third-person-camera/',
  tps: 'game/tps/',
  'behavior-graphs': 'tutorials/behavior-graphs/',
  'static-batching': 'tutorials/static-batching/',
  'procedural-materials': 'tutorials/procedural-materials/',
  'procedural-terrain': 'tutorials/procedural-terrain/',
  editing: 'tutorials/editing/',
  'parametric-surfaces': 'tutorials/parametric-surfaces/',
  pipes: 'tutorials/parametric-surfaces/',
  'saving-scenes': 'tutorials/saving-scenes/',
  'custom-importer': 'tutorials/writing-an-importer/',
  ocean: 'tutorials/ocean/',
  coast: 'tutorials/floating-objects/',
  'shallow-water': 'tutorials/shallow-water/',
  basin: 'tutorials/shallow-water/',
  'smoke-2d': 'tutorials/smoke/',
  smoke: 'tutorials/smoke/',
  liquid: 'tutorials/liquid/',
  splash: 'tutorials/liquid/',
  'ray-shadows': 'tutorials/ray-traced-shadows/',
  'ray-reflections': 'tutorials/ray-reflections/',
  'path-tracing': 'tutorials/path-tracing/',
  'ray-characters': 'tutorials/ray-traced-characters/',
};

// The clock of the examples, stopped: the same image at every run.
const time = 1.5;
// Frames rendered before the capture, then the rendering stops: the
// shadows, the caches and the smoothed cameras settle, and the image stays.
const frames = 10;
// More for the examples waiting for results read back from the GPU. Fewer
// for the game in the forest: thousands of firs in its shadow maps, seconds
// a frame on SwiftShader; its image is the same from the first frame.
const framesOf: Record<string, number> = {
  'occlusion-culling': 40,
  tps: 2,
  // The fluids: their steps of 1/60 s a frame while the clock is stopped,
  // the water and the smoke set in motion.
  'shallow-water': 20,
  basin: 20,
  'smoke-2d': 90,
  smoke: 60,
  liquid: 20,
  splash: 20,
  // The path tracer: frames gathered.
  'path-tracing': 30,
  // The rays of the reflections, slow on SwiftShader: the same image.
  'ray-reflections': 3,
};
// Longer for the examples loading many files.
const timeouts: Record<string, number> = {
  tps: 120_000,
  'occlusion-culling': 60_000,
  'levels-of-detail': 60_000,
  'saving-scenes': 60_000,
  coast: 60_000,
  basin: 120_000,
  'smoke-2d': 120_000,
  smoke: 240_000,
  liquid: 120_000,
  splash: 120_000,
  // The rays traversed in WGSL, on SwiftShader.
  'ray-shadows': 120_000,
  'ray-reflections': 300_000,
  'path-tracing': 360_000,
  'ray-characters': 360_000,
};

for (const [name, page] of Object.entries(examples)) {
  test(name, async ({ page: browser }, info) => {
    if (timeouts[name]) {
      test.setTimeout(timeouts[name] + 60_000);
    }
    const backend = info.project.name;
    const count = framesOf[name] ?? frames;
    const query = `time=${time}&frames=${count}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`;
    await browser.goto(`/fdw-engine/${page}?${query}`);
    const example = browser.locator(`[data-example="${name}"]`).first();
    await example.scrollIntoViewIfNeeded();
    const canvas = example.locator('canvas');
    const status = example.locator('.fdw-example-status');
    await expect(status).not.toHaveAttribute('data-error');
    await expect
      .poll(
        async () => Number((await canvas.getAttribute('data-frames')) ?? 0),
        {
          timeout: timeouts[name] ?? 30_000,
        },
      )
      .toBe(count);
    await expect(canvas).toHaveScreenshot(`${name}-${backend}.png`, {
      timeout: timeouts[name] ?? 30_000,
    });
  });
}

// Picking in the browser: the identifiers under the mouse, read back.
test('picking under the mouse', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/picking/?time=${time}&frames=${frames}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
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

// The editing tools: the gizmo dragged then undone, a rectangle of
// selection, the selection removed then put back. The status line tells
// the selection and the last entry of the history.
test('editing with the gizmo', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/editing/?time=${time}&frames=${frames}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="editing"]').first();
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
  // In pixels of the canvas (630 × 354 CSS pixels).
  const at = (x: number, y: number) => ({
    x: box.x + (x * box.width) / 630,
    y: box.y + (y * box.height) / 354,
  });
  await expect(status).toContainText('cube 1 selected · no change');
  // The x axis of the gizmo on the first cube, dragged to the right.
  const axis = at(255, 182);
  await browser.mouse.move(axis.x, axis.y);
  await browser.mouse.down();
  const to = at(345, 194);
  await browser.mouse.move(to.x, to.y, { steps: 6 });
  await browser.mouse.up();
  await expect(status).toContainText('cube 1 selected · Move');
  await browser.keyboard.press('Control+z');
  await expect(status).toContainText('cube 1 selected · no change');
  // A rectangle around the yellow cube, the green sphere and the table.
  const from = at(330, 120);
  const corner = at(450, 270);
  await browser.mouse.move(from.x, from.y);
  await browser.mouse.down();
  await browser.mouse.move(corner.x, corner.y, { steps: 6 });
  await browser.mouse.up();
  await expect(status).toContainText('cube 3, sphere 1, table selected');
  await browser.keyboard.press('Delete');
  await expect(status).toContainText('nothing selected · Delete 3 objects');
  await browser.keyboard.press('Control+z');
  await expect(status).toContainText('nothing selected · no change');
});

// A scene saved, cleared, loaded back: the status line tells the files and
// whether the scene is there; the image is the one of the scene loaded.
test('saving and loading a scene', async ({ page: browser }, info) => {
  test.setTimeout(120_000);
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/saving-scenes/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="saving-scenes"]').first();
  await example.scrollIntoViewIfNeeded();
  const status = example.locator('.fdw-example-status');
  const button = (label: string) =>
    example.getByRole('button', { name: label, exact: true });
  await expect(status).toContainText('loaded from level.scene.json', {
    timeout: 60_000,
  });
  await expect(status).toContainText('level.scene.bin');
  await button('Clear').click();
  await expect(status).toContainText('cleared');
  await button('Load').click();
  await expect(status).toContainText('loaded from level.scene.json');
  await expect(example.locator('canvas')).toHaveScreenshot(
    `saving-scenes-loaded-${backend}.png`,
    { timeout: 30_000 },
  );
});

// Ambient occlusion: two clicks show the occlusion alone. The clock is
// stopped but the frames are not limited: the frames after the clicks show
// it.
test('ambient occlusion alone', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/ambient-occlusion/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
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
    { timeout: 20_000 },
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
      }`,
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
        { timeout: 30_000 },
      )
      .toBeGreaterThan(after + frames);
    await expect(canvas).toHaveScreenshot(`${mode.shot}-${backend}.png`, {
      timeout: 30_000,
    });
  });
}

// Shadow cascades: C switches to a single shadow map, F turns the fog
// off. The clock is stopped: the camera stays where it is.
test('shadow-cascades-one-map', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/shadow-cascades/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="shadow-cascades"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect(status).toContainText('four cascades');
  await expect(status).toContainText('4 shadow maps');
  await canvas.click();
  await browser.keyboard.press('KeyC');
  await browser.keyboard.press('KeyF');
  await expect(status).toContainText('one shadow map (C) · fog off');
  await expect(status).toContainText('1 shadow maps');
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(
    `shadow-cascades-one-map-${backend}.png`,
    { timeout: 20_000 },
  );
});

// The third-person game: Play leaves the menu; the first wave is on its
// way. The pointer lock may be refused to a headless browser. Its own
// browser: the game, never stopped, queues a minute of frames on
// SwiftShader, which the next test of a shared browser would wait for;
// closed, the browser drops them.
test('tps-play', async ({ playwright, baseURL, viewport }, info) => {
  test.setTimeout(180_000);
  const own = await playwright.chromium.launch(info.project.use.launchOptions);
  try {
    const browser = await own.newPage({ baseURL, viewport });
    const backend = info.project.name;
    await browser.goto(
      `/fdw-engine/game/tps/?time=${time}${
        backend === 'webgl2' ? '&backend=webgl2' : ''
      }`,
    );
    const example = browser.locator('[data-example="tps"]').first();
    await example.scrollIntoViewIfNeeded();
    const canvas = example.locator('canvas');
    const status = example.locator('.fdw-example-status');
    await expect(status).toContainText('[Play]', { timeout: 120_000 });
    // A frame takes seconds on SwiftShader: the click is read at the next.
    await canvas.click();
    await expect(status).not.toContainText('[Play]', { timeout: 60_000 });
    await expect(status).toContainText('Get ready');
    await expect(status).not.toHaveAttribute('data-error');
  } finally {
    await own.close();
  }
});

// Camera navigation: C switches from the orbit to the walk. The clock is
// stopped: the camera stays where the operator puts it.
test('camera-operators-walk', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/camera-operators/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="camera-operators"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect(status).toContainText('orbit');
  await canvas.click();
  await browser.keyboard.press('KeyC');
  await expect(status).toContainText('walk');
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(
    `camera-operators-walk-${backend}.png`,
    {
      timeout: 20_000,
    },
  );
});

// First person controls: a click leaves the menu for the game, Space
// shoots the pillar ahead, which turns orange. The pointer lock may be
// refused to a headless browser: the shot does not need it.
test('first-person-shot', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/first-person/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="first-person"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect(status).toContainText('paused');
  await canvas.click();
  await expect(status).toContainText('playing');
  await browser.keyboard.press('Space');
  await expect(status).toContainText('hits: 1');
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(`first-person-shot-${backend}.png`, {
    timeout: 30_000,
  });
});

// Systems and the fixed step: P pauses, N runs one step at a time. The
// clock is stopped: only the steps asked for move the balls.
test('systems-steps', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/systems/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="systems"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  // The first frame runs the 5 steps of 1.5 s, at most.
  await expect(status).toContainText('0.08 s simulated');
  await canvas.click();
  await browser.keyboard.press('KeyP');
  await expect(status).toContainText('paused');
  // One press per frame at most: wait for each step.
  for (const time of ['0.10', '0.12', '0.13']) {
    await browser.keyboard.press('KeyN');
    await expect(status).toContainText(`${time} s simulated`);
  }
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(`systems-steps-${backend}.png`, {
    timeout: 20_000,
  });
});

// Behavior graphs: N stops the watched guard before its next node, H
// sends a noise, which it handles node by node; C lets the others go.
// The clock is stopped: only the events move the graphs.
test('behavior-graphs-steps', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/behavior-graphs/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="behavior-graphs"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect(status).toContainText('compile · guard 1: patrol');
  await canvas.click();
  // One press per frame at most: wait for each.
  await browser.keyboard.press('KeyN');
  await expect(status).toContainText('interpret · guard 1: patrol');
  await browser.keyboard.press('KeyH');
  await expect(status).toContainText('stopped before "noise"');
  await browser.keyboard.press('KeyN');
  await expect(status).toContainText('stopped before "on patrol?"');
  await browser.keyboard.press('KeyN');
  await expect(status).toContainText('stopped before "there"');
  await browser.keyboard.press('KeyN');
  await expect(status).toContainText('stopped before "search"');
  await browser.keyboard.press('KeyC');
  await expect(status).toContainText(
    'guard 1: search · breakpoint off · noise → on patrol? → there → search',
  );
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(
    `behavior-graphs-steps-${backend}.png`,
    {
      timeout: 20_000,
    },
  );
});

// Physics: a click pushes what is at the center (the clock is stopped: it
// does not move), D shows the debug view, the ray of the click with it.
test('physics-debug', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/physics/?time=${time}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="physics"]').first();
  await example.scrollIntoViewIfNeeded();
  const canvas = example.locator('canvas');
  const status = example.locator('.fdw-example-status');
  await expect(status).toContainText('debug off');
  await canvas.click();
  await browser.keyboard.press('KeyD');
  await expect(status).toContainText('debug on');
  await expect(status).not.toHaveAttribute('data-error');
  const after = Number((await canvas.getAttribute('data-frames')) ?? 0);
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(after + frames);
  await expect(canvas).toHaveScreenshot(`physics-debug-${backend}.png`, {
    timeout: 20_000,
  });
});

// Static batching: the identifier of an object merged in a batch, read back
// under the mouse; then the same object drawn alone.
test('static-batching-picking', async ({ page: browser }, info) => {
  const backend = info.project.name;
  await browser.goto(
    `/fdw-engine/tutorials/static-batching/?time=${time}&frames=${frames}${
      backend === 'webgl2' ? '&backend=webgl2' : ''
    }`,
  );
  const example = browser.locator('[data-example="static-batching"]').first();
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
  // The batches on the GPU only, the drum moved in its batch at each frame.
  await expect(status).toContainText(
    /0\.0 MB on the CPU, [1-9]\d* moves in place/,
  );
  // A column in the front, a little left of the center.
  const column = { x: box.x + box.width * 0.435, y: box.y + box.height * 0.82 };
  await browser.mouse.move(column.x, column.y);
  await expect(status).toContainText(/under the mouse: column \d+, in a batch/);
  // A click switches the batching off: the same column, alone.
  await browser.mouse.click(column.x, column.y);
  await expect(status).toContainText('batching off');
  await browser.mouse.move(column.x + 1, column.y);
  await expect(status).toContainText(/under the mouse: column \d+$/);
});
