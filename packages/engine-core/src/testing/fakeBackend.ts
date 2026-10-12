import {
  BackendCapabilities,
  ObjectTableDescriptor,
  CameraMath,
  GpuBindGroupEntry,
  GpuBuffer,
  GpuRenderTarget,
  GpuTextureConfiguration,
  matchVertexLayout,
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  RenderBackend,
  RenderPipelineDescriptor,
  Surface,
  TransformMath,
} from '@fdw/engine-backend';
import {
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  ShaderType,
  std,
} from '@fdw/engine-shader';
import { Mesh } from '../render/Mesh';

// Test helpers shared by the tests and the benchmarks of engine-core: not
// part of the library.

// --- A fake backend recording what the renderer asks for ----------------------

export class FakeBuffer implements GpuBuffer {
  readonly usage = [];
  writes = 0;
  data = new ArrayBuffer(0);
  destroyed = false;
  constructor(readonly size: number, readonly label?: string) {}
  write(_: number, value: ArrayBuffer): void {
    this.writes++;
    this.data = value.slice(0);
  }
  async read(): Promise<ArrayBuffer> {
    return this.data.slice(0);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export const sizeOf = (type: ShaderType): number =>
  type.kind === 'matrix'
    ? 64
    : type.kind === 'array'
    ? sizeOf(type.element) * (type.length ?? 0)
    : 16;

// Every member in its own 16-byte slot (64 for matrices, 16 per element of
// arrays), values as floats.
export const layoutStrategy: PhysicalLayoutStrategy = {
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
          const size = sizeOf(member.type);
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

// The projection of every fake camera: orthographic, 2000 units wide and
// deep, looking down -z with the depth from 0 to 1. Large enough for the
// objects of the tests, real enough for the culling.
export const fakeProjection = Float32Array.of(
  0.001,
  0,
  0,
  0,
  0,
  0.001,
  0,
  0,
  0,
  0,
  -0.0005,
  0,
  0,
  0,
  0.5,
  1
);

// a × b, column-major.
const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
};

// The view is a translation by -position (no rotation).
const cameraMath = {
  getViewMatrix: (position: ArrayLike<number>) =>
    translation([-position[0], -position[1], -position[2]]),
  getProjectionMatrix: () => fakeProjection,
  getViewProjectionMatrix: (view: Float32Array, projection: Float32Array) =>
    multiply(projection, view),
} as unknown as CameraMath;

// The floats of a row of an object table: the world matrix, then the
// normal matrix as three columns of vec4.
const RowFloats = 28;

/** The row `index` written to the object tables of a fake backend. */
export const rowOf = (
  log: { readonly rows: Float32Array },
  index: number
): Float32Array =>
  log.rows.subarray(index * RowFloats, (index + 1) * RowFloats);

export function fakeBackend(capabilities?: BackendCapabilities) {
  const log = {
    buffers: [] as FakeBuffer[],
    objectTables: [] as { rows: number; instances: number }[],
    // The rows written to the object tables, 28 floats each (rowOf).
    rows: new Float32Array(0),
    rowWrites: [] as { first: number; bytes: number }[],
    instanceWrites: [] as { first: number; count: number }[],
    // A view of the rows of the last write: read it right after the frame.
    lastInstances: new Uint32Array() as Uint32Array,
    pipelines: [] as RenderPipelineDescriptor[],
    bindGroups: [] as { key: string; entries: readonly GpuBindGroupEntry[] }[],
    draws: [] as {
      pipeline: string;
      groups: Record<number, unknown>;
      count: number;
      indexed: boolean;
      instances?: number;
      firstInstance?: number;
    }[],
    submits: 0,
    textures: [] as GpuTextureConfiguration[],
    renderPasses: [] as string[],
    viewports: [] as number[][],
    calls: {
      setPipeline: 0,
      setBindGroup: 0,
      setVertexBuffer: 0,
      setIndexBuffer: 0,
    },
  };
  let current: (typeof log.draws)[number] | undefined;
  let boundGroups: Record<number, unknown> = {};
  let pipelineLabel = '';
  const layouts = new Map<string, PhysicalProgramLayout>();

  const backend: RenderBackend = {
    buffers: {
      create: ({ size, label }) => {
        const buffer = new FakeBuffer(size, label);
        log.buffers.push(buffer);
        return buffer;
      },
    },
    textures: {
      createTexture: (descriptor) => {
        log.textures.push(descriptor);
        return { ...descriptor, destroy: () => undefined };
      },
      writeTexture: () => undefined,
      createSampler: () => ({ destroy: () => undefined }),
    } as RenderBackend['textures'],
    pipelines: {
      codegen: {} as RenderBackend['pipelines']['codegen'],
      layoutStrategy,
      // Cached by program, as in the real backends.
      resolveLayout: (program) => {
        let layout = layouts.get(program.programKey);
        if (!layout) {
          layout = layoutStrategy.resolve(program.layout);
          layouts.set(program.programKey, layout);
        }
        return layout;
      },
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
      createRenderPipelineAsync: async (descriptor) => {
        log.pipelines.push(descriptor);
        return {
          label: descriptor.label,
          vertexBuffers: matchVertexLayout(
            descriptor.program.vertexInputs,
            descriptor.vertex
          ).map((b) => b.buffer),
        };
      },
      createComputePipeline: () => {
        throw new Error('no compute in the fake backend');
      },
      createComputePipelineAsync: async () => {
        throw new Error('no compute in the fake backend');
      },
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
    capabilities,
    // An object table recording its writes.
    createObjectTable: ({ rows, instances }: ObjectTableDescriptor) => {
      log.objectTables.push({ rows, instances });
      return {
        rows,
        instances,
        writeRows: (first: number, data: ArrayBufferView) => {
          log.rowWrites.push({ first, bytes: data.byteLength });
          // A copy of the rows written, 28 floats each.
          const floats = new Float32Array(
            data.buffer,
            data.byteOffset,
            data.byteLength / 4
          );
          const end = first * RowFloats + floats.length;
          if (end > log.rows.length) {
            const grown = new Float32Array(Math.max(end, log.rows.length * 2));
            grown.set(log.rows);
            log.rows = grown;
          }
          log.rows.set(floats, first * RowFloats);
        },
        // The rows of the last write; the count of every write.
        writeInstances: (first: number, rows: Uint32Array) => {
          log.instanceWrites.push({ first, count: rows.length });
          log.lastInstances = rows;
        },
        destroy: () => undefined,
      };
    },
    createRenderTarget: ({ width, height, format }) => ({
      width,
      height,
      format,
      destroy: () => undefined,
    }),
    createCommandEncoder: () => ({
      beginComputePass: () => {
        throw new Error('no compute in the fake backend');
      },
      copyBufferToBuffer: () => undefined,
      copyTextureToTexture: () => undefined,
      beginRenderPass: (descriptor) => {
        log.renderPasses.push(descriptor.label ?? '');
        return {
          setPipeline: (pipeline) => {
            log.calls.setPipeline++;
            pipelineLabel = pipeline.label ?? '';
            boundGroups = {};
          },
          setBindGroup: (index, group) => {
            log.calls.setBindGroup++;
            return (boundGroups[index] = group);
          },
          setVertexBuffer: () => {
            log.calls.setVertexBuffer++;
            return undefined;
          },
          setIndexBuffer: () => {
            log.calls.setIndexBuffer++;
            return undefined;
          },
          setViewport: (x, y, width, height) =>
            log.viewports.push([x, y, width, height]),
          draw: (count, instances = 1, firstInstance = 0) => {
            current = {
              pipeline: pipelineLabel,
              groups: { ...boundGroups },
              count,
              indexed: false,
              instances,
              firstInstance,
            };
            log.draws.push(current);
          },
          drawIndexed: (count, instances = 1, firstInstance = 0) => {
            current = {
              pipeline: pipelineLabel,
              groups: { ...boundGroups },
              count,
              indexed: true,
              instances,
              firstInstance,
            };
            log.draws.push(current);
          },
          end: () => undefined,
        };
      },
      finish: () => ({}),
    }),
    submit: () => log.submits++,
  };
  return { backend, log };
}

export const target: GpuRenderTarget = {
  width: 4,
  height: 4,
  format: 'rgba8unorm',
};
export const surface: Surface = {
  width: 4,
  height: 4,
  format: 'rgba8unorm',
  init: async () => undefined,
  getCurrentTarget: () => target,
  present: () => undefined,
};

// --- Scene helpers -------------------------------------------------------------

export const triangle = () =>
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

export const colorGraph = (name = 'color'): MaterialGraphData => {
  const g = new GraphBuilder(name);
  g.surface({
    baseColor: g.uniform('color', BuiltinTypes.vec3f, { default: [1, 0, 0] }),
  });
  return g.build();
};

export const texturedGraph = (): MaterialGraphData => {
  const g = new GraphBuilder('textured');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', BuiltinTypes.vec2f),
  });
  g.surface({ baseColor: texel.swizzle('rgb') });
  return g.build();
};
