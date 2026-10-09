// Builds the native addon with CMake: build/fdw_native.node.
// Usage: node scripts/build.mjs [--debug]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddon } from '../../../tools/native/build-addon.mjs';

buildAddon(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
