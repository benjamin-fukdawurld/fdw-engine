import type {
  GpuBuffer,
  GpuComputePassEncoder,
  GpuObjectTable,
  RenderBackend,
} from '@fdw/engine-backend';
import type { Aabb } from '@fdw/engine-geometry';
import {
  arrayType,
  BuiltinTypes,
  compile,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import type {
  CompiledProgram,
  ConstantValue,
  PortHandle,
} from '@fdw/engine-shader';
import { ComputeRunner } from '../compute/ComputeRunner';

// The culling of the instances on the GPU (design/p24-gpu-driven.md §3.2):
// the candidates of the draws tested against the frustum, the visible ones
// compacted into the list of instances of the object table by a prefix sum
// (no atomics: the compiler has none), and the arguments of an indirect draw
// per run. One thread per candidate (per run for the arguments), in
// workgroups of 64.

const Workgroup = 64;
// The u32 of the arguments of a draw (drawIndexedIndirect; drawIndirect
// uses the first four).
export const ArgumentWords = 5;

const u32Array = arrayType(BuiltinTypes.u32);
const vec4Array = arrayType(BuiltinTypes.vec4f);
const vec4uArray = arrayType(BuiltinTypes.vec4u);

type Value = PortHandle | ConstantValue;

function setup(name: string) {
  const g = new GraphBuilder(`culling ${name}`);
  const index = g.builtin('global-invocation-id').swizzle('x');
  const call = (fn: Parameters<GraphBuilder['call']>[0], inputs: object) =>
    g.call(fn, inputs as Record<string, Value>);
  const o = {
    add: (a: Value, b: Value) => call(std.add, { a, b }),
    sub: (a: Value, b: Value) => call(std.sub, { a, b }),
    mul: (a: Value, b: Value) => call(std.mul, { a, b }),
    dot: (a: Value, b: Value) => call(std.dot, { a, b }),
    abs: (x: Value) => call(std.abs, { x }),
    less: (a: Value, b: Value) => call(std.less, { a, b }),
    greaterEqual: (a: Value, b: Value) => call(std.greaterEqual, { a, b }),
    equal: (a: Value, b: Value) => call(std.equal, { a, b }),
    select: (ifFalse: Value, ifTrue: Value, condition: Value) =>
      call(std.select, { ifFalse, ifTrue, condition }),
    index: (array: Value, at: Value) => call(std.index, { array, index: at }),
    u32: (value: number) => g.constant(BuiltinTypes.u32, value),
  };
  // a[i - 1] for i > 0, else 0, without reading before the array.
  const previous = (array: PortHandle, i: Value) => {
    const inside = o.greaterEqual(i, 1);
    return o.select(
      o.u32(0),
      o.index(array, o.select(o.u32(0), o.sub(i, 1), inside)),
      inside,
    );
  };
  return { g, o, index, previous };
}

function finish(g: GraphBuilder) {
  g.compute({ workgroupSize: [Workgroup, 1, 1] });
  return g.build();
}

/**
 * visible[i]: 1 if the box of candidate i (center, then half extents, two
 * vec4 each) is on the inner side of the six planes, else 0.
 */
function testGraph() {
  const { g, o, index } = setup('test');
  const boxes = g.storage('boxes', vec4Array);
  const center = o.index(boxes, o.mul(index, 2)).swizzle('xyz');
  const extent = o.index(boxes, o.add(o.mul(index, 2), 1)).swizzle('xyz');
  let inside: Value = true;
  for (let p = 0; p < 6; p++) {
    const plane = g.uniform(`plane${p}`, BuiltinTypes.vec4f);
    const normal = plane.swizzle('xyz');
    // The distance of the corner furthest along the normal.
    const distance = o.add(
      o.add(o.dot(normal, center), plane.swizzle('w')),
      o.dot(o.abs(normal), extent),
    );
    const side = o.greaterEqual(distance, 0);
    inside = p === 0 ? side : o.select(false, side, inside);
  }
  g.write(g.storage('visible', u32Array, { access: 'read-write' }), {
    index,
    value: o.select(o.u32(0), o.u32(1), inside),
    when: o.less(index, g.uniform('count', BuiltinTypes.u32)),
  });
  return finish(g);
}

/** A step of the prefix sum (Hillis and Steele): to[i] = from[i] + from[i - offset]. */
function scanGraph() {
  const { g, o, index } = setup('scan');
  const from = g.storage('from', u32Array);
  const offset = g.uniform('offset', BuiltinTypes.u32);
  const reaches = o.greaterEqual(index, offset);
  const before = o.select(
    o.u32(0),
    o.index(from, o.select(o.u32(0), o.sub(index, offset), reaches)),
    reaches,
  );
  g.write(g.storage('to', u32Array, { access: 'read-write' }), {
    index,
    value: o.add(o.index(from, index), before),
    when: o.less(index, g.uniform('count', BuiltinTypes.u32)),
  });
  return finish(g);
}

/** The rows of the visible candidates, compacted: instances[first + sum[i] - 1]. */
function scatterGraph() {
  const { g, o, index, previous } = setup('scatter');
  const sum = g.storage('sum', u32Array);
  const through = o.index(sum, index);
  const visible = o.equal(o.sub(through, previous(sum, index)), 1);
  const first = g.uniform('first', BuiltinTypes.u32);
  g.write(g.storage('instances', u32Array, { access: 'read-write' }), {
    index: o.sub(o.add(first, through), 1),
    value: o.index(g.storage('rows', u32Array), index),
    when: o.select(
      false,
      visible,
      o.less(index, g.uniform('count', BuiltinTypes.u32)),
    ),
  });
  return finish(g);
}

/**
 * The arguments of the draw of each run (start, end, vertex or index count,
 * indexed): its visible instances and the first of them.
 */
function argumentsGraph() {
  const { g, o, index, previous } = setup('arguments');
  const run = o.index(g.storage('runs', vec4uArray), index);
  const sum = g.storage('sum', u32Array);
  const before = previous(sum, run.swizzle('x'));
  const count = o.sub(o.index(sum, o.sub(run.swizzle('y'), 1)), before);
  const firstInstance = o.add(g.uniform('first', BuiltinTypes.u32), before);
  const indexed = o.equal(run.swizzle('w'), 1);
  const when = o.less(index, g.uniform('runCount', BuiltinTypes.u32));
  const args = g.storage('arguments', u32Array, { access: 'read-write' });
  const at = o.mul(index, ArgumentWords);
  const words: Value[] = [
    run.swizzle('z'),
    count,
    o.u32(0),
    // drawIndirect: firstInstance; drawIndexedIndirect: baseVertex.
    o.select(firstInstance, o.u32(0), indexed),
    o.select(o.u32(0), firstInstance, indexed),
  ];
  words.forEach((value, word) =>
    g.write(args, { index: o.add(at, word), value, when }),
  );
  return finish(g);
}

interface Programs {
  readonly test: CompiledProgram;
  readonly scan: CompiledProgram;
  readonly scatter: CompiledProgram;
  readonly arguments: CompiledProgram;
}

/** A draw of the culled candidates: entries [start, start + count). */
export interface CulledRun {
  readonly start: number;
  readonly count: number;
  // The vertices, or the indices, of its mesh.
  readonly elements: number;
  readonly indexed: boolean;
}

// The buffers of a list of candidates, grown as needed and kept from frame
// to frame.
interface CullingBuffers {
  readonly boxes: GpuBuffer;
  readonly rows: GpuBuffer;
  // The prefix sum, in ping-pong.
  readonly sums: readonly [GpuBuffer, GpuBuffer];
  readonly runs: GpuBuffer;
  readonly arguments: GpuBuffer;
  // The data written before upload, of the size of the buffers.
  readonly boxData: Float32Array<ArrayBuffer>;
  readonly runData: Uint32Array<ArrayBuffer>;
  // The owners of the dispatches of the steps: their own uniforms.
  readonly steps: object[];
}

const destroyBuffers = (list: CullingBuffers) => {
  for (const buffer of [list.boxes, list.rows, ...list.sums, list.runs]) {
    buffer.destroy();
  }
  list.arguments.destroy();
};

/**
 * What a culled list draws: the arguments of its runs, and the table its
 * instances were written into.
 */
export interface CulledDraws {
  readonly arguments: GpuBuffer;
  readonly table: GpuObjectTable;
}

/**
 * The culling of the instances of scene passes on the GPU, for the
 * backends with indirect draws and compute shaders. One list of buffers
 * per named list of candidates (a pass), reused from frame to frame.
 */
export class GpuCulling {
  private _programs?: Programs;
  private readonly _runner: ComputeRunner;
  private readonly _lists = new Map<string, CullingBuffers>();

  constructor(private readonly _backend: RenderBackend) {
    this._runner = new ComputeRunner(_backend);
  }

  /** Whether the backend can cull on the GPU. */
  static supported(backend: RenderBackend): boolean {
    const capabilities = backend.capabilities;
    return (
      capabilities?.indirectDraw === true &&
      capabilities.compute !== false &&
      !capabilities.emulatedCompute
    );
  }

  /**
   * The buffer of the arguments of the draws of a list of `count`
   * candidates in `runs` runs: five u32 per run (ArgumentWords), written by
   * the culling (record, with the same counts).
   */
  prepare(name: string, count: number, runs: number): GpuBuffer {
    return this.list(name, count, runs).arguments;
  }

  /**
   * Records the culling of a list of candidates into a compute pass: their
   * rows (reserved in the object table, `first` the first instance), their
   * world bounds (undefined: always visible), and the runs drawn. Returns
   * what the draws read.
   */
  record(
    pass: GpuComputePassEncoder,
    name: string,
    candidates: {
      readonly first: number;
      readonly rows: Uint32Array<ArrayBuffer>;
      readonly table: GpuObjectTable;
      readonly bounds: (index: number) => Aabb | undefined;
      readonly runs: readonly CulledRun[];
      // left, right, bottom, top, near, far: (nx, ny, nz, d), inside when
      // n · p + d ≥ 0.
      readonly planes: ArrayLike<number>;
    },
  ): CulledDraws {
    const { first, rows, table, bounds, runs, planes } = candidates;
    const instances = table.instanceBuffer;
    if (!instances) {
      throw new Error('The object table has no instance buffer');
    }
    const count = rows.length;
    const list = this.list(name, count, runs.length);
    const programs = this.programs();
    const groups = (n: number) =>
      [Math.max(1, Math.ceil(n / Workgroup))] as const;

    // The boxes: center, then half extents (infinite without bounds).
    const boxes = list.boxData;
    for (let i = 0; i < count; i++) {
      const box = bounds(i);
      const o = i * 8;
      if (box) {
        for (let axis = 0; axis < 3; axis++) {
          boxes[o + axis] = (box.min[axis] + box.max[axis]) / 2;
          boxes[o + 4 + axis] = (box.max[axis] - box.min[axis]) / 2;
        }
      } else {
        boxes.fill(0, o, o + 4);
        boxes.fill(1e30, o + 4, o + 7);
      }
      boxes[o + 3] = 0;
      boxes[o + 7] = 0;
    }
    list.boxes.write(0, boxes.buffer, 0, count * 32);
    list.rows.write(0, rows.buffer, rows.byteOffset, count * 4);
    const runData = list.runData;
    runs.forEach((run, r) => {
      runData[r * 4] = run.start;
      runData[r * 4 + 1] = run.start + run.count;
      runData[r * 4 + 2] = run.elements;
      runData[r * 4 + 3] = run.indexed ? 1 : 0;
    });
    list.runs.write(0, runData.buffer, 0, runs.length * 16);

    const step = (k: number) => {
      while (list.steps.length <= k) {
        list.steps.push({});
      }
      return list.steps[k];
    };
    const planeValues: Record<string, number[]> = {};
    for (let p = 0; p < 6; p++) {
      planeValues[`plane${p}`] = Array.from(
        { length: 4 },
        (_, i) => planes[p * 4 + i],
      );
    }
    const [a, b] = list.sums;
    this._runner.record(pass, programs.test, {
      values: { boxes: list.boxes, visible: a, count, ...planeValues },
      workgroups: groups(count),
      owner: step(0),
    });
    // The prefix sum, from a to b and back.
    let sum = a;
    let k = 1;
    for (let offset = 1; offset < count; offset *= 2, k++) {
      const to = sum === a ? b : a;
      this._runner.record(pass, programs.scan, {
        values: { from: sum, to, count, offset },
        workgroups: groups(count),
        owner: step(k),
      });
      sum = to;
    }
    this._runner.record(pass, programs.scatter, {
      values: { sum, rows: list.rows, instances, first, count },
      workgroups: groups(count),
      owner: step(k++),
    });
    this._runner.record(pass, programs.arguments, {
      values: {
        runs: list.runs,
        sum,
        arguments: list.arguments,
        first,
        runCount: runs.length,
      },
      workgroups: groups(runs.length),
      owner: step(k),
    });
    return { arguments: list.arguments, table };
  }

  destroy(): void {
    for (const list of this._lists.values()) {
      destroyBuffers(list);
    }
    this._lists.clear();
    this._runner.destroy();
  }

  // The buffers of a list, holding `count` candidates and `runs` runs:
  // those of the previous frames, or larger ones.
  private list(name: string, count: number, runs: number): CullingBuffers {
    const previous = this._lists.get(name);
    // The threads past the end of the last workgroup read the buffers too
    // (their writes are skipped): whole workgroups.
    const whole = (n: number) =>
      Math.ceil(Math.max(n, 1) / Workgroup) * Workgroup;
    const candidates = whole(count);
    const needed = {
      boxes: candidates * 32,
      rows: candidates * 4,
      runs: whole(runs) * 16,
      arguments: runs * ArgumentWords * 4,
    };
    if (
      previous &&
      previous.boxes.size >= needed.boxes &&
      previous.runs.size >= needed.runs &&
      previous.arguments.size >= needed.arguments
    ) {
      return previous;
    }
    if (previous) {
      destroyBuffers(previous);
    }
    // Twice what is needed: grown by doubling.
    const create = (
      size: number,
      label: string,
      usage: Parameters<RenderBackend['buffers']['create']>[0]['usage'] = [
        'storage',
        'copy-dst',
      ],
    ) =>
      this._backend.buffers.create({
        size: Math.max(size * 2, 256),
        usage,
        label: `culling ${name} ${label}`,
      });
    const boxes = create(needed.boxes, 'boxes');
    const runBuffer = create(needed.runs, 'runs');
    const list: CullingBuffers = {
      boxes,
      rows: create(needed.rows, 'rows'),
      sums: [create(needed.rows, 'sums 0'), create(needed.rows, 'sums 1')],
      runs: runBuffer,
      arguments: create(needed.arguments, 'arguments', [
        'storage',
        'indirect',
        'copy-src',
        'copy-dst',
      ]),
      boxData: new Float32Array(boxes.size / 4),
      runData: new Uint32Array(runBuffer.size / 4),
      steps: previous?.steps ?? [],
    };
    this._lists.set(name, list);
    return list;
  }

  private programs(): Programs {
    if (!this._programs) {
      const capabilities = this._backend.capabilities;
      const build = (graph: ReturnType<typeof finish>) =>
        compile(graph, { capabilities });
      this._programs = {
        test: build(testGraph()),
        scan: build(scanGraph()),
        scatter: build(scatterGraph()),
        arguments: build(argumentsGraph()),
      };
    }
    return this._programs;
  }
}
