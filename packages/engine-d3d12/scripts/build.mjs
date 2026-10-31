// Builds the native addon with CMake: build/fdw_d3d12.node, unless the
// prebuilt one of these sources can be fetched (with DXC). Windows only:
// Direct3D 12, DXGI and the DXC header come from the Windows SDK.
// Usage: node scripts/build.mjs [--debug] [--from-source]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAddon,
  fetchPrebuilt,
} from '../../../tools/native/build-addon.mjs';

if (process.platform !== 'win32') {
  // Not an error: the tests needing the addon are skipped without it.
  console.warn(
    'Direct3D 12 is only available on Windows: the addon is not built',
  );
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!(await fetchPrebuilt(root))) buildAddon(root);
