import type { RenderBackend, Surface } from '@fdw/engine-backend';
import {
  BuiltinTypes,
  defineFunction,
  GraphBuilder,
  std,
  stdMacros,
} from '@fdw/engine-shader';
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
