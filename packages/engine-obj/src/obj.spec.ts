import { readFile } from 'node:fs/promises';
import {
  installAssets,
  MaterialDataType,
  ModelType,
  type ImageCodec,
  type Model,
  type PhongMaterialData,
} from '@fdw/engine-assets';
import { fakeBackend } from '@fdw/engine-core/testing';
import { MemorySource, ResourceStore } from '@fdw/engine-resources';
import { describe, expect, it } from 'vitest';
import { installObj } from './install';
import { parseMtl } from './mtl';
import { parseObj } from './obj';

const quad = `
# a quad, as one polygon, and a triangle in another group
mtllib quad.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
o Quad
usemtl Red
f 1/1/1 2/2/1 3/3/1 4/4/1
usemtl Blue
f -4/-4/-1 -2/-2/-1 -1/-1/-1
g Lonely
f 1 2 3
`;

describe('parseObj', () => {
  it('splits polygons, objects and materials into typed arrays', () => {
    const { groups, mtllibs } = parseObj(quad);
    expect(mtllibs).toEqual(['quad.mtl']);
    expect(groups.map((g) => [g.name, [...g.primitives.keys()]])).toEqual([
      ['Quad', ['Red', 'Blue']],
      ['Lonely', ['Blue']],
    ]);
    const red = groups[0].primitives.get('Red')!;
    expect(red.indices).toBeInstanceOf(Uint16Array);
    expect([...red.indices!]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(red.description.vertexCount).toBe(4);
    expect(red.description.vertexBuffers[0].stride).toBe(32);
    // v is flipped: the second corner (1, 0) becomes (1, 1).
    expect([...(red.vertices[0] as Float32Array).subarray(8, 16)]).toEqual([
      1, 0, 0, 0, 0, 1, 1, 1,
    ]);
  });

  it('computes the normals the file lacks', () => {
    const { groups } = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const mesh = groups[0].primitives.get('')!;
    expect(mesh.description.vertexBuffers[0].stride).toBe(24); // no uv
    expect([...(mesh.vertices[0] as Float32Array).subarray(3, 6)]).toEqual([
      0, 0, 1,
    ]);
  });
});

describe('parseMtl', () => {
  it('reads colors, maps and their options', () => {
    const materials = parseMtl(
      'newmtl Red\nKd 1 0 0\nKs 0.5 0.5 0.5\nNs 64\nd 0.5\nmap_Kd -s 2 2 1 -clamp on tex/red.png\nnorm n.png\nbump b.png\n',
      (p) => `base/${p}`
    );
    const red = materials.get('Red')!;
    expect(red).toMatchObject({
      diffuse: [1, 0, 0],
      shininess: 64,
      opacity: 0.5,
      alphaMode: 'blend',
    });
    expect(red.diffuseTexture).toMatchObject({
      image: 'base/tex/red.png',
      sampler: { wrapModeS: 'clamp-to-edge' },
      transform: { scale: [2, 2], offset: [0, 0] },
    });
    expect(red.normalTexture?.image).toBe('base/n.png');
  });
});

describe('with a ResourceStore', () => {
  const codec: ImageCodec = {
    name: 'any',
    sniff: () => true,
    decode: async () => ({
      type: '2d',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      levels: [new Uint8Array(4)],
    }),
  };

  function store(files: Record<string, string | Uint8Array>) {
    const resources = new ResourceStore({ warn: () => undefined });
    resources.mount('mem', new MemorySource(files), { default: true });
    const { backend } = fakeBackend();
    installAssets(resources, {
      backend,
      codecs: [codec],
      warn: () => undefined,
    });
    const warnings: string[] = [];
    installObj(resources, { warn: (m) => void warnings.push(m) });
    return { resources, warnings };
  }

  it('loads a model, its MTL as a dependency, and its textures', async () => {
    const { resources } = store({
      'models/quad.obj': quad,
      'models/quad.mtl':
        'newmtl Red\nKd 1 0 0\nmap_Kd red.png\nnewmtl Blue\nKd 0 0 1\n',
      'models/red.png': new Uint8Array(1),
    });
    const handle = resources.load<Model>(ModelType, 'models/quad.obj');
    const model = await handle.ready;
    expect(model.data.nodes.map((n) => n.name)).toEqual(['Quad', 'Lonely']);
    expect(model.meshes[0]).toHaveLength(2);
    // One material per name, shared by the groups.
    expect(model.meshes[1][0].material).toBe(model.meshes[0][1].material);
    const red = resources.peek(MaterialDataType, 'models/quad.obj#material/Red')
      ?.value as PhongMaterialData;
    expect(red.diffuseTexture?.image).toBe('mem:models/red.png');
    expect(
      model.meshes[0][0].material.getValue('diffuseTexture')
    ).toMatchObject({ label: 'mem:models/red.png' });
  });

  it('keeps going without its MTL file', async () => {
    const { resources, warnings } = store({ 'quad.obj': quad });
    const model = await resources.load<Model>(ModelType, 'quad.obj').ready;
    expect(model.meshes[0]).toHaveLength(2);
    expect(warnings.join()).toMatch(/quad\.mtl cannot be read/);
  });

  it('loads the sphere of the demo', async () => {
    const dir = new URL('../../../apps/demo/public/', import.meta.url);
    const read = async (name: string) =>
      new Uint8Array(await readFile(new URL(name, dir)));
    const { resources } = store({
      'sphere.obj': await read('sphere.obj'),
      'sphere.mtl': await read('sphere.mtl'),
    });
    const model = await resources.load<Model>(ModelType, 'sphere.obj').ready;
    const mesh = model.meshes[0][0].mesh;
    expect(mesh.description.vertexCount).toBeGreaterThan(100);
    expect(mesh.indices?.length).toBeGreaterThan(mesh.description.vertexCount);
  });
});
