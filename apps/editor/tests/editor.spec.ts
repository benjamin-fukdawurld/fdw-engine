// The desktop editor, end to end (step 4 of P18): Electron started by
// Playwright in an X server, its engine on Vulkan (lavapipe in the CI), the
// inputs given by the X server (XTest), as a user would: through the child
// window of the viewport. The pixels are read on the screen, where the
// child window is (a capture of the page does not have it).
import { expect, test } from '@playwright/test';
import { startEditor, type Editor } from './editor';

let editor: Editor;

test.afterEach(async () => {
  await editor?.close();
});

test('draws the level on Vulkan in the area of the viewport', async () => {
  editor = await startEditor();
  const status = await editor.drawing();
  expect(status).toContain('vulkan');
  const area = await editor.viewportArea();
  // The size of the swapchain is that of the area, in device pixels.
  expect(status).toContain(`${area.width} × ${area.height}`);
  // The ground of the level, under the center of the area: not the color
  // of the page behind the child window.
  expect(await editor.differsFromPage(area.centerX, area.centerY)).toBe(true);
});

test('the clicks of the X server reach the engine through its window', async () => {
  editor = await startEditor();
  await editor.drawing();
  const { page } = editor;
  const tree = page.getByRole('tree', { name: 'Level' });
  // Framed in the center of the viewport, then another node selected.
  await tree.getByText('cube 2').click();
  await page.getByTestId('viewport').focus();
  await page.keyboard.press('f');
  await page.waitForTimeout(800);
  await tree.getByText('sun').click();
  await expect(tree.getByRole('treeitem', { name: /sun/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const area = await editor.viewportArea();
  await editor.x.click(area.centerX, area.centerY);
  await expect(tree.getByRole('treeitem', { name: /cube 2/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('the keys of the X server reach the engine once the viewport is clicked', async () => {
  editor = await startEditor();
  await editor.drawing();
  const area = await editor.viewportArea();
  await editor.x.click(area.x + 8, area.y + 8);
  await editor.x.press('e');
  await expect(editor.page.locator('footer')).toContainText('Rotate');
  await editor.x.press('w');
  await expect(editor.page.locator('footer')).toContainText('Move');
});

test('a right drag turns the camera, also out of the viewport', async () => {
  editor = await startEditor();
  await editor.drawing();
  const area = await editor.viewportArea();
  const before = await editor.x.region(area.x, area.y, area.width, area.height);
  await editor.x.move(area.centerX, area.centerY);
  await editor.x.button(3, 'down');
  // Past the left edge of the viewport: the pointer is captured.
  for (let step = 1; step <= 10; step++) {
    await editor.x.move(area.centerX - step * area.width * 0.08, area.centerY);
    await editor.page.waitForTimeout(50);
  }
  await editor.x.button(3, 'up');
  await editor.page.waitForTimeout(500);
  const after = await editor.x.region(area.x, area.y, area.width, area.height);
  expect(after).not.toEqual(before);
});

test('the viewport follows the window resized', async () => {
  editor = await startEditor();
  await editor.drawing();
  await editor.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 700),
  );
  await expect
    .poll(async () => {
      const area = await editor.viewportArea();
      const status = await editor.page.locator('footer').innerText();
      return status.includes(`${area.width} × ${area.height}`);
    })
    .toBe(true);
  const area = await editor.viewportArea();
  // The bottom right corner of the new area is drawn.
  expect(
    await editor.differsFromPage(
      area.x + area.width - 20,
      area.y + area.height - 20,
    ),
  ).toBe(true);
});

test('no frames while the window is hidden, again once shown', async () => {
  editor = await startEditor();
  await editor.drawing();
  await editor.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.hide(),
  );
  await expect(editor.page.locator('footer')).toContainText(' 0 fps');
  await editor.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.show(),
  );
  await expect(editor.page.locator('footer')).not.toContainText(' 0 fps');
  await editor.drawing();
});

test('the command palette shows over the viewport, through a hole', async () => {
  editor = await startEditor();
  await editor.drawing();
  const area = await editor.viewportArea();
  await editor.x.click(area.x + 8, area.y + 8);
  await editor.page.keyboard.press('Control+Shift+P');
  const palette = editor.page.getByRole('dialog');
  await expect(palette).toBeVisible();
  const box = await editor.screenBox(palette);
  await editor.page.waitForTimeout(300);
  // The palette, not the level: its color is that of the page.
  const color = await editor.x.pixel(box.x + 12, box.y + box.height - 6);
  const page = await editor.pageColor(box.x + 12, box.y + box.height - 6);
  expect(color).toEqual(page);
  await editor.page.keyboard.press('Escape');
});

test('draws the level by rays when the Rendering menu asks for it', async () => {
  editor = await startEditor();
  await editor.drawing();
  const area = await editor.viewportArea();
  const region = () =>
    editor.x.region(area.centerX - 40, area.centerY - 40, 80, 80);
  const rasterized = await region();
  const { page } = editor;
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('Path traced');
  await page.keyboard.press('Enter');
  // The image of the path tracer, gathered over a few frames: the light
  // bounced off the level, not the rasterized one.
  await page.waitForTimeout(3000);
  const traced = await region();
  expect(
    traced.some((value, i) => Math.abs(value - (rasterized[i] ?? 0)) > 3),
  ).toBe(true);
  expect(await editor.differsFromPage(area.centerX, area.centerY)).toBe(true);
  // Rasterized again: the image of before.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('Rasterized');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const again = await region();
  expect(
    again.every((value, i) => Math.abs(value - (rasterized[i] ?? 0)) <= 3),
  ).toBe(true);
});

test('a reload of the page connects it again to the engine', async () => {
  editor = await startEditor();
  await editor.drawing();
  await editor.page.reload();
  const status = await editor.drawing();
  expect(status).toContain('vulkan');
  const area = await editor.viewportArea();
  expect(await editor.differsFromPage(area.centerX, area.centerY)).toBe(true);
});

test('Dawn when asked for, copied into the window', async () => {
  editor = await startEditor({ FDW_BACKEND: 'dawn' });
  const status = await editor.drawing();
  expect(status).toContain('dawn');
  const area = await editor.viewportArea();
  expect(await editor.differsFromPage(area.centerX, area.centerY)).toBe(true);
});
