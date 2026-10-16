import type {
  GpuBuffer,
  GpuTexture,
  RenderBackend,
  Surface,
} from '@fdw/engine-backend';
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
  computeTangents,
  ComputeRunner,
  RenderGraph,
  RenderGraphRunner,
  DirectionalLight,
  Material,
  Mesh,
  pickIds,
  PointLight,
  Renderable,
  Renderer,
  RenderItem,
  SceneOutput,
  SpotLight,
  TextureHandle,
  Transform,
} from '@fdw/engine-core';
import { instantiate, Model } from '@fdw/engine-assets';
import { OcclusionCulling } from '@fdw/engine-occlusion';
import { Scene } from '@fdw/engine-scene';
import {
  defaultSkinningMode,
  MeshSkin,
  skinPositions,
  Skinning,
} from '@fdw/engine-skinning';
import { patchGrid, PatchSurface, patchVertex } from '@fdw/engine-tessellation';

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
    `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)} (±1)`,
  ).toBe(true);

export function describeRenderer(
  name: string,
  createFixture: () => Promise<RenderingFixture>,
  options: { skip?: boolean } = {},
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
      items: Renderable[],
      time = 0,
      lights: BaseLight[] = [],
      using: Renderer = renderer,
      exposure = 1,
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

    it('reads the data of the object drawn in the fragment stage', async () => {
      // Red where the origin of the object is right of the center.
      const g = new GraphBuilder('object origin');
      const origin = g.call(std.transform, {
        matrix: g.engine('object.world'),
        vector: g.constant(BuiltinTypes.vec4f, [0, 0, 0, 1]),
      });
      g.surface({
        baseColor: g.call(std.vec3, {
          x: g.call(std.step, { edge: 0, x: origin.swizzle('x') }),
          y: 0,
          z: 0,
        }),
      });
      const material = new Material({ graph: g.build() });
      const pixel = await render([
        { mesh: quad(), material, transform: at(-0.5) },
        { mesh: quad(), material, transform: at(0.5) },
      ]);
      expectColor(pixel(16, 32), [0, 0, 0, 255]);
      expectColor(pixel(48, 32), [255, 0, 0, 255]);
    });

    it('draws the objects sharing a mesh and a material as instances', async () => {
      const mesh = quad();
      const red = new Material({ graph: colorGraph() });
      const blue = new Material({
        graph: colorGraph(),
        values: { color: [0, 0, 1, 1] },
      });
      const pixel = await render([
        { mesh, material: red, transform: at(-0.5, 0.5) },
        { mesh, material: blue, transform: at(0.5, -0.5) },
        { mesh, material: red, transform: at(0.5, 0.5) },
      ]);
      // Each instance at the place of its object.
      expectColor(pixel(16, 16), [255, 0, 0, 255]);
      expectColor(pixel(48, 16), [255, 0, 0, 255]);
      expectColor(pixel(48, 48), [0, 0, 255, 255]);
      expectColor(pixel(16, 48), [0, 0, 0, 255]);
      // The two red quads in one draw.
      expect(renderer.stats.get('scene')).toMatchObject({
        drawn: 3,
        drawCalls: 2,
      });
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

    it('rewrites textures between frames', async () => {
      // Created black, drawn, then rewritten: white, blue / green, red.
      const map = backend.textures.createTexture({
        type: '2d',
        format: 'rgba8unorm',
        dimensions: { width: 2, height: 2 },
        source: new Uint8Array(16),
      });
      const mapSampler = backend.textures.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest',
        mipmapFilter: 'nearest',
      });
      const material = new Material({
        graph: texturedGraph(),
        values: { map, mapSampler, tint: [1, 1, 1] },
      });
      const items = [
        {
          mesh: quad(),
          material,
          transform: new Transform({ scale: { x: 2, y: 2, z: 1 } }),
        },
      ];
      expectColor((await render(items))(8, 8), [0, 0, 0, 255]);
      backend.textures.writeTexture(
        map,
        new Uint8Array([
          255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255,
        ]),
      );
      const pixel = await render(items);
      expectColor(pixel(8, 8), [255, 255, 255, 255]);
      expectColor(pixel(56, 8), [0, 0, 255, 255]);
      expectColor(pixel(8, 56), [0, 255, 0, 255]);
      expectColor(pixel(56, 56), [255, 0, 0, 255]);
    });

    describe('mipmaps and anisotropic filtering', () => {
      // The level of the map sampled, a uniform. Sampled per pixel:
      // textureSampleLevel of a per-vertex uv would run in the vertex stage.
      const levelGraph = () => {
        const g = new GraphBuilder('sampled at a level');
        const texel = g.call(std.textureSampleLevel, {
          texture: g.texture('map'),
          sampler: g.sampler('mapSampler'),
          uv: g.call(std.perFragment, {
            value: g.attribute('uv', BuiltinTypes.vec2f),
          }),
          level: g.uniform('level', BuiltinTypes.f32, { default: 0 }),
        });
        g.surface({ baseColor: texel.swizzle('rgb') });
        return g.build();
      };
      // 4×4, in 2×2 blocks: red, green / blue, white.
      const blocks = (colors: number[][]) =>
        Uint8Array.from({ length: 64 }, (_, i) => {
          const x = (i >> 2) % 4;
          const y = i >> 4;
          return i % 4 === 3 ? 255 : colors[(y >> 1) * 2 + (x >> 1)][i % 4];
        });
      const red = [255, 0, 0];
      const green = [0, 255, 0];
      const blue = [0, 0, 255];
      const white = [255, 255, 255];
      const black = [0, 0, 0];

      it('computes the levels of the textures written', async () => {
        const map = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width: 4, height: 4 },
          mipLevelCount: 3,
          source: blocks([red, green, blue, white]),
        });
        const material = new Material({
          graph: levelGraph(),
          values: {
            map,
            mapSampler: backend.textures.createSampler({
              minFilter: 'nearest',
              magFilter: 'nearest',
              mipmapFilter: 'nearest',
            }),
            level: 1,
          },
        });
        const items = [
          {
            mesh: quad(),
            material,
            transform: new Transform({ scale: { x: 2, y: 2, z: 1 } }),
          },
        ];
        // Level 1 (2×2): a texel per block.
        let pixel = await render(items);
        expectColor(pixel(8, 8), [255, 0, 0, 255]);
        expectColor(pixel(56, 8), [0, 255, 0, 255]);
        expectColor(pixel(8, 56), [0, 0, 255, 255]);
        expectColor(pixel(56, 56), [255, 255, 255, 255]);
        // Level 2 (1×1): the average.
        material.setValue('level', 2);
        pixel = await render(items);
        expectColor(pixel(32, 32), [128, 128, 128, 255]);

        // Rewritten: the levels follow.
        backend.textures.writeTexture(map, blocks([red, black, black, black]));
        pixel = await render(items);
        expectColor(pixel(32, 32), [64, 0, 0, 255]);
        map.destroy();
      });

      it('refuses levels the texture cannot have', () => {
        const texture = (
          descriptor: Partial<
            Parameters<RenderBackend['textures']['createTexture']>[0]
          >,
        ) =>
          backend.textures.createTexture({
            type: '2d',
            format: 'rgba8unorm',
            dimensions: { width: 4, height: 4 },
            ...descriptor,
          });
        expect(() => texture({ mipLevelCount: 4 })).toThrow(
          /more than the 3 of its size/,
        );
        expect(() => texture({ mipLevelCount: 2, format: 'r32uint' })).toThrow(
          /cannot be computed/,
        );
        expect(() =>
          texture({
            mipLevelCount: 2,
            sampleCount: 4,
            usage: ['render-attachment'],
          }),
        ).toThrow(/single level/);
      });

      // Renders the quad sampled at each level of a texture, over the whole
      // view: the pixels of each.
      const sampleLevels = async (map: GpuTexture, levels: number) => {
        const material = new Material({
          graph: levelGraph(),
          values: {
            map,
            mapSampler: backend.textures.createSampler({
              minFilter: 'nearest',
              magFilter: 'nearest',
              mipmapFilter: 'nearest',
            }),
            level: 0,
          },
        });
        const items = [
          {
            mesh: quad(),
            material,
            transform: new Transform({ scale: { x: 2, y: 2, z: 1 } }),
          },
        ];
        const frames: ((x: number, y: number) => number[])[] = [];
        for (let level = 0; level < levels; level++) {
          material.setValue('level', level);
          frames.push(await render(items));
        }
        return frames;
      };
      // The pixels of a level of one color.
      const filled = (count: number, [r, g, b]: number[]) =>
        Uint8Array.from({ length: count * 4 }, (_, i) =>
          i % 4 === 3 ? 255 : [r, g, b][i % 4],
        );

      it('samples the levels given, and a level written alone', async () => {
        const map = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width: 4, height: 4 },
          levels: [filled(16, red), filled(4, green), filled(1, blue)],
        });
        let frames = await sampleLevels(map, 3);
        expectColor(frames[0](32, 32), [255, 0, 0, 255]);
        expectColor(frames[1](32, 32), [0, 255, 0, 255]);
        expectColor(frames[2](32, 32), [0, 0, 255, 255]);

        // The second level replaced, the others kept.
        backend.textures.writeTexture(map, filled(4, white), { level: 1 });
        frames = await sampleLevels(map, 3);
        expectColor(frames[0](32, 32), [255, 0, 0, 255]);
        expectColor(frames[1](32, 32), [255, 255, 255, 255]);
        expectColor(frames[2](32, 32), [0, 0, 255, 255]);
        map.destroy();
      });

      // A BC7 block of one color, in mode 5: both endpoints the color (7
      // bits per color channel, 8 for alpha), every index 0.
      const bc7Block = (color: number[]) => {
        const bytes = new Uint8Array(16);
        let bit = 0;
        const put = (value: number, count: number) => {
          for (let i = 0; i < count; i++, bit++) {
            bytes[bit >> 3] |= ((value >> i) & 1) << (bit & 7);
          }
        };
        // Mode 5, no rotation.
        put(1 << 5, 6);
        put(0, 2);
        color.forEach((channel) => put((channel >> 1) * 0x81, 14));
        put(0xffff, 16);
        return bytes;
      };
      // An ETC2 RGB block of one color, in the individual mode of ETC1: a
      // base color of 4 bits per channel (0 or 15), every pixel modified by
      // -2 (table 0): 255 reads 253.
      const etc2Block = (color: number[]) =>
        Uint8Array.of(
          ...color.map((channel) => (channel ? 0xff : 0)),
          0,
          0xff,
          0xff,
          0,
          0,
        );
      const compressed = [
        { format: 'bc7-rgba-unorm', block: bc7Block, max: 255 },
        { format: 'etc2-rgb8unorm', block: etc2Block, max: 253 },
      ];

      it('samples the levels of the compressed formats the device has', async (context) => {
        const formats = compressed.filter(({ format }) =>
          backend.capabilities?.compressedFormats?.includes(format),
        );
        context.skip(formats.length === 0, 'no BC7 or ETC2 textures');
        for (const { format, block, max } of formats) {
          const blocks = (count: number, color: number[]) => {
            const one = block(color);
            const data = new Uint8Array(count * one.length);
            for (let i = 0; i < count; i++) {
              data.set(one, i * one.length);
            }
            return data;
          };
          // 8 × 8: 2 × 2 blocks, the top row red, the bottom one blue (the
          // orientation is checked); then a block for 4 × 4, 2 × 2 and 1 × 1.
          const map = backend.textures.createTexture({
            type: '2d',
            format,
            dimensions: { width: 8, height: 8 },
            levels: [
              Uint8Array.of(...blocks(2, red), ...blocks(2, blue)),
              blocks(1, green),
              blocks(1, blue),
              blocks(1, white),
            ],
          });
          const frames = await sampleLevels(map, 4);
          expectColor(frames[0](32, 8), [max, 0, 0, 255]);
          expectColor(frames[0](32, 56), [0, 0, max, 255]);
          expectColor(frames[1](32, 32), [0, max, 0, 255]);
          expectColor(frames[2](32, 32), [0, 0, max, 255]);
          expectColor(frames[3](32, 32), [max, max, max, 255]);
          map.destroy();
        }
      });

      it('gives the samplers the anisotropy the device allows', async () => {
        const limit = backend.capabilities?.maxAnisotropy ?? 1;
        expect(limit).toBeGreaterThanOrEqual(1);
        const textures = backend.textures;
        try {
          textures.defaultMaxAnisotropy = 64;
          // Clamped to the limit; only for linear, non-comparison samplers.
          expect(textures.createSampler().maxAnisotropy).toBe(limit);
          expect(
            textures.createSampler({ minFilter: 'nearest' }).maxAnisotropy,
          ).toBe(1);
          expect(
            textures.createSampler({ compare: 'less-equal' }).maxAnisotropy,
          ).toBe(1);
          expect(
            textures.createSampler({ maxAnisotropy: 2 }).maxAnisotropy,
          ).toBe(Math.min(2, limit));
        } finally {
          textures.defaultMaxAnisotropy = 1;
        }
        expect(textures.createSampler().maxAnisotropy).toBe(1);
        expect(() =>
          textures.createSampler({ maxAnisotropy: 4, magFilter: 'nearest' }),
        ).toThrow(/needs linear min, mag and mipmap filters/);

        // A plane seen at a grazing angle, sampled with mipmaps and
        // anisotropic filtering: the device accepts the sampler.
        const map = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width: 4, height: 4 },
          mipLevelCount: 3,
          source: blocks([white, white, white, white]),
        });
        const material = new Material({
          graph: texturedGraph(),
          values: {
            map,
            mapSampler: textures.createSampler({ maxAnisotropy: 16 }),
            tint: [1, 1, 1],
          },
        });
        const pixel = await render([
          {
            mesh: quad(),
            material,
            transform: new Transform({
              scale: { x: 2, y: 2, z: 1 },
              rotation: { x: Math.sin(-0.7), y: 0, z: 0, w: Math.cos(-0.7) },
            }),
          },
        ]);
        expectColor(pixel(32, 32), [255, 255, 255, 255]);
        map.destroy();
      });
    });

    it('passes the engine time to the materials', async () => {
      const material = new Material({ graph: timeGraph() });
      const items = [{ mesh: quad(), material, transform: at(0) }];
      expectColor((await render(items, 0))(32, 32), [128, 128, 128, 255]);
      expectColor(
        (await render(items, Math.PI / 2))(32, 32),
        [255, 255, 255, 255],
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
          /the backend has no storage buffers/,
        );
        return;
      }
      expectColor(
        (await render(material({ palette: create() })))(32, 32),
        [0, 128, 255, 255],
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
        /no compute shaders/,
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
          32,
        ),
      ).toEqual([0, 0, 0, 255]);
      expect(
        (await render([{ mesh: quad(), material: double, transform: turned }]))(
          32,
          32,
        ),
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
            surface.getCurrentTarget(),
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
                  { width: size / 2, height: size / 2 },
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

      it('writes several color targets in one pass', async () => {
        // Red in the color, (0.5, 0.25, 0) in a second target, an integer
        // in a third.
        const g = new GraphBuilder('three targets');
        g.fullscreen({ color: [1, 0, 0, 1] });
        g.target('half', [0.5, 0.25, 0, 1], 1);
        g.target('id', g.constant(BuiltinTypes.u32, 7), 2);
        // Then the left half of the frame shows the color, the right half
        // the second target.
        const show = new GraphBuilder('show');
        const uv = show.builtin('screen-uv');
        const sample = (name: string) =>
          show.call(std.textureSample, {
            texture: show.texture(name),
            sampler: show.sampler(`${name}Sampler`),
            uv,
          });
        show.fullscreen({
          color: show.call(std.select, {
            ifFalse: sample('color'),
            ifTrue: sample('half'),
            condition: show.call(std.greater, { a: uv.swizzle('x'), b: 0.5 }),
          }),
        });
        const sampler = backend.textures.createSampler({
          minFilter: 'nearest',
          magFilter: 'nearest',
          mipmapFilter: 'nearest',
        });

        const graph = new RenderGraph();
        const written = renderer.addFullscreenPass(graph, 'three targets', {
          material: new Material({ graph: g.build() }),
          target: graph.createTexture('color', { format: 'rgba8unorm' }),
          format: 'rgba8unorm',
          targets: {
            half: {
              target: graph.createTexture('half', { format: 'rgba8unorm' }),
              format: 'rgba8unorm',
            },
            id: {
              target: graph.createTexture('id', { format: 'r32uint' }),
              format: 'r32uint',
              clearColor: { r: 0, g: 0, b: 0, a: 0 },
            },
          },
        });
        renderer.addFullscreenPass(graph, 'show', {
          material: new Material({
            graph: show.build(),
            values: { colorSampler: sampler, halfSampler: sampler },
          }),
          inputs: { color: written.color, half: written.targets.half },
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        // The integer target, read by nobody, is kept by a pass with side
        // effects: its writes are checked by the backend (validation).
        graph.addCopyPass('keep id', (pass) => {
          pass.read(written.targets.id, 'copy-src');
          pass.hasSideEffects();
          return { execute: () => undefined };
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(graph);
        runner.destroy();
        const pixels = await fixture.readPixels();
        const at = (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
        expectColor(at(16, 32), [255, 0, 0, 255]);
        expectColor(at(48, 32), [128, 64, 0, 255]);
      });

      it('refuses more color targets than the backend allows', () => {
        const max = backend.capabilities?.maxColorAttachments ?? 4;
        const g = new GraphBuilder('too many targets');
        g.fullscreen({ color: [1, 0, 0, 1] });
        const targets: Record<string, { target: never; format: string }> = {};
        for (let i = 1; i <= max; i++) {
          g.target(`t${i}`, [0, 0, 0, 1], i);
        }
        const graph = new RenderGraph();
        for (let i = 1; i <= max; i++) {
          targets[`t${i}`] = {
            target: graph.createTexture(`t${i}`, {
              format: 'r8unorm',
            }) as never,
            format: 'r8unorm',
          };
        }
        if (max >= 8) {
          // Locations stop at 7: the compiler refuses first.
          expect(() =>
            renderer.addFullscreenPass(graph, 'too many', {
              material: new Material({ graph: g.build() }),
              target: graph.createTexture('c', { format: 'r8unorm' }),
              format: 'r8unorm',
              targets,
            }),
          ).toThrow();
          return;
        }
        expect(() =>
          renderer.addFullscreenPass(graph, 'too many', {
            material: new Material({ graph: g.build() }),
            target: graph.createTexture('c', { format: 'r8unorm' }),
            format: 'r8unorm',
            targets,
          }),
        ).toThrow(/more than the \d+ of the backend/);
      });
    });

    describe('scene outputs', () => {
      // A 1×1 quad facing the camera, with normals.
      const flat = () =>
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
              -0.5, -0.5, 0, 0, 0, 1, 0.5, -0.5, 0, 0, 0, 1, 0.5, 0.5, 0, 0, 0,
              1, -0.5, 0.5, 0, 0, 0, 1,
            ]),
          ],
          indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        });
      const nearest = () =>
        backend.textures.createSampler({
          minFilter: 'nearest',
          magFilter: 'nearest',
          mipmapFilter: 'nearest',
        });
      // An output function: one input of the surface, as a color.
      const asColor = (input: 'viewDepth' | 'objectId', scale: number) => {
        const f = new GraphBuilder(`${input} as color`);
        const value = f.functionInput(
          input,
          input === 'objectId' ? BuiltinTypes.u32 : BuiltinTypes.f32,
        );
        const float =
          input === 'objectId'
            ? f.call(
                std.convert,
                { value },
                { params: { to: BuiltinTypes.f32 } },
              )
            : value;
        f.functionOutput(
          'value',
          f.call(std.vec4, {
            x: f.call(std.mul, { a: float, b: scale }),
            w: 1,
          }),
        );
        return defineFunction(f.build(), { id: `test.${input}Color` });
      };
      // Draws the scene with outputs, then shows one of them on the
      // surface; the pixels.
      const output = async (
        items: RenderItem[],
        outputs: Record<string, SceneOutput>,
        shown: string,
        options: { samples?: number; color?: boolean } = {},
      ) => {
        const graph = new RenderGraph();
        const scene = renderer.addScenePasses(graph, {
          items,
          camera,
          ...(options.color === false
            ? { size: { width: size, height: size } }
            : {
                target: graph.createTexture('scene', {
                  format: 'rgba8unorm',
                }),
                format: 'rgba8unorm',
              }),
          outputs,
          ...(options.samples ? { samples: options.samples } : {}),
        } as never) as { outputs: Record<string, TextureHandle> };
        const g = new GraphBuilder('show');
        g.fullscreen({
          color: g.call(std.textureSample, {
            texture: g.texture('source'),
            sampler: g.sampler('sourceSampler'),
            uv: g.builtin('screen-uv'),
          }),
        });
        renderer.addFullscreenPass(graph, 'show', {
          material: new Material({
            graph: g.build(),
            values: { sourceSampler: nearest() },
          }),
          inputs: { source: scene.outputs[shown] },
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(graph);
        runner.destroy();
        const pixels = await fixture.readPixels();
        return (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
      };
      const red = () => new Material({ graph: colorGraph() });
      const items = (): RenderItem[] => [
        { mesh: flat(), material: red(), transform: at(-0.5), id: 3 },
        { mesh: flat(), material: red(), transform: at(0.5), id: 9 },
      ];

      it('writes the normals, the depths and the identifiers of the surfaces', async () => {
        let pixel = await output(
          items(),
          { normal: { format: 'rgba8unorm', value: 'view-normal' } },
          'normal',
        );
        // Facing the camera: (0, 0, 1); nothing elsewhere.
        expectColor(pixel(16, 32), [0, 0, 255, 255]);
        expectColor(pixel(16, 4), [0, 0, 0, 0]);
        // 5 in front of the camera, as 5 / 10.
        pixel = await output(
          items(),
          {
            depth: {
              format: 'rgba8unorm',
              value: asColor('viewDepth', 0.1),
            },
          },
          'depth',
        );
        expectColor(pixel(16, 32), [128, 0, 0, 255]);
        // The identifiers 3 and 9, as 3 / 16 and 9 / 16.
        pixel = await output(
          items(),
          { id: { format: 'rgba8unorm', value: asColor('objectId', 1 / 16) } },
          'id',
        );
        expectColor(pixel(16, 32), [48, 0, 0, 255]);
        expectColor(pixel(48, 32), [143, 0, 0, 255]);
      });

      it('writes the values of the materials, or the default', async () => {
        const g = new GraphBuilder('masked out');
        g.surface({ baseColor: [1, 0, 0] });
        g.output('mask', [1, 1, 0, 1]);
        const pixel = await output(
          [
            {
              mesh: flat(),
              material: new Material({ graph: g.build() }),
              transform: at(-0.5),
            },
            { mesh: flat(), material: red(), transform: at(0.5) },
          ],
          {
            mask: {
              format: 'rgba8unorm',
              value: 'material',
              default: [0, 0, 1, 1],
            },
          },
          'mask',
        );
        expectColor(pixel(16, 32), [255, 255, 0, 255]);
        expectColor(pixel(48, 32), [0, 0, 255, 255]);
      });

      it('writes a G-buffer without the shading models', async () => {
        const pixel = await output(
          items(),
          { albedo: { format: 'rgba8unorm', value: 'base-color' } },
          'albedo',
          { color: false },
        );
        expectColor(pixel(16, 32), [255, 0, 0, 255]);
        expectColor(pixel(16, 4), [0, 0, 0, 0]);
      });

      it('resolves the multisampled outputs', async () => {
        const pixel = await output(
          items(),
          { normal: { format: 'rgba8unorm', value: 'view-normal' } },
          'normal',
          { samples: 4 },
        );
        expectColor(pixel(16, 32), [0, 0, 255, 255]);
      });

      it('keeps the outputs of the opaque items under the transparent ones', async () => {
        const glass = new Material({
          graph: colorGraph(),
          values: { color: [0, 0, 1, 0.5] },
          renderState: { alphaMode: 'blend' },
        });
        const pixel = await output(
          [
            ...items(),
            {
              mesh: flat(),
              material: glass,
              transform: new Transform({
                position: { x: -0.5, y: 0, z: 1 },
              }),
              id: 12,
            },
          ],
          { id: { format: 'rgba8unorm', value: asColor('objectId', 1 / 16) } },
          'id',
        );
        expectColor(pixel(16, 32), [48, 0, 0, 255]);
      });
    });

    describe('readback and picking', () => {
      // A 2 × 2 texture of a format, with its content, readable.
      const readable = (format: string, data: ArrayBufferView<ArrayBuffer>) =>
        backend.textures.createTexture({
          type: '2d',
          format,
          dimensions: { width: 2, height: 2 },
          usage: ['sampled', 'copy-src', 'copy-dst'],
          source: data,
        });

      it('reads textures back, whole or a region, rows from the top', async () => {
        const cases: [string, ArrayBufferView<ArrayBuffer>][] = [
          // Red, green / blue, white.
          [
            'rgba8unorm',
            new Uint8Array([
              255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255,
              255,
            ]),
          ],
          ['r32uint', new Uint32Array([1, 2, 3, 16777216])],
          // 1, 2 / -1, 0.5 / 0, 65504 / -2, 0.25, as half floats.
          [
            'rg16float',
            new Uint16Array([
              0x3c00, 0x4000, 0xbc00, 0x3800, 0, 0x7bff, 0xc000, 0x3400,
            ]),
          ],
          [
            'rgba32float',
            new Float32Array([...Array(16)].map((_, i) => i * 0.5 - 2)),
          ],
          ['r16sint', new Int16Array([-1, 2, -32768, 32767])],
        ];
        for (const [format, data] of cases) {
          const texture = readable(format, data);
          const bytes = new Uint8Array(data.buffer);
          const pixel = bytes.length / 4;
          expect(
            [...new Uint8Array(await backend.textures.readTexture(texture))],
            format,
          ).toEqual([...bytes]);
          // The second column, then the bottom row.
          expect(
            [
              ...new Uint8Array(
                await backend.textures.readTexture(texture, {
                  x: 1,
                  y: 0,
                  width: 1,
                  height: 2,
                }),
              ),
            ],
            format,
          ).toEqual([
            ...bytes.subarray(pixel, 2 * pixel),
            ...bytes.subarray(3 * pixel, 4 * pixel),
          ]);
          expect(
            [
              ...new Uint8Array(
                await backend.textures.readTexture(texture, {
                  x: 0,
                  y: 1,
                  width: 2,
                  height: 1,
                }),
              ),
            ],
            format,
          ).toEqual([...bytes.subarray(2 * pixel)]);
          texture.destroy();
        }
      });

      it('refuses the regions and the textures it cannot read', async () => {
        const texture = readable('rgba8unorm', new Uint8Array(16));
        expect(() =>
          backend.textures.readTexture(texture, {
            x: 1,
            y: 1,
            width: 2,
            height: 1,
          }),
        ).toThrow(/not inside its 2×2 pixels/);
        texture.destroy();
        const sampled = backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width: 2, height: 2 },
        });
        expect(() => backend.textures.readTexture(sampled)).toThrow(
          /copy-src usage/,
        );
        sampled.destroy();
      });

      it('picks the identifiers of the objects, instanced and masked', async () => {
        const mesh = quad();
        const red = new Material({ graph: colorGraph() });
        // Discards the left half of the quad: alpha = u.
        const g = new GraphBuilder('half');
        g.surface({
          baseColor: [0, 1, 0],
          alpha: g.attribute('uv', BuiltinTypes.vec2f).swizzle('x'),
        });
        const half = new Material({
          graph: g.build(),
          renderState: { alphaMode: 'mask' },
        });
        const ids = backend.textures.createTexture({
          label: 'ids',
          type: '2d',
          format: 'r32uint',
          dimensions: { width: size, height: size },
          usage: ['render-attachment', 'copy-src'],
        });
        const graph = new RenderGraph();
        renderer.addScenePasses(graph, {
          items: [
            // Two instances of one draw, at the top.
            { mesh, material: red, transform: at(-0.5, 0.5), id: 1 },
            { mesh, material: red, transform: at(0.5, 0.5), id: 2 },
            // At the bottom left, seen through the masked half of the quad
            // in front, which covers the bottom.
            { mesh, material: red, transform: at(-0.5, -0.5), id: 3 },
            {
              mesh,
              material: half,
              transform: new Transform({
                position: { x: 0, y: -0.5, z: 1 },
                scale: { x: 2, y: 1, z: 1 },
              }),
              id: 16777216,
            },
          ],
          camera,
          outputs: {
            id: {
              format: 'r32uint',
              value: 'object-id',
              target: graph.importTexture('ids', ids),
            },
          },
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(graph);
        const picks = await Promise.all([
          pickIds(backend, ids, { x: 16, y: 16 }),
          pickIds(backend, ids, { x: 48, y: 16 }),
          pickIds(backend, ids, { x: 16, y: 48 }),
          pickIds(backend, ids, { x: 48, y: 48 }),
          // The top half, then everything.
          pickIds(backend, ids, { x: 0, y: 0, width: size, height: 31 }),
          pickIds(backend, ids, {
            x: size,
            y: size,
            width: -size,
            height: -size,
          }),
        ]);
        expect(picks).toEqual([
          [1],
          [2],
          [3],
          [16777216],
          [1, 2],
          [1, 2, 3, 16777216],
        ]);
        // The three red quads in one draw: each instance keeps its own.
        expect(renderer.stats.get('scene')).toMatchObject({
          drawn: 4,
          drawCalls: 2,
        });
        runner.destroy();
        ids.destroy();
      });
    });

    describe('occlusion culling', () => {
      const perspective = new Camera({
        position: { x: 0, y: 0, z: 5 },
        projection: {
          type: 'perspective',
          fov: 60,
          aspect: 1,
          near: 0.1,
          far: 100,
        },
      });
      const colored = (r: number, g: number, b: number) =>
        new Material({ graph: colorGraph(), values: { color: [r, g, b, 1] } });
      const placed = (x: number, z: number, width: number, height = width) =>
        new Transform({
          position: { x, y: 0, z },
          scale: { x: width, y: height, z: 1 },
        });

      it('leaves out what the opaque items hide, on every backend', async () => {
        const mesh = quad();
        // A wall on the left; behind it, a quad it hides; on the right, a
        // quad nothing hides.
        const wall = {
          mesh,
          material: colored(1, 0, 0),
          transform: placed(-1, 0, 2, 3),
        };
        const hidden = {
          mesh,
          material: colored(0, 1, 0),
          transform: placed(-1, -2, 0.5),
        };
        const seen = {
          mesh,
          material: colored(0, 0, 1),
          transform: placed(1, -2, 0.5),
        };
        const items = [wall, hidden, seen];
        const occlusion = new OcclusionCulling();
        const frame = async () => {
          renderer.render({
            items,
            camera: perspective,
            surface,
            occlusion,
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
          });
          const pixels = await fixture.readPixels();
          return (x: number, y: number) => [
            ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
          ];
        };
        // Frames until the results of a test arrive and apply.
        const settle = async (done: () => boolean) => {
          for (let i = 0; i < 20 && !done(); i++) {
            await frame();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return frame();
        };

        let pixel = await settle(() => occlusion.isHidden(hidden));
        expect(renderer.stats.get('scene')).toMatchObject({
          visible: 2,
          occluded: 1,
        });
        expect(occlusion.isHidden(wall)).toBe(false);
        expect(occlusion.isHidden(seen)).toBe(false);
        // The image is the same: the wall where the hidden quad is.
        expectColor(pixel(24, 32), [255, 0, 0, 255]);
        expectColor(pixel(40, 32), [0, 0, 255, 255]);

        // The wall out of view: the quad is drawn again.
        wall.transform.position = { x: -20 };
        pixel = await settle(() => !occlusion.isHidden(hidden));
        expect(renderer.stats.get('scene')).toMatchObject({
          visible: 2,
          occluded: 0,
        });
        expectColor(pixel(24, 32), [0, 255, 0, 255]);
        occlusion.destroy();
      });
    });

    describe('tessellation', () => {
      // The grid of patches in XZ turned to face the camera: (x, 0, z) →
      // (x, -z, 0); v points down, as in images.
      const facing = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
      const heightMap = (width: number, at: (x: number) => number) =>
        backend.textures.createTexture({
          type: '2d',
          format: 'rgba8unorm',
          dimensions: { width, height: width },
          source: new Uint8Array(
            Array.from({ length: width * width }, (_, i) => {
              const h = Math.round(at(i) * 255);
              return [h, h, h, 255];
            }).flat(),
          ),
        });
      const linear = () =>
        backend.textures.createSampler({
          minFilter: 'linear',
          magFilter: 'linear',
          mipmapFilter: 'nearest',
          wrapModeS: 'clamp-to-edge',
          wrapModeT: 'clamp-to-edge',
        });

      it('generates the vertices of the patches from their index', async () => {
        // The uv as a color: each point where it belongs.
        const g = new GraphBuilder('patch uv');
        const vertex = patchVertex(g);
        g.surface({
          baseColor: g.call(std.vec3, {
            x: vertex.uv.swizzle('x'),
            y: vertex.uv.swizzle('y'),
            z: 0,
          }),
        });
        const material = new Material({ graph: g.build() });
        const terrain = new PatchSurface(backend, {
          patches: patchGrid({ width: 2, depth: 2, columns: 2, rows: 2 }),
          material,
          matrix: facing,
          minLevel: 3,
        });
        terrain.update(camera, { width: size, height: size });
        expect(terrain.stats.drawn).toBe(4);
        const pixel = await render([terrain]);
        for (const [x, y] of [
          [8, 8],
          [40, 16],
          [16, 56],
          [60, 44],
        ]) {
          const [r, gr, b] = pixel(x, y);
          expect(Math.abs(r - ((x + 0.5) / size) * 255)).toBeLessThan(3);
          expect(Math.abs(gr - ((y + 0.5) / size) * 255)).toBeLessThan(3);
          expect(b).toBe(0);
        }
        terrain.destroy();
      });

      it('displaces the patches at their levels, without crack', async () => {
        // Rough ground seen from above at an angle: every pixel is ground.
        // Without the points of the edges moved to the grid of their level,
        // the sky shows between the patches of different levels here.
        const g = new GraphBuilder('rough');
        patchVertex(g, {
          displacement: {
            texture: g.texture('heightMap'),
            sampler: g.sampler('heightSampler'),
            scale: 1.5,
            texel: 1 / 64,
          },
        });
        g.surface({ baseColor: [1, 1, 1] });
        let seed = 7;
        const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const material = new Material({
          graph: g.build(),
          values: {
            heightMap: heightMap(64, () => random()),
            heightSampler: linear(),
          },
        });
        const terrain = new PatchSurface(backend, {
          patches: patchGrid({ width: 40, depth: 40, columns: 10, rows: 10 }),
          material,
          edgePixels: 8,
          displacement: 1.5,
        });
        const above = new Camera({
          position: { x: 0, y: 12, z: 12 },
          // 45° down.
          rotation: {
            x: -Math.sin(Math.PI / 8),
            y: 0,
            z: 0,
            w: Math.cos(Math.PI / 8),
          },
          projection: {
            type: 'perspective',
            fov: 40,
            aspect: 1,
            near: 0.1,
            far: 100,
          },
        });
        terrain.update(above, { width: size, height: size });
        // Several levels, some patches out of view.
        expect(
          terrain.stats.levels.filter((n) => n > 0).length,
        ).toBeGreaterThan(1);
        expect(terrain.stats.drawn).toBeLessThan(100);
        renderer.render({
          items: [terrain],
          camera: above,
          surface,
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
        });
        const pixels = await fixture.readPixels();
        let holes = 0;
        for (let i = 0; i < size * size; i++) {
          if (pixels[i * 4] < 128) {
            holes++;
          }
        }
        expect(holes).toBe(0);
        terrain.destroy();
      });

      it('computes the normal of the displaced surface', async () => {
        // A ramp: the height goes from 0 to 1 along u, 2 units wide, scaled
        // by 2: a slope of 1, the normal (-1, 1, 0) / √2 in the grid.
        const g = new GraphBuilder('ramp');
        const vertex = patchVertex(g, {
          displacement: {
            texture: g.texture('heightMap'),
            sampler: g.sampler('heightSampler'),
            scale: 2,
            texel: 1 / 64,
          },
        });
        g.surface({
          baseColor: g.call(std.add, {
            a: g.call(std.mul, { a: vertex.normal, b: 0.5 }),
            b: 0.5,
          }),
        });
        const material = new Material({
          graph: g.build(),
          values: {
            heightMap: heightMap(64, (i) => (i % 64) / 63),
            heightSampler: linear(),
          },
        });
        const terrain = new PatchSurface(backend, {
          patches: patchGrid({ width: 2, depth: 2, columns: 2, rows: 2 }),
          material,
          matrix: facing,
          displacement: 2,
        });
        terrain.update(camera, { width: size, height: size });
        const pixel = await render([terrain]);
        const half = Math.SQRT1_2 * 0.5;
        const expected = [0.5 - half, 0.5 + half, 0.5].map((c) => c * 255);
        pixel(32, 32)
          .slice(0, 3)
          .forEach((c, i) => expect(Math.abs(c - expected[i])).toBeLessThan(6));
        terrain.destroy();
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
        values: ConstructorParameters<typeof Material>[0]['values'] = {},
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

      it('computes the functions of screen-uv per pixel', async () => {
        // The distance to the center: not linear in the uv, wrong if it
        // were interpolated from the vertices of the triangle.
        drawFullscreen(renderer, (g) => {
          const distance = g.call(std.length, {
            x: g.call(std.sub, { a: g.builtin('screen-uv'), b: 0.5 }),
          });
          g.fullscreen({
            color: g.call(std.vec4, { x: distance, w: 1 }),
          });
        });
        const pixel = await pixelsOf();
        const at = (x: number, y: number) => {
          const u = (x + 0.5) / size - 0.5;
          const v = (y + 0.5) / size - 0.5;
          return [Math.round(Math.hypot(u, v) * 255), 0, 0, 255];
        };
        for (const [x, y] of [
          [32, 32],
          [0, 0],
          [63, 10],
          [20, 50],
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
          inputs: { source: scene.color },
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

      it('reads texels and depths by their coordinates, rows from the top', async () => {
        // 0.25, 0.5 / 0.75, 1 in a texture that cannot be filtered.
        const values = backend.textures.createTexture({
          type: '2d',
          format: 'r32float',
          dimensions: { width: 2, height: 2 },
          source: new Float32Array([0.25, 0.5, 0.75, 1]),
        });
        const g = new GraphBuilder('loads');
        const uv = g.builtin('screen-uv');
        const texel = g.call(std.textureLoad, {
          texture: g.texture('values', { sampleType: 'unfilterable-float' }),
          coords: g.call(
            std.convert,
            { value: g.call(std.mul, { a: uv, b: 2 }) },
            { params: { to: BuiltinTypes.vec2i } },
          ),
        });
        // The depth of the scene, × 10 (0.049 where the quad is, 1 elsewhere).
        const depth = g.call(std.textureLoadDepth, {
          texture: g.texture('depth', { sampleType: 'depth' }),
          coords: g.call(
            std.convert,
            { value: g.call(std.mul, { a: uv, b: size }) },
            { params: { to: BuiltinTypes.vec2i } },
          ),
        });
        g.fullscreen({
          color: g.call(std.vec4, {
            x: g.call(std.saturate, {
              x: g.call(std.mul, { a: depth, b: 10 }),
            }),
            y: texel.swizzle('r'),
            w: 1,
          }),
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
        });
        renderer.addFullscreenPass(graph, 'loads', {
          material: new Material({ graph: g.build(), values: { values } }),
          inputs: { depth: scene.depth },
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        runner.execute(graph);
        runner.destroy();
        const pixel = await pixelsOf();
        // The quad 5 units away, between the planes at 0.1 and 100.
        const quadDepth = Math.round(((5 - 0.1) / 99.9) * 10 * 255);
        expectColor(pixel(16, 24), [quadDepth, 64, 0, 255]);
        expectColor(pixel(48, 24), [255, 128, 0, 255]);
        expectColor(pixel(16, 40), [quadDepth, 191, 0, 255]);
        expectColor(pixel(48, 40), [255, 255, 0, 255]);
        values.destroy();
      });

      it('computes the levels of the textures rendered in the graph', async () => {
        // The last level (1×1) of the scene: the average of its pixels.
        const g = new GraphBuilder('average');
        const texel = g.call(std.textureSampleLevel, {
          texture: g.texture('source'),
          sampler: g.sampler('sourceSampler'),
          uv: g.builtin('screen-uv'),
          level: g.uniform('level', BuiltinTypes.f32, { default: 0 }),
        });
        g.fullscreen({
          color: g.call(std.extend, { xyz: texel.swizzle('rgb'), w: 1 }),
        });
        const average = new Material({
          graph: g.build(),
          values: {
            sourceSampler: backend.textures.createSampler({
              minFilter: 'nearest',
              magFilter: 'nearest',
              mipmapFilter: 'nearest',
            }),
            level: Math.log2(size),
          },
        });
        const runner = new RenderGraphRunner(backend);
        const graph = new RenderGraph();
        // A red quad over a quarter of the frame.
        const scene = renderer.addScenePasses(graph, {
          items: [
            {
              mesh: quad(),
              material: new Material({ graph: colorGraph() }),
              transform: at(-0.5),
            },
          ],
          camera,
          target: graph.createTexture('scene', {
            format: 'rgba8unorm',
            mipLevelCount: 'full',
          }),
          format: 'rgba8unorm',
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
        });
        renderer.addFullscreenPass(graph, 'average', {
          material: average,
          inputs: { source: graph.addMipmapPass('scene mipmaps', scene.color) },
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        runner.execute(graph);
        runner.destroy();
        const pixel = await pixelsOf();
        expectColor(pixel(32, 32), [64, 0, 0, 255]);
      });

      it('measures the GPU time of the passes, where the backend can', async (context) => {
        const probe = backend.createPassTimer?.(1);
        if (!probe) {
          context.skip();
          return;
        }
        probe.destroy();
        const runner = new RenderGraphRunner(backend, { timing: true });
        const items = [
          {
            mesh: quad(),
            material: new Material({ graph: colorGraph() }),
            transform: at(0),
          },
        ];
        // The measures arrive a few frames late.
        let times = runner.passTimes;
        for (let frame = 0; frame < 20 && times.size === 0; frame++) {
          const graph = new RenderGraph();
          renderer.addScenePasses(graph, {
            items,
            camera,
            target: graph.importTexture('surface', surface.getCurrentTarget()),
            format: surface.format,
          });
          runner.execute(graph);
          // Waits for the GPU.
          await fixture.readPixels();
          await new Promise((resolve) => setTimeout(resolve, 10));
          times = runner.passTimes;
        }
        runner.destroy();
        expect(times.size).toBeGreaterThan(0);
        for (const [name, milliseconds] of times) {
          expect(name).not.toBe('');
          expect(milliseconds).toBeGreaterThanOrEqual(0);
          expect(milliseconds).toBeLessThan(1000);
        }
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
              0.8,
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
              'rgba16float',
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
          using,
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
              ].flatMap(([x, y]) => [x * half, y * half, z, 0, 0, 1]),
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

      it('draws the shadows of the casters out of view that fall in it', async () => {
        // The camera at z = 5 sees from z = 4.9 down. A blocker behind it,
        // at z = 6, shadows the center of the ground; another one, out of
        // the view on the side, shadows nothing the camera sees.
        const items = [
          { mesh: square(1, 0), material: white(), transform: at(0) },
          { mesh: square(0.25, 6), material: white(), transform: at(0) },
          { mesh: square(0.25, 0.5), material: white(), transform: at(5) },
        ];
        const pixel = await render(items, 0, [sun({ x: 0, y: 0, z: -1 })]);
        // Lit straight on: 1 + ambient, saturated.
        expectColor(pixel(32, 32), shadowed);
        expectColor(pixel(8, 8), gray(1));
        // The ground only is visible; the ground and the blocker above it
        // are drawn into the shadow map, not the one on the side.
        expect(renderer.stats.get('scene')).toEqual(
          expect.objectContaining({ visible: 1, shadowMaps: 1, casters: 2 }),
        );
      });

      it('leaves out the lights that cannot reach the view', async () => {
        const lamp = (x: number) =>
          new PointLight({
            position: { x, y: 0, z: 1 },
            ambient: { x: 0, y: 0, z: 0 },
            diffuse: { x: 1, y: 1, z: 1 },
            specular: { x: 0, y: 0, z: 0 },
            quadraticAttenuation: 1,
          });
        // Reaches 16 units: the one at x = 30 lights nothing visible.
        const pixel = await render(scene(5, 5), 0, [lamp(0), lamp(30)]);
        expect(renderer.stats.get('scene')?.lights).toBe(1);
        // Above the center, 1 away: N·L = 1, attenuation 1 / (1 + 1).
        expectColor(pixel(32, 32), gray(0.5));
      });

      // Deferred rendering: the scene passes write a G-buffer (the base
      // color, the normal, the depth), a full screen pass lights it with the
      // shading model of the materials. The same image as the forward one.
      const deferred = async (
        items: RenderItem[],
        lights: BaseLight[],
        view: Camera = camera,
      ) => {
        // Black first: a failed frame does not leave the forward one.
        await render([]);
        const f = new GraphBuilder('geometry');
        f.functionOutput(
          'value',
          f.call(std.extend, {
            xyz: f.functionInput('worldNormal', BuiltinTypes.vec3f),
            w: f.functionInput('viewDepth', BuiltinTypes.f32),
          }),
        );
        const geometry = defineFunction(f.build(), { id: 'test.geometry' });
        const g = new GraphBuilder('deferred lighting');
        const uv = g.builtin('screen-uv');
        const read = (name: string) =>
          g.call(std.textureSample, {
            texture: g.texture(name),
            sampler: g.sampler(`${name}Sampler`),
            uv,
          });
        const normalDepth = read('geometry');
        const position = g.call('camera.positionFromDepth', {
          uv,
          viewDepth: normalDepth.swizzle('w'),
        });
        g.fullscreen({
          color: g.call('lighting.phong', {
            baseColor: read('baseColor').swizzle('rgb'),
            normal: normalDepth.swizzle('xyz'),
            worldPosition: g.call(std.extend, { xyz: position, w: 1 }),
            specular: [0, 0, 0],
          }),
        });
        const nearest = backend.textures.createSampler({
          minFilter: 'nearest',
          magFilter: 'nearest',
          mipmapFilter: 'nearest',
        });
        const lighting = new Material({
          graph: g.build(),
          values: { geometrySampler: nearest, baseColorSampler: nearest },
        });
        const graph = new RenderGraph();
        const scene = renderer.addScenePasses(graph, {
          items,
          camera: view,
          lights,
          size: { width: size, height: size },
          include: 'opaque',
          outputs: {
            baseColor: { format: 'rgba8unorm', value: 'base-color' },
            geometry: { format: 'rgba16float', value: geometry },
          },
        });
        renderer.addFullscreenPass(graph, 'lighting', {
          material: lighting,
          inputs: {
            geometry: scene.outputs.geometry,
            baseColor: scene.outputs.baseColor,
          },
          ...(scene.shadows ? { shadows: scene.shadows } : {}),
          target: graph.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(graph);
        runner.destroy();
        const pixels = await fixture.readPixels();
        return (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
      };
      // Same pixels, within two units, where there is something.
      const samePixels = (
        forward: (x: number, y: number) => number[],
        lighted: (x: number, y: number) => number[],
      ) => {
        for (let y = 2; y < size; y += 5) {
          for (let x = 2; x < size; x += 5) {
            const [a, b] = [forward(x, y), lighted(x, y)];
            expect(
              a.slice(0, 3).every((c, i) => Math.abs(c - b[i]) <= 2),
              `(${x}, ${y}): forward ${a}, deferred ${b}`,
            ).toBe(true);
          }
        }
      };

      it('lights a G-buffer in a full screen pass, shadows included', async () => {
        const items = scene(-0.5, 0);
        const lights = [sun({ x: 1, y: 0, z: -1 })];
        const forward = await render(items, 0, lights);
        const pixel = await deferred(items, lights);
        // The shadow, and the light around it.
        expectColor(pixel(32, 32), shadowed);
        expectColor(pixel(48, 32), lit);
        samePixels(forward, pixel);
      });

      it('rebuilds the positions of a perspective view for point lights', async () => {
        const perspective = new Camera({
          position: { x: 0.3, y: 0.2, z: 3 },
          projection: {
            type: 'perspective',
            fov: 45,
            aspect: 1,
            near: 0.1,
            far: 100,
          },
        });
        const items = scene(0.3, 0.3, false);
        const lights = [
          new PointLight({
            position: { x: -0.4, y: 0.2, z: 1 },
            ambient: { x: 0.05, y: 0.05, z: 0.05 },
            diffuse: { x: 1, y: 1, z: 1 },
            specular: { x: 0, y: 0, z: 0 },
            linearAttenuation: 0.2,
            quadraticAttenuation: 0.5,
          }),
        ];
        renderer.render({
          items,
          camera: perspective,
          surface,
          lights,
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
        });
        const pixels = await fixture.readPixels();
        const forward = (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
        samePixels(forward, await deferred(items, lights, perspective));
      });
    });

    describe('surface details', () => {
      // A 2 × 2 quad facing the camera, covering the view, with normals and
      // uvs (u along +x, v along -y: v points down, as in images).
      const lit = (withTangents = false) => {
        const mesh = new Mesh({
          description: {
            vertexBuffers: [
              {
                stride: 32,
                stepMode: 'vertex',
                attributes: [
                  { semantic: 'position', format: 'float32x3', offset: 0 },
                  { semantic: 'normal', format: 'float32x3', offset: 12 },
                  { semantic: 'uv', format: 'float32x2', offset: 24 },
                ],
              },
            ],
            vertexCount: 4,
            indexBuffer: { format: 'uint16', count: 6 },
          },
          vertices: [
            new Float32Array(
              [
                [-1, -1, 0, 1],
                [1, -1, 1, 1],
                [1, 1, 1, 0],
                [-1, 1, 0, 0],
              ].flatMap(([x, y, u, v]) => [x, y, 0, 0, 0, 1, u, v]),
            ),
          ],
          indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        });
        return withTangents ? computeTangents(mesh) : mesh;
      };
      // The world normal of the surface, from [-1, 1] to [0, 255].
      const f = new GraphBuilder('encode normal');
      f.functionOutput(
        'value',
        f.call(std.extend, {
          xyz: f.call(std.add, {
            a: f.call(std.mul, {
              a: f.functionInput('worldNormal', BuiltinTypes.vec3f),
              b: 0.5,
            }),
            b: 0.5,
          }),
        }),
      );
      const encodeNormal = defineFunction(f.build(), {
        id: 'test.encodeNormal',
      });
      const normalAt = async (graph: GraphBuilder, mesh = lit()) => {
        const frame = new RenderGraph();
        renderer.addScenePasses(frame, {
          items: [
            {
              mesh,
              material: new Material({ graph: graph.build() }),
              transform: at(0),
            },
          ],
          camera,
          outputs: {
            normal: {
              format: 'rgba8unorm',
              value: encodeNormal,
              target: frame.importTexture(
                'surface',
                surface.getCurrentTarget(),
              ),
            },
          },
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(frame);
        runner.destroy();
        const pixels = await fixture.readPixels();
        return (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
      };

      it('gives the derivatives along x right and y down on every backend', async () => {
        const g = new GraphBuilder('derivatives');
        const uv = g.builtin('screen-uv');
        // One pixel is 1 / size of the uv: × size, 1.
        g.fullscreen({
          color: g.call(std.vec4, {
            x: g.call(std.mul, {
              a: g.call(std.dpdx, { x: uv.swizzle('x') }),
              b: size,
            }),
            y: g.call(std.mul, {
              a: g.call(std.dpdy, { x: uv.swizzle('y') }),
              b: size,
            }),
            z: g.call(std.mul, {
              a: g.call(std.fwidth, { x: uv.swizzle('x') }),
              b: size * 0.5,
            }),
            w: 1,
          }),
        });
        const frame = new RenderGraph();
        renderer.addFullscreenPass(frame, 'derivatives', {
          material: new Material({ graph: g.build() }),
          target: frame.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(frame);
        runner.destroy();
        const pixels = await fixture.readPixels();
        const at = (17 * size + 23) * 4;
        expectColor([...pixels.subarray(at, at + 4)], [255, 255, 128, 255]);
      });

      it('tilts the normal by the slope of a height', async () => {
        // The height grows by 1 from x = -1 to 1: a slope of 0.5, × 2.
        const g = new GraphBuilder('bumped');
        g.surface({
          shadingModel: 'phong',
          normal: g.call(stdMacros.bumpMapping, {
            height: g.attribute('uv', BuiltinTypes.vec2f).swizzle('x'),
            scale: 2,
          }),
        });
        const pixel = await normalAt(g);
        // normalize(-1, 0, 1).
        const encoded = (n: number) => Math.round((n * 0.5 + 0.5) * 255);
        expectColor(pixel(20, 40), [
          encoded(-Math.SQRT1_2),
          128,
          encoded(Math.SQRT1_2),
          255,
        ]);
      });

      for (const withTangents of [false, true]) {
        it(`maps the normals ${
          withTangents ? 'with the tangents of the mesh' : 'without tangents'
        }`, async () => {
          const mapped = (sample: number[]) => {
            const g = new GraphBuilder('normal mapped');
            g.surface({
              shadingModel: 'phong',
              normal: g.call(stdMacros.normalMapping, { sample }),
            });
            return g;
          };
          // (0.6, 0, 0.8) in the tangent frame: along +u, then up in the
          // image (green), which is +y here.
          let pixel = await normalAt(
            mapped([0.8, 0.5, 0.9]),
            lit(withTangents),
          );
          expectColor(pixel(40, 20), [204, 128, 230, 255]);
          pixel = await normalAt(mapped([0.5, 0.8, 0.9]), lit(withTangents));
          expectColor(pixel(40, 20), [128, 204, 230, 255]);
        });
      }
    });

    describe('cube textures', () => {
      it('samples the faces of a cube texture in their directions', async () => {
        // 1 × 1 faces: +x red, -x green, +y blue, -y yellow, +z magenta,
        // -z cyan.
        const colors = [
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
          [255, 255, 0, 255],
          [255, 0, 255, 255],
          [0, 255, 255, 255],
        ];
        const environment = backend.textures.createTexture({
          type: 'cube',
          format: 'rgba8unorm',
          dimensions: { width: 1, height: 1, layers: 6 },
          source: new Uint8Array(colors.flat()),
        });
        const directions = [
          [1, 0.2, -0.1],
          [-1, 0.1, 0.2],
          [0.1, 1, 0.2],
          [-0.2, -1, 0.1],
          [0.2, -0.1, 1],
          [0.1, 0.2, -1],
        ];
        // Six columns, each sampling a direction; the last one at an
        // explicit level.
        const g = new GraphBuilder('cube');
        const column = g.call(std.floor, {
          x: g.call(std.mul, {
            a: g.builtin('screen-uv').swizzle('x'),
            b: 6,
          }),
        });
        let direction = g.constant(BuiltinTypes.vec3f, directions[0]);
        directions.slice(1).forEach((value, i) => {
          direction = g.call(std.select, {
            ifFalse: direction,
            ifTrue: g.constant(BuiltinTypes.vec3f, value),
            condition: g.call(std.greater, { a: column, b: i + 0.5 }),
          });
        });
        const texture = g.texture('environment', { dimension: 'cube' });
        const sampler = g.sampler('environmentSampler');
        g.fullscreen({
          color: g.call(std.select, {
            ifFalse: g.call(std.textureSampleCube, {
              texture,
              sampler,
              direction,
            }),
            ifTrue: g.call(std.textureSampleCubeLevel, {
              texture,
              sampler,
              direction,
              level: 0,
            }),
            condition: g.call(std.greater, { a: column, b: 4.5 }),
          }),
        });
        const frame = new RenderGraph();
        renderer.addFullscreenPass(frame, 'cube', {
          material: new Material({
            graph: g.build(),
            values: {
              environment,
              environmentSampler: backend.textures.createSampler({
                minFilter: 'nearest',
                magFilter: 'nearest',
                mipmapFilter: 'nearest',
              }),
            },
          }),
          target: frame.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(frame);
        runner.destroy();
        const pixels = await fixture.readPixels();
        colors.forEach((color, i) => {
          const x = Math.floor(((i + 0.5) / 6) * size);
          const at = (32 * size + x) * 4;
          expectColor([...pixels.subarray(at, at + 4)], color);
        });
      });
    });

    describe('scene inputs', () => {
      it('binds the textures of the graph to the materials of the scene', async () => {
        // A full screen pass fills a texture; a quad samples it.
        const fill = new GraphBuilder('fill');
        fill.fullscreen({ color: [0, 1, 0, 1] });
        const g = new GraphBuilder('reads the graph');
        g.surface({
          baseColor: g
            .call(std.textureSample, {
              texture: g.texture('rendered'),
              sampler: g.sampler('renderedSampler'),
              uv: g.attribute('uv', BuiltinTypes.vec2f),
            })
            .swizzle('rgb'),
        });
        const material = new Material({
          graph: g.build(),
          values: { renderedSampler: backend.textures.createSampler({}) },
        });
        const frame = new RenderGraph();
        const rendered = renderer.addFullscreenPass(frame, 'fill', {
          material: new Material({ graph: fill.build() }),
          target: frame.createTexture('rendered', {
            format: 'rgba8unorm',
            size: { width: 4, height: 4 },
          }),
          format: 'rgba8unorm',
        });
        renderer.addScenePasses(frame, {
          items: [{ mesh: quad(), material, transform: at(-0.5) }],
          camera,
          inputs: { rendered },
          target: frame.importTexture('surface', surface.getCurrentTarget()),
          format: surface.format,
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
        });
        const runner = new RenderGraphRunner(backend);
        runner.execute(frame);
        runner.destroy();
        const pixels = await fixture.readPixels();
        const at16 = (32 * size + 16) * 4;
        expectColor([...pixels.subarray(at16, at16 + 4)], [0, 255, 0, 255]);
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
          [...values].map((value) => value * 2.5),
        );
        runner.destroy();
      });

      it('dispatches as many workgroups as a buffer says', async () => {
        if (backend.capabilities?.compute === false) {
          return;
        }
        // 2 workgroups of 64: the first 128 values, not the next ones.
        const values = Float32Array.from({ length: 200 }, (_, i) => i);
        const input = backend.buffers.create({
          size: values.byteLength,
          usage: ['storage', 'copy-dst'],
          initialData: values,
        });
        const output = backend.buffers.create({
          size: values.byteLength,
          usage: ['storage', 'copy-src', 'copy-dst'],
        });
        const counts = backend.buffers.create({
          size: 16,
          usage: ['indirect', 'copy-dst'],
          // Offset 4: x, y, z.
          initialData: new Uint32Array([0, 2, 1, 1]),
        });
        const runner = new ComputeRunner(backend);
        runner.dispatch(
          compile(scaleGraph(), { capabilities: backend.capabilities }),
          {
            values: { input, output, factor: 2 },
            workgroups: { buffer: counts, offset: 4 },
          },
        );
        const result = new Float32Array(await output.read());
        expect(result[0]).toBe(0);
        expect(result[127]).toBe(254);
        expect(result[128]).toBe(0);
        runner.destroy();
        input.destroy();
        output.destroy();
        counts.destroy();
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
              { params: { to: BuiltinTypes.vec2f } },
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
          i % 4 === 3 ? 255 : (i * 37) % 256,
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
            5,
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

    describe('skinning', () => {
      // A strip of 2 quads along y, from -0.9 to 0.9: its bottom row on the
      // root joint, its top row on the tip, the middle one on both. The
      // joints at the origin, without inverse bind matrices.
      const strip = () => {
        const stride = 32;
        const data = new ArrayBuffer(stride * 6);
        const view = new DataView(data);
        [-0.9, 0, 0.9].forEach((y, row) => {
          [-0.2, 0.2].forEach((x, column) => {
            const o = (row * 2 + column) * stride;
            view.setFloat32(o, x, true);
            view.setFloat32(o + 4, y, true);
            view.setUint8(o + 12, row === 2 ? 1 : 0);
            view.setUint8(o + 13, 1);
            view.setFloat32(o + 16, row === 1 ? 0.5 : 1, true);
            view.setFloat32(o + 20, row === 1 ? 0.5 : 0, true);
          });
        });
        return new Mesh({
          description: {
            vertexCount: 6,
            vertexBuffers: [
              {
                stride,
                stepMode: 'vertex',
                attributes: [
                  { semantic: 'position', format: 'float32x3', offset: 0 },
                  { semantic: 'joints', format: 'uint8x4', offset: 12 },
                  { semantic: 'weights', format: 'float32x4', offset: 16 },
                ],
              },
            ],
            indexBuffer: { format: 'uint16', count: 12 },
          },
          vertices: [new Uint8Array(data)],
          indices: new Uint16Array([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4]),
        });
      };
      // The tip 0.5 to the right: the top row moves by 0.5, the middle one
      // by 0.25.
      const bent = (mode: 'vertex' | 'compute') => {
        const mesh = strip();
        const material = new Material({ graph: colorGraph() });
        const model = new Model(
          {
            nodes: [
              { name: 'Body', children: [], mesh: 0, skin: 0 },
              { name: 'root', children: [2] },
              { name: 'tip', children: [] },
            ],
            roots: [0, 1],
            meshes: [{ primitives: [{ mesh: 'strip', material: 'red' }] }],
            skins: [{ joints: [1, 2] }],
            animations: [],
            cameras: [],
            lights: [],
          },
          [[{ mesh, material }]],
        );
        const scene = new Scene();
        const skinning = new Skinning(
          backend,
          instantiate(model, scene),
          model,
          {
            mode,
          },
        );
        const pose = skinning.skeleton.rest.clone();
        pose.translations.set(
          [0.5, 0, 0],
          skinning.skeleton.require('tip') * 3,
        );
        skinning.applyPose(pose).update();
        return { scene, skinning, mesh };
      };
      const modes = (): ('vertex' | 'compute')[] =>
        defaultSkinningMode(backend) === 'compute'
          ? ['vertex', 'compute']
          : ['vertex'];

      it('skins in a compute pass the vertices the CPU skins', async () => {
        if (defaultSkinningMode(backend) !== 'compute') {
          return;
        }
        const { skinning, mesh } = bent('compute');
        const vertices = skinning.primitives[0].vertices as GpuBuffer;
        const skinned = new Float32Array(await vertices.read());
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const expected = skinPositions(MeshSkin.of(mesh), [
          ...identity,
          ...identity.slice(0, 12),
          0.5,
          0,
          0,
          1,
        ]);
        for (let v = 0; v < 6; v++) {
          for (let k = 0; k < 3; k++) {
            expect(skinned[v * 4 + k]).toBeCloseTo(expected[v * 3 + k], 5);
          }
          expect(skinned[v * 4 + 3]).toBe(1);
        }
        skinning.destroy();
      });

      it('draws the skinned vertices, in each mode of the backend', async () => {
        for (const mode of modes()) {
          const { scene, skinning } = bent(mode);
          renderer.render({
            source: scene,
            camera,
            surface,
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
          });
          const pixels = await fixture.readPixels();
          const pixel = (x: number, y: number) => {
            // From the view [-1, 1]² to the pixels, y down.
            const px = Math.floor(((x + 1) / 2) * size);
            const py = Math.floor(((1 - y) / 2) * size);
            return [
              ...pixels.subarray(
                (py * size + px) * 4,
                (py * size + px) * 4 + 4,
              ),
            ];
          };
          // The top moved right, the bottom stayed.
          expectColor(pixel(0.45, 0.8), [255, 0, 0, 255]);
          expectColor(pixel(-0.15, 0.8), [0, 0, 0, 255]);
          expectColor(pixel(-0.15, -0.8), [255, 0, 0, 255]);
          expectColor(pixel(0.1, 0), [255, 0, 0, 255]);
          skinning.destroy();
        }
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
        values: Record<string, never> = {},
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
          exposure,
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
              exposure,
            ),
            [v, v, v, 255],
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
          [light],
        );
        for (const [x, y] of pixels) {
          expectColor(
            pixel(x, y),
            phongReference(x, y, {
              position: [0.6, 0, 0.8],
              w: 0,
              ambient: [0.1, 0.1, 0.1],
              attenuation: [1, 0, 0],
            }),
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
          [light],
        );
        for (const [x, y] of pixels) {
          expectColor(
            pixel(x, y),
            phongReference(x, y, {
              position: [0.3, -0.2, 1],
              w: 1,
              ambient: [0.05, 0.05, 0.05],
              attenuation: [1, 0.2, 0.5],
            }),
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
          lights,
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
              },
            ),
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
          (c) => 0.04 + (c - 0.04) * material.metallic,
        );
        const diffuseColor = material.baseColor.map(
          (c) => c * (1 - material.metallic),
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
            lights,
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
                {
                  position: [-0.3, 0.4, 1.5],
                  w: 1,
                  ambient: 0,
                  intensity: 0.4,
                },
              ),
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
            { params: { feature: 'warm' } },
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
          [0, 0, 0, 255],
        );
        await asyncRenderer.whenReady();
        expectColor(
          (await render(items, 0, [], asyncRenderer))(32, 32),
          [255, 0, 0, 255],
        );
        asyncRenderer.destroy();
      });
    });
  });
}
