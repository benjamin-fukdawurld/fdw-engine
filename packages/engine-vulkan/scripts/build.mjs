// Builds the native addon with CMake: build/fdw_vulkan.node, unless the
// prebuilt one of these sources can be fetched (with DXC). The build needs
// the Vulkan SDK (VULKAN_SDK, set by its setup-env.sh): headers, volk, VMA
// and DXC come from it.
// Usage: node scripts/build.mjs [--debug] [--from-source]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAddon,
  fetchPrebuilt,
} from '../../../tools/native/build-addon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (await fetchPrebuilt(root)) process.exit(0);
if (!process.env.VULKAN_SDK) {
  // An error, not an empty success: Nx would cache it, and replay it once a
  // prebuilt addon of these sources is published.
  console.error(
    'VULKAN_SDK is not set and there is no prebuilt Vulkan addon for these sources: install the Vulkan SDK and source its setup-env.sh',
  );
  process.exit(1);
}
buildAddon(root, [`-DVULKAN_SDK=${process.env.VULKAN_SDK}`]);
