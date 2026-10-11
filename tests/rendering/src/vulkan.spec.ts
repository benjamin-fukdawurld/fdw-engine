import { existsSync } from 'node:fs';
import {
  addonPath,
  VulkanEngine,
  VulkanOffscreenSurface,
} from '@fdw/engine-vulkan';
import { describeRenderer, RenderingFixture, size } from './suite';
import { canRun } from '@fdw/engine-backend/testing';

// The shared rendering tests on Vulkan, through the native library of
// @fdw/engine-vulkan, with the validation layer: any message fails the
// test reading the pixels. Skipped where the addon is not built (it needs
// the Vulkan SDK).

async function createFixture(): Promise<RenderingFixture> {
  const engine = new VulkanEngine({ validation: true, application: 'tests' });
  await engine.init();
  const surface = new VulkanOffscreenSurface(size, size);
  await surface.init(engine);
  const device = engine.device;
  const backend = engine.backend;
  if (!device || !backend) {
    throw new Error('The Vulkan engine is not ready');
  }
  return {
    backend,
    surface,
    readPixels: async () => {
      const pixels = await surface.readPixels();
      const messages = device.takeMessages();
      if (messages.length > 0) {
        throw new Error(`Vulkan validation:\n${messages.join('\n')}`);
      }
      return pixels;
    },
    destroy: async () => {
      surface.destroy();
      // The tests that read no pixels (compute) are checked here.
      device.waitIdle();
      const messages = device.takeMessages();
      await engine.destroy();
      if (messages.length > 0) {
        throw new Error(`Vulkan validation:\n${messages.join('\n')}`);
      }
    },
  };
}

describeRenderer('Renderer on Vulkan', createFixture, {
  skip: !canRun(
    'vulkan',
    existsSync(addonPath()),
    'the Vulkan addon is not built (VULKAN_SDK)'
  ),
});
