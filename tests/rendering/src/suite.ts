import type { GpuBuffer, RenderBackend, Surface } from '@fdw/engine-backend';
import {
  arrayType,
  BuiltinTypes,
  compile,
  defineFunction,
  GraphBuilder,
  std,
  stdMacros,
} from '@fdw/engine-shader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BaseLight,
  Camera,
  ComputeRunner,
  RenderGraph,
  RenderGraphRunner,
  DirectionalLight,
  Material,
  Mesh,
  PointLight,
  Renderer,
  RenderItem,
  SpotLight,
  Transform,
} from '@fdw/engine-core';

// Rendering tests shared by every backend: the same graphs, meshes and
// expected pixels, rendered through the whole engine on a real GPU API.

// A backend under test: a ready backend and an offscreen surface of
// size × size pixels.
export interface RenderingFixture {
  readonly backend: RenderBackend;
  readonly surface: Surface;
  // RGBA pixels of the last frame, row by row from the top.
  readPixels(): Promise<Uint8Array>;
  destroy(): Promise<void>;
}

export const size = 64;

const linearOutput = { encoding: 'linear', toneMapping: 'none' } as const;

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
  const color = g.uniform('color', BuiltinTypes.vec4f, {
    default: [1, 0, 0, 1],
  });
  g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
  return g.build();
};

const texturedGraph = () => {
  const g = new GraphBuilder('textured');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', BuiltinTypes.vec2f),
  });
  const tint = g.uniform('tint', BuiltinTypes.vec3f, { default: [1, 1, 1] });
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
export const expectColor = (actual: number[], expected: number[]) =>
  expect(
    actual.every((component, i) => Math.abs(component - expected[i]) <= 1),
    `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)} (±1)`
  ).toBe(true);

export function describeRenderer(
  name: string,
  createFixture: () => Promise<RenderingFixture>,
  options: { skip?: boolean } = {}
): void {
  describe.skipIf(options.skip ?? false)(name, () => {
    let fixture: RenderingFixture;
    let backend: RenderBackend;
    let surface: Surface;
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
      using: Renderer = renderer,
      exposure = 1
    ) => {
      using.render({
        items,
        camera,
        surface,
        time,
        exposure,
        lights,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
      });
      const pixels = await fixture.readPixels();
      return (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
      ];
    };

    beforeAll(async () => {
      fixture = await createFixture();
      backend = fixture.backend;
      surface = fixture.surface;
      // Linear output: the expected colors are those computed by the shaders.
      renderer = new Renderer(backend, { output: linearOutput });
    });

    afterAll(() => {
      renderer?.destroy();
      return fixture?.destroy();
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

    it('discards the masked fragments', async () => {
      // 2×2 alpha checker: opaque at the top left and bottom right.
      const map = backend.textures.createTexture({
        type: '2d',
        format: 'rgba8unorm',
        dimensions: { width: 2, height: 2 },
        source: new Uint8Array([
          255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255,
          255,
        ]),
      });
      const mapSampler = backend.textures.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest',
        mipmapFilter: 'nearest',
      });
      const g = new GraphBuilder('masked');
      const texel = g.call(std.textureSample, {
        texture: g.texture('map'),
        sampler: g.sampler('mapSampler'),
        uv: g.attribute('uv', BuiltinTypes.vec2f),
      });
      g.surface({ baseColor: texel.swizzle('rgb'), alpha: texel.swizzle('a') });
      const masked = new Material({
        graph: g.build(),
        values: { map, mapSampler },
        renderState: { alphaMode: 'mask' },
      });
      const red = new Material({
        graph: colorGraph(),
        values: { color: [1, 0, 0, 1] },
      });
      const full = { x: 2, y: 2, z: 1 };
      // The masked quad is in front: through its holes, the red quad behind
      // is visible.
      const pixel = await render([
        {
          mesh: quad(),
          material: masked,
          transform: new Transform({ scale: full }),
        },
        {
          mesh: quad(),
          material: red,
          transform: new Transform({
            position: { x: 0, y: 0, z: -1 },
            scale: full,
          }),
        },
      ]);
      expectColor(pixel(16, 16), [255, 255, 255, 255]);
      expectColor(pixel(48, 16), [255, 0, 0, 255]);
      expectColor(pixel(16, 48), [255, 0, 0, 255]);
      expectColor(pixel(48, 48), [255, 255, 255, 255]);
    });

    it('renders a material calling a function graph', async () => {
      const f = new GraphBuilder('halve');
      const value = f.functionInput('value', BuiltinTypes.vec3f);
      f.functionOutput('result', f.call(std.mul, { a: value, b: 0.5 }));
      const halve = defineFunction(f.build(), { id: 'test.halve' });

      const g = new GraphBuilder('halved');
      g.surface({
        baseColor: g.call(halve, {
          value: g.uniform('color', BuiltinTypes.vec3f, { default: [1, 0, 1] }),
        }),
      });
      const material = new Material({ graph: g.build() });
      const pixel = await render([
        { mesh: quad(), material, transform: at(0) },
      ]);
      expectColor(pixel(32, 32), [128, 0, 128, 255]);
    });

    it('reads storage buffers, where the backend has them', async () => {
      const g = new GraphBuilder('palette');
      const palette = g.storage('palette', arrayType(BuiltinTypes.vec4f));
      // The last color of the palette.
      g.surface({
        baseColor: g
          .call(std.index, {
            array: palette,
            index: g.call(std.sub, {
              a: g.call(std.arrayLength, { array: palette }),
              b: 1,
            }),
          })
          .swizzle('rgb'),
      });
      const material = (values: Record<string, GpuBuffer> = {}) => [
        {
          mesh: quad(),
          material: new Material({ graph: g.build(), values }),
          transform: at(0),
        },
      ];
      const create = () =>
        backend.buffers.create({
          size: 48,
          usage: ['storage', 'copy-dst'],
          initialData: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0.5, 1, 1]),
        });
      if (backend.capabilities?.storageBuffers === false) {
        // WebGL2: explicit errors, not a broken shader.
        expect(create).toThrow(/no storage buffers/);
        await expect(render(material())).rejects.toThrow(
          /the backend has no storage buffers/
        );
        return;
      }
      expectColor(
        (await render(material({ palette: create() })))(32, 32),
        [0, 128, 255, 255]
      );
    });

    it('reads buffers back', async () => {
      const buffer = backend.buffers.create({
        size: 16,
        usage: ['vertex', 'copy-src', 'copy-dst'],
        initialData: new Float32Array([1, 2, 3, 4]),
      });
      expect([...new Float32Array(await buffer.read())]).toEqual([1, 2, 3, 4]);
      expect([...new Float32Array(await buffer.read(8, 4))]).toEqual([3]);
      buffer.destroy();
    });

    it('refuses compute stages where the backend has none', () => {
      if (backend.capabilities?.compute !== false) {
        return;
      }
      expect(() => backend.createCommandEncoder().beginComputePass()).toThrow(
        /no compute shaders/
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

    it('shows both layers of a double-sided transparent shape', async () => {
      // A slab: a quad facing +z at z = 0.5, listed first, and one facing -z at
      // z = -0.5. Drawn in index order with depth writes, the front face would
      // hide the back one.
      const slab = new Mesh({
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
          vertexCount: 8,
          indexBuffer: { format: 'uint16', count: 12 },
        },
        vertices: [
          new Float32Array([
            -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
            -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5,
          ]),
        ],
        indices: new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
      });
      const glass = new Material({
        graph: colorGraph(),
        values: { color: [0, 0, 1, 0.5] },
        renderState: { alphaMode: 'blend', doubleSided: true },
      });
      const pixel = await render([
        { mesh: slab, material: glass, transform: at(0) },
      ]);
      // Two layers of 0.5 × blue over black: 0.75 × 255.
      expectColor(pixel(32, 32), [0, 0, 191, 255]);
    });

    describe('render graph', () => {
      it('renders into transient textures and copies them to the surface', async () => {
        const runner = new RenderGraphRunner(backend);
        const frame = (color: { r: number; g: number; b: number }) => {
          const graph = new RenderGraph();
          const backbuffer = graph.importTexture(
            'backbuffer',
            surface.getCurrentTarget()
          );
          // Half of the frame: the copy fills the top left quarter.
          const half = graph.createTexture('half', {
            format: 'rgba8unorm',
            size: { relative: 0.5 },
          });
          const filled = graph.addRasterPass('fill', (pass) => ({
            color: pass.writeColor(half, {
              load: 'clear',
              clearValue: { ...color, a: 1 },
            }),
            execute: () => undefined,
          }));
          // A clear of the surface, then the copy over it.
          const cleared = graph.addRasterPass('clear', (pass) => ({
            color: pass.writeColor(backbuffer, { load: 'clear' }),
            execute: () => undefined,
          }));
          graph.addCopyPass('copy', (pass) => {
            const source = pass.read(filled.color, 'copy-src');
            const destination = pass.write(cleared.color, 'copy-dst');
            return {
              execute: (context) =>
                context.encoder.copyTextureToTexture(
                  context.texture(source),
                  context.texture(destination),
                  { width: size / 2, height: size / 2 }
                ),
            };
          });
          runner.execute(graph);
        };
        frame({ r: 1, g: 0, b: 0 });
        let pixels = await fixture.readPixels();
        const at = (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
        expect(at(8, 8)).toEqual([255, 0, 0, 255]);
        expect(at(48, 48)).toEqual([0, 0, 0, 255]);

        // The next frame reuses the compilation and the texture.
        frame({ r: 0, g: 0, b: 1 });
        pixels = await fixture.readPixels();
        expect(at(8, 8)).toEqual([0, 0, 255, 255]);
        expect(runner.compilations).toBe(1);
        expect(runner.created).toBe(1);
        runner.destroy();
      });
    });

    describe('HDR and post-processing', () => {
      const hdrCapable = () =>
        backend.capabilities?.renderableFormats?.includes('rgba16float') ??
        false;
      const pixelsOf = async () => {
        const pixels = await fixture.readPixels();
        return (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
      };
      // A full screen pass writing a graph to the surface.
      const drawFullscreen = (
        using: Renderer,
        build: (g: GraphBuilder) => void,
        values: ConstructorParameters<typeof Material>[0]['values'] = {}
      ) => {
        const g = new GraphBuilder('fullscreen');
        build(g);
        const graph = new RenderGraph();
        using.addFullscreenPass(graph, 'fullscreen', {
          material: new Material({ graph: g.build(), values }),
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(graph);
        runner.destroy();
      };

      it('gives screen-uv from the top left corner, on every backend', async () => {
        drawFullscreen(renderer, (g) => {
          const uv = g.builtin('screen-uv');
          g.fullscreen({
            color: g.call(std.vec4, {
              x: uv.swizzle('x'),
              y: uv.swizzle('y'),
              z: 0,
              w: 1,
            }),
          });
        });
        const pixel = await pixelsOf();
        // The center of pixel (x, y): ((x + 0.5) / size, (y + 0.5) / size).
        const at = (x: number, y: number) => [
          Math.round(((x + 0.5) / size) * 255),
          Math.round(((y + 0.5) / size) * 255),
          0,
          255,
        ];
        for (const [x, y] of [
          [0, 0],
          [63, 0],
          [0, 63],
          [20, 40],
        ]) {
          expectColor(pixel(x, y), at(x, y));
        }
      });

      it('post-processes the scene through textures of the render graph', async () => {
        // The scene (red on the left) in a transient texture, then inverted.
        const g = new GraphBuilder('invert');
        const texel = g.call(std.textureSample, {
          texture: g.texture('source'),
          sampler: g.sampler('sourceSampler'),
          uv: g.builtin('screen-uv'),
        });
        g.fullscreen({
          color: g.call(std.extend, {
            xyz: g.call(std.sub, { a: 1, b: texel.swizzle('rgb') }),
            w: 1,
          }),
        });
        const invert = new Material({
          graph: g.build(),
          values: { sourceSampler: backend.textures.createSampler() },
        });
        const runner = new RenderGraphRunner(backend);
        const graph = new RenderGraph();
        const scene = renderer.addScenePasses(graph, {
          items: [
            {
              mesh: quad(),
              material: new Material({ graph: colorGraph() }),
              transform: at(-0.5),
            },
          ],
          camera,
          target: graph.createTexture('scene', { format: 'rgba8unorm' }),
          format: 'rgba8unorm',
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
        });
        renderer.addFullscreenPass(graph, 'invert', {
          material: invert,
          inputs: { source: scene },
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        runner.execute(graph);
        runner.destroy();
        const pixel = await pixelsOf();
        expectColor(pixel(16, 32), [0, 255, 255, 255]);
        expectColor(pixel(48, 32), [255, 255, 255, 255]);
        // Top half of the quad: the orientation is kept.
        expectColor(pixel(16, 8), [255, 255, 255, 255]);
      });

      it('blends transparent materials in linear colors in HDR', async (context) => {
        // White at alpha 0.5 over black, encoded in sRGB.
        const items = () => [
          {
            mesh: quad(),
            material: new Material({
              graph: colorGraph(),
              values: { color: [1, 1, 1, 0.5] },
              renderState: { alphaMode: 'blend' },
            }),
            transform: at(0),
          },
        ];
        const pixelWith = async (hdr: boolean) => {
          const using = new Renderer(backend, { hdr });
          const pixel = await render(items(), 0, [], using);
          using.destroy();
          return pixel(32, 32);
        };
        // Without HDR target, the encoded colors blend: 0.5 × 255.
        expectColor(await pixelWith(false), [128, 128, 128, 255]);
        context.skip(!hdrCapable(), 'no rgba16float render target');
        // In HDR, the linear ones: 0.5, encoded as 188.
        expectColor(await pixelWith(true), [188, 188, 188, 255]);
      });

      it('applies the same output in the materials and in the HDR pass', async (context) => {
        context.skip(!hdrCapable(), 'no rgba16float render target');
        const g = new GraphBuilder('gray');
        g.surface({ baseColor: [1.5, 0.25, 0.04] });
        const graph = g.build();
        for (const toneMapping of ['none', 'reinhard', 'aces', 'neutral']) {
          const pixels = [];
          for (const hdr of [false, true]) {
            const using = new Renderer(backend, {
              hdr,
              output: { toneMapping: toneMapping as 'aces' },
            });
            const pixel = await render(
              [
                {
                  mesh: quad(),
                  material: new Material({ graph }),
                  transform: at(0),
                },
              ],
              0,
              [],
              using,
              0.8
            );
            using.destroy();
            pixels.push(pixel(32, 32));
          }
          expectColor(pixels[1], pixels[0]);
        }
      });
    });

    describe('multisampling', () => {
      // The lower left half of the view: its edge goes through the centers
      // of the pixels (x, x).
      const halfView = () =>
        new Mesh({
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
            vertexCount: 3,
          },
          vertices: [new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0])],
        });
      const edgePixel = async (samples: number, hdr: boolean) => {
        const using = new Renderer(backend, {
          samples,
          hdr:
            hdr &&
            (backend.capabilities?.renderableFormats ?? []).includes(
              'rgba16float'
            ),
          output: linearOutput,
        });
        const pixel = await render(
          [
            {
              mesh: halfView(),
              material: new Material({ graph: colorGraph() }),
              transform: at(0),
            },
          ],
          0,
          [],
          using
        );
        using.destroy();
        return pixel;
      };

      it('smooths the edges with 4 samples per pixel', async () => {
        for (const hdr of [false, true]) {
          const pixel = await edgePixel(4, hdr);
          // Inside and outside the triangle.
          expectColor(pixel(10, 50), [255, 0, 0, 255]);
          expectColor(pixel(50, 10), [0, 0, 0, 255]);
          // On the edge: some of the samples.
          const [red] = pixel(20, 20);
          expect(red).toBeGreaterThan(30);
          expect(red).toBeLessThan(225);
        }
        // Without multisampling, a pixel is in or out.
        const [red] = (await edgePixel(1, false))(20, 20);
        expect([0, 255]).toContain(red);
      });
    });

    describe('shadows', () => {
      // A square of the given half size facing the camera (normal +z), at
      // depth z.
      const square = (half: number, z: number) =>
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
            new Float32Array(
              [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ].flatMap(([x, y]) => [x * half, y * half, z, 0, 0, 1])
            ),
          ],
          indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        });
      // White, diffuse only.
      const white = () => {
        const g = new GraphBuilder('white');
        g.surface({
          shadingModel: 'phong',
          baseColor: [1, 1, 1],
          specular: [0, 0, 0],
        });
        return new Material({ graph: g.build() });
      };
      const ambient = 0.1;
      const byte = (value: number) => Math.round(Math.min(value, 1) * 255);
      const gray = (value: number) => [
        byte(value),
        byte(value),
        byte(value),
        255,
      ];
      // A ground covering the view and a blocker of 0.5 × 0.5, 0.5 in front
      // of it, centered on (x, y).
      const scene = (x: number, y: number, castShadow = true) => [
        { mesh: square(1, 0), material: white(), transform: at(0) },
        {
          mesh: square(0.25, 0.5),
          material: white(),
          transform: at(x, y),
          castShadow,
        },
      ];
      const sun = (direction: { x: number; y: number; z: number }) =>
        new DirectionalLight({
          direction,
          ambient: { x: ambient, y: ambient, z: ambient },
          diffuse: { x: 1, y: 1, z: 1 },
          specular: { x: 0, y: 0, z: 0 },
          castShadow: true,
        });
      // Lit by a light 45° from the normal.
      const lit = gray(ambient + Math.SQRT1_2);
      const shadowed = gray(ambient);

      it('casts the shadows of directional lights', async () => {
        // The light goes right and away: the shadow is 0.5 to the right of
        // the blocker, around the center of the view.
        const pixel = await render(scene(-0.5, 0), 0, [
          sun({ x: 1, y: 0, z: -1 }),
        ]);
        expectColor(pixel(32, 32), shadowed);
        expectColor(pixel(28, 36), shadowed);
        // The blocker itself, and the ground around the shadow.
        expectColor(pixel(16, 32), lit);
        for (const [x, y] of [
          [48, 32],
          [60, 32],
          [32, 8],
          [32, 56],
          [56, 56],
          [4, 4],
        ]) {
          expectColor(pixel(x, y), lit);
        }
      });

      it('keeps the orientation of the shadow maps on every backend', async () => {
        // The light goes down: the shadow is 0.5 below the blocker.
        const pixel = await render(scene(0, 0.5), 0, [
          sun({ x: 0, y: -1, z: -1 }),
        ]);
        expectColor(pixel(32, 16), lit);
        expectColor(pixel(32, 32), shadowed);
        expectColor(pixel(32, 48), lit);
        expectColor(pixel(12, 32), lit);
      });

      it('casts the shadows of spot lights', async () => {
        // From (-2, 0, 2) towards the center: the shadow of the blocker
        // grows to x in [-1/3, 1/3].
        const light = new SpotLight({
          position: { x: -2, y: 0, z: 2 },
          direction: { x: 1, y: 0, z: -1 },
          innerCutoff: 35,
          outerCutoff: 40,
          ambient: { x: ambient, y: ambient, z: ambient },
          diffuse: { x: 1, y: 1, z: 1 },
          specular: { x: 0, y: 0, z: 0 },
          castShadow: true,
        });
        const pixel = await render(scene(-0.5, 0), 0, [light]);
        expectColor(pixel(32, 32), shadowed);
        expectColor(pixel(38, 26), shadowed);
        // Lit ground right of the shadow: N·L from the light position.
        const x = (52 + 0.5) / 32 - 1;
        const nDotL = 2 / Math.hypot(x + 2, 2);
        expectColor(pixel(52, 32), gray(ambient + nDotL));
      });

      it('only draws the casters in the shadow maps', async () => {
        const pixel = await render(scene(-0.5, 0, false), 0, [
          sun({ x: 1, y: 0, z: -1 }),
        ]);
        expectColor(pixel(32, 32), lit);
      });
    });

    describe('compute graphs', () => {
      // output[i] = input[i] × factor, for i < arrayLength(input).
      const scaleGraph = () => {
        const g = new GraphBuilder('scale');
        const index = g.builtin('global-invocation-id').swizzle('x');
        const input = g.storage('input', arrayType(BuiltinTypes.f32));
        const output = g.storage('output', arrayType(BuiltinTypes.f32), {
          access: 'read-write',
        });
        g.write(output, {
          index,
          value: g.call(std.mul, {
            a: g.call(std.index, { array: input, index }),
            b: g.uniform('factor', BuiltinTypes.f32),
          }),
          when: g.call(std.less, {
            a: index,
            b: g.call(std.arrayLength, { array: input }),
          }),
        });
        g.compute({ workgroupSize: [64, 1, 1] });
        return g.build();
      };

      it('runs a compute graph, or reports that the backend cannot', async () => {
        const compileScale = () =>
          compile(scaleGraph(), { capabilities: backend.capabilities });
        if (backend.capabilities?.compute === false) {
          expect(compileScale).toThrow(/the backend has no compute shaders/);
          return;
        }
        const values = Float32Array.from({ length: 100 }, (_, i) => i - 10);
        const input = backend.buffers.create({
          size: values.byteLength,
          usage: ['storage', 'copy-dst'],
          initialData: values,
        });
        const output = backend.buffers.create({
          size: values.byteLength,
          usage: ['storage', 'copy-src', 'copy-dst'],
        });
        const runner = new ComputeRunner(backend);
        runner.dispatch(compileScale(), {
          values: { input, output, factor: 2.5 },
          workgroups: [Math.ceil(values.length / 64)],
        });
        expect([...new Float32Array(await output.read())]).toEqual(
          [...values].map((value) => value * 2.5)
        );
        runner.destroy();
      });

      it('processes an image with a two-dimensional dispatch', async () => {
        if (backend.capabilities?.compute === false) {
          return;
        }
        // The luminance of each texel of a 4 × 4 image, in a buffer.
        const g = new GraphBuilder('luminance');
        const id = g.builtin('global-invocation-id');
        const uv = g.call(std.div, {
          a: g.call(std.add, {
            a: g.call(
              std.convert,
              { value: id.swizzle('xy') },
              { params: { to: BuiltinTypes.vec2f } }
            ),
            b: 0.5,
          }),
          b: 4,
        });
        const texel = g.call(std.textureSampleLevel, {
          texture: g.texture('image'),
          sampler: g.sampler('imageSampler'),
          uv,
        });
        const output = g.storage('luminance', arrayType(BuiltinTypes.f32), {
          access: 'read-write',
        });
        g.write(output, {
          index: g.call(std.add, {
            a: g.call(std.mul, { a: id.swizzle('y'), b: 4 }),
            b: id.swizzle('x'),
          }),
          value: g.call(std.dot, {
            a: texel.swizzle('rgb'),
            b: [0.2126, 0.7152, 0.0722],
          }),
        });
        g.compute({ workgroupSize: [4, 4, 1] });

        const pixels = Uint8Array.from({ length: 64 }, (_, i) =>
          i % 4 === 3 ? 255 : (i * 37) % 256
        );
        const image = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width: 4, height: 4 },
          source: pixels,
        });
        const luminance = backend.buffers.create({
          size: 64,
          usage: ['storage', 'copy-src'],
        });
        const runner = new ComputeRunner(backend);
        runner.dispatch(compile(g.build()), {
          values: {
            image,
            imageSampler: backend.textures.createSampler({
              minFilter: 'nearest',
              magFilter: 'nearest',
              mipmapFilter: 'nearest',
            }),
            luminance,
          },
          workgroups: [1, 1],
        });
        const result = new Float32Array(await luminance.read());
        for (let i = 0; i < 16; i++) {
          const [r, gr, b] = [0, 1, 2].map((c) => pixels[i * 4 + c] / 255);
          expect(result[i]).toBeCloseTo(
            0.2126 * r + 0.7152 * gr + 0.0722 * b,
            5
          );
        }
        runner.destroy();
      });

      it('samples textures at an explicit level in fragment shaders', async () => {
        const g = new GraphBuilder('sampled at a level');
        const texel = g.call(std.textureSampleLevel, {
          texture: g.texture('map'),
          sampler: g.sampler('mapSampler'),
          uv: g.attribute('uv', BuiltinTypes.vec2f),
          level: 0,
        });
        g.surface({ baseColor: texel.swizzle('rgb') });
        const map = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width: 1, height: 1 },
          source: new Uint8Array([0, 255, 128, 255]),
        });
        const pixel = await render([
          {
            mesh: quad(),
            material: new Material({
              graph: g.build(),
              values: { map, mapSampler: backend.textures.createSampler() },
            }),
            transform: at(0),
          },
        ]);
        expectColor(pixel(32, 32), [0, 255, 128, 255]);
      });
    });

    describe('color management', () => {
      const gray = (value: number) => {
        const g = new GraphBuilder('gray');
        g.surface({ baseColor: [value, value, value] });
        return g.build();
      };
      const pixelOf = async (
        graph: ReturnType<typeof gray>,
        output: ConstructorParameters<typeof Renderer>[1],
        exposure = 1,
        values: Record<string, never> = {}
      ) => {
        const using = new Renderer(backend, output);
        const pixel = await render(
          [
            {
              mesh: quad(),
              material: new Material({ graph, values }),
              transform: at(0),
            },
          ],
          0,
          [],
          using,
          exposure
        );
        using.destroy();
        return pixel(32, 32);
      };
      const byte = (value: number) =>
        Math.round(Math.min(Math.max(value, 0), 1) * 255);
      const srgb = (c: number) =>
        c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

      it('encodes the linear colors in sRGB by default', async () => {
        for (const value of [0.5, 0.002, 1]) {
          const v = byte(srgb(value));
          expectColor(await pixelOf(gray(value), {}), [v, v, v, 255]);
        }
      });

      it('decodes the sRGB textures', async () => {
        // 188 encodes 0.5 in sRGB: read as 0.5, written as 128 in linear.
        const map = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm-srgb',
          dimensions: { width: 1, height: 1 },
          source: new Uint8Array([188, 188, 188, 255]),
        });
        const pixel = await render([
          {
            mesh: quad(),
            material: new Material({
              graph: texturedGraph(),
              values: {
                map,
                mapSampler: backend.textures.createSampler(),
              },
            }),
            transform: at(0),
          },
        ]);
        expectColor(pixel(32, 32), [128, 128, 128, 255]);
      });

      it('tone maps the colors multiplied by the exposure', async () => {
        const aces = (c: number) =>
          (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
        // Khronos PBR Neutral, for a gray: below the compression, the color
        // only loses the offset; above, its peak is compressed.
        const neutral = (c: number) => {
          const offset = c < 0.08 ? c - 6.25 * c * c : 0.04;
          const peak = c - offset;
          const start = 0.76;
          if (peak < start) {
            return peak;
          }
          const d = 1 - start;
          return 1 - (d * d) / (peak + d - start);
        };
        const cases: [string, (c: number) => number, number, number][] = [
          ['reinhard', (c) => c / (1 + c), 2, 1],
          ['aces', aces, 0.8, 1],
          ['neutral', neutral, 0.5, 1],
          ['neutral', neutral, 3, 1],
          // The exposure scales the color before the tone mapping.
          ['reinhard', (c) => c / (1 + c), 1, 3],
        ];
        for (const [toneMapping, operator, value, exposure] of cases) {
          const v = byte(operator(value * exposure));
          expectColor(
            await pixelOf(
              gray(value),
              {
                output: {
                  toneMapping: toneMapping as 'reinhard',
                  encoding: 'linear',
                },
              },
              exposure
            ),
            [v, v, v, 255]
          );
        }
      });
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
      const scale = (a: Vec3, k: number): Vec3 => [
        a[0] * k,
        a[1] * k,
        a[2] * k,
      ];
      const normalize = (a: Vec3) => scale(a, 1 / Math.hypot(...a));

      interface ReferenceLight {
        position: Vec3;
        w: number;
        ambient: Vec3;
        attenuation: Vec3;
        // Diffuse and specular color, gray.
        intensity?: number;
        spot?: { direction: Vec3; innerDegrees: number; outerDegrees: number };
      }

      // Reference implementation of lighting.phong, summed over the lights,
      // at the center of a pixel.
      const phongReference = (
        x: number,
        y: number,
        ...lights: ReferenceLight[]
      ) => {
        const p: Vec3 = [
          (x + 0.5) / (size / 2) - 1,
          1 - (y + 0.5) / (size / 2),
          0,
        ];
        const n: Vec3 = [0, 0, 1];
        const v = normalize(sub([0, 0, 5], p));
        const color = [0, 0, 0];
        for (const light of lights) {
          const toLight = sub(light.position, scale(p, light.w));
          const l = normalize(toLight);
          const d = Math.hypot(...toLight);
          const [c, linear, q] = light.attenuation;
          const attenuation = 1 / (c + linear * d + q * d * d);
          let spot = 1;
          if (light.spot) {
            const cosine = (degrees: number) =>
              Math.cos((degrees * Math.PI) / 180);
            const inner = cosine(light.spot.innerDegrees);
            const outer = cosine(light.spot.outerDegrees);
            const theta = dot(scale(l, -1), normalize(light.spot.direction));
            spot = Math.min(Math.max((theta - outer) / (inner - outer), 0), 1);
          }
          const nDotL = dot(n, l);
          const r = sub(scale(n, 2 * nDotL), l);
          const specular =
            Math.max(dot(v, r), 0) ** shininess * (nDotL >= 0 ? 1 : 0);
          const intensity = light.intensity ?? 1;
          base.forEach((b, i) => {
            color[i] +=
              light.ambient[i] * b +
              intensity *
                (b * Math.max(nDotL, 0) + specular) *
                attenuation *
                spot;
          });
        }
        return color
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

      it('sums several lights, spot lights included', async () => {
        const gray = (value: number) => ({ x: value, y: value, z: value });
        const lights = [
          new DirectionalLight({
            direction: { x: -0.6, y: 0, z: -0.8 },
            ambient: gray(0.05),
            diffuse: gray(0.3),
            specular: gray(0.3),
          }),
          new PointLight({
            position: { x: 0.3, y: -0.2, z: 1 },
            ambient: gray(0),
            diffuse: gray(0.3),
            specular: gray(0.3),
            constantAttenuation: 1,
            linearAttenuation: 0.2,
            quadraticAttenuation: 0.5,
          }),
          new SpotLight({
            position: { x: -0.5, y: 0.5, z: 1.5 },
            direction: { x: 0, y: 0, z: -1 },
            ambient: gray(0),
            diffuse: gray(0.4),
            specular: gray(0.4),
            innerCutoff: 10,
            outerCutoff: 30,
          }),
        ];
        const pixel = await render(
          [
            {
              mesh: litQuad(),
              material: new Material({ graph: phongGraph() }),
              transform: at(0),
            },
          ],
          0,
          lights
        );
        // Under the spot, at the edge of its cone, outside of it, elsewhere.
        for (const [x, y] of [
          [16, 16],
          [30, 16],
          [5, 5],
          [60, 60],
          [32, 32],
          [12, 50],
        ]) {
          expectColor(
            pixel(x, y),
            phongReference(
              x,
              y,
              {
                position: [0.6, 0, 0.8],
                w: 0,
                ambient: [0.05, 0.05, 0.05],
                attenuation: [1, 0, 0],
                intensity: 0.3,
              },
              {
                position: [0.3, -0.2, 1],
                w: 1,
                ambient: [0, 0, 0],
                attenuation: [1, 0.2, 0.5],
                intensity: 0.3,
              },
              {
                position: [-0.5, 0.5, 1.5],
                w: 1,
                ambient: [0, 0, 0],
                attenuation: [1, 0, 0],
                intensity: 0.4,
                spot: {
                  direction: [0, 0, -1],
                  innerDegrees: 10,
                  outerDegrees: 30,
                },
              }
            )
          );
        }
      });

      // Reference implementation of lighting.pbr, at the center of a pixel,
      // for gray lights without attenuation nor spot.
      const pbrReference = (
        x: number,
        y: number,
        material: { baseColor: Vec3; metallic: number; roughness: number },
        ...lights: {
          position: Vec3;
          w: number;
          ambient: number;
          intensity: number;
        }[]
      ) => {
        const p: Vec3 = [
          (x + 0.5) / (size / 2) - 1,
          1 - (y + 0.5) / (size / 2),
          0,
        ];
        const n: Vec3 = [0, 0, 1];
        const v = normalize(sub([0, 0, 5], p));
        const nDotV = Math.max(dot(n, v), 1e-4);
        const r = Math.min(Math.max(material.roughness, 0.04), 1);
        const a2 = r ** 4;
        const k = (r + 1) ** 2 / 8;
        const geometry = (value: number) => value / (value * (1 - k) + k);
        const f0 = material.baseColor.map(
          (c) => 0.04 + (c - 0.04) * material.metallic
        );
        const diffuseColor = material.baseColor.map(
          (c) => c * (1 - material.metallic)
        );
        const color = [0, 0, 0];
        for (const light of lights) {
          const l = normalize(sub(light.position, scale(p, light.w)));
          const h = normalize([l[0] + v[0], l[1] + v[1], l[2] + v[2]]);
          const nDotL = Math.max(dot(n, l), 0);
          const nDotH = Math.max(dot(n, h), 0);
          const vDotH = Math.max(dot(v, h), 0);
          const d = nDotH * nDotH * (a2 - 1) + 1;
          const distribution = a2 / (Math.PI * d * d);
          const g = geometry(nDotL) * geometry(nDotV);
          for (let i = 0; i < 3; i++) {
            const fresnel = f0[i] + (1 - f0[i]) * (1 - vDotH) ** 5;
            const specular =
              (distribution * g * fresnel) / (4 * nDotL * nDotV + 1e-4);
            const diffuse = ((1 - fresnel) * diffuseColor[i]) / Math.PI;
            color[i] +=
              light.ambient * material.baseColor[i] +
              (diffuse + specular) * light.intensity * Math.PI * nDotL;
          }
        }
        return color
          .map((value) => Math.round(Math.min(Math.max(value, 0), 1) * 255))
          .concat(255);
      };

      it('matches the reference PBR for dielectrics and metals', async () => {
        const gray = (value: number) => ({ x: value, y: value, z: value });
        const lights = [
          new DirectionalLight({
            direction: { x: -0.6, y: 0, z: -0.8 },
            ambient: gray(0.05),
            diffuse: gray(0.6),
            specular: gray(0.6),
          }),
          new PointLight({
            position: { x: -0.3, y: 0.4, z: 1.5 },
            ambient: gray(0),
            diffuse: gray(0.4),
            specular: gray(0.4),
          }),
        ];
        const baseColor: Vec3 = [0.8, 0.3, 0.2];
        for (const [metallic, roughness] of [
          [0, 0.9],
          [0, 0.3],
          [1, 0.4],
        ]) {
          const g = new GraphBuilder('pbr');
          g.surface({ shadingModel: 'pbr', baseColor, metallic, roughness });
          const pixel = await render(
            [
              {
                mesh: litQuad(),
                material: new Material({ graph: g.build() }),
                transform: at(0),
              },
            ],
            0,
            lights
          );
          for (const [x, y] of [
            [32, 32],
            [20, 18],
            [5, 5],
            [60, 40],
          ]) {
            expectColor(
              pixel(x, y),
              pbrReference(
                x,
                y,
                { baseColor, metallic, roughness },
                {
                  position: [0.6, 0, 0.8],
                  w: 0,
                  ambient: 0.05,
                  intensity: 0.6,
                },
                { position: [-0.3, 0.4, 1.5], w: 1, ambient: 0, intensity: 0.4 }
              )
            );
          }
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
        const asyncRenderer = new Renderer(backend, {
          asyncPipelines: true,
          output: linearOutput,
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
}
