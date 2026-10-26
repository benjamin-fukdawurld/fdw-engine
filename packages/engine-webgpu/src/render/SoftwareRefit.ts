// The refits of the dynamic software bottom levels (their vertices moved
// on the GPU: a skinning), in compute passes: the triangles of the pool
// rewritten from the vertices, then the boxes of the nodes, level by
// level from the deepest, each node taking the boxes of its two children.
// Their topology is that of their first build: a refit BVH stays correct,
// slower to traverse the further the vertices go from where they were.

const code = /* wgsl */ `
struct Params {
  // The first entry of the step in the refit data, its number of entries.
  first: u32,
  count: u32,
  // Where the vertices are in the buffer, and their stride, in floats.
  offset: u32,
  stride: u32,
  // The vec4 of the first triangle of the level in the pool.
  triangles: u32,
};

@group(0) @binding(0) var<storage, read_write> pool: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> refit: array<u32>;
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

fn position(vertex: u32) -> vec3<f32> {
  let at = params.offset + vertex * params.stride;
  return vec3<f32>(vertices[at], vertices[at + 1u], vertices[at + 2u]);
}

// A triangle of the pool per thread, from the indices of its vertices.
@compute @workgroup_size(64)
fn triangles(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= params.count) {
    return;
  }
  let p0 = position(refit[params.first + k * 3u]);
  let p1 = position(refit[params.first + k * 3u + 1u]);
  let p2 = position(refit[params.first + k * 3u + 2u]);
  let at = params.triangles + k * 3u;
  pool[at] = vec4<f32>(p0, pool[at].w);
  pool[at + 1u] = vec4<f32>(p1 - p0, pool[at + 1u].w);
  pool[at + 2u] = vec4<f32>(p2 - p0, pool[at + 2u].w);
}

struct Box {
  low: vec3<f32>,
  high: vec3<f32>,
};

// The box of a child: of the triangles of a leaf, or of the two boxes of
// a node.
fn child(reference: u32, count: u32) -> Box {
  if (count == 0u) {
    return Box(
      min(pool[reference].xyz, pool[reference + 2u].xyz),
      max(pool[reference + 1u].xyz, pool[reference + 3u].xyz),
    );
  }
  var box = Box(vec3<f32>(3.0e38), vec3<f32>(-3.0e38));
  for (var t = 0u; t < count; t = t + 1u) {
    let at = reference + t * 3u;
    let v0 = pool[at].xyz;
    let v1 = v0 + pool[at + 1u].xyz;
    let v2 = v0 + pool[at + 2u].xyz;
    box.low = min(box.low, min(v0, min(v1, v2)));
    box.high = max(box.high, max(v0, max(v1, v2)));
  }
  return box;
}

// A node of a level per thread: the boxes of its children.
@compute @workgroup_size(64)
fn nodes(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= params.count) {
    return;
  }
  let at = refit[params.first + k];
  let a0 = pool[at];
  let a1 = pool[at + 1u];
  let b0 = pool[at + 2u];
  let b1 = pool[at + 3u];
  let left = child(bitcast<u32>(a0.w), bitcast<u32>(a1.w));
  let right = child(bitcast<u32>(b0.w), bitcast<u32>(b1.w));
  pool[at] = vec4<f32>(left.low, a0.w);
  pool[at + 1u] = vec4<f32>(left.high, a1.w);
  pool[at + 2u] = vec4<f32>(right.low, b0.w);
  pool[at + 3u] = vec4<f32>(right.high, b1.w);
}
`;

/** The pipelines of the refits of a device. */
export class SoftwareRefitPipelines {
  readonly layout: GPUBindGroupLayout;
  readonly triangles: GPUComputePipeline;
  readonly nodes: GPUComputePipeline;

  constructor(readonly device: GPUDevice) {
    const storage = (type: GPUBufferBindingType, binding: number) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    });
    this.layout = device.createBindGroupLayout({
      label: 'refit',
      entries: [
        storage('storage', 0),
        storage('read-only-storage', 1),
        storage('read-only-storage', 2),
        storage('uniform', 3),
      ],
    });
    const module = device.createShaderModule({ label: 'refit', code });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [this.layout],
    });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({
        label: `refit ${entryPoint}`,
        layout,
        compute: { module, entryPoint },
      });
    this.triangles = pipeline('triangles');
    this.nodes = pipeline('nodes');
  }
}

/** Words of the Params of a step. */
const ParamWords = 8;

/**
 * What a dynamic bottom level keeps to be refit: the indices of the
 * vertices of its triangles (in the order of the pool), the offsets of its
 * nodes by level, the parameters of each step.
 */
export class SoftwareRefit {
  private readonly _data: GPUBuffer;
  private readonly _params: GPUBuffer;
  // Per step (the triangles, then each level from the deepest): its
  // entries in the data.
  private readonly _steps: { first: number; count: number }[];
  private readonly _words: Uint32Array<ArrayBuffer>;
  private _source = '';

  /**
   * `indices`: 3 per triangle, in the order of the pool; `levels`: the
   * offsets of the nodes in the pool, by depth from the root.
   */
  constructor(
    private readonly pipelines: SoftwareRefitPipelines,
    private readonly triangleStart: number,
    indices: Uint32Array,
    levels: readonly (readonly number[])[],
  ) {
    const device = pipelines.device;
    const nodes = levels.flat().length;
    const data = new Uint32Array(Math.max(1, indices.length + nodes));
    data.set(indices);
    this._steps = [{ first: 0, count: indices.length / 3 }];
    let first = indices.length;
    for (let depth = levels.length - 1; depth >= 0; depth--) {
      data.set(levels[depth], first);
      this._steps.push({ first, count: levels[depth].length });
      first += levels[depth].length;
    }
    this._data = device.createBuffer({
      label: 'refit data',
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._data, 0, data);
    // A uniform block per step, 256 bytes apart (dynamic offsets aside,
    // the alignment of the bindings).
    this._params = device.createBuffer({
      label: 'refit params',
      size: this._steps.length * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._words = new Uint32Array(this._steps.length * 64);
  }

  /** Records the refit from the vertices of a buffer (bytes). */
  record(
    encoder: GPUCommandEncoder,
    pool: GPUBuffer,
    vertices: GPUBuffer,
    offset: number,
    stride: number,
  ): void {
    if (offset % 4 !== 0 || stride % 4 !== 0) {
      throw new Error('The vertices of a refit are aligned to 4 bytes');
    }
    const source = `${offset},${stride}`;
    if (source !== this._source) {
      this._source = source;
      this._steps.forEach(({ first, count }, step) => {
        this._words.set(
          [first, count, offset / 4, stride / 4, this.triangleStart],
          step * 64,
        );
      });
      this.pipelines.device.queue.writeBuffer(this._params, 0, this._words);
    }
    const pass = encoder.beginComputePass({ label: 'refit' });
    this._steps.forEach(({ count }, step) => {
      if (count === 0) {
        return;
      }
      pass.setPipeline(
        step === 0 ? this.pipelines.triangles : this.pipelines.nodes,
      );
      pass.setBindGroup(
        0,
        this.pipelines.device.createBindGroup({
          layout: this.pipelines.layout,
          entries: [
            { binding: 0, resource: { buffer: pool } },
            { binding: 1, resource: { buffer: this._data } },
            { binding: 2, resource: { buffer: vertices } },
            {
              binding: 3,
              resource: {
                buffer: this._params,
                offset: step * 256,
                size: ParamWords * 4,
              },
            },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(count / 64));
    });
    pass.end();
  }

  destroy(): void {
    this._data.destroy();
    this._params.destroy();
  }
}
