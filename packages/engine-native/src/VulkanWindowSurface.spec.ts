import { existsSync } from 'node:fs';
import { canRun, hasDisplay } from '@fdw/engine-backend/testing';
import { Camera, Material, Mesh, Renderer, Transform } from '@fdw/engine-core';
import { GraphBuilder } from '@fdw/engine-shader';
import { addonPath, VulkanEngine } from '@fdw/engine-vulkan';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NativeWindow } from './NativeWindow';
import { VulkanWindowSurface } from './VulkanWindowSurface';

// A swapchain on a hidden window: needs the two addons and a display.
const ready = canRun(
  'window',
  existsSync(new URL('../build/fdw_native.node', import.meta.url)) &&
    existsSync(addonPath()) &&
    hasDisplay(),
  'needs the two addons and a display',
);

describe.skipIf(!ready)('VulkanWindowSurface', () => {
  let engine: VulkanEngine;
  let window: NativeWindow;
  let surface: VulkanWindowSurface;

  beforeAll(async () => {
    engine = new VulkanEngine({ validation: true, application: 'tests' });
    await engine.init();
    window = new NativeWindow({
      title: 'tests',
      width: 64,
      height: 48,
      hidden: true,
      vulkan: true,
    });
    // Without vsync: the tests do not wait for the display.
    surface = new VulkanWindowSurface(window, { vsync: false });
    await surface.init(engine);
  });
  afterAll(async () => {
    surface?.destroy();
    window?.destroy();
    await engine?.destroy();
  });
  afterEach(() => {
    expect(engine.device?.takeMessages()).toEqual([]);
  });

  it('renders into the images of the swapchain and presents them', async () => {
    expect(['bgra8unorm', 'rgba8unorm']).toContain(surface.format);
    const backend = engine.backend;
    if (!backend) {
      throw new Error('The engine is not ready');
    }
    for (const red of [1, 0.2]) {
      const target = surface.getCurrentTarget();
      expect([target.width, target.height]).toEqual([
        window.width,
        window.height,
      ]);
      // The same image until it is presented.
      expect(surface.getCurrentTarget()).toBe(target);
      const encoder = backend.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [
            { target, load: 'clear', clearValue: { r: red, g: 0, b: 0, a: 1 } },
          ],
        })
        .end();
      backend.submit([encoder.finish()]);
      // Read before the presentation: BGRA or RGBA bytes.
      const pixels = new Uint8Array(await target.read());
      const channel = surface.format === 'bgra8unorm' ? 2 : 0;
      expect(pixels[channel]).toBe(Math.round(red * 255));
      surface.present();
    }
  });

  it('runs frames of the Renderer', () => {
    const backend = engine.backend;
    if (!backend) {
      throw new Error('The engine is not ready');
    }
    const g = new GraphBuilder('lit');
    g.surface({ shadingModel: 'pbr', baseColor: [0.8, 0.4, 0.2] });
    const mesh = new Mesh({
      description: {
        vertexBuffers: [
          {
            stride: 24,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float32x3', offset: 0 },
              { semantic: 'normal', format: 'float32x3', offset: 12 },
            ],
          },
        ],
        vertexCount: 3,
      },
      vertices: [
        new Float32Array([
          -1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
        ]),
      ],
    });
    const renderer = new Renderer(backend, { samples: 4 });
    const items = [
      {
        mesh,
        material: new Material({ graph: g.build() }),
        transform: new Transform(),
      },
    ];
    const camera = new Camera({ position: { x: 0, y: 0, z: 5 } });
    for (let frame = 0; frame < 10; frame++) {
      renderer.render({ items, camera, surface, time: frame / 60 });
    }
    renderer.destroy();
    engine.device?.waitIdle();
  });
});
