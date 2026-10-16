import { readFile } from 'node:fs/promises';
import {
  installAssets,
  MaterialDataType,
  MeshDataType,
  ModelDataType,
  ModelType,
  type ImageCodec,
  type MeshData,
  type Model,
  type ModelData,
  type PbrMaterialData,
  instantiate,
  ImageCodecRegistry,
  ImageCodecsService,
} from '@fdw/engine-assets';
import { Camera, Mesh, Renderer } from '@fdw/engine-core';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import {
  MemorySource,
  ResourceBytesType,
  ResourceError,
  ResourceStore,
} from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { BufferType } from './buffers';
import { installGltf } from './install';
import { decomposeMatrix } from './nodes';
import type { GltfOptions } from './options';
import { GltfBuilder, writeGlb } from './testing/GltfBuilder';

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

function setup(
  files: Record<string, string | Uint8Array> = {},
  options: GltfOptions = {},
) {
  const { backend, log } = fakeBackend();
  const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
  const mem = new MemorySource(files);
  store.mount('mem', mem, { default: true });
  const warnings: string[] = [];
  installAssets(store, {
    backend,
    codecs: [testCodec],
    warn: (m) => void warnings.push(m),
  });
  installGltf(store, { warn: (m) => void warnings.push(m), ...options });
  const data = (uri: string) => store.load<ModelData>(ModelDataType, uri).ready;
  const mesh = (uri: string) =>
    store.peek<MeshData>(MeshDataType, `mem:${uri}`)?.value;
  const material = (uri: string) =>
    store.peek(MaterialDataType, `mem:${uri}`)?.value as
      PbrMaterialData | undefined;
  return { store, mem, backend, log, warnings, data, mesh, material };
}

const image = (r: number, g: number, b: number) =>
  new TextEncoder().encode(`img 1 1 ${r} ${g} ${b} 255`);

const formats = (data: MeshData | undefined) =>
  Object.fromEntries(
    data!.description.vertexBuffers.flatMap((b) =>
      b.attributes.map((a) => [a.semantic, a.format]),
    ),
  );

const vertices = (data: MeshData, semantic: string) => {
  const i = data.description.vertexBuffers.findIndex((b) =>
    b.attributes.some((a) => a.semantic === semantic),
  );
  return data.vertices[i];
};

/** A triangle with normals and uv, indexed, textured by an image embedded in the buffer. */
function texturedTriangle(b = new GltfBuilder()) {
  const position = b.accessor(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    'VEC3',
    { min: [0, 0, 0], max: [1, 1, 0] },
  );
  const normal = b.accessor(
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    'VEC3',
  );
  const uv = b.accessor(new Float32Array([0, 0, 1, 0, 0, 1]), 'VEC2');
  const indices = b.accessor(new Uint16Array([0, 1, 2]), 'SCALAR');
  const img = b.add('images', {
    bufferView: b.bufferView(image(255, 0, 0)),
    mimeType: 'image/png',
  });
  b.add('samplers', {
    wrapS: 33071,
    wrapT: 33648,
    magFilter: 9728,
    minFilter: 9985,
  });
  b.add('textures', { source: img, sampler: 0 });
  b.add('materials', {
    name: 'Red',
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0 },
      metallicFactor: 0.25,
    },
  });
  const node = b.meshNode(
    {
      attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
      indices,
      material: 0,
    },
    'Tri',
  );
  b.add('scenes', { nodes: [node] });
  b.json.scene = 0;
  return b;
}

/** An unlit material: its meshes get no computed normals, and keep their indices. */
function unlit(b: GltfBuilder): number {
  b.json.extensionsUsed = [
    ...new Set([...(b.json.extensionsUsed ?? []), 'KHR_materials_unlit']),
  ];
  b.json.materials ??= [];
  const found = b.json.materials.findIndex(
    (m: { name?: string }) => m.name === 'unlit',
  );
  return found >= 0
    ? found
    : b.add('materials', {
        name: 'unlit',
        extensions: { KHR_materials_unlit: {} },
      });
}

/** A primitive of positions only, with the given mode and indices. */
function positions(b: GltfBuilder, count: number, primitive: object = {}) {
  const values = new Float32Array(count * 3).map((_, i) =>
    i % 3 === 0 ? i : i % 3 === 1 ? i % 2 : 0,
  );
  return b.meshNode({
    attributes: { POSITION: b.accessor(values, 'VEC3') },
    material: unlit(b),
    ...primitive,
  });
}

describe('a Khronos sample: BoxTextured', () => {
  // The PNG of the box decoded to its size only (IHDR): the pipeline is
  // what is tested, not a PNG decoder.
  const pngCodec: ImageCodec = {
    name: 'png-size',
    sniff: (head) => head[0] === 0x89 && head[1] === 0x50,
    async decode(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const width = view.getUint32(16);
      const height = view.getUint32(20);
      return {
        type: '2d',
        width,
        height,
        format: 'rgba8unorm',
        levels: [new Uint8Array(width * height * 4)],
      };
    },
  };

  it('loads, realizes, instantiates and renders it', async () => {
    const glb = await readFile(
      new URL('./testing/BoxTextured.glb', import.meta.url),
    );
    const { store, log, backend, mesh, material, warnings } = setup({
      'BoxTextured.glb': new Uint8Array(glb),
    });
    store.provideService(
      ImageCodecsService,
      new ImageCodecRegistry([pngCodec]),
    );
    const handle = store.load<Model>(ModelType, 'BoxTextured.glb');
    const model = await handle.ready;
    expect(warnings).toEqual([]);

    // A root node whose matrix turns -90° around x, decomposed.
    expect(model.data.roots).toEqual([0]);
    const [root, child] = model.data.nodes;
    expect(root.children).toEqual([1]);
    expect(root.rotation![0]).toBeCloseTo(-Math.SQRT1_2);
    expect(root.rotation![3]).toBeCloseTo(Math.SQRT1_2);
    expect(root.translation).toEqual([0, 0, 0]);
    expect(root.scale!.map((v) => +v.toFixed(6))).toEqual([1, 1, 1]);
    expect(child.mesh).toBe(0);
    expect(model.data.meshes[0].primitives).toEqual([
      { mesh: 'mesh/Mesh/0', material: 'material/Texture' },
    ]);

    // 24 vertices (4 per face), 36 indices.
    const box = mesh('BoxTextured.glb#mesh/Mesh/0')!;
    expect(box.description).toMatchObject({
      vertexCount: 24,
      indexBuffer: { format: 'uint16', count: 36 },
    });
    expect(formats(box)).toEqual({
      position: 'float32x3',
      normal: 'float32x3',
      uv: 'float32x2',
    });

    const texture = material('BoxTextured.glb#material/Texture')!;
    expect(texture).toMatchObject({ metallic: 0, roughness: 1 });
    expect(texture.baseColorTexture).toEqual({
      image: 'mem:BoxTextured.glb#image/0',
      texCoord: 0,
      sampler: {
        wrapModeS: 'repeat',
        wrapModeT: 'repeat',
        magFilter: 'linear',
        minFilter: 'nearest',
        mipmapFilter: 'linear',
      },
    });

    // The embedded PNG became a texture, in sRGB, with its mipmaps.
    const [{ mesh: boxMesh, material: boxMaterial }] = model.meshes[0];
    expect(boxMesh).toBeInstanceOf(Mesh);
    const uploaded = log.textures.find(
      (t) => t.label === 'mem:BoxTextured.glb#image/0',
    )!;
    expect(uploaded.format).toBe('rgba8unorm-srgb');
    expect(uploaded.dimensions.width).toBeGreaterThan(1);
    expect(uploaded.mipLevelCount).toBeGreaterThan(1);
    expect(boxMaterial.getValue('baseColorTexture')).toMatchObject({
      label: 'mem:BoxTextured.glb#image/0',
    });

    const scene = new Scene();
    instantiate(handle, scene);
    new Renderer(backend).render({
      source: scene,
      camera: new Camera({ position: { x: 0, y: 0, z: 3 } }),
      surface,
    });
    expect(log.draws.length).toBeGreaterThan(0);
  });
});

describe('glTF models', () => {
  it('loads a GLB: meshes, materials and embedded images as sub-resources', async () => {
    const { store, log, backend, mesh, material } = setup({
      'models/x.glb': texturedTriangle().glb(),
    });
    const handle = store.load<Model>(ModelType, 'models/x.glb');
    const model = await handle.ready;
    expect(model.data).toMatchObject({
      name: 'x',
      roots: [0],
      nodes: [{ mesh: 0, children: [] }],
    });
    expect(model.data.meshes[0]).toEqual({
      name: 'Tri',
      primitives: [{ mesh: 'mesh/Tri/0', material: 'material/Red' }],
    });

    const data = mesh('models/x.glb#mesh/Tri/0')!;
    expect(data.description).toMatchObject({
      vertexCount: 3,
      indexBuffer: { format: 'uint16', count: 3 },
    });
    expect(formats(data)).toEqual({
      position: 'float32x3',
      normal: 'float32x3',
      uv: 'float32x2',
    });
    expect([...data.indices!]).toEqual([0, 1, 2]);

    const red = material('models/x.glb#material/Red')!;
    expect(red).toMatchObject({
      kind: 'pbr',
      name: 'Red',
      metallic: 0.25,
      roughness: 1,
      baseColor: [1, 1, 1, 1],
    });
    expect(red.baseColorTexture).toEqual({
      image: 'mem:models/x.glb#image/0',
      texCoord: 0,
      sampler: {
        wrapModeS: 'clamp-to-edge',
        wrapModeT: 'mirror-repeat',
        magFilter: 'nearest',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
      },
    });
    const bytes = store.peek(
      ResourceBytesType,
      'mem:models/x.glb#image/0',
    )?.value;
    expect(new TextDecoder().decode(bytes)).toBe('img 1 1 255 0 0 255');

    // The embedded image became a texture, and the model draws.
    const [{ mesh: realized, material: mat }] = model.meshes[0];
    expect(realized).toBeInstanceOf(Mesh);
    expect(mat.getValue('baseColorTexture')).toMatchObject({
      label: 'mem:models/x.glb#image/0',
    });
    expect(log.textures).toHaveLength(1);
    const scene = new Scene();
    const instance = instantiate(model, scene);
    new Renderer(backend).render({
      source: scene,
      camera: new Camera({ position: { x: 0, y: 0, z: 5 } }),
      surface,
    });
    expect(log.pipelines.length).toBeGreaterThan(0);
    instance.dispose();
    handle.release();
  });

  it('reads the external buffers and images of a .gltf, shared as resources', async () => {
    const b = texturedTriangle();
    b.json.images = [{ uri: '../textures/red%20brick.img' }];
    const { store, data, material } = setup({
      'scene/a.gltf': b.gltf('../bin/data.bin'),
      'bin/data.bin': b.bin,
      'textures/red brick.img': image(255, 0, 0),
    });
    await data('scene/a.gltf');
    expect(material('scene/a.gltf#material/Red')?.baseColorTexture?.image).toBe(
      'mem:textures/red brick.img',
    );
    expect(store.peek(BufferType, 'mem:bin/data.bin')?.value?.byteLength).toBe(
      b.bin.byteLength,
    );
    const model = await store.load<Model>(ModelType, 'scene/a.gltf').ready;
    expect(
      model.meshes[0][0].material.getValue('baseColorTexture'),
    ).toMatchObject({ label: 'mem:textures/red brick.img' });
  });

  it('decodes the data URIs of buffers and images itself', async () => {
    const b = texturedTriangle();
    b.json.images = [
      {
        uri: `data:image/x-test;base64,${Buffer.from(image(0, 255, 0)).toString(
          'base64',
        )}`,
      },
    ];
    const { store, data, mesh, material } = setup({ 'a.gltf': b.gltf() });
    await data('a.gltf');
    expect(mesh('a.gltf#mesh/Tri/0')?.description.vertexCount).toBe(3);
    expect(material('a.gltf#material/Red')?.baseColorTexture?.image).toBe(
      'mem:a.gltf#image/0',
    );
    const texture = await store.load<Model>(ModelType, 'a.gltf').ready;
    expect(
      texture.meshes[0][0].material.getValue('baseColorTexture'),
    ).toMatchObject({ label: 'mem:a.gltf#image/0' });
  });

  it('fails on a missing external buffer, naming it', async () => {
    const b = texturedTriangle();
    const { data } = setup({ 'a.gltf': b.gltf('missing.bin') });
    await expect(data('a.gltf')).rejects.toMatchObject({
      code: 'dependency',
      path: ['mem:a.gltf', 'mem:missing.bin'],
    });
  });

  it('recognizes a GLB by its magic, whatever its extension', async () => {
    const { data } = setup({ 'model.bin': texturedTriangle().glb() });
    expect((await data('model.bin')).meshes).toHaveLength(1);
  });
});

describe('glTF geometry', () => {
  it('converts strips and fans to lists, uint8 indices to uint16, and keeps unindexed lists', async () => {
    const b = new GltfBuilder();
    positions(b, 5, { mode: 5 }); // strip
    positions(b, 5, { mode: 6 }); // fan
    positions(b, 4, {
      indices: b.accessor(new Uint8Array([0, 1, 2, 2, 1, 3]), 'SCALAR'),
    });
    positions(b, 3);
    positions(b, 4, {
      mode: 5,
      indices: b.accessor(new Uint32Array([3, 2, 1, 0]), 'SCALAR'),
    });
    const { data, mesh } = setup({ 'g.glb': b.glb() });
    await data('g.glb');
    expect([...mesh('g.glb#mesh/0/0')!.indices!]).toEqual([
      0, 1, 2, 2, 1, 3, 2, 3, 4,
    ]);
    expect([...mesh('g.glb#mesh/1/0')!.indices!]).toEqual([
      0, 1, 2, 0, 2, 3, 0, 3, 4,
    ]);
    const uint8 = mesh('g.glb#mesh/2/0')!;
    expect(uint8.indices).toBeInstanceOf(Uint16Array);
    expect(uint8.description.indexBuffer).toEqual({
      format: 'uint16',
      count: 6,
    });
    const unindexed = mesh('g.glb#mesh/3/0')!;
    expect(unindexed.indices).toBeUndefined();
    expect(unindexed.description).not.toHaveProperty('indexBuffer');
    expect(unindexed.description.vertexCount).toBe(3);
    expect([...mesh('g.glb#mesh/4/0')!.indices!]).toEqual([3, 2, 1, 1, 2, 0]);
  });

  it('skips points and lines with a warning', async () => {
    const b = new GltfBuilder();
    const mesh = b.add('meshes', {
      primitives: [
        {
          attributes: { POSITION: b.accessor(new Float32Array(9), 'VEC3') },
          mode: 1,
        },
        { attributes: { POSITION: b.accessor(new Float32Array(9), 'VEC3') } },
      ],
    });
    b.add('nodes', { mesh });
    const { data, warnings } = setup({ 'l.glb': b.glb() });
    expect((await data('l.glb')).meshes[0].primitives).toEqual([
      { mesh: 'mesh/0/1', material: 'material/default' },
    ]);
    expect(warnings.join()).toMatch(/primitive 0 of mesh 0 skipped: lines/);
  });

  it('maps quantized attributes to vertex formats, padded for WebGPU', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = b.json.extensionsRequired = [
      'KHR_mesh_quantization',
    ];
    b.add('materials', {});
    const attributes = {
      POSITION: b.accessor(
        new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0]),
        'VEC3',
        { normalized: true },
      ),
      NORMAL: b.accessor(
        new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]),
        'VEC3',
        { normalized: true },
      ),
      TEXCOORD_0: b.accessor(
        new Uint16Array([0, 0, 65535, 0, 0, 65535]),
        'VEC2',
        { normalized: true },
      ),
      TEXCOORD_1: b.accessor(new Uint8Array([0, 0, 2, 0, 0, 2]), 'VEC2'),
      COLOR_0: b.accessor(
        new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]),
        'VEC3',
        { normalized: true },
      ),
      JOINTS_0: b.accessor(
        new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]),
        'VEC4',
      ),
      WEIGHTS_0: b.accessor(
        new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        'VEC4',
      ),
    };
    b.meshNode({ attributes, material: 0 });
    b.meshNode({
      attributes: {
        POSITION: b.accessor(
          new Int16Array([0, 0, 0, 4, 0, 0, 0, -4, 0]),
          'VEC3',
        ),
      },
    });
    const { store, data, mesh, material } = setup({ 'q.glb': b.glb() });
    await data('q.glb');
    const q = mesh('q.glb#mesh/0/0')!;
    expect(formats(q)).toEqual({
      position: 'snorm16x4',
      normal: 'snorm8x4',
      uv: 'unorm16x2',
      uv1: 'float32x2',
      color: 'unorm8x4',
      joints: 'uint8x4',
      weights: 'float32x4',
    });
    expect([...(vertices(q, 'position') as Int16Array)].slice(0, 8)).toEqual([
      0, 0, 0, 0, 32767, 0, 0, 0,
    ]);
    expect([...(vertices(q, 'color') as Uint8Array)].slice(0, 4)).toEqual([
      255, 0, 0, 255,
    ]);
    expect([...(vertices(q, 'uv1') as Float32Array)]).toEqual([
      0, 0, 2, 0, 0, 2,
    ]);
    expect(q.description.vertexBuffers.every((v) => v.stride % 4 === 0)).toBe(
      true,
    );
    expect(material('q.glb#material/0')?.vertexColors).toBe(true);
    // Integer positions are converted to floats: the shaders read floats.
    const integer = mesh('q.glb#mesh/1/0')!;
    expect(formats(integer).position).toBe('float32x3');
    expect(
      [...(vertices(integer, 'position') as Float32Array)].slice(3, 9),
    ).toEqual([4, 0, 0, 0, -4, 0]);
    // And the quantized mesh realizes and draws (its formats match the graph).
    const model = await store.load<Model>(ModelType, 'q.glb').ready;
    expect(model.meshes[0][0].mesh.description.vertexBuffers).toHaveLength(7);
  });

  it('expands sparse accessors', async () => {
    const b = new GltfBuilder();
    const base = b.accessor(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      'VEC3',
    );
    const accessor = b.add('accessors', {
      ...b.json.accessors[base],
      sparse: {
        count: 1,
        indices: {
          bufferView: b.bufferView(new Uint8Array([2])),
          componentType: 5121,
        },
        values: { bufferView: b.bufferView(new Float32Array([5, 6, 7])) },
      },
    });
    const zeros = b.add('accessors', {
      componentType: 5126,
      count: 3,
      type: 'VEC3',
      sparse: {
        count: 1,
        indices: {
          bufferView: b.bufferView(new Uint16Array([1, 0])),
          componentType: 5123,
        },
        values: { bufferView: b.bufferView(new Float32Array([0, 0, 1])) },
      },
    });
    b.meshNode({ attributes: { POSITION: accessor, NORMAL: zeros } });
    const { data, mesh } = setup({ 's.glb': b.glb() });
    await data('s.glb');
    const s = mesh('s.glb#mesh/0/0')!;
    expect([...(vertices(s, 'position') as Float32Array)]).toEqual([
      0, 0, 0, 1, 0, 0, 5, 6, 7,
    ]);
    expect([...(vertices(s, 'normal') as Float32Array)]).toEqual([
      0, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
  });

  it('computes flat normals when there are none, except for unlit materials', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = ['KHR_materials_unlit'];
    b.add('materials', { name: 'lit' });
    b.add('materials', {
      name: 'flat',
      extensions: { KHR_materials_unlit: {} },
    });
    const position = b.accessor(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, -1]),
      'VEC3',
    );
    const indices = b.accessor(new Uint16Array([0, 1, 2, 0, 3, 1]), 'SCALAR');
    b.meshNode({ attributes: { POSITION: position }, indices, material: 0 });
    b.meshNode({ attributes: { POSITION: position }, indices, material: 1 });
    const { data, mesh, material } = setup({ 'n.glb': b.glb() });
    await data('n.glb');
    const lit = mesh('n.glb#mesh/0/0')!;
    expect(lit.description).toMatchObject({ vertexCount: 6 });
    expect(lit.indices).toBeUndefined();
    expect([...(vertices(lit, 'position') as Float32Array)]).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, -1, 1, 0, 0,
    ]);
    expect([...(vertices(lit, 'normal') as Float32Array)]).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    ]);
    const unlit = mesh('n.glb#mesh/1/0')!;
    expect(formats(unlit)).toEqual({ position: 'float32x3' });
    expect(material('n.glb#material/flat')?.unlit).toBe(true);
  });

  it('names the sub-resources by name when unique, else by index', async () => {
    const b = new GltfBuilder();
    const position = b.accessor(new Float32Array(9), 'VEC3');
    for (const name of ['a/b#c', 'twin', 'twin', '7'])
      b.meshNode({ attributes: { POSITION: position } }, name);
    for (const name of ['default', 'Bark']) b.add('materials', { name });
    const { data } = setup({ 'k.glb': b.glb() });
    const model = await data('k.glb');
    expect(model.meshes.map((m) => m.primitives[0].mesh)).toEqual([
      'mesh/a_b_c/0',
      'mesh/1/0',
      'mesh/2/0',
      'mesh/3/0',
    ]);
    expect(model.meshes[0].primitives[0].material).toBe('material/default');
  });
});

describe('glTF materials and extensions', () => {
  it('reads factors, texture transforms, emissive strength and samplers', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = [
      'KHR_texture_transform',
      'KHR_materials_emissive_strength',
    ];
    b.add('images', { uri: 'n.img' });
    b.add('textures', { source: 0 });
    b.add('materials', {
      name: 'M',
      pbrMetallicRoughness: {
        baseColorFactor: [0.5, 0.25, 1, 0.5],
        roughnessFactor: 0.3,
      },
      normalTexture: {
        index: 0,
        scale: 0.5,
        extensions: {
          KHR_texture_transform: {
            offset: [0.5, 0],
            rotation: 1,
            scale: [2, 2],
            texCoord: 1,
          },
        },
      },
      occlusionTexture: { index: 0, strength: 0.7, texCoord: 1 },
      emissiveFactor: [1, 0.5, 0],
      alphaMode: 'MASK',
      alphaCutoff: 0.25,
      doubleSided: true,
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 4 } },
    });
    b.meshNode({
      attributes: { POSITION: b.accessor(new Float32Array(9), 'VEC3') },
      material: 0,
    });
    const { data, material } = setup({ 'm.glb': b.glb() });
    await data('m.glb');
    const sampler = {
      wrapModeS: 'repeat',
      wrapModeT: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    };
    expect(material('m.glb#material/M')).toEqual({
      kind: 'pbr',
      name: 'M',
      baseColor: [0.5, 0.25, 1, 0.5],
      metallic: 1,
      roughness: 0.3,
      normalTexture: {
        image: 'mem:n.img',
        texCoord: 1,
        sampler,
        transform: { offset: [0.5, 0], rotation: 1, scale: [2, 2] },
        scale: 0.5,
      },
      occlusionTexture: {
        image: 'mem:n.img',
        texCoord: 1,
        sampler,
        strength: 0.7,
      },
      emissive: [4, 2, 0],
      alphaMode: 'mask',
      alphaCutoff: 0.25,
      doubleSided: true,
    });
  });

  it('reads the KTX2 image of KHR_texture_basisu', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = ['KHR_texture_basisu'];
    b.add('images', { uri: 'fallback.png' });
    b.add('images', { uri: 'color.ktx2' });
    b.add('textures', {
      source: 0,
      extensions: { KHR_texture_basisu: { source: 1 } },
    });
    b.add('materials', {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
    });
    b.meshNode({
      attributes: { POSITION: b.accessor(new Float32Array(9), 'VEC3') },
      material: 0,
    });
    const { data, material } = setup({ 'k.glb': b.glb() });
    await data('k.glb');
    expect(material('k.glb#material/0')?.baseColorTexture?.image).toBe(
      'mem:color.ktx2',
    );
  });

  it('reads the punctual lights of the nodes', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = ['KHR_lights_punctual'];
    b.json.extensions = {
      KHR_lights_punctual: {
        lights: [
          {
            type: 'spot',
            name: 'Spot',
            color: [1, 0.5, 0],
            intensity: 20,
            range: 10,
            spot: { outerConeAngle: 0.5 },
          },
          { type: 'directional' },
        ],
      },
    };
    b.add('nodes', {
      name: 'lamp',
      extensions: { KHR_lights_punctual: { light: 0 } },
    });
    b.add('nodes', {
      name: 'sun',
      extensions: { KHR_lights_punctual: { light: 1 } },
    });
    const { data } = setup({ 'l.glb': b.glb() });
    const model = await data('l.glb');
    expect(model.lights).toEqual([
      {
        type: 'spot',
        name: 'Spot',
        color: [1, 0.5, 0],
        intensity: 20,
        range: 10,
        innerConeAngle: 0,
        outerConeAngle: 0.5,
      },
      { type: 'directional', color: [1, 1, 1], intensity: 1 },
    ]);
    expect(model.nodes.map((n) => n.light)).toEqual([0, 1]);
    expect(model.roots).toEqual([0, 1]);
  });

  it('fails on an unknown required extension, and ignores an unknown optional one', async () => {
    const b = texturedTriangle();
    b.json.extensionsUsed = ['EXT_unknown', 'KHR_fancy'];
    b.json.extensionsRequired = ['KHR_fancy'];
    const { data, warnings } = setup({ 'r.glb': b.glb() });
    const error = await data('r.glb').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceError);
    expect(error).toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/KHR_fancy/),
    });
    expect(warnings.join()).toMatch(/EXT_unknown is not supported; ignored/);
  });

  it('accepts an extension given in the options', async () => {
    const b = texturedTriangle();
    b.json.extensionsUsed = b.json.extensionsRequired = ['EXT_tint'];
    b.json.materials[0].extensions = { EXT_tint: { color: [0, 1, 0, 1] } };
    const { data, material } = setup(
      { 't.glb': b.glb() },
      {
        extensions: [
          {
            name: 'EXT_tint',
            material: (ext, data) => ({
              ...data,
              baseColor: (ext as { color: [number, number, number, number] })
                .color,
            }),
          },
        ],
      },
    );
    await data('t.glb');
    expect(material('t.glb#material/Red')?.baseColor).toEqual([0, 1, 0, 1]);
  });
});

describe('glTF compression', () => {
  async function meshoptFile() {
    await MeshoptEncoder.ready;
    const b = new GltfBuilder();
    b.json.extensionsUsed = b.json.extensionsRequired = [
      'EXT_meshopt_compression',
    ];
    const positions = new Float32Array([
      0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0,
    ]); // vec3 + padding, 16 bytes
    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    const compressed = (
      source: ArrayBufferView,
      count: number,
      size: number,
      mode: string,
    ) => {
      const bytes = MeshoptEncoder.encodeGltfBuffer(
        new Uint8Array(source.buffer),
        count,
        size,
        mode,
      );
      return { offset: b.append(bytes), length: bytes.byteLength };
    };
    const p = compressed(positions, 4, 16, 'ATTRIBUTES');
    const i = compressed(indices, 6, 2, 'TRIANGLES');
    // A fallback buffer without data: the views can only be decoded.
    b.json.buffers = [
      {},
      {
        byteLength: 1024,
        extensions: { EXT_meshopt_compression: { fallback: true } },
      },
    ];
    const view = (
      o: { offset: number; length: number },
      byteStride: number | undefined,
      count: number,
      mode: string,
    ) =>
      b.add('bufferViews', {
        buffer: 1,
        byteLength: count * (byteStride ?? 2),
        ...(byteStride ? { byteStride } : {}),
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: o.offset,
            byteLength: o.length,
            byteStride: byteStride ?? 2,
            count,
            mode,
          },
        },
      });
    const position = b.add('accessors', {
      bufferView: view(p, 16, 4, 'ATTRIBUTES'),
      componentType: 5126,
      count: 4,
      type: 'VEC3',
    });
    const index = b.add('accessors', {
      bufferView: view(i, undefined, 6, 'TRIANGLES'),
      componentType: 5123,
      count: 6,
      type: 'SCALAR',
    });
    b.meshNode({
      attributes: { POSITION: position },
      indices: index,
      material: unlit(b),
    });
    return b.glb();
  }

  it('decodes EXT_meshopt_compression with the decoder of meshoptimizer', async () => {
    const { data, mesh } = setup(
      { 'c.glb': await meshoptFile() },
      { meshopt: MeshoptDecoder },
    );
    await data('c.glb');
    const c = mesh('c.glb#mesh/0/0')!;
    expect([...c.indices!]).toEqual([0, 1, 2, 2, 1, 3]);
    expect([...(vertices(c, 'position') as Float32Array)]).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0,
    ]);
  });

  it('fails when a required decoder is missing', async () => {
    const { data } = setup({ 'c.glb': await meshoptFile() });
    await expect(data('c.glb')).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/EXT_meshopt_compression needs a decoder/),
    });
  });

  it('decodes KHR_draco_mesh_compression with the decoder of the application', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = b.json.extensionsRequired = [
      'KHR_draco_mesh_compression',
    ];
    const compressed = b.bufferView(new TextEncoder().encode('draco!'));
    const position = b.add('accessors', {
      componentType: 5126,
      count: 3,
      type: 'VEC3',
    });
    const uv = b.add('accessors', {
      componentType: 5126,
      count: 3,
      type: 'VEC2',
    });
    const indices = b.add('accessors', {
      componentType: 5125,
      count: 3,
      type: 'SCALAR',
    });
    b.meshNode({
      attributes: { POSITION: position, TEXCOORD_0: uv },
      indices,
      extensions: {
        KHR_draco_mesh_compression: {
          bufferView: compressed,
          attributes: { POSITION: 0, TEXCOORD_0: 1 },
        },
      },
    });
    const calls: unknown[] = [];
    const { data, mesh } = setup(
      { 'd.glb': b.glb() },
      {
        draco: {
          async decode(bytes, attributes) {
            calls.push([new TextDecoder().decode(bytes), attributes]);
            return {
              attributes: {
                POSITION: {
                  array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
                  components: 3,
                },
                TEXCOORD_0: {
                  array: new Uint16Array([0, 0, 65535, 0, 0, 65535]),
                  components: 2,
                  normalized: true,
                },
              },
              indices: new Uint32Array([0, 1, 2]),
            };
          },
        },
      },
    );
    await data('d.glb');
    expect(calls).toEqual([['draco!', { POSITION: 0, TEXCOORD_0: 1 }]]);
    const d = mesh('d.glb#mesh/0/0')!;
    // Without normals, flat ones are computed: the vertices are unwelded.
    expect(formats(d)).toEqual({
      position: 'float32x3',
      uv: 'unorm16x2',
      normal: 'float32x3',
    });
    expect(d.description.vertexCount).toBe(3);
    expect(d.indices).toBeUndefined();
  });
});

describe('glTF hierarchy, skins and animations', () => {
  it('decomposes node matrices', () => {
    // Translation (1, 2, 3), 90° about z, scale (2, 3, 4): columns are the scaled axes.
    const { translation, rotation, scale } = decomposeMatrix([
      0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1,
    ]);
    expect(translation).toEqual([1, 2, 3]);
    expect(scale.map((v) => +v.toFixed(6))).toEqual([2, 3, 4]);
    expect(rotation.map((v) => +v.toFixed(6))).toEqual([
      0,
      0,
      +Math.SQRT1_2.toFixed(6),
      +Math.SQRT1_2.toFixed(6),
    ]);
    // A mirror goes to the scale.
    const mirrored = decomposeMatrix([
      -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect(mirrored.scale).toEqual([-1, 1, 1]);
    expect(mirrored.rotation).toEqual([0, 0, 0, 1]);
    // Half a turn about x: the largest term is not the trace.
    const flipped = decomposeMatrix([
      1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1,
    ]);
    expect(flipped.rotation.map((v) => Math.abs(+v.toFixed(6)))).toEqual([
      1, 0, 0, 0,
    ]);
  });

  it('reads nodes, the default scene, cameras, skins and animations', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = ['KHR_mesh_quantization'];
    b.add('nodes', {
      name: 'root',
      children: [1, 2],
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
    });
    b.add('nodes', {
      name: 'joint',
      translation: [0, 1, 0],
      rotation: [0, 0, 0, 1],
    });
    b.add('nodes', { name: 'eye', camera: 0, skin: 0 });
    b.add('nodes', { name: 'elsewhere' });
    b.add('scenes', { nodes: [3] });
    b.add('scenes', { nodes: [0] });
    b.json.scene = 1;
    b.add('cameras', {
      type: 'perspective',
      name: 'cam',
      perspective: { yfov: 0.8, znear: 0.1 },
    });
    b.add('cameras', {
      type: 'orthographic',
      orthographic: { xmag: 1, ymag: 2, znear: 0, zfar: 10 },
    });
    const ibm = new Float32Array(32);
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1], 16);
    b.add('skins', {
      name: 'rig',
      joints: [0, 1],
      skeleton: 0,
      inverseBindMatrices: b.accessor(ibm, 'MAT4'),
    });
    const times = b.accessor(new Float32Array([0, 0.5, 2]), 'SCALAR');
    const rotations = b.accessor(
      new Int16Array([0, 0, 0, 32767, 0, 0, 32767, 0, 0, 0, -32767, 0]),
      'VEC4',
      { normalized: true },
    );
    const moves = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0]), 'VEC3');
    const moveTimes = b.accessor(new Float32Array([0, 1]), 'SCALAR');
    b.add('animations', {
      name: 'wave',
      samplers: [
        { input: times, output: rotations },
        { input: moveTimes, output: moves, interpolation: 'STEP' },
      ],
      channels: [
        { sampler: 0, target: { node: 1, path: 'rotation' } },
        { sampler: 1, target: { node: 0, path: 'translation' } },
        { sampler: 1, target: { path: 'pointer' } },
      ],
    });
    const { data } = setup({ 'h.glb': b.glb() });
    const model = await data('h.glb');
    expect(model.roots).toEqual([0]);
    expect(model.nodes[0]).toEqual({
      name: 'root',
      translation: [5, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      children: [1, 2],
    });
    expect(model.nodes[1]).toEqual({
      name: 'joint',
      translation: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      children: [],
    });
    expect(model.nodes[2]).toMatchObject({ camera: 0, skin: 0 });
    expect(model.cameras).toEqual([
      { type: 'perspective', name: 'cam', yfov: 0.8, znear: 0.1 },
      { type: 'orthographic', xmag: 1, ymag: 2, znear: 0, zfar: 10 },
    ]);
    expect(model.skins[0]).toMatchObject({
      name: 'rig',
      joints: [0, 1],
      skeleton: 0,
    });
    expect([...model.skins[0].inverseBindMatrices!.subarray(16)]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
    ]);
    const [clip] = model.animations;
    expect(clip.name).toBe('wave');
    expect(clip.duration).toBe(2);
    expect(clip.channels).toHaveLength(2);
    expect(clip.channels[0]).toMatchObject({
      node: 1,
      path: 'rotation',
      interpolation: 'LINEAR',
    });
    expect([...clip.channels[0].values]).toEqual([
      0, 0, 0, 1, 0, 0, 1, 0, 0, 0, -1, 0,
    ]);
    expect(clip.channels[1]).toMatchObject({
      node: 0,
      path: 'translation',
      interpolation: 'STEP',
    });
  });

  it('roots the parentless nodes when there is no scene', async () => {
    const b = new GltfBuilder();
    b.add('nodes', { children: [2] });
    b.add('nodes', {});
    b.add('nodes', {});
    const { data } = setup({ 'p.gltf': JSON.stringify(b.json) });
    expect((await data('p.gltf')).roots).toEqual([0, 1]);
  });

  it('rejects other versions and malformed files', async () => {
    const { data } = setup({
      'v1.gltf': JSON.stringify({ asset: { version: '1.0' } }),
      'bad.glb': writeGlb({ asset: { version: '2.0' } }).subarray(0, 18),
      'bad.gltf': '{',
    });
    await expect(data('v1.gltf')).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(data('bad.glb')).rejects.toMatchObject({ code: 'decode' });
    await expect(data('bad.gltf')).rejects.toMatchObject({ code: 'decode' });
  });
});
