// Builds the native viewport addon with CMake: build/fdw_editor.node.
// Usage: node scripts/build-native.mjs [--debug]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddon } from '../../../tools/native/build-addon.mjs';

buildAddon(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
