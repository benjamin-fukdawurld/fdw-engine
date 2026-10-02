import { WebGpuEngine, WebGpuOffscreenSurface } from '@fdw/engine-webgpu';
import { GraphBuilder, std, stdMacros, T } from '@fdw/engine-shader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BaseLight,
  Camera,
  DirectionalLight,
  Material,
  Mesh,
  PointLight,
  Renderer,
  RenderItem,
  Transform,
} from '@fdw/engine-core';

// Renders real frames with Dawn, the WebGPU implementation of Chrome running
// in Node, and checks the pixels. Skipped where Dawn cannot load.
const dawn = await import('webgpu').catch(() => undefined);

const size = 64;

// A 1×1 quad in the z = 0 plane, with uvs (v pointing down, like images).
const quad = () =>
  new Mesh({
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
      vertexCount: 4,
      indexBuffer: { format: 'uint16', count: 6 },
    },
    vertices: [
      new Float32Array([
        -0.5, -0.5, 0, 0, 1, 0.5, -0.5, 0, 1, 1, 0.5, 0.5, 0, 1, 0, -0.5, 0.5,
        0, 0, 0,
      ]),
    ],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

const colorGraph = () => {
  const g = new GraphBuilder('color');
  const color = g.uniform('color', T.vec4f, { default: [1, 0, 0, 1] });
  g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
  return g.build();
};

const texturedGraph = () => {
  const g = new GraphBuilder('textured');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', T.vec2f),
  });
  const tint = g.uniform('tint', T.vec3f, { default: [1, 1, 1] });
  g.surface({
    baseColor: g.call(std.mul, { a: texel.swizzle('rgb'), b: tint }),
  });
  return g.build();
};

const timeGraph = () => {
  const g = new GraphBuilder('time');
  // 0.5 + 0.5 × sin(time): 0.5 at t = 0, ~1 at t = π/2.
  const wave = g.call(std.add, {
    a: g.call(std.mul, { a: g.call(std.sin, { x: g.engine('time') }), b: 0.5 }),
    b: 0.5,
  });
  g.surface({ baseColor: g.call(std.mul, { a: [1, 1, 1], b: wave }) });
  return g.build();
};

const at = (x: number, y = 0) => new Transform({ position: { x, y, z: 0 } });

// GPUs round 0.5 × 255 to 127 or 128: compare colors within one unit.
const expectColor = (actual: number[], expected: number[]) =>
  expect(
    actual.every((component, i) => Math.abs(component - expected[i]) <= 1),
    `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)} (±1)`
  ).toBe(true);

describe.skipIf(!dawn)('Renderer on WebGPU (Dawn)', () => {
  let engine: WebGpuEngine;
  let surface: WebGpuOffscreenSurface;
  let renderer: Renderer;

  // An orthographic camera looking at -z: the view covers [-1, 1]².
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

  // Renders a frame and returns the RGBA color at pixel (x, y), from the top
  // left.
  const render = async (
    items: RenderItem[],
    time = 0,
    lights: BaseLight[] = [],
    using: Renderer = renderer
  ) => {
    using.render({
      items,
      camera,
      surface,
      time,
      lights,
      clearColor: { r: 0, g: 0, b: 0, a: 1 },
    });
    const pixels = await surface.readPixels();
    return (x: number, y: number) => [
      ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
    ];
  };

  beforeAll(async () => {
    Object.assign(globalThis, dawn!.globals);
    engine = new WebGpuEngine({ gpu: dawn!.create([]) });
    await engine.init();
    surface = new WebGpuOffscreenSurface(size, size);
    await surface.init(engine);
    renderer = new Renderer(engine.backend!);
  });

  afterAll(() => {
    renderer?.destroy();
    surface?.destroy();
    return engine?.destroy();
  });

  it('draws uniform-colored objects where their transforms place them', async () => {
    const material = new Material({ graph: colorGraph() });
    const pixel = await render([
      { mesh: quad(), material, transform: at(-0.5) },
    ]);
    expectColor(pixel(16, 32), [255, 0, 0, 255]);
    expectColor(pixel(48, 32), [0, 0, 0, 255]);
  });

  it('applies new uniform values and transforms on the next frame', async () => {
    const material = new Material({ graph: colorGraph() });
    const transform = at(-0.5);
    const items = [{ mesh: quad(), material, transform }];
    await render(items);

    material.setValue('color', [0, 0, 1, 1]);
    transform.position = { x: 0.5 };
    const pixel = await render(items);
    expectColor(pixel(16, 32), [0, 0, 0, 255]);
    expectColor(pixel(48, 32), [0, 0, 255, 255]);
  });

  it('samples textures', async () => {
    const backend = engine.backend!;
    // 2×2: red, green / blue, white.
    const map = backend.textures.createTexture({
      type: '2d',
      format: 'rgba8unorm',
      dimensions: { width: 2, height: 2 },
      source: new Uint8Array([
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
      ]),
    });
    const mapSampler = backend.textures.createSampler({
      minFilter: 'nearest',
      magFilter: 'nearest',
      mipmapFilter: 'nearest',
    });
    const material = new Material({
      graph: texturedGraph(),
      values: { map, mapSampler, tint: [0.5, 0.5, 0.5] },
    });
    const transform = new Transform({ scale: { x: 2, y: 2, z: 1 } });
    const pixel = await render([{ mesh: quad(), material, transform }]);
    expectColor(pixel(8, 8), [128, 0, 0, 255]);
    expectColor(pixel(56, 8), [0, 128, 0, 255]);
    expectColor(pixel(8, 56), [0, 0, 128, 255]);
    expectColor(pixel(56, 56), [128, 128, 128, 255]);
  });

  it('passes the engine time to the materials', async () => {
    const material = new Material({ graph: timeGraph() });
    const items = [{ mesh: quad(), material, transform: at(0) }];
    expectColor((await render(items, 0))(32, 32), [128, 128, 128, 255]);
    expectColor(
      (await render(items, Math.PI / 2))(32, 32),
      [255, 255, 255, 255]
    );
  });

  it('blends transparent materials over the opaque ones', async () => {
    const opaque = new Material({
      graph: colorGraph(),
      values: { color: [1, 0, 0, 1] },
    });
    const glass = new Material({
      graph: colorGraph(),
      values: { color: [0, 0, 1, 0.5] },
      renderState: { alphaMode: 'blend' },
    });
    // The transparent quad is listed first: the renderer still draws it last.
    const pixel = await render([
      {
        mesh: quad(),
        material: glass,
        transform: new Transform({ position: { x: 0, y: 0, z: 1 } }),
      },
      { mesh: quad(), material: opaque, transform: at(0) },
    ]);
    // 0.5 × blue + 0.5 × red.
    expectColor(pixel(32, 32), [128, 0, 128, 255]);
  });

  it('culls back faces unless the material is double sided', async () => {
    const turned = new Transform({ rotation: { x: 0, y: 1, z: 0, w: 0 } });
    const single = new Material({ graph: colorGraph() });
    const double = new Material({
      graph: colorGraph(),
      renderState: { doubleSided: true },
    });
    expect(
      (await render([{ mesh: quad(), material: single, transform: turned }]))(
        32,
        32
      )
    ).toEqual([0, 0, 0, 255]);
    expect(
      (await render([{ mesh: quad(), material: double, transform: turned }]))(
        32,
        32
      )
    ).toEqual([255, 0, 0, 255]);
  });

  it('reports no WebGPU validation error', async () => {
    const device = engine.device!;
    device.pushErrorScope('validation');
    await render([
      {
        mesh: quad(),
        material: new Material({
          graph: texturedGraph(),
          values: {
            map: engine.backend!.textures.createTexture({
              type: '2d',
              format: 'rgba8unorm',
              dimensions: { width: 1, height: 1 },
              source: new Uint8Array([255, 255, 255, 255]),
            }),
            mapSampler: engine.backend!.textures.createSampler(),
          },
        }),
        transform: at(0),
      },
    ]);
    expect((await device.popErrorScope())?.message).toBeUndefined();
  });

  describe('phase 4: lighting, features, async pipelines', () => {
    // A 2×2 quad facing the camera (normal +z), covering the whole view.
    const litQuad = () =>
      new Mesh({
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
          vertexCount: 4,
          indexBuffer: { format: 'uint16', count: 6 },
        },
        vertices: [
          new Float32Array([
            -1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, -1, 1, 0,
            0, 0, 1,
          ]),
        ],
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      });

    const base = [0.5, 0.25, 1];
    const shininess = 4;
    const phongGraph = () => {
      const g = new GraphBuilder('phong');
      g.surface({ shadingModel: 'phong', baseColor: base, shininess });
      return g.build();
    };

    type Vec3 = [number, number, number];
    const sub = (a: Vec3, b: Vec3): Vec3 => [
      a[0] - b[0],
      a[1] - b[1],
      a[2] - b[2],
    ];
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
    const normalize = (a: Vec3) => scale(a, 1 / Math.hypot(...a));

    // Reference implementation of lighting.phong, at the center of a pixel.
    const phongReference = (
      x: number,
      y: number,
      light: { position: Vec3; w: number; ambient: Vec3; attenuation: Vec3 }
    ) => {
      const p: Vec3 = [
        (x + 0.5) / (size / 2) - 1,
        1 - (y + 0.5) / (size / 2),
        0,
      ];
      const n: Vec3 = [0, 0, 1];
      const toLight = sub(light.position, scale(p, light.w));
      const l = normalize(toLight);
      const v = normalize(sub([0, 0, 5], p));
      const d = Math.hypot(...toLight);
      const [c, linear, q] = light.attenuation;
      const attenuation = 1 / (c + linear * d + q * d * d);
      const nDotL = dot(n, l);
      const r = sub(scale(n, 2 * nDotL), l);
      const specular =
        Math.max(dot(v, r), 0) ** shininess * (nDotL >= 0 ? 1 : 0);
      return base
        .map(
          (b, i) =>
            light.ambient[i] * b +
            (b * Math.max(nDotL, 0) + specular) * attenuation
        )
        .map((value) => Math.round(Math.min(Math.max(value, 0), 1) * 255))
        .concat(255);
    };

    const pixels = [
      [32, 32],
      [5, 5],
      [60, 10],
      [12, 50],
    ];

    it('matches the reference Phong with a directional light', async () => {
      const light = new DirectionalLight({
        direction: { x: -0.6, y: 0, z: -0.8 },
        ambient: { x: 0.1, y: 0.1, z: 0.1 },
        diffuse: { x: 1, y: 1, z: 1 },
        specular: { x: 1, y: 1, z: 1 },
      });
      const pixel = await render(
        [
          {
            mesh: litQuad(),
            material: new Material({ graph: phongGraph() }),
            transform: at(0),
          },
        ],
        0,
        [light]
      );
      for (const [x, y] of pixels) {
        expectColor(
          pixel(x, y),
          phongReference(x, y, {
            position: [0.6, 0, 0.8],
            w: 0,
            ambient: [0.1, 0.1, 0.1],
            attenuation: [1, 0, 0],
          })
        );
      }
    });

    it('matches the reference Phong with an attenuated point light', async () => {
      const light = new PointLight({
        position: { x: 0.3, y: -0.2, z: 1 },
        ambient: { x: 0.05, y: 0.05, z: 0.05 },
        diffuse: { x: 1, y: 1, z: 1 },
        specular: { x: 1, y: 1, z: 1 },
        constantAttenuation: 1,
        linearAttenuation: 0.2,
        quadraticAttenuation: 0.5,
      });
      const pixel = await render(
        [
          {
            mesh: litQuad(),
            material: new Material({ graph: phongGraph() }),
            transform: at(0),
          },
        ],
        0,
        [light]
      );
      for (const [x, y] of pixels) {
        expectColor(
          pixel(x, y),
          phongReference(x, y, {
            position: [0.3, -0.2, 1],
            w: 1,
            ambient: [0.05, 0.05, 0.05],
            attenuation: [1, 0.2, 0.5],
          })
        );
      }
    });

    it('only shows the emissive color without light', async () => {
      const g = new GraphBuilder('emissive');
      g.surface({ shadingModel: 'phong', emissive: [0, 0.5, 0] });
      const material = new Material({ graph: g.build() });
      const pixel = await render([
        { mesh: litQuad(), material, transform: at(0) },
      ]);
      expectColor(pixel(32, 32), [0, 128, 0, 255]);
    });

    it('selects variants with the material features', async () => {
      const g = new GraphBuilder('switch');
      g.parameter('warm', false);
      g.surface({
        baseColor: g.call(
          stdMacros.staticSwitch,
          { ifTrue: [1, 0.5, 0], ifFalse: [0, 0.5, 1] },
          { params: { feature: 'warm' } }
        ),
      });
      const material = new Material({ graph: g.build() });
      const items = [{ mesh: litQuad(), material, transform: at(0) }];
      expectColor((await render(items))(32, 32), [0, 128, 255, 255]);
      material.setFeature('warm', true);
      expectColor((await render(items))(32, 32), [255, 128, 0, 255]);
    });

    it('skips items until their asynchronous pipeline is ready', async () => {
      const asyncRenderer = new Renderer(engine.backend!, {
        asyncPipelines: true,
      });
      const items = [
        {
          mesh: litQuad(),
          material: new Material({ graph: colorGraph() }),
          transform: at(0),
        },
      ];
      expectColor(
        (await render(items, 0, [], asyncRenderer))(32, 32),
        [0, 0, 0, 255]
      );
      await asyncRenderer.whenReady();
      expectColor(
        (await render(items, 0, [], asyncRenderer))(32, 32),
        [255, 0, 0, 255]
      );
      asyncRenderer.destroy();
    });
  });
});
