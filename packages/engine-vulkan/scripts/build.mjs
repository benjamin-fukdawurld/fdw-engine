// Builds the native addon with CMake: build/fdw_vulkan.node. Needs the
// Vulkan SDK (VULKAN_SDK, set by its setup-env.sh): headers, volk, VMA and
// DXC come from it.
// Usage: node scripts/build.mjs [--debug]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddon } from '../../../tools/native/build-addon.mjs';

if (!process.env.VULKAN_SDK) {
  // Not an error: the tests needing the addon are skipped without it.
  console.warn(
    'VULKAN_SDK is not set: the Vulkan addon is not built (install the Vulkan SDK and source its setup-env.sh)'
  );
  process.exit(0);
}
buildAddon(resolve(dirname(fileURLToPath(import.meta.url)), '..'), [
  `-DVULKAN_SDK=${process.env.VULKAN_SDK}`,
]);
