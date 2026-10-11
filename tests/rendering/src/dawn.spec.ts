import { Camera, Material, Mesh, Renderer, Transform } from '@fdw/engine-core';
import { GraphBuilder, std, BuiltinTypes } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { createDawnFixture, dawn } from './dawnFixture';
import { describeRenderer } from './suite';
import { canRun } from '@fdw/engine-backend/testing';

// The shared rendering tests on WebGPU, with Dawn (the WebGPU implementation
// of Chrome) running in Node. Skipped where Dawn cannot load.
const createFixture = () => createDawnFixture();

const ready = canRun('dawn', !!dawn, 'the webgpu package (Dawn) did not load');

describeRenderer('Renderer on WebGPU (Dawn)', createFixture, { skip: !ready });

describe.skipIf(!ready)('WebGPU validation (Dawn)', () => {
  it('reports no validation error', async () => {
    const fixture = await createFixture();
    const { engine, backend, surface } = fixture;
    const renderer = new Renderer(backend);
    const g = new GraphBuilder('textured');
    const texel = g.call(std.textureSample, {
      texture: g.texture('map'),
      sampler: g.sampler('mapSampler'),
      uv: g.attribute('uv', BuiltinTypes.vec2f),
    });
    g.surface({ baseColor: texel.swizzle('rgb') });
    const device = engine.device!;
    device.pushErrorScope('validation');
    renderer.render({
      camera: new Camera({
        position: { x: 0, y: 0, z: 5 },
        projection: {
          type: 'orthographic',
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 100,
        },
      }),
      surface,
      items: [
        {
          mesh: new Mesh({
            description: {
              vertexBuffers: [
                {
                  stride: 20,
                  stepMode: 'vertex',
                  attributes: [
                    { semantic: 'position', format: 'float32x3', offset: 0 },
                    { semantic: 'uv', format: 'float32x2', offset: 12 },
                  ],
                },
              ],
              vertexCount: 3,
            },
            vertices: [
              new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            ],
          }),
          material: new Material({
            graph: g.build(),
            values: {
              map: backend.textures.createTexture({
                type: '2d',
                format: 'rgba8unorm',
                dimensions: { width: 1, height: 1 },
                source: new Uint8Array([255, 255, 255, 255]),
              }),
              mapSampler: backend.textures.createSampler(),
            },
          }),
          transform: new Transform(),
        },
      ],
    });
    await fixture.readPixels();
    expect((await device.popErrorScope())?.message).toBeUndefined();
    renderer.destroy();
    await fixture.destroy();
  });
});
