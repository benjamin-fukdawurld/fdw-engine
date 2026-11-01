import { existsSync } from 'node:fs';
import {
  addonPath,
  D3D12Engine,
  D3D12OffscreenSurface,
  loadD3D12Addon,
} from '@fdw/engine-d3d12';
import { describeRays } from './rays';
import { describeRenderer, RenderingFixture, size } from './suite';
import { canRun } from '@fdw/engine-backend/testing';
import { memoryShaderCache } from './shaderCache';

// The shared rendering tests on Direct3D 12, through the native library of
// @fdw/engine-d3d12, with the debug layer: any message fails the test
// reading the pixels. Skipped where the addon is not built (Windows only);
// the rays, where the GPU has no DXR 1.1. The programs come from a cache
// after their first compilation.

const shaderCache = memoryShaderCache();

async function createFixture(): Promise<RenderingFixture> {
  const engine = new D3D12Engine({
    validation: true,
    application: 'tests',
    shaderCache,
  });
  await engine.init();
  const surface = new D3D12OffscreenSurface(size, size);
  await surface.init(engine);
  const device = engine.device;
  const backend = engine.backend;
  if (!device || !backend) {
    throw new Error('The Direct3D 12 engine is not ready');
  }
  return {
    backend,
    surface,
    readPixels: async () => {
      const pixels = await surface.readPixels();
      const messages = device.takeMessages();
      if (messages.length > 0) {
        throw new Error(`Direct3D 12 debug layer:\n${messages.join('\n')}`);
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
        throw new Error(`Direct3D 12 debug layer:\n${messages.join('\n')}`);
      }
    },
  };
}

describeRenderer('Renderer on Direct3D 12', createFixture, {
  skip: !canRun(
    'd3d12',
    existsSync(addonPath()),
    'the Direct3D 12 addon is not built (Windows only)',
  ),
});

// Whether the GPU has DXR 1.1.
function tracesRays(): boolean {
  const addon = loadD3D12Addon();
  const context = addon.createContext(false);
  try {
    return addon.rayQuerySupported(context);
  } finally {
    addon.destroyContext(context);
  }
}

describeRays('Rays on Direct3D 12', createFixture, {
  skip: !existsSync(addonPath()) || !tracesRays(),
});
