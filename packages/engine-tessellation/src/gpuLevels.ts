import type {
  GpuBuffer,
  GpuComputePassEncoder,
  RenderBackend,
} from '@fdw/engine-backend';
import {
  ComputeRunner,
  ComputeWorkgroup,
  computeGraph,
  finishComputeGraph,
  recordPrefixSum,
  scanGraph,
} from '@fdw/engine-core';
import { arrayType, BuiltinTypes, compile, std } from '@fdw/engine-shader';
import type { CompiledProgram, PortHandle } from '@fdw/engine-shader';
import { DrawHeader } from './graph';
import { MaxLevel, Patches } from './patches';

// The choice of the levels of a PatchSurface on the GPU
// (design/p24-gpu-driven.md §3.6): what LevelSelection and
// PatchSurface.writeDraws do on the CPU, in compute graphs without atomics.
//
// 1. The level of each edge (a thread per edge), as on the CPU.
// 2. The flags (a thread per level and patch, level-major): 1 where the
//    patch is in view and at that level, the finest of its edges.
// 3. Their prefix sum: the rank of each patch drawn, sorted by level.
// 4. The starts (one thread): the patches at each level, the finest level
//    that keeps the vertices under MaxVertices (the CPU lowers maxLevel
//    until they are), the first vertex and the first draw of each level in
//    the header of the buffer of the draws, and the vertex count.
// 5. The draws (a thread per level and patch): each patch drawn at its
//    rank, with the steps of its edges.

/** The vertices the shader reads exactly: the vertex index goes through an f32. */
export const MaxVertices = 2 ** 24;

const Levels = MaxLevel + 1;
const prefix = 'patch levels';
const u32Array = arrayType(BuiltinTypes.u32);
const vec4Array = arrayType(BuiltinTypes.vec4f);
const vec4uArray = arrayType(BuiltinTypes.vec4u);

type Graph = ReturnType<typeof computeGraph>;

// p.xyz through the world matrix.
const toWorld = ({ g }: Graph, point: PortHandle) =>
  g
    .call(std.transform, {
      matrix: g.uniform('world', BuiltinTypes.mat4f),
      vector: g.call(std.extend, { xyz: point, w: 1 }),
    })
    .swizzle('xyz');

/** edgeLevels[e]: the level of each edge, by its length on the screen. */
function edgesGraph() {
  const graph = computeGraph('edges', prefix);
  const { g, o, index } = graph;
  const ends = g.storage('ends', vec4Array);
  const a = toWorld(graph, o.index(ends, o.mul(index, 2)).swizzle('xyz'));
  const b = toWorld(
    graph,
    o.index(ends, o.add(o.mul(index, 2), 1)).swizzle('xyz'),
  );
  // xyz: the camera; w: 1 for an orthographic projection.
  const camera = g.uniform('camera', BuiltinTypes.vec4f);
  const c = camera.swizzle('xyz');
  const d = o.sub(b, a);
  const lengthSquared = o.dot(d, d);
  const along = o.select(
    0,
    g.call(std.clamp, {
      x: o.div(o.dot(o.sub(c, a), d), o.max(lengthSquared, 1e-30)),
      low: 0,
      high: 1,
    }),
    o.greaterEqual(lengthSquared, 1e-30),
  );
  const toClosest = o.sub(o.add(a, o.mul(d, along)), c);
  const distance = o.select(
    o.max(g.call(std.length, { x: toClosest }), 1e-6),
    1,
    o.equal(camera.swizzle('w'), 1),
  );
  const segments = o.div(
    o.mul(
      g.call(std.sqrt, { x: lengthSquared }),
      g.uniform('perPixel', BuiltinTypes.f32),
    ),
    distance,
  );
  // ceil(log2(segments)) = -floor(-log2(segments)), where segments > 1.
  const level = o.select(
    g.constant(BuiltinTypes.f32, 0),
    o.mul(
      g.call(std.floor, {
        x: o.mul(g.call(std.log2, { x: segments }), -1),
      }),
      -1,
    ),
    o.less(g.constant(BuiltinTypes.f32, 1), segments),
  );
  // minLevel, maxLevel, grow, cull.
  const options = g.uniform('options', BuiltinTypes.vec4f);
  const clamped = g.call(std.clamp, {
    x: level,
    low: options.swizzle('x'),
    high: options.swizzle('y'),
  });
  g.write(g.storage('edgeLevels', u32Array, { access: 'read-write' }), {
    index,
    value: g.call(
      std.convert,
      { value: clamped },
      { params: { to: BuiltinTypes.u32 } },
    ),
    when: o.less(index, g.uniform('count', BuiltinTypes.u32)),
  });
  return finishComputeGraph(g);
}

// The finest level of the edges of a patch (u32), and the levels of its
// four edges.
function patchLevel({ g, o }: Graph, patch: PortHandle) {
  const edges = o.index(g.storage('patchEdges', vec4uArray), patch);
  const levels = g.storage('edgeLevels', u32Array);
  const edgeLevels = (['x', 'y', 'z', 'w'] as const).map((axis) =>
    o.index(levels, edges.swizzle(axis)),
  );
  const level = o.max(
    o.max(edgeLevels[0], edgeLevels[1]),
    o.max(edgeLevels[2], edgeLevels[3]),
  );
  return { level, edgeLevels };
}

/** flags[level × patches + patch]: 1 where the patch is drawn at that level. */
function flagsGraph() {
  const graph = computeGraph('flags', prefix);
  const { g, o, index } = graph;
  const patches = g.uniform('patches', BuiltinTypes.u32);
  const level = o.div(index, patches);
  const patch = o.remainder(index, patches);
  const boxes = g.storage('boxes', vec4Array);
  const low = o.index(boxes, o.mul(patch, 2)).swizzle('xyz');
  const high = o.index(boxes, o.add(o.mul(patch, 2), 1)).swizzle('xyz');
  // The box through the world matrix, grown by the displacement.
  const world = g.uniform('world', BuiltinTypes.mat4f);
  const options = g.uniform('options', BuiltinTypes.vec4f);
  const center = toWorld(graph, o.mul(o.add(low, high), 0.5));
  const half = o.mul(o.sub(high, low), 0.5);
  const column = (k: number) =>
    o.abs(
      g
        .call(std.transform, {
          matrix: world,
          vector: g.call(std.vec4, {
            x: k === 0 ? 1 : 0,
            y: k === 1 ? 1 : 0,
            z: k === 2 ? 1 : 0,
            w: 0,
          }),
        })
        .swizzle('xyz'),
    );
  const extent = o.add(
    o.add(
      o.add(
        o.mul(column(0), half.swizzle('x')),
        o.mul(column(1), half.swizzle('y')),
      ),
      o.mul(column(2), half.swizzle('z')),
    ),
    options.swizzle('z'),
  );
  let inside: PortHandle | boolean = true;
  for (let p = 0; p < 6; p++) {
    const plane = g.uniform(`plane${p}`, BuiltinTypes.vec4f);
    const normal = plane.swizzle('xyz');
    const side = o.greaterEqual(
      o.add(
        o.add(o.dot(normal, center), plane.swizzle('w')),
        o.dot(o.abs(normal), extent),
      ),
      0,
    );
    inside = p === 0 ? side : o.and(inside, side);
  }
  const visible = o.or(o.equal(options.swizzle('w'), 0), inside);
  const drawn = o.and(visible, o.equal(patchLevel(graph, patch).level, level));
  g.write(g.storage('flags', u32Array, { access: 'read-write' }), {
    index,
    value: o.select(o.u32(0), o.u32(1), drawn),
    when: o.less(index, o.mul(patches, Levels)),
  });
  return finishComputeGraph(g);
}

/**
 * The header of the draws (the first vertex and the first draw of each
 * level), the vertex count (counts[0]) and the finest level (counts[1]),
 * by one thread.
 */
function startsGraph() {
  const { g, o, index, previous } = computeGraph('starts', prefix);
  const sum = g.storage('sum', u32Array);
  const patches = g.uniform('patches', BuiltinTypes.u32);
  const maxLevel = g.uniform('options', BuiltinTypes.vec4f).swizzle('y');
  const f = (value: number) => g.constant(BuiltinTypes.f32, value);
  // The patches at each level, as floats (exact up to 2^24).
  const counts = Array.from({ length: Levels }, (_, level) =>
    o.f32(
      o.sub(
        previous(sum, o.mul(patches, level + 1)),
        previous(sum, o.mul(patches, level)),
      ),
    ),
  );
  // The vertices with the levels capped at k: those above drawn at k.
  const totalAt = (k: number) => {
    let total: PortHandle = f(0);
    let above: PortHandle = f(0);
    for (let level = 0; level < Levels; level++) {
      if (level < k) {
        total = o.add(total, o.mul(counts[level], 6 * 4 ** level));
      } else {
        above = o.add(above, counts[level]);
      }
    }
    return o.add(total, o.mul(above, 6 * 4 ** k));
  };
  // The finest cap within maxLevel that fits, else 0.
  let cap: PortHandle = f(0);
  for (let k = 1; k < Levels; k++) {
    cap = o.select(
      cap,
      f(k),
      o.and(o.lessEqual(k, maxLevel), o.lessEqual(totalAt(k), MaxVertices)),
    );
  }
  // The counts with the cap.
  const capped = counts.map((count, level) => {
    let above: PortHandle = count;
    for (let finer = level + 1; finer < Levels; finer++) {
      above = o.add(above, counts[finer]);
    }
    return o.select(
      o.select(f(0), above, o.equal(cap, level)),
      count,
      o.less(level, cap),
    );
  });
  const vertexStarts: PortHandle[] = [];
  const drawStarts: PortHandle[] = [];
  let vertex: PortHandle = f(0);
  let draw: PortHandle = f(0);
  for (let level = 0; level < Levels; level++) {
    vertexStarts.push(vertex);
    drawStarts.push(draw);
    vertex = o.add(vertex, o.mul(capped[level], 6 * 4 ** level));
    draw = o.add(draw, capped[level]);
  }
  // Past the last level: never reached.
  vertexStarts.push(f(1e30));
  drawStarts.push(draw);
  const vec4 = (v: PortHandle[]) =>
    g.call(std.vec4, { x: v[0], y: v[1], z: v[2], w: v[3] });
  const first = o.equal(index, 0);
  const draws = g.storage('draws', vec4Array, { access: 'read-write' });
  const header = [
    vec4(vertexStarts.slice(0, 4)),
    vec4(vertexStarts.slice(4, 8)),
    vec4(drawStarts.slice(0, 4)),
    vec4(drawStarts.slice(4, 8)),
  ];
  header.forEach((value, at) =>
    g.write(draws, { index: o.u32(at), value, when: first }),
  );
  const u32 = (value: PortHandle) =>
    g.call(std.convert, { value }, { params: { to: BuiltinTypes.u32 } });
  const out = g.storage('counts', u32Array, { access: 'read-write' });
  g.write(out, { index: o.u32(0), value: u32(vertex), when: first });
  g.write(out, { index: o.u32(1), value: u32(cap), when: first });
  return finishComputeGraph(g);
}

/** The draws: each patch at its rank, with the steps of its edges. */
function drawsGraph() {
  const graph = computeGraph('draws', prefix);
  const { g, o, index, previous } = graph;
  const patches = g.uniform('patches', BuiltinTypes.u32);
  const patch = o.remainder(index, patches);
  const sum = g.storage('sum', u32Array);
  const through = o.index(sum, index);
  const drawn = o.equal(o.sub(through, previous(sum, index)), 1);
  const cap = o.index(g.storage('counts', u32Array), o.u32(1));
  const { level, edgeLevels } = patchLevel(graph, patch);
  const capped = o.min(level, cap);
  // 2^(level of the patch − level of the edge), both capped.
  const step = (edge: PortHandle) =>
    g.call(std.exp2, { x: o.f32(o.sub(capped, o.min(edge, cap))) });
  const value = g.call(std.vec4, {
    x: o.f32(patch),
    y: o.add(step(edgeLevels[0]), o.mul(step(edgeLevels[1]), 128)),
    z: o.add(step(edgeLevels[2]), o.mul(step(edgeLevels[3]), 128)),
    w: 0,
  });
  g.write(g.storage('draws', vec4Array, { access: 'read-write' }), {
    index: o.add(through, DrawHeader - 1),
    value,
    when: o.and(o.less(index, o.mul(patches, Levels)), drawn),
  });
  return finishComputeGraph(g);
}

interface Programs {
  readonly edges: CompiledProgram;
  readonly flags: CompiledProgram;
  readonly scan: CompiledProgram;
  readonly starts: CompiledProgram;
  readonly draws: CompiledProgram;
}

/** What the levels are chosen from, in a frame: see GpuLevels.record. */
export interface GpuLevelView {
  // Column-major.
  readonly world: ArrayLike<number>;
  readonly camera: readonly [number, number, number];
  readonly orthographic: boolean;
  // Pixels per world unit at a distance of 1, over the pixels of an edge
  // of a triangle.
  readonly perPixel: number;
  readonly minLevel: number;
  readonly maxLevel: number;
  // How far the displacement moves the points, in world units.
  readonly grow: number;
  // The planes of the frustum (left, right, bottom, top, near, far), or
  // undefined: every patch drawn.
  readonly planes?: ArrayLike<number>;
}

/**
 * The levels of the patches of a surface chosen on the GPU, for the
 * backends with compute shaders and indirect draws: writes the buffer of
 * the draws its material reads (`draws`) and the vertex count of its draw
 * (`counts`, a u32 at 0, see Mesh.setGpuVertexCount).
 */
export class GpuLevels {
  readonly draws: GpuBuffer;
  readonly counts: GpuBuffer;
  private readonly _runner: ComputeRunner;
  private readonly _buffers: GpuBuffer[] = [];
  private readonly _ends: GpuBuffer;
  private readonly _patchEdges: GpuBuffer;
  private readonly _boxes: GpuBuffer;
  private readonly _edgeLevels: GpuBuffer;
  private readonly _flags: GpuBuffer;
  private readonly _sums: [GpuBuffer, GpuBuffer];
  private readonly _steps: object[] = [];
  private _programs?: Programs;

  constructor(
    private readonly _backend: RenderBackend,
    readonly patches: Patches,
    draws: GpuBuffer,
    label: string,
  ) {
    this._runner = new ComputeRunner(_backend);
    this.draws = draws;
    const whole = (n: number) =>
      Math.ceil(n / ComputeWorkgroup) * ComputeWorkgroup;
    const create = (
      size: number,
      name: string,
      data?: ArrayBufferView<ArrayBuffer>,
      usage: readonly ('storage' | 'copy-dst' | 'copy-src')[] = [
        'storage',
        'copy-dst',
      ],
    ) => {
      const buffer = _backend.buffers.create({
        size: Math.max(size, 256),
        usage: [...usage],
        label: `${label} ${name}`,
        ...(data ? { initialData: data } : {}),
      });
      this._buffers.push(buffer);
      return buffer;
    };
    const edges = patches.edgeCount;
    // The ends of the edges and the boxes of the patches, as vec4f.
    const ends = new Float32Array(whole(edges) * 8);
    for (let e = 0; e < edges; e++) {
      ends.set(patches.edgeEnds.subarray(e * 6, e * 6 + 3), e * 8);
      ends.set(patches.edgeEnds.subarray(e * 6 + 3, e * 6 + 6), e * 8 + 4);
    }
    const count = patches.count;
    const boxes = new Float32Array(whole(count) * 8);
    for (let p = 0; p < count; p++) {
      boxes.set(patches.boxes.subarray(p * 6, p * 6 + 3), p * 8);
      boxes.set(patches.boxes.subarray(p * 6 + 3, p * 6 + 6), p * 8 + 4);
    }
    const patchEdges = new Uint32Array(whole(count) * 4);
    patchEdges.set(patches.edges);
    this._ends = create(ends.byteLength, 'edge ends', ends);
    this._boxes = create(boxes.byteLength, 'boxes', boxes);
    this._patchEdges = create(patchEdges.byteLength, 'edges', patchEdges);
    this._edgeLevels = create(whole(edges) * 4, 'edge levels');
    const flags = whole(count * Levels) * 4;
    this._flags = create(flags, 'flags');
    this._sums = [create(flags, 'sums 0'), create(flags, 'sums 1')];
    this.counts = create(16, 'counts', undefined, [
      'storage',
      'copy-dst',
      'copy-src',
    ]);
  }

  /** Records the choice of the levels for a view into a compute pass. */
  record(pass: GpuComputePassEncoder, view: GpuLevelView): void {
    const programs = this.programs();
    const step = (k: number) => {
      while (this._steps.length <= k) {
        this._steps.push({});
      }
      return this._steps[k];
    };
    const groups = (n: number) => [Math.ceil(n / ComputeWorkgroup)] as const;
    const patches = this.patches.count;
    const edges = this.patches.edgeCount;
    const planes: Record<string, number[]> = {};
    for (let p = 0; p < 6; p++) {
      planes[`plane${p}`] = view.planes
        ? Array.from({ length: 4 }, (_, i) => view.planes?.[p * 4 + i] ?? 0)
        : [0, 0, 0, 1];
    }
    const common = {
      world: Array.from(view.world),
      camera: [...view.camera, view.orthographic ? 1 : 0],
      perPixel: view.perPixel,
      options: [view.minLevel, view.maxLevel, view.grow, view.planes ? 1 : 0],
      patches,
      ...planes,
    };
    this._runner.record(pass, programs.edges, {
      values: {
        ...common,
        ends: this._ends,
        edgeLevels: this._edgeLevels,
        count: edges,
      },
      workgroups: groups(edges),
      owner: step(0),
    });
    const flags = patches * Levels;
    this._runner.record(pass, programs.flags, {
      values: {
        ...common,
        boxes: this._boxes,
        patchEdges: this._patchEdges,
        edgeLevels: this._edgeLevels,
        flags: this._flags,
      },
      workgroups: groups(flags),
      owner: step(1),
    });
    const sum = recordPrefixSum(
      this._runner,
      pass,
      programs.scan,
      this._flags,
      this._sums,
      flags,
      (k) => step(2 + k),
    );
    const k = 2 + Math.ceil(Math.log2(flags));
    this._runner.record(pass, programs.starts, {
      values: { ...common, sum, draws: this.draws, counts: this.counts },
      workgroups: [1],
      owner: step(k),
    });
    this._runner.record(pass, programs.draws, {
      values: {
        ...common,
        sum,
        patchEdges: this._patchEdges,
        edgeLevels: this._edgeLevels,
        counts: this.counts,
        draws: this.draws,
      },
      workgroups: groups(flags),
      owner: step(k + 1),
    });
  }

  /** Chooses the levels in a submission of its own. */
  dispatch(view: GpuLevelView): void {
    const encoder = this._backend.createCommandEncoder();
    const pass = encoder.beginComputePass(prefix);
    this.record(pass, view);
    pass.end();
    this._backend.submit([encoder.finish()]);
  }

  destroy(): void {
    this._buffers.forEach((buffer) => buffer.destroy());
    this._runner.destroy();
  }

  private programs(): Programs {
    if (!this._programs) {
      const build = (graph: ReturnType<typeof finishComputeGraph>) =>
        compile(graph, { capabilities: this._backend.capabilities });
      this._programs = {
        edges: build(edgesGraph()),
        flags: build(flagsGraph()),
        scan: build(scanGraph(prefix)),
        starts: build(startsGraph()),
        draws: build(drawsGraph()),
      };
    }
    return this._programs;
  }
}
