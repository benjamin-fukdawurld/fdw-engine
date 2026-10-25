import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// The web editor in the pages of the documentation (Editor.astro): the one
// of apps/editor-web, built into the site under /editor-app/, in a frame.
const pages: Record<string, string> = {
  introduction: 'editor/introduction/',
  'editing-a-level': 'editor/editing-a-level/',
  'writing-a-plugin': 'editor/writing-a-plugin/',
};

// The frame of the first editor of the page, once its engine draws.
async function openEditor(
  page: Page,
  path: string,
  backend: string,
): Promise<FrameLocator> {
  await page.goto(
    `/fdw-engine/${path}${backend === 'webgl2' ? '?backend=webgl2' : ''}`,
  );
  const holder = page.locator('[data-editor]').first();
  // The frame loads once near the screen.
  await holder.scrollIntoViewIfNeeded();
  const frame = page.frameLocator('[data-editor] iframe').first();
  await expect(frame.locator('footer')).toContainText(/ [1-9]\d* fps/, {
    timeout: 60_000,
  });
  await expect(frame.locator('footer')).toContainText(backend);
  return frame;
}

for (const [name, path] of Object.entries(pages)) {
  test(`the editor of ${name}`, async ({ page }, info) => {
    const backend = info.project.name;
    const frame = await openEditor(page, path, backend);
    // The level, its tree.
    await expect(
      frame.getByRole('tree', { name: 'Level' }).getByText('cube 1'),
    ).toBeVisible();
    // The frames and the times change at each run; the console tells the
    // time of its messages.
    await expect(page.locator('[data-editor]').first()).toHaveScreenshot(
      `editor-${name}-${backend}.png`,
      {
        mask: [
          frame.locator('footer'),
          frame.getByRole('log', { name: 'Console' }),
        ],
      },
    );
  });
}

test('the plugin of the tutorial isolates the selection', async ({
  page,
}, info) => {
  const frame = await openEditor(
    page,
    pages['writing-a-plugin'] ?? '',
    info.project.name,
  );
  const tree = frame.getByRole('tree', { name: 'Level' });
  await tree.getByText('cube 2').click();
  // Its panel, behind the Inspector.
  await frame.getByText('Statistics', { exact: true }).click();
  await expect(
    frame.getByRole('button', { name: 'Isolate the selection' }),
  ).toBeEnabled();
  await frame.locator('body').press('i');
  await expect(frame.locator('footer')).toContainText(
    'Isolated: 1 of 13 nodes shown',
  );
  await expect(
    frame.getByRole('button', { name: 'Show everything' }),
  ).toBeVisible();
  await frame.locator('body').press('Shift+I');
  await expect(frame.locator('footer')).not.toContainText('Isolated');
});

test('the editor of the French pages', async ({ page }, info) => {
  const frame = await openEditor(
    page,
    'fr/editor/writing-a-plugin/',
    info.project.name,
  );
  await expect(
    frame.getByRole('tree', { name: 'Level' }).getByText('cube 1'),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: "Ouvrir l'éditeur dans une page à lui" }),
  ).toBeVisible();
});

// The editors of graphs (P19), each beside the viewport of its page.
test('the material of the tutorial, edited live', async ({ page }, info) => {
  const backend = info.project.name;
  const frame = await openEditor(page, 'editor/editing-a-material/', backend);
  const canvas = frame.getByRole('application', { name: 'wood: graph' });
  await expect(canvas).toBeVisible();
  await expect(
    frame.getByRole('combobox', { name: 'Material graph shown' }),
  ).toHaveValue('target:procedural/wood');
  // The preview drawn by the engine: not a single color.
  const preview = frame.getByRole('img', { name: 'Preview of the material' });
  await expect
    .poll(
      () =>
        preview.evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const data = canvas
            .getContext('2d')
            ?.getImageData(0, 0, canvas.width, canvas.height).data;
          return data ? new Set(data).size : 0;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(16);
  // The code generated for the backend, its lines by node.
  await frame.getByRole('tab', { name: 'Code' }).click();
  await expect(
    frame.getByRole('list', { name: 'Generated code' }),
  ).toContainText(backend === 'webgpu' ? '@fragment' : 'void main');
  // A node added by the search, undone.
  await canvas.click({ position: { x: 20, y: 20 } });
  await canvas.press('Space');
  await frame.getByRole('textbox', { name: 'Add a node' }).fill('smoothstep');
  await frame.getByRole('textbox', { name: 'Add a node' }).press('Enter');
  await expect(
    frame.getByRole('button', { name: /^Undo Add smoothstep/ }),
  ).toBeEnabled();
  await canvas.press('Control+z');
  await expect(
    frame.getByRole('button', { name: /^Undo Add smoothstep/ }),
  ).toHaveCount(0);
});

for (const [name, path, graph] of [
  ['behavior', 'editor/debugging-a-behavior/', 'Enemies'],
  ['animation', 'editor/animating-in-the-editor/', 'hero animation'],
] as const) {
  test(`the ${name} graph of the game, in its tutorial`, async ({
    page,
  }, info) => {
    const frame = await openEditor(page, path, info.project.name);
    // Listed once the game has loaded its characters.
    await expect(
      frame
        .getByRole('combobox', { name: new RegExp(`${name} graph shown`, 'i') })
        .locator('option:checked'),
    ).toHaveText(graph, { timeout: 120_000 });
    await expect(frame.getByText('live', { exact: true })).toBeVisible();
    if (name === 'behavior') {
      await frame.getByRole('button', { name: 'Debug' }).click();
      await expect(
        frame.getByRole('button', { name: 'Continue' }),
      ).toBeVisible();
      await expect(
        frame.getByRole('status').filter({ hasText: 'Running' }),
      ).toBeVisible();
    } else {
      // The machine of the hero, in its view.
      await frame.getByRole('group', { name: 'body' }).dblclick();
      await expect(
        frame.getByRole('button', { name: 'State move' }),
      ).toBeVisible();
    }
  });
}
