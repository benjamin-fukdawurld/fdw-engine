import { Camera, Material, Mesh, Renderer } from '@fdw/engine-core';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import {
  MemorySource,
  ResourceStore,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  defaultPbrMaterial,
  MaterialDataType,
  MeshDataType,
  ModelDataType,
  singleMeshModel,
  type MaterialData,
  type MeshData,
  type ModelData,
  type PbrMaterialData,
} from './data';
import { featureKey, materialGraph, uvTransformRows } from './graphs';
import { toHalf } from './image/half';
import { ImageAssetType, type ImageAsset } from './image/ImageAsset';
import { pixelCodec, type ImageCodec } from './image/codecs';
import { TextureType, type Texture } from './image/Texture';
import { installAssets } from './install';
import { instantiate } from './instantiate';
import { MeshType } from './meshes';
import { ModelType, type Model } from './models';
import { RenderBackendService } from './services';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A codec of the tests: "img W H R G B A" files, a single color.
const testCodec: ImageCodec = {
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

const triangleData = (name = 'triangle', y = 1): MeshData => ({
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

/** A format of the tests: "model" files, JSON { material, y } → one triangle. */
const ModelFormat: ResourceLoader<ModelData> = {
  type: ModelDataType,
  async load(ctx) {
    const { material, y } = JSON.parse(await ctx.text()) as {
      material: MaterialData;
      y?: number;
    };
    ctx.provide(MeshDataType, 'mesh/0', triangleData('tri', y));
    ctx.provide(MaterialDataType, 'material/0', material);
    return singleMeshModel('tri', [{ mesh: 'mesh/0', material: 'material/0' }]);
  },
};

function setup(
  files: Record<string, string> = {},
  keepCpuData: 'always' | 'never' = 'never'
) {
  const { backend, log } = fakeBackend();
  const destroyed: unknown[] = [];
  const createTexture = backend.textures.createTexture;
  backend.textures.createTexture = (descriptor) => {
    const texture = createTexture(descriptor);
    return { ...texture, destroy: () => void destroyed.push(texture) };
  };
  const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
  const mem = new MemorySource(files);
  store.mount('mem', mem, { default: true });
  const warnings: string[] = [];
  installAssets(store, {
    backend,
    codecs: [testCodec],
    keepCpuData,
    warn: (m) => void warnings.push(m),
  });
  store.registerLoader(ModelFormat);
  return { store, mem, backend, log, destroyed, warnings };
}

const textured = (
  image: string,
  extra: Partial<PbrMaterialData> = {}
): PbrMaterialData => ({
  ...defaultPbrMaterial,
  baseColorTexture: {
    image,
    texCoord: 0,
    sampler: { wrapModeS: 'repeat', wrapModeT: 'repeat' },
  },
  ...extra,
});

describe('textures', () => {
  it('decodes and uploads an image, in sRGB with mipmaps by default', async () => {
    const { store, log, destroyed } = setup({
      'red.img': 'img 4 4 255 0 0 255',
    });
    const handle = store.load<Texture>(TextureType, 'red.img');
    const texture = await handle.ready;
    expect(texture.colorSpace).toBe('srgb');
    expect(log.textures).toHaveLength(1);
    expect(log.textures[0]).toMatchObject({
      format: 'rgba8unorm-srgb',
      mipLevelCount: 3,
      dimensions: { width: 4, height: 4 },
    });
    handle.release();
    store.trim(0);
    expect(destroyed).toHaveLength(1);
  });

  it('makes one texture per color space, sharing the sampler', async () => {
    const { store, log } = setup({ 'n.img': 'img 2 2 128 128 255 255' });
    const color = await store.load<Texture>(TextureType, 'n.img').ready;
    const data = await store.load(TextureType, 'n.img', {
      options: { colorSpace: 'linear', mips: 'none' },
    }).ready;
    const again = await store.load(TextureType, 'n.img').ready;
    expect(again).toBe(color);
    expect(log.textures.map((t) => [t.format, t.mipLevelCount])).toEqual([
      ['rgba8unorm-srgb', 2],
      ['rgba8unorm', 1],
    ]);
    expect(data.sampler).toBe(color.sampler);
  });

  it('keeps the image on the CPU, shared, with keepCpuData: always', async () => {
    const { store } = setup({ 'n.img': 'img 2 2 1 2 3 4' }, 'always');
    await store.load(TextureType, 'n.img').ready;
    await store.load(TextureType, 'n.img', {
      options: { colorSpace: 'linear' },
    }).ready;
    const image = store.peek<ImageAsset>(ImageAssetType, 'n.img');
    expect(image?.value?.width).toBe(2);
  });

  it('realizes the textures again on another backend', async () => {
    const { store, log } = setup({ 'red.img': 'img 1 1 255 0 0 255' });
    const handle = store.load<Texture>(TextureType, 'red.img');
    const first = await handle.ready;
    const other = fakeBackend();
    store.provideService(RenderBackendService, other.backend);
    await sleep(10);
    store.update();
    expect(handle.value).not.toBe(first);
    expect(other.log.textures).toHaveLength(1);
    expect(log.textures).toHaveLength(1);
  });

  it('converts HDR pixels to half floats', async () => {
    const codec = pixelCodec({
      decode: async () => ({
        width: 1,
        height: 1,
        pixels: new Float32Array([1, 0.5, 2, 1]),
        hdr: true,
      }),
    });
    const image = await codec.decode(new Uint8Array(1));
    expect(image.format).toBe('rgba16float');
    expect([...(image.levels[0] as Uint16Array)]).toEqual([
      0x3c00, 0x3800, 0x4000, 0x3c00,
    ]);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(-0)).toBe(0x8000);
  });
});

describe('materials', () => {
  it('shares a graph between the materials of the same features', () => {
    const a = textured('a.img');
    const b = textured('b.img', { baseColor: [1, 0, 0, 1], roughness: 0.2 });
    expect(featureKey(a)).toBe(featureKey(b));
    expect(materialGraph(a)).toBe(materialGraph(b));
    expect(materialGraph(defaultPbrMaterial)).not.toBe(materialGraph(a));
  });

  it('computes the rows of KHR_texture_transform', () => {
    const [r0, r1] = uvTransformRows({
      offset: [0.5, 0.25],
      rotation: Math.PI / 2,
      scale: [2, 3],
    });
    expect(r0.map((v) => +v.toFixed(6))).toEqual([0, -3, 0.5]);
    expect(r1.map((v) => +v.toFixed(6))).toEqual([2, 0, 0.25]);
  });

  it('shows a placeholder for a missing texture, and says so', async () => {
    const { store, warnings } = setup({
      'm.model': JSON.stringify({ material: textured('missing.img') }),
    });
    const model = await store.load<Model>(ModelType, 'm.model').ready;
    const material = model.meshes[0][0].material;
    expect(material.getValue('baseColorTexture')).toMatchObject({
      label: 'placeholder',
    });
    expect(warnings[0]).toMatch(/missing\.img/);
  });
});

describe('models', () => {
  it('realizes a model, instantiates it, and frees it', async () => {
    const { store, log, backend } = setup({
      'm.model': JSON.stringify({ material: textured('red.img') }),
      'red.img': 'img 2 2 255 0 0 255',
    });
    const handle = store.load<Model>(ModelType, 'm.model');
    const model = await handle.ready;
    const [{ mesh, material }] = model.meshes[0];
    expect(mesh).toBeInstanceOf(Mesh);
    expect(material).toBeInstanceOf(Material);
    expect(material.getValue('baseColorTexture')).toMatchObject({
      label: 'mem:red.img',
    });

    const scene = new Scene();
    const a = instantiate(handle, scene, { position: { x: 1 } });
    const b = instantiate(model, scene, { position: { x: -1 } });
    expect(a.nodes).toHaveLength(1);
    expect(scene.find('tri')).toBeDefined();

    // The graph compiles and both instances are drawn with one pipeline.
    const renderer = new Renderer(backend);
    renderer.render({
      source: scene,
      camera: new Camera({ position: { x: 0, y: 0, z: 5 } }),
      surface,
    });
    expect(log.pipelines.length).toBeGreaterThan(0);

    // The instance keeps the model alive after the scope's handle is gone.
    handle.release();
    store.trim(0);
    expect(mesh.destroyed).toBe(false);
    a.dispose();
    b.dispose();
    store.trim(0);
    expect(mesh.destroyed).toBe(true);
    expect(scene.find('tri')).toBeUndefined();
  });

  it('updates meshes and materials in place on reload', async () => {
    const { store, mem } = setup({
      'm.model': JSON.stringify({ material: textured('c.img'), y: 1 }),
      'c.img': 'img 1 1 255 0 0 255',
    });
    store.watch(true);
    const handle = store.load<Model>(ModelType, 'm.model');
    const model = await handle.ready;
    const [{ mesh, material }] = model.meshes[0];
    const texture = material.getValue('baseColorTexture');
    const meshVersion = mesh.version;

    // The image changes: the material takes the new texture, in place.
    mem.set('c.img', 'img 2 2 0 255 0 255');
    for (let i = 0; i < 5; i++) {
      await sleep(5);
      store.update();
    }
    expect(model.meshes[0][0].material).toBe(material);
    expect(material.getValue('baseColorTexture')).not.toBe(texture);

    // The model changes: same mesh object, new vertices.
    mem.set('m.model', JSON.stringify({ material: textured('c.img'), y: 2 }));
    for (let i = 0; i < 5; i++) {
      await sleep(5);
      store.update();
    }
    expect(model.meshes[0][0].mesh).toBe(mesh);
    expect(mesh.version).toBeGreaterThan(meshVersion);
    expect((mesh.vertices[0] as Float32Array)[17]).toBe(2);
  });

  it('gives tangents to the meshes of normal-mapped materials', async () => {
    const material = textured('n.img', {
      normalTexture: { image: 'n.img', texCoord: 0, sampler: {}, scale: 1 },
    });
    const { store } = setup({
      'm.model': JSON.stringify({ material }),
      'n.img': 'img 1 1 128 128 255 255',
    });
    const model = await store.load<Model>(ModelType, 'm.model').ready;
    const mesh = model.meshes[0][0].mesh;
    expect(
      mesh.description.vertexBuffers.some((b) =>
        b.attributes.some((a) => a.semantic === 'tangent')
      )
    ).toBe(true);
    expect(store.peek(MeshType, 'm.model#mesh/0')).toBeUndefined(); // the entry has options
  });
});
