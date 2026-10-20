import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
// @ts-expect-error: the validator of Khronos has no types.
import { validateBytes } from 'gltf-validator';
import {
  installAssets,
  MaterialDataType,
  MeshDataType,
  ModelDataType,
  type GraphMaterialData,
  type ImageCodec,
  type MeshData,
  type ModelData,
  type PbrMaterialData,
} from '@fdw/engine-assets';
import { fakeBackend } from '@fdw/engine-core/testing';
import type { PhysicsBodyData } from '@fdw/engine-physics';
import {
  MemorySource,
  ResourceBytesType,
  ResourceStore,
} from '@fdw/engine-resources';
import {
  SceneDataType,
  type ExportedFile,
  type SceneData,
} from '@fdw/engine-scene-io';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { encodeGlb, parseGlb } from './glb';
import { installGltf } from './install';
import { writeGltf } from './scene/export';
import { installGltfScenes } from './scene/install';
import { GltfBuilder } from './testing/GltfBuilder';

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

function setup(files: Record<string, string | Uint8Array> = {}) {
  const { backend } = fakeBackend();
  const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
  const mem = new MemorySource(files);
  store.mount('mem', mem, { default: true });
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);
  installAssets(store, { backend, codecs: [testCodec], warn });
  installGltf(store, { warn });
  installGltfScenes(store);
  const scene = (uri: string) => store.load(SceneDataType, uri).ready;
  const mount = (out: readonly ExportedFile[]) => {
    for (const file of out) mem.set(file.path, file.bytes);
  };
  return { store, mem, warnings, warn, scene, mount };
}

const triangle = () => {
  const b = new GltfBuilder();
  const position = b.accessor(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    'VEC3',
    { min: [0, 0, 0], max: [1, 1, 0] },
  );
  return { b, position };
};

describe('glTF scenes: import', () => {
  it('reads nodes, meshes, lights, cameras and the physics extensions', async () => {
    const { b, position } = triangle();
    b.add('meshes', {
      name: 'tri',
      primitives: [{ attributes: { POSITION: position } }],
    });
    b.json.extensionsUsed = [
      'KHR_lights_punctual',
      'KHR_physics_rigid_bodies',
      'KHR_implicit_shapes',
    ];
    b.json.extensions = {
      KHR_lights_punctual: {
        lights: [{ type: 'point', color: [1, 0.5, 0], intensity: 2 }],
      },
      KHR_implicit_shapes: {
        shapes: [
          { type: 'box', box: { size: [2, 1, 4] } },
          { type: 'sphere', sphere: { radius: 0.5 } },
          {
            type: 'capsule',
            capsule: { height: 1, radiusTop: 0.3, radiusBottom: 0.3 },
          },
        ],
      },
      KHR_physics_rigid_bodies: {
        physicsMaterials: [
          {
            staticFriction: 0.9,
            dynamicFriction: 0.6,
            restitution: 0.2,
            frictionCombine: 'minimum',
          },
        ],
        collisionFilters: [
          { collisionSystems: ['player'], collideWithSystems: ['world'] },
        ],
      },
    };
    b.add('cameras', {
      type: 'perspective',
      perspective: { yfov: Math.PI / 3, aspectRatio: 2, znear: 0.1, zfar: 50 },
    });
    // 0 ground: a static box, scaled; 1 crate: dynamic, its sphere, and a
    // child collider at an offset; 3 lamp; 4 eye; 5 zone: a trigger.
    b.add('nodes', {
      name: 'ground',
      mesh: 0,
      scale: [2, 1, 1],
      extensions: {
        KHR_physics_rigid_bodies: { collider: { geometry: { shape: 0 } } },
      },
    });
    b.add('nodes', {
      name: 'crate',
      translation: [0, 3, 0],
      children: [2],
      extensions: {
        KHR_physics_rigid_bodies: {
          motion: { mass: 2, linearVelocity: [1, 0, 0] },
          collider: { geometry: { shape: 1 }, physicsMaterial: 0 },
        },
      },
    });
    b.add('nodes', {
      name: 'handle',
      translation: [0, 1, 0],
      extensions: {
        KHR_physics_rigid_bodies: { collider: { geometry: { shape: 1 } } },
      },
    });
    b.add('nodes', {
      name: 'lamp',
      extensions: { KHR_lights_punctual: { light: 0 } },
    });
    b.add('nodes', { name: 'eye', camera: 0 });
    b.add('nodes', {
      name: 'zone',
      extensions: {
        KHR_physics_rigid_bodies: {
          trigger: { geometry: { shape: 2 }, collisionFilter: 0 },
        },
      },
    });
    b.add('scenes', { nodes: [0, 1, 3, 4, 5] });
    const { scene, warnings } = setup({ 's.glb': b.glb() });
    const data = await scene('s.glb');
    expect(warnings).toEqual([]);
    expect(data.nodes.map((n) => [n.name, n.parent])).toEqual([
      ['ground', undefined],
      ['crate', undefined],
      ['handle', 1],
      ['lamp', undefined],
      ['eye', undefined],
      ['zone', undefined],
    ]);
    const [ground, crate, handle, lamp, eye, zone] = data.nodes;
    expect(ground.components?.['mesh renderer'].data).toEqual({
      mesh: '#mesh/tri/0',
      material: '#material/default',
    });
    expect(ground.components?.['physics body'].data).toEqual({
      body: {
        type: 'static',
        colliders: [
          { shape: { type: 'box', halfExtents: { x: 2, y: 0.5, z: 2 } } },
        ],
      },
    });
    expect(crate.components?.['physics body'].data).toEqual({
      body: {
        type: 'dynamic',
        linearVelocity: { x: 1, y: 0, z: 0 },
        colliders: [
          {
            shape: { type: 'sphere', radius: 0.5 },
            material: {
              friction: 0.6,
              restitution: 0.2,
              frictionCombine: 'min',
            },
          },
          {
            shape: { type: 'sphere', radius: 0.5 },
            position: { x: 0, y: 1, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        ],
      },
    });
    expect(handle.components).toBeUndefined();
    expect(lamp.components?.['light'].data).toEqual({
      type: 'point',
      ambient: [0, 0, 0],
      diffuse: [2, 1, 0],
      specular: [2, 1, 0],
      attenuation: [1, 0, 1],
    });
    const { projection } = eye.components?.['camera view'].data as {
      projection: { fov: number };
    };
    expect(projection).toMatchObject({
      type: 'perspective',
      aspect: 2,
      near: 0.1,
      far: 50,
    });
    expect(projection.fov).toBeCloseTo(60);
    expect(zone.components?.['physics body'].data).toEqual({
      body: {
        type: 'static',
        colliders: [
          {
            shape: { type: 'capsule', halfHeight: 0.5, radius: 0.3 },
            sensor: true,
            groups: 1,
            mask: 2,
          },
        ],
      },
    });
  });

  it('reads EXT_mesh_gpu_instancing as a batch under its node', async () => {
    const { b, position } = triangle();
    b.add('meshes', { primitives: [{ attributes: { POSITION: position } }] });
    const translation = b.accessor(
      new Float32Array([0, 0, 0, 5, 0, 0]),
      'VEC3',
    );
    b.json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
    b.add('nodes', {
      name: 'grass',
      mesh: 0,
      translation: [0, 1, 0],
      extensions: {
        EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: translation } },
      },
    });
    const { scene } = setup({ 'i.glb': b.glb() });
    const data = await scene('i.glb');
    expect(data.nodes).toEqual([{ name: 'grass', position: [0, 1, 0] }]);
    expect(data.batches).toHaveLength(1);
    expect(data.batches[0]).toMatchObject({
      parent: 0,
      count: 2,
      mesh: '#mesh/0/0',
    });
    expect([...data.batches[0].positions]).toEqual([0, 0, 0, 5, 0, 0]);
    expect([...data.batches[0].rotations]).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

function tintedGraph() {
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

const interleaved: MeshData = {
  name: 'quad',
  description: {
    vertexBuffers: [
      {
        stride: 20,
        stepMode: 'vertex',
        attributes: [
          { semantic: 'position', format: 'float32x3', offset: 0 },
          { semantic: 'uv', format: 'unorm16x2', offset: 12 },
        ],
      },
    ],
    vertexCount: 3,
    indexBuffer: { format: 'uint16', count: 3 },
  },
  vertices: [
    (() => {
      const bytes = new ArrayBuffer(60);
      const view = new DataView(bytes);
      [
        [0, 0, 0, 0, 0],
        [1, 0, 0, 65535, 0],
        [0, 1, 0, 0, 65535],
      ].forEach(([x, y, z, u, v], i) => {
        view.setFloat32(i * 20, x, true);
        view.setFloat32(i * 20 + 4, y, true);
        view.setFloat32(i * 20 + 8, z, true);
        view.setUint16(i * 20 + 12, u, true);
        view.setUint16(i * 20 + 14, v, true);
      });
      return new Uint8Array(bytes);
    })(),
  ],
  indices: new Uint16Array([0, 1, 2]),
};

const scene: SceneData = {
  name: 'level',
  nodes: [
    {
      name: 'ground',
      position: [0, -1, 0],
      static: true,
      components: {
        'mesh renderer': {
          version: 1,
          data: { mesh: '#mesh/0', material: '#material/0', castShadow: false },
        },
        'physics body': {
          version: 1,
          data: {
            body: {
              type: 'static',
              colliders: [
                {
                  shape: {
                    type: 'heightfield',
                    rows: 2,
                    columns: 2,
                    heights: new Float32Array([0, 1, 0, 1]),
                    size: { x: 4, y: 2, z: 4 },
                  },
                },
              ],
            },
          } satisfies PhysicsBodyData,
        },
      },
    },
    {
      name: 'sun',
      parent: 0,
      rotation: [0, 0.6, 0, 0.8],
      components: {
        light: {
          version: 1,
          data: {
            type: 'directional',
            ambient: [0.1, 0.1, 0.1],
            diffuse: [2, 1.5, 1],
            specular: [2, 1.5, 1],
            castShadow: true,
          },
        },
      },
    },
    {
      name: 'crate',
      components: {
        'physics body': {
          version: 1,
          data: {
            body: {
              type: 'dynamic',
              colliders: [
                { shape: { type: 'box', halfExtents: { x: 1, y: 1, z: 1 } } },
                {
                  shape: { type: 'sphere', radius: 0.5 },
                  position: { x: 0, y: 1, z: 0 },
                  density: 3,
                },
              ],
            },
          },
        },
        health: { version: 2, data: { value: 42 } },
      },
    },
  ],
  batches: [
    {
      parent: 0,
      name: 'pebble',
      count: 2,
      positions: new Float32Array([1, 0, 0, 2, 0, 0]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      scales: new Float32Array([1, 1, 1, 2, 2, 2]),
      static: true,
      mesh: '#mesh/0',
      material: '#material/0',
      components: { lod: { version: 1, data: [{ levels: [] }, null] } },
    },
  ],
  meshes: [interleaved],
  materials: [
    {
      kind: 'graph',
      name: 'tinted',
      graph: tintedGraph(),
      values: {
        tint: [1, 0.5, 0.25],
        color: { texture: 'red.img' },
        colorSampler: {
          sampler: { minFilter: 'nearest', wrapModeS: 'clamp-to-edge' },
        },
      },
    },
  ],
};

describe('glTF scenes: export', () => {
  it('writes a scene the engine reads back as it was', async () => {
    const {
      store,
      mount,
      scene: load,
      warnings,
      warn,
    } = setup({
      'red.img': 'img 1 1 255 0 0 255',
    });
    const files = await writeGltf(scene, 'out/level.glb', {
      store,
      uri: 'mem:level.scene.json',
      warn,
    });
    expect(files.map((f) => f.path)).toEqual(['out/level.glb']);
    const { json } = parseGlb(files[0].bytes);
    expect([...(json.extensionsUsed ?? [])]).toEqual([
      'EXT_mesh_gpu_instancing',
      'FDW_scene',
      'KHR_implicit_shapes',
      'KHR_lights_punctual',
      'KHR_physics_rigid_bodies',
    ]);
    expect(json.extensionsRequired).toBeUndefined();
    expect(warnings).toEqual([
      'mem:red.img: unknown image type',
      'node ground: a heightfield is written as a mesh of triangles',
    ]);
    mount(files);
    const back = await load('out/level.glb');
    expect(back.nodes.map((n) => n.name)).toEqual(['ground', 'sun', 'crate']);
    const [ground, sun, crate] = back.nodes;
    expect(ground).toMatchObject({ position: [0, -1, 0], static: true });
    expect(ground.components?.['mesh renderer'].data).toEqual({
      mesh: '#mesh/quad/0',
      material: '#material/tinted',
      castShadow: false,
    });
    expect(ground.components?.['physics body']).toEqual(
      scene.nodes[0].components?.['physics body'],
    );
    expect(sun.parent).toBe(0);
    expect(sun.components?.['light']).toEqual(
      scene.nodes[1].components?.['light'],
    );
    expect(crate.components).toEqual(scene.nodes[2].components);
    // The batch, by its index after the nodes, under the ground.
    expect(back.batches).toHaveLength(1);
    const batch = back.batches[0];
    expect(batch).toMatchObject({
      parent: 0,
      name: 'pebble',
      count: 2,
      static: true,
      mesh: '#mesh/quad/0',
      material: '#material/tinted',
      components: scene.batches[0].components,
    });
    expect([...batch.scales]).toEqual([1, 1, 1, 2, 2, 2]);
    // The mesh, de-interleaved; the uv dequantized.
    const mesh = store.peek<MeshData>(
      MeshDataType,
      'mem:out/level.glb#mesh/quad/0',
    )!.value!;
    expect(mesh.description.vertexCount).toBe(3);
    const attribute = (semantic: string) => {
      const i = mesh.description.vertexBuffers.findIndex((v) =>
        v.attributes.some((a) => a.semantic === semantic),
      );
      return [...(mesh.vertices[i] as Float32Array)];
    };
    expect(attribute('position')).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(attribute('uv')).toEqual([0, 0, 1, 0, 0, 1]);
    // The graph material, read back from FDW_scene, its texture an image of the file.
    const material = store.peek(
      MaterialDataType,
      'mem:out/level.glb#material/tinted',
    )!.value! as GraphMaterialData;
    expect(material.kind).toBe('graph');
    expect(material.graph).toEqual(
      scene.materials[0].kind === 'graph' && scene.materials[0].graph,
    );
    expect(material.values['tint']).toEqual([1, 0.5, 0.25]);
    expect(material.values['color']).toEqual({
      texture: 'mem:out/level.glb#image/0',
    });
    const image = store.peek(
      ResourceBytesType,
      'mem:out/level.glb#image/0',
    )!.value!;
    expect(new TextDecoder().decode(image)).toBe('img 1 1 255 0 0 255');
  });

  it('writes the standard extensions for other tools', async () => {
    const { store, warn } = setup({ 'red.img': 'img 1 1 255 0 0 255' });
    const [file] = await writeGltf(scene, 'level.glb', {
      store,
      uri: 'mem:level.scene.json',
      warn,
    });
    const { json } = parseGlb(file.bytes) as { json: Record<string, any> };
    const nodes = json['nodes'];
    // The crate: dynamic, its two colliders on nodes of their own.
    expect(nodes[2].extensions.KHR_physics_rigid_bodies).toEqual({
      motion: {},
    });
    const helpers = nodes[2].children.map((i: number) => nodes[i]);
    expect(
      helpers.map((h: any) => h.extensions.KHR_physics_rigid_bodies),
    ).toEqual([
      { collider: { geometry: { shape: 0 } } },
      { collider: { geometry: { shape: 1 } } },
    ]);
    expect(helpers[1].translation).toEqual([0, 1, 0]);
    expect(json['extensions'].KHR_implicit_shapes.shapes).toEqual([
      { type: 'box', box: { size: [2, 2, 2] } },
      { type: 'sphere', sphere: { radius: 0.5 } },
    ]);
    // The ground: a mesh collider.
    const ground = nodes[0].extensions.KHR_physics_rigid_bodies;
    expect(json['meshes'][ground.collider.geometry.mesh].name).toBe('collider');
    // The sun: color and intensity, its ambient in FDW_scene.
    expect(json['extensions'].KHR_lights_punctual.lights).toEqual([
      { type: 'directional', color: [1, 0.75, 0.5], intensity: 2 },
    ]);
    expect(nodes[1].extensions.FDW_scene.components.light).toBeDefined();
    // The graph material: its texture previewed, its values in FDW_scene.
    const material = json['materials'][0];
    expect(material.pbrMetallicRoughness.baseColorTexture).toEqual({
      index: 0,
    });
    expect(material.extensions.FDW_scene.material.values).toMatchObject({
      color: { image: 0 },
      colorSampler: {
        sampler: { minFilter: 'nearest', wrapModeS: 'clamp-to-edge' },
      },
    });
    // The quad: POSITION with its bounds, TEXCOORD_0 as floats.
    const primitive = json['meshes'][nodes[0].mesh].primitives[0];
    const uv = json['accessors'][primitive.attributes.TEXCOORD_0];
    expect(uv).toMatchObject({ componentType: 5126, type: 'VEC2', count: 3 });
    expect(json['accessors'][primitive.attributes.POSITION]).toMatchObject({
      min: [0, 0, 0],
      max: [1, 1, 0],
    });
    // Without FDW_scene (another tool), the bodies come from the standard.
    for (const node of nodes)
      if (node.extensions && !node.extensions.FDW_scene?.helper)
        delete node.extensions.FDW_scene;
    const { bin } = parseGlb(file.bytes);
    const other = setup({ 'plain.glb': encodeGlb(json, bin) });
    const plain = await other.scene('plain.glb');
    const crate = plain.nodes.find((n) => n.name === 'crate')!;
    expect(crate.components?.['physics body'].data).toEqual({
      body: {
        type: 'dynamic',
        colliders: [
          {
            shape: { type: 'box', halfExtents: { x: 1, y: 1, z: 1 } },
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
          {
            shape: { type: 'sphere', radius: 0.5 },
            position: { x: 0, y: 1, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        ],
      },
    });
    const groundBody = plain.nodes[0].components?.['physics body'].data as {
      body: { colliders: { shape: { type: string } }[] };
    };
    expect(groundBody.body.colliders[0].shape.type).toBe('mesh');
  });

  it('writes a .gltf and its .bin', async () => {
    const {
      store,
      mount,
      scene: load,
      warn,
    } = setup({ 'red.img': 'img 1 1 255 0 0 255' });
    const files = await writeGltf(scene, 'out/level.gltf', {
      store,
      uri: 'mem:level.scene.json',
      binary: false,
      warn,
    });
    expect(files.map((f) => f.path)).toEqual([
      'out/level.gltf',
      'out/level.bin',
    ]);
    const json = JSON.parse(new TextDecoder().decode(files[0].bytes));
    expect(json.buffers).toEqual([
      { uri: 'level.bin', byteLength: files[1].bytes.length },
    ]);
    mount(files);
    const back = await load('out/level.gltf');
    expect(back.nodes[2].components).toEqual(scene.nodes[2].components);
  });

  it('writes BoxTextured again: the same geometry, the same image', async () => {
    const glb = new Uint8Array(
      await readFile(new URL('./testing/BoxTextured.glb', import.meta.url)),
    );
    const { store, mount, scene: load } = setup({ 'BoxTextured.glb': glb });
    const data = await load('BoxTextured.glb');
    const files = await writeGltf(data, 'Box2.glb', {
      store,
      uri: 'mem:BoxTextured.glb',
    });
    mount(files);
    const [a, b] = await Promise.all(
      ['BoxTextured.glb', 'Box2.glb'].map(
        (uri) => store.load<ModelData>(ModelDataType, uri).ready,
      ),
    );
    expect(b.nodes.map((n) => n.name)).toEqual(a.nodes.map((n) => n.name));
    expect(b.nodes[0].rotation![0]).toBeCloseTo(a.nodes[0].rotation![0]);
    const meshOf = (uri: string, model: ModelData) =>
      store.peek<MeshData>(
        MeshDataType,
        `mem:${uri}#${model.meshes[0].primitives[0].mesh}`,
      )!.value!;
    const [ma, mb] = [meshOf('BoxTextured.glb', a), meshOf('Box2.glb', b)];
    expect(mb.description.vertexCount).toBe(ma.description.vertexCount);
    expect([...mb.indices!]).toEqual([...ma.indices!]);
    const position = (mesh: MeshData) => {
      const i = mesh.description.vertexBuffers.findIndex((v) =>
        v.attributes.some((x) => x.semantic === 'position'),
      );
      return [...new Float32Array(mesh.vertices[i].buffer.slice(0))];
    };
    expect(position(mb)).toEqual(position(ma));
    const materialOf = (uri: string, model: ModelData) =>
      store.peek(
        MaterialDataType,
        `mem:${uri}#${model.meshes[0].primitives[0].material}`,
      )!.value! as PbrMaterialData;
    const [pa, pb] = [
      materialOf('BoxTextured.glb', a),
      materialOf('Box2.glb', b),
    ];
    expect(pb.baseColor).toEqual(pa.baseColor);
    expect(pb.baseColorTexture!.sampler).toEqual(pa.baseColorTexture!.sampler);
    const bytes = (uri: string) => store.peek(ResourceBytesType, uri)?.value;
    expect(bytes(pb.baseColorTexture!.image)).toEqual(
      bytes(pa.baseColorTexture!.image),
    );
  });

  it('writes files the validator of Khronos accepts', async () => {
    const glb = new Uint8Array(
      await readFile(new URL('./testing/BoxTextured.glb', import.meta.url)),
    );
    const {
      store,
      scene: load,
      warn,
      warnings,
    } = setup({
      'red.img': png(),
      'BoxTextured.glb': glb,
    });
    const box = await load('BoxTextured.glb');
    const outputs = [
      ...(await writeGltf(scene, 'level.glb', {
        store,
        uri: 'mem:level.scene.json',
        warn,
      })),
      ...(await writeGltf(box, 'box.glb', {
        store,
        uri: 'mem:BoxTextured.glb',
      })),
    ];
    expect(warnings.filter((w) => /image type/.test(w))).toEqual([]);
    for (const file of outputs) {
      const report = await validateBytes(file.bytes, {
        ignoredIssues: ['UNSUPPORTED_EXTENSION'],
      });
      const errors = report.issues.messages.filter(
        (m: { severity: number }) => m.severity === 0,
      );
      expect({ file: file.path, errors }).toEqual({
        file: file.path,
        errors: [],
      });
    }
  });
});

// A PNG of a red pixel.
function png(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  header.set([8, 6, 0, 0, 0], 8);
  const pixels = deflateSync(new Uint8Array([0, 255, 0, 0, 255]));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(pixels)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
