import type { VulkanAddon } from '@fdw/engine-vulkan';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The Node-API addon (native/src/node_d3d12.c), built by scripts/build.mjs.

/**
 * The addon: the API of the Vulkan addon (the same objects, ids and
 * commands), on Direct3D 12. The layouts of the groups take the stride of
 * their storage buffers, viewed as structured buffers.
 */
export type D3D12Addon = VulkanAddon;

let addon: D3D12Addon | undefined;

/** The path of the addon: build/fdw_d3d12.node, or FDW_D3D12_ADDON. */
export const addonPath = (): string =>
  process.env['FDW_D3D12_ADDON'] ??
  fileURLToPath(new URL('../build/fdw_d3d12.node', import.meta.url));

/** Loads the addon. */
export function loadD3D12Addon(): D3D12Addon {
  if (!addon) {
    const require = createRequire(import.meta.url);
    const path = addonPath();
    try {
      addon = require(path) as D3D12Addon;
    } catch (error) {
      throw new Error(
        `The native addon of @fdw/engine-d3d12 is not built (${path}): run "node packages/engine-d3d12/scripts/build.mjs" on Windows`,
        { cause: error },
      );
    }
  }
  return addon;
}
