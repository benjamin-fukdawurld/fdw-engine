import { Pose } from '@fdw/engine-animation';
import { instantiate, Model, type ModelData } from '@fdw/engine-assets';
import { Material, Mesh } from '@fdw/engine-core';
import { colorGraph, fakeBackend } from '@fdw/engine-core/testing';
import { Aabb } from '@fdw/engine-geometry';
import { Scene } from '@fdw/engine-scene';
import { compile } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { skinGraph, skinningKernel, SkinValues } from './graph';
import { MeshSkin, skinPositions } from './MeshSkin';
import { clipsOf, defaultSkinningMode, skeletonOf, Skinning } from './Skinning';

// A bar of 3 vertices along y: the first on the root joint, the last on
// the tip joint (1 above), the middle one halfway between.
const bar = () => {
  const stride = 32;
  const data = new ArrayBuffer(stride * 3);
  const view = new DataView(data);
  // y, the joints, the weights.
  const vertices: [number, [number, number], [number, number]][] = [
    [0, [0, 0], [1, 0]],
    [1, [0, 1], [0.5, 0.5]],
    [2, [1, 0], [1, 0]],
  ];
  vertices.forEach(([y, joints, weights], i) => {
    view.setFloat32(i * stride + 4, y, true);
    joints.forEach((j, k) => view.setUint8(i * stride + 12 + k, j));
    weights.forEach((w, k) =>
      view.setFloat32(i * stride + 16 + k * 4, w, true),
    );
  });
  return new Mesh({
    label: 'bar',
    description: {
      vertexCount: 3,
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
    },
    vertices: [new Uint8Array(data)],
  });
};

const translation = (x: number, y: number, z: number) => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];

const model = () => {
  const mesh = bar();
  const material = new Material({ graph: colorGraph('bar') });
  const data: ModelData = {
    name: 'bar',
    nodes: [
      { name: 'Character', children: [1, 2] },
      { name: 'Body', children: [], mesh: 0, skin: 0 },
      { name: 'root', children: [3] },
      { name: 'tip', translation: [0, 1, 0], children: [] },
    ],
    roots: [0],
    meshes: [{ name: 'bar', primitives: [{ mesh: 'm', material: 'mat' }] }],
    skins: [
      {
        joints: [2, 3],
        inverseBindMatrices: new Float32Array([
          ...translation(0, 0, 0),
          ...translation(0, -1, 0),
        ]),
      },
    ],
    animations: [
      {
        name: 'Bend',
        duration: 1,
        channels: [
          {
            node: 3,
            path: 'translation',
            interpolation: 'LINEAR',
            times: new Float32Array([0, 1]),
            values: new Float32Array([0, 1, 0, 1, 1, 0]),
          },
        ],
      },
    ],
    cameras: [],
    lights: [],
  };
  return { mesh, material, model: new Model(data, [[{ mesh, material }]]) };
};

describe('the skinning graphs', () => {
  it('skins in the vertex stage, from the attributes of the mesh', () => {
    const graph = skinGraph(colorGraph(), 'vertex', {
      normal: true,
      tangent: true,
    });
    const program = compile(graph, {
      vertexAttributes: ['position', 'normal', 'tangent', 'joints', 'weights'],
    });
    expect(program.vertexInputs.map((input) => input.semantic).sort()).toEqual([
      'joints',
      'position',
      'weights',
    ]);
    expect(graph.name).toBe('color (skinned)');
  });

  it('reads the vertices of the compute pass by their index', () => {
    const graph = skinGraph(colorGraph(), 'compute', {
      normal: false,
      tangent: false,
    });
    const program = compile(graph, { vertexAttributes: ['position'] });
    expect(program.vertexInputs).toEqual([]);
    const resources = program.layout.groups.flatMap((group) =>
      group.bindings.map((binding) => binding.name),
    );
    expect(resources).toContain(SkinValues.vertices);
  });

  it('compiles its kernel where the backend has compute shaders', () => {
    const kernel = skinningKernel({ normal: true, tangent: true });
    expect(() => compile(kernel)).not.toThrow();
    expect(() => compile(kernel, { capabilities: { compute: false } })).toThrow(
      /no compute shaders/,
    );
  });
});

describe('MeshSkin', () => {
  it('reads the joints, the weights and the rest vertices', () => {
    const skin = MeshSkin.of(bar());
    expect(skin.vertexCount).toBe(3);
    expect(skin.attributes).toEqual({ normal: false, tangent: false });
    expect(Array.from(skin.joints.subarray(4, 8))).toEqual([0, 1, 0, 0]);
    expect(Array.from(skin.joints.subarray(8, 12))).toEqual([1, 0, 0, 0]);
    expect(Array.from(skin.weights.subarray(4, 8))).toEqual([0.5, 0.5, 0, 0]);
    expect(Array.from(skin.rest.subarray(8, 12))).toEqual([0, 2, 0, 1]);
    // The root moves the first two vertices, the tip the last two.
    const radii = skin.radii(
      new Float32Array([...translation(0, 0, 0), ...translation(0, -1, 0)]),
    );
    expect(Array.from(radii)).toEqual([1, 1]);
  });

  it('skins the positions on the CPU', () => {
    const skin = MeshSkin.of(bar());
    // The tip moved by +x: the middle vertex half of it.
    const matrices = [...translation(0, 0, 0), ...translation(2, 0, 0)];
    expect(Array.from(skinPositions(skin, matrices))).toEqual([
      0, 0, 0, 1, 1, 0, 2, 2, 0,
    ]);
  });

  it('refuses a mesh without joints', () => {
    const mesh = new Mesh({
      description: { vertexCount: 0, vertexBuffers: [] },
      vertices: [],
    });
    expect(() => MeshSkin.of(mesh)).toThrow(/needs joints, weights/);
  });
});

describe('Skinning', () => {
  const setup = (mode?: 'vertex' | 'compute') => {
    const { backend, log } = fakeBackend({ objectTable: true });
    const writes: Float32Array[] = [];
    backend.textures.writeTexture = (_texture, data) => {
      writes.push(new Float32Array((data as Float32Array).slice()));
    };
    const dispatches: { values: object; workgroups: unknown }[] = [];
    const compute = {
      dispatch: (
        _program: unknown,
        dispatch: { values?: object; workgroups: unknown },
      ) => {
        dispatches.push({
          values: dispatch.values ?? {},
          workgroups: dispatch.workgroups,
        });
      },
    };
    const scene = new Scene();
    const { model: bar, mesh, material } = model();
    const instance = instantiate(bar, scene, { position: { x: 10 } });
    const skinning = new Skinning(backend, instance, bar, {
      ...(mode ? { mode } : {}),
      compute,
    });
    return {
      backend,
      log,
      writes,
      dispatches,
      scene,
      bar,
      mesh,
      material,
      instance,
      skinning,
    };
  };

  it('skins in the vertex stage where the backend has no compute', () => {
    const { backend } = fakeBackend();
    expect(defaultSkinningMode(backend)).toBe('compute');
    expect(
      defaultSkinningMode({ ...backend, capabilities: { compute: false } }),
    ).toBe('vertex');
  });

  it('gives the skinned primitives a material of their own', () => {
    const { skinning, instance, material, mesh, scene } = setup('vertex');
    const [primitive] = skinning.primitives;
    expect(skinning.primitives).toHaveLength(1);
    expect(primitive.node).toBe(instance.nodes[1]);
    expect(primitive.original).toBe(material);
    expect(primitive.material).not.toBe(material);
    expect(primitive.material.graph.name).toBe('bar (skinned)');
    expect(primitive.material.getValue(SkinValues.jointTexture)).toBeDefined();
    expect(scene.MeshRenderer.material[primitive.node.entity]).toBe(
      primitive.material,
    );
    expect(scene.MeshRenderer.mesh[primitive.node.entity]).toBe(mesh);
  });

  it('sends the joint matrices relative to the mesh node, and bounds the joints', () => {
    const { skinning, writes, instance, scene } = setup('vertex');
    expect(skinning.skeleton.names).toEqual([
      'Character',
      'Body',
      'root',
      'tip',
    ]);
    // The tip 2 to the right of its rest position.
    const pose = skinning.skeleton.rest.clone();
    pose.translations.set([2, 1, 0], 3 * 3);
    skinning.applyPose(pose).update();
    expect(instance.nodes[3].transform.position).toMatchObject({ x: 2, y: 1 });
    const matrices = writes[writes.length - 1];
    // inverse(body) × tip × inverse bind: a translation of (2, 0, 0); the
    // instance at x = 10 cancels out.
    expect(Array.from(matrices.subarray(0, 16))).toEqual(translation(0, 0, 0));
    expect(Array.from(matrices.subarray(16, 32))).toEqual(translation(2, 0, 0));
    // The bounds: around the root (radius 1) and the tip at (2, 1, 0).
    const bounds = scene.bounds(new Aabb(), skinning.primitives[0].node.entity);
    expect(Array.from(bounds.min)).toEqual([9, -1, -1]);
    expect(Array.from(bounds.max)).toEqual([13, 2, 1]);
  });

  it('runs the compute skinning of each primitive', () => {
    const { skinning, dispatches, mesh } = setup('compute');
    const [primitive] = skinning.primitives;
    expect(primitive.vertices?.size).toBe(3 * 16);
    expect(primitive.material.getValue(SkinValues.vertices)).toBe(
      primitive.vertices,
    );
    skinning.update();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].workgroups).toEqual([1]);
    expect(Object.keys(dispatches[0].values).sort()).toEqual(
      [
        SkinValues.jointMatrices,
        SkinValues.joints,
        SkinValues.rest,
        SkinValues.vertices,
        SkinValues.weights,
      ].sort(),
    );
    expect(MeshSkin.of(mesh).stride).toBe(1);
  });

  it('plays the clips of the model on its skeleton', () => {
    const { model: bar } = model();
    const skeleton = skeletonOf(bar);
    expect(skeletonOf(bar)).toBe(skeleton);
    const clips = clipsOf(bar);
    expect(Object.keys(clips)).toEqual(['Bend']);
    const pose = clips['Bend'].sample(0.5, skeleton.rest.clone());
    expect(pose.translation(3)).toEqual([0.5, 1, 0]);
  });

  it('refuses a pose of another skeleton, and gives the materials back', () => {
    const { skinning, material, scene } = setup('vertex');
    expect(() => skinning.applyPose(new Pose(2))).toThrow(
      'A pose of 2 joints for a skeleton of 4',
    );
    const node = skinning.primitives[0].node;
    skinning.destroy();
    expect(scene.MeshRenderer.material[node.entity]).toBe(material);
    expect(scene.MeshRenderer.localBounds[node.entity]).toBeUndefined();
  });
});
