// Builds the native addon with CMake: build/fdw_native.node, unless the
// prebuilt one of these sources can be fetched.
// Usage: node scripts/build.mjs [--debug] [--from-source]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAddon,
  fetchPrebuilt,
} from '../../../tools/native/build-addon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!(await fetchPrebuilt(root))) buildAddon(root);
