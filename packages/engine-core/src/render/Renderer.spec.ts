import {
  CameraMath,
  GpuBindGroupEntry,
  GpuBuffer,
  GpuRenderTarget,
  matchVertexLayout,
  PhysicalLayoutStrategy,
  RenderBackend,
  RenderPipelineDescriptor,
  Surface,
  TransformMath,
} from '@fdw/engine-backend';
import { GraphBuilder, MaterialGraphData, std, T } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { Transform } from '../Transform';
import { Material } from './Material';
import { Mesh } from './Mesh';
import { Renderer } from './Renderer';

// --- A fake backend recording what the renderer asks for ----------------------

class FakeBuffer implements GpuBuffer {
  readonly usage = [];
  writes = 0;
  data = new ArrayBuffer(0);
  destroyed = false;
  constructor(readonly size: number, readonly label?: string) {}
  write(_: number, value: ArrayBuffer): void {
    this.writes++;
    this.data = value.slice(0);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const sizeOf = (kind: string) => (kind === 'matrix' ? 64 : 16);

// Every member in its own 16-byte slot (64 for matrices), values as floats.
const layoutStrategy: PhysicalLayoutStrategy = {
  resolve: (layout) => ({
    groups: layout.groups.map((group, index) => ({
      index,
      slot: group.slot,
      bindings: group.bindings.map((resource, binding) => {
        if (resource.kind !== 'uniform-block') {
          return { binding, resource };
        }
        let offset = 0;
        const members = resource.members.map((member) => {
          const size = sizeOf(member.type.kind);
          const physical = {
            name: member.name,
            type: member.type,
            offset,
            size,
          };
          offset += size;
          return physical;
        });
        return { binding, resource, block: { size: offset, members } };
      }),
    })),
  }),
  writeUniform: (view, member, value) => {
    const values =
      typeof value === 'number' || typeof value === 'boolean'
        ? [Number(value)]
        : Array.from(value);
    values
      .slice(0, member.size / 4)
      .forEach((v, i) => view.setFloat32(member.offset + i * 4, v, true));
  },
};

const translation = (position: ArrayLike<number>) => {
  const matrix = new Float32Array(16);
  [0, 5, 10, 15].forEach((i) => (matrix[i] = 1));
  matrix.set([position[0], position[1], position[2]], 12);
  return matrix;
};

const transformMath = {
  getLocalMatrix: translation,
  getInverseLocalMatrix: (matrix: Float32Array) => matrix,
  getLocalNormalMatrix: () => new Float32Array(12),
  getWorldMatrix: (local: Float32Array) => local,
  getWorldNormalMatrix: (normal: Float32Array) => normal,
  primitiveApis: {
    mat4: { identity: () => translation([0, 0, 0]) },
    mat3: { identity: () => new Float32Array(12) },
  },
} as unknown as TransformMath;

const cameraMath = {
  getViewMatrix: (position: ArrayLike<number>) =>
    translation([-position[0], -position[1], -position[2]]),
  getProjectionMatrix: () => translation([0, 0, 0]),
  getViewProjectionMatrix: (view: Float32Array) => view,
} as unknown as CameraMath;

function fakeBackend() {
  const log = {
    buffers: [] as FakeBuffer[],
    pipelines: [] as RenderPipelineDescriptor[],
    bindGroups: [] as { key: string; entries: readonly GpuBindGroupEntry[] }[],
    draws: [] as {
      pipeline: string;
      groups: Record<number, unknown>;
      count: number;
      indexed: boolean;
    }[],
    submits: 0,
  };
  let current: (typeof log.draws)[number] | undefined;
  let boundGroups: Record<number, unknown> = {};
  let pipelineLabel = '';

  const backend: RenderBackend = {
    buffers: {
      create: ({ size, label }) => {
        const buffer = new FakeBuffer(size, label);
        log.buffers.push(buffer);
        return buffer;
      },
    },
    textures: {} as RenderBackend['textures'],
    pipelines: {
      codegen: {} as RenderBackend['pipelines']['codegen'],
      layoutStrategy,
      resolveLayout: (program) => layoutStrategy.resolve(program.layout),
      createRenderPipeline: (descriptor) => {
        log.pipelines.push(descriptor);
        return {
          label: descriptor.label,
          vertexBuffers: matchVertexLayout(
            descriptor.program.vertexInputs,
            descriptor.vertex
          ).map((b) => b.buffer),
        };
      },
      createRenderPipelineAsync: () => Promise.reject(new Error('unused')),
      createBindGroupLayout: (group) => ({
        key: JSON.stringify(group.bindings.map((b) => b.resource)),
      }),
      createBindGroup: (layout, entries) => {
        log.bindGroups.push({ key: layout.key, entries });
        return { layout };
      },
    },
    cameraMath,
    transformMath,
    depthFormat: 'depth24plus',
    createRenderTarget: ({ width, height, format }) => ({
      width,
      height,
      format,
      destroy: () => undefined,
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: (pipeline) => {
          pipelineLabel = pipeline.label ?? '';
          boundGroups = {};
        },
        setBindGroup: (index, group) => (boundGroups[index] = group),
        setVertexBuffer: () => undefined,
        setIndexBuffer: () => undefined,
        draw: (count) => {
          current = {
            pipeline: pipelineLabel,
            groups: { ...boundGroups },
            count,
            indexed: false,
          };
          log.draws.push(current);
        },
        drawIndexed: (count) => {
          current = {
            pipeline: pipelineLabel,
            groups: { ...boundGroups },
            count,
            indexed: true,
          };
          log.draws.push(current);
        },
        end: () => undefined,
      }),
      finish: () => ({}),
    }),
    submit: () => log.submits++,
  };
  return { backend, log };
}

const target: GpuRenderTarget = { width: 4, height: 4, format: 'rgba8unorm' };
const surface: Surface = {
  width: 4,
  height: 4,
  format: 'rgba8unorm',
  init: async () => undefined,
  getCurrentTarget: () => target,
  present: () => undefined,
};

// --- Scene helpers -------------------------------------------------------------

const triangle = () =>
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
      vertexCount: 3,
      indexBuffer: { format: 'uint16', count: 3 },
    },
    vertices: [new Float32Array(15)],
    indices: new Uint16Array([0, 1, 2]),
  });

const colorGraph = (name = 'color'): MaterialGraphData => {
  const g = new GraphBuilder(name);
  g.surface({ baseColor: g.uniform('color', T.vec3f, { default: [1, 0, 0] }) });
  return g.build();
};

const texturedGraph = (): MaterialGraphData => {
  const g = new GraphBuilder('textured');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', T.vec2f),
  });
  g.surface({ baseColor: texel.swizzle('rgb') });
  return g.build();
};

const transformAt = (x: number, z = 0) =>
  new Transform({ position: { x, y: 0, z } });

const setup = () => {
  const { backend, log } = fakeBackend();
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  const render = (items: Parameters<Renderer['render']>[0]['items']) =>
    renderer.render({ items, camera, surface });
  return { renderer, render, log, camera };
};

const floatsOf = (buffer: FakeBuffer) => [...new Float32Array(buffer.data)];

describe('Renderer', () => {
  it('draws the items and submits once per frame', () => {
    const { render, log } = setup();
    const material = new Material({ graph: colorGraph() });
    render([{ mesh: triangle(), material, transform: transformAt(0) }]);
    expect(log.draws).toEqual([
      expect.objectContaining({ count: 3, indexed: true }),
    ]);
    expect(log.submits).toBe(1);
  });

  it('creates programs, pipelines and mesh buffers once', () => {
    const { render, log } = setup();
    const mesh = triangle();
    const graph = colorGraph();
    const a = new Material({ graph });
    const b = new Material({ graph, values: { color: [0, 1, 0] } });
    const items = [
      { mesh, material: a, transform: transformAt(0) },
      { mesh, material: b, transform: transformAt(1) },
    ];
    render(items);
    const buffers = log.buffers.length;
    render(items);
    render(items);

    // Same graph and render state: one pipeline for both materials.
    expect(log.pipelines).toHaveLength(1);
    expect(log.buffers).toHaveLength(buffers);
    expect(log.draws).toHaveLength(6);
  });

  it('uploads material uniforms only when the values change', () => {
    const { render, log } = setup();
    const material = new Material({ graph: colorGraph() });
    const items = [{ mesh: triangle(), material, transform: transformAt(0) }];
    render(items);
    const buffer = log.buffers.find((b) =>
      b.label?.includes('color uniforms')
    ) as FakeBuffer;
    expect(floatsOf(buffer).slice(0, 3)).toEqual([1, 0, 0]);

    render(items);
    expect(buffer.writes).toBe(1);

    material.setValue('color', [0, 0, 1]);
    render(items);
    expect(buffer.writes).toBe(2);
    expect(floatsOf(buffer).slice(0, 3)).toEqual([0, 0, 1]);
  });

  it('uploads object matrices only when the transform changes', () => {
    const { render, log } = setup();
    const transform = transformAt(2);
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform,
      },
    ];
    render(items);
    const buffer = log.buffers.find(
      (b) => b.label === 'object uniforms'
    ) as FakeBuffer;
    expect(floatsOf(buffer)[12]).toBe(2);

    render(items);
    expect(buffer.writes).toBe(1);

    transform.position = { x: 5 };
    render(items);
    expect(buffer.writes).toBe(2);
    expect(floatsOf(buffer)[12]).toBe(5);
  });

  it('writes the camera in the frame uniforms every frame', () => {
    const { render, log, camera } = setup();
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];
    render(items);
    const buffer = log.buffers.find(
      (b) => b.label === 'frame uniforms'
    ) as FakeBuffer;
    // viewProjection is the fake view: a translation by -position.
    expect(floatsOf(buffer)[14]).toBe(-10);

    camera.position = { z: 3 };
    render(items);
    expect(floatsOf(buffer)[14]).toBe(-3);
  });

  it('binds textures and rebuilds the bind group when one changes', () => {
    const { render, log } = setup();
    const texture = {
      type: '2d',
      format: 'rgba8unorm',
      dimensions: { width: 1 },
      destroy: () => undefined,
    } as const;
    const other = { ...texture };
    const sampler = { destroy: () => undefined };
    const material = new Material({
      graph: texturedGraph(),
      values: { map: texture, mapSampler: sampler },
    });
    const items = [{ mesh: triangle(), material, transform: transformAt(0) }];

    render(items);
    const materialGroups = () =>
      log.bindGroups.filter((group) => group.key.includes('"map"'));
    expect(materialGroups()).toHaveLength(1);
    expect(materialGroups()[0].entries.map((entry) => entry.resource)).toEqual([
      texture,
      sampler,
    ]);

    render(items);
    expect(materialGroups()).toHaveLength(1);

    material.setValue('map', other);
    render(items);
    expect(materialGroups()).toHaveLength(2);
    expect(materialGroups()[1].entries[0].resource).toBe(other);
  });

  it('reports a missing texture with the material name', () => {
    const { render } = setup();
    const material = new Material({ graph: texturedGraph(), label: 'wood' });
    expect(() =>
      render([{ mesh: triangle(), material, transform: transformAt(0) }])
    ).toThrow('Material "wood": no texture set for "map"');
  });

  it('shares the frame and object bind groups between programs', () => {
    const { render, log } = setup();
    const transform = transformAt(0);
    render([
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph('a') }),
        transform,
      },
      {
        mesh: triangle(),
        material: new Material({
          graph: texturedGraph(),
          values: { map: {}, mapSampler: {} } as never,
        }),
        transform,
      },
    ]);
    const [first, second] = log.draws;
    expect(first.groups[0]).toBe(second.groups[0]);
    expect(first.groups[2]).toBe(second.groups[2]);
    expect(first.groups[1]).not.toBe(second.groups[1]);
  });

  it('draws opaque items first, then transparent ones back to front', () => {
    const { render, log } = setup();
    const opaque = new Material({ graph: colorGraph(), label: 'opaque' });
    const glass = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'blend' },
      label: 'glass',
    });
    render([
      { mesh: triangle(), material: glass, transform: transformAt(0, 5) },
      { mesh: triangle(), material: opaque, transform: transformAt(0) },
      { mesh: triangle(), material: glass, transform: transformAt(0, -5) },
    ]);
    expect(log.draws.map((draw) => draw.pipeline)).toEqual([
      'opaque',
      'glass',
      'glass',
    ]);
    // Object buffers are created in draw order: the opaque one, then the far
    // transparent one (z = -5, 15 from the camera), then the near one.
    const objectBuffers = log.buffers.filter(
      (b) => b.label === 'object uniforms'
    );
    expect(objectBuffers.map((b) => floatsOf(b)[14])).toEqual([0, -5, 5]);
    expect(log.draws[1].groups[2]).not.toBe(log.draws[2].groups[2]);
  });

  it('derives the pipeline state from the render state', () => {
    const { render, log } = setup();
    render([
      {
        mesh: triangle(),
        material: new Material({
          graph: colorGraph(),
          renderState: {
            doubleSided: true,
            alphaMode: 'blend',
            depthWrite: false,
          },
        }),
        transform: transformAt(0),
      },
    ]);
    const [pipeline] = log.pipelines;
    expect(pipeline.primitive.cullMode).toBe('none');
    expect(pipeline.depthStencil).toEqual({
      format: 'depth24plus',
      depthWrite: false,
      depthCompare: 'less',
    });
    expect(pipeline.targets[0].blend).toBeDefined();
  });
});

describe('Material', () => {
  it('falls back on the defaults of the graph', () => {
    const material = new Material({ graph: colorGraph() });
    expect(material.getValue('color')).toEqual([1, 0, 0]);
    material.setValue('color', [0, 1, 0]);
    expect(material.getValue('color')).toEqual([0, 1, 0]);
    expect(material.version).toBe(1);
  });
});

describe('Mesh', () => {
  it('checks the data against the description', () => {
    const description = triangle().description;
    expect(() => new Mesh({ description, vertices: [] })).toThrow(
      /describes 1 vertex buffers but 0/
    );
    expect(
      () => new Mesh({ description, vertices: [new Float32Array(15)] })
    ).toThrow(/no indices were given/);
    expect(
      () =>
        new Mesh({
          description,
          vertices: [new Float32Array(15)],
          indices: new Uint32Array([0, 1, 2]),
        })
    ).toThrow(/must be a Uint16Array/);
  });

  it('versions vertex updates', () => {
    const mesh = triangle();
    mesh.setVertices(0, new Float32Array(15));
    expect(mesh.version).toBe(1);
    expect(() => mesh.setVertices(1, new Float32Array(1))).toThrow(
      /no vertex buffer 1/
    );
  });
});
