import { canRun } from '@fdw/engine-backend/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebGpuEngine } from '../WebGpuEngine';
import { Texture } from './Texture';

// The textures created by Dawn, the WebGPU implementation of Chrome, in
// Node. Skipped where Dawn cannot load.
const dawn = await import('webgpu').catch(() => undefined);
const ready = canRun('dawn', !!dawn, 'the webgpu package (Dawn) did not load');

describe.skipIf(!ready)('textures on WebGPU (Dawn)', () => {
  let engine: WebGpuEngine;

  beforeAll(async () => {
    Object.assign(globalThis, dawn!.globals);
    engine = new WebGpuEngine({ gpu: dawn!.create([]) });
    await engine.init();
  });

  afterAll(() => engine?.destroy());

  it('creates the 3d textures in 3d, their depth written', async () => {
    const device = engine.device!;
    device.pushErrorScope('validation');
    const texture = engine.backend!.textures.createTexture({
      type: '3d',
      format: 'rgba8unorm',
      dimensions: { width: 2, height: 2, layers: 3 },
      source: new Uint8Array(2 * 2 * 3 * 4).fill(255),
    }) as Texture;
    // A view of the 3d dimension: invalid on a 2d texture.
    expect(texture.view).toBeDefined();
    const error = await device.popErrorScope();
    expect(error?.message).toBeUndefined();
    expect(texture.texture!.dimension).toBe('3d');
    expect(texture.texture!.depthOrArrayLayers).toBe(3);
    texture.destroy();
  });
});
