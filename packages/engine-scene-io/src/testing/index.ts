import {
  installAssets,
  MaterialDataType,
  MeshDataType,
  ModelDataType,
  singleMeshModel,
  type ImageCodec,
  type MaterialData,
  type MeshData,
  type ModelData,
} from '@fdw/engine-assets';
import { Mesh } from '@fdw/engine-core';
import { fakeBackend } from '@fdw/engine-core/testing';
import {
  MemorySource,
  ResourceStore,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';

// What the tests of scene-io share: a store over memory files, a codec of
// single color images, a format of small models, meshes and materials
// made in code.

/** "img W H R G B A" files, a single color. */
export const testImageCodec: ImageCodec = {
  name: 'test',
  sniff: (head) => new TextDecoder().decode(head.subarray(0, 4)) === 'img ',
  async decode(bytes) {
    const [, w, h, ...rgba] = new TextDecoder()
      .decode(bytes)
      .split(' ')
      .map(Number);
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) pixels.set(rgba, i * 4);
    return {
      type: '2d',
      width: w,
      height: h,
      format: 'rgba8unorm',
      levels: [pixels],
    };
  },
};

/** A triangle: positions, normals, uv. */
export const triangleData = (name = 'triangle', y = 1): MeshData => ({
  name,
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
    vertexCount: 3,
    indexBuffer: { format: 'uint16', count: 3 },
  },
  vertices: [
    new Float32Array([
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      1,
      0,
      0,
      y,
      0,
      0,
      0,
      1,
      0,
      1,
    ]),
  ],
  indices: new Uint16Array([0, 1, 2]),
});

export const triangle = (name?: string, y?: number): Mesh => {
  const data = triangleData(name, y);
  return new Mesh({ ...data, label: data.name });
};

/**
 * "model" files: JSON `{ nodes: [{ name, children?, mesh? }], roots }`,
 * each mesh a triangle of a material `{ color }`.
 */
export const testModelFormat: ResourceLoader<ModelData> = {
  type: ModelDataType,
  extensions: ['model'],
  async load(ctx) {
    const file = JSON.parse(await ctx.text()) as {
      name: string;
      nodes: {
        name?: string;
        children?: number[];
        mesh?: number;
        translation?: [number, number, number];
      }[];
      roots: number[];
      meshes: { color: number[]; primitives?: number }[];
    };
    const meshes = file.meshes.map((mesh, m) => {
      const count = mesh.primitives ?? 1;
      const material: MaterialData = {
        kind: 'pbr',
        baseColor: mesh.color as [number, number, number, number],
        metallic: 0,
        roughness: 1,
        emissive: [0, 0, 0],
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
      };
      ctx.provide(MaterialDataType, `material/${m}`, material);
      return {
        primitives: Array.from({ length: count }, (_, p) => {
          ctx.provide(MeshDataType, `mesh/${m}/${p}`, triangleData(`m${m}`, p));
          return { mesh: `mesh/${m}/${p}`, material: `material/${m}` };
        }),
      };
    });
    if (file.nodes.length === 0) {
      return singleMeshModel(file.name, meshes[0].primitives);
    }
    return {
      name: file.name,
      nodes: file.nodes.map((n) => ({
        name: n.name,
        translation: n.translation,
        children: n.children ?? [],
        mesh: n.mesh,
      })),
      roots: file.roots,
      meshes,
      skins: [],
      animations: [],
      cameras: [],
      lights: [],
    };
  },
};

/** A store over memory files, with the assets of a fake backend and the test formats. */
export function testStore(files: Record<string, string | Uint8Array> = {}) {
  const { backend } = fakeBackend();
  const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
  const mem = new MemorySource(files);
  store.mount('mem', mem, { default: true });
  const warnings: string[] = [];
  installAssets(store, {
    backend,
    codecs: [testImageCodec],
    warn: (m) => void warnings.push(m),
  });
  store.registerLoader(testModelFormat);
  return { store, mem, backend, warnings };
}

/** A material graph of a texture tinted by a color, with its sampler. */
export function tintedGraph() {
  const g = new GraphBuilder('tinted');
  const tint = g.uniform('tint', BuiltinTypes.vec3f, { default: [1, 1, 1] });
  const texel = g.call(std.textureSample, {
    texture: g.texture('color'),
    sampler: g.sampler('colorSampler'),
    uv: g.attribute('uv', BuiltinTypes.vec2f),
  });
  g.surface({
    shadingModel: 'unlit',
    baseColor: g.call(std.mul, { a: texel.swizzle('rgb'), b: tint }),
  });
  return g.build();
}
