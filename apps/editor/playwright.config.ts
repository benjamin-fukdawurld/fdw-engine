// The desktop editor end to end (tests/editor.spec.ts): Electron in an X
// server (xvfb-run, by the test target), its engine on lavapipe (below). One
// editor at a time: they share the screen, where their pixels are read.
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// The drivers of a GPU do not present into the windows of Xvfb: lavapipe,
// where it is installed, unless a driver is chosen.
const lavapipe = '/usr/share/vulkan/icd.d/lvp_icd.json';
if (!process.env['VK_ICD_FILENAMES'] && existsSync(lavapipe)) {
  process.env['VK_ICD_FILENAMES'] = lavapipe;
}

export default defineConfig({
  testDir: 'tests',
  outputDir: 'out/playwright',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
});
