import { Camera, Material, Mesh, Renderer, Transform } from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { WebGpuEngine } from '@fdw/engine-webgpu';
import { WebGpuOffscreenSurface } from '@fdw/engine-webgpu';
import { canRun } from '@fdw/engine-backend/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDawnEngine } from './dawn';
import { DawnWindowSurface } from './DawnWindowSurface';
import type { NativeWindow } from './NativeWindow';

const dawn = await import('webgpu').catch(() => undefined);

// A window recording the images it shows.
function fakeWindow(width: number, height: number) {
  const shown: { pixels: Uint8Array; width: number; height: number }[] = [];
  const window = {
    width,
    height,
    destroyed: false,
    presentRgba: (pixels: Uint8Array, w: number, h: number, stride: number) => {
      // Rows without their padding.
      const rows = new Uint8Array(w * h * 4);
      for (let row = 0; row < h; row++) {
        rows.set(
          pixels.subarray(row * stride, row * stride + w * 4),
          row * w * 4
        );
      }
      shown.push({ pixels: rows, width: w, height: h });
    },
  };
  return { window: window as unknown as NativeWindow, shown, fake: window };
}

// A red square on the left half of the view.
const scene = () => {
  const g = new GraphBuilder('red');
  g.surface({
    baseColor: g.uniform('color', BuiltinTypes.vec3f, { default: [1, 0, 0] }),
  });
  const mesh = new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
          ],
        },
      ],
      vertexCount: 6,
    },
    vertices: [
      new Float32Array([
        -1, -1, 0, 0, -1, 0, 0, 1, 0, -1, -1, 0, 0, 1, 0, -1, 1, 0,
      ]),
    ],
  });
  return [
    {
      mesh,
      material: new Material({ graph: g.build() }),
      transform: new Transform(),
    },
  ];
};

const camera = new Camera({
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
});

describe.skipIf(
  !canRun('dawn', !!dawn, 'the webgpu package (Dawn) did not load')
)('DawnWindowSurface', () => {
  let engine: WebGpuEngine;
  beforeAll(async () => {
    engine = await createDawnEngine();
  });
  afterAll(() => engine?.destroy());

  it('shows the frames rendered offscreen', async () => {
    const { window, shown } = fakeWindow(40, 20);
    const surface = new DawnWindowSurface(window);
    await surface.init(engine);
    const offscreen = new WebGpuOffscreenSurface(40, 20);
    await offscreen.init(engine);
    const renderer = new Renderer(engine.backend!, {
      output: { encoding: 'linear' },
    });
    const items = scene();
    renderer.render({ items, camera, surface });
    renderer.render({ items, camera, surface: offscreen });
    await surface.throttle();
    // Every frame read back.
    while (shown.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(shown[0].width).toBe(40);
    expect(shown[0].pixels).toEqual(await offscreen.readPixels());
    // Red on the left, black on the right.
    expect([...shown[0].pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...shown[0].pixels.subarray(39 * 4, 40 * 4)]).toEqual([
      0, 0, 0, 255,
    ]);
    renderer.destroy();
    offscreen.destroy();
    surface.destroy();
  });

  it('bounds the frames in flight and follows the size of the window', async () => {
    const { window, shown, fake } = fakeWindow(16, 16);
    const surface = new DawnWindowSurface(window, { framesInFlight: 2 });
    await surface.init(engine);
    const renderer = new Renderer(engine.backend!);
    const items = scene();
    for (let frame = 0; frame < 6; frame++) {
      if (frame === 3) {
        fake.width = 32;
        fake.height = 8;
      }
      renderer.render({ items, camera, surface });
      await surface.throttle();
    }
    await surface.throttle();
    while (shown.length < 1 || shown.at(-1)?.width !== 32) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // In order, the last ones at the new size.
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.at(-1)).toMatchObject({ width: 32, height: 8 });
    expect(surface.getCurrentTarget().width).toBe(32);
    renderer.destroy();
    surface.destroy();
  });
});
