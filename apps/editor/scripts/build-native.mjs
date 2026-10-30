// Builds the native viewport addon with CMake: build/fdw_editor.node, and
// the probe of the end-to-end tests. The prebuilt addon has no probe: CMake
// when the tests need it (--from-source, FDW_FROM_SOURCE, or no probe).
// Usage: node scripts/build-native.mjs [--debug] [--from-source]
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAddon,
  fetchPrebuilt,
} from '../../../tools/native/build-addon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const probe = join(
  root,
  process.platform === 'win32' ? 'build/winprobe.exe' : 'build/xprobe',
);
if (!(existsSync(probe) && (await fetchPrebuilt(root)))) buildAddon(root);
