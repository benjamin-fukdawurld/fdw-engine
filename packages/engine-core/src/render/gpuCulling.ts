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
import type { MaterialValue } from './Material';
import type { OcclusionPyramid } from './occlusion';

// The culling of the instances on the GPU (design/p24-gpu-driven.md §3.2):
// the candidates of the draws tested against the frustum, the visible ones
// compacted into the list of instances of the object table by a prefix sum
// (no atomics: the compiler has none), and the arguments of an indirect draw
// per run. One thread per candidate (per run for the arguments), in
// workgroups of 64.

export const Workgroup = 64;
// The u32 of the arguments of a draw (drawIndexedIndirect; drawIndirect
// uses the first four).
export const ArgumentWords = 5;

const u32Array = arrayType(BuiltinTypes.u32);
const f32Array = arrayType(BuiltinTypes.f32);
const vec4Array = arrayType(BuiltinTypes.vec4f);
const vec4uArray = arrayType(BuiltinTypes.vec4u);

export type Value = PortHandle | ConstantValue;

/**
 * A compute graph of one thread per element (global-invocation-id.x), with
 * shorthands for its nodes: for the culling and the light clusters.
 */
export function setup(name: string, prefix = 'culling') {
  const g = new GraphBuilder(`${prefix} ${name}`);
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
    div: (a: Value, b: Value) => call(std.div, { a, b }),
    remainder: (a: Value, b: Value) => call(std.remainder, { a, b }),
    min: (a: Value, b: Value) => call(std.min, { a, b }),
    max: (a: Value, b: Value) => call(std.max, { a, b }),
    lessEqual: (a: Value, b: Value) => call(std.lessEqual, { a, b }),
    and: (a: Value, b: Value) =>
      call(std.select, { ifFalse: false, ifTrue: b, condition: a }),
    or: (a: Value, b: Value) =>
      call(std.select, { ifFalse: b, ifTrue: true, condition: a }),
    f32: (value: Value) =>
      g.call(std.convert, { value } as Record<string, Value>, {
        params: { to: BuiltinTypes.f32 },
      }),
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

/** Ends a graph of setup: workgroups of Workgroup threads. */
export function finish(g: GraphBuilder) {
  g.compute({ workgroupSize: [Workgroup, 1, 1] });
  return g.build();
}

/**
 * The pyramid of the second phase of the occlusion culling, as the test
 * graph reads it: see OcclusionPyramid.
 */
type PyramidTest = Pick<OcclusionPyramid, 'key' | 'test'>;

/**
 * The phase of the occlusion culling on the GPU a list is culled in:
 * - 'early', the first: only the candidates visible at the previous frame
 *   (their row set in `history`), drawn first;
 * - 'late', the second: the candidates tested against the depth pyramid of
 *   the first, their visibility kept in `history` for the next frame
 *   (`remember`, the opaque lists), and only those the first phase did not
 *   draw drawn (`early`, the list of the first phase);
 * - 'shadow', the casters of a shadow map (design/p24-gpu-driven.md
 *   §3.9): tested against the frustum of its tile and, with a `mask`,
 *   against the receivers the camera draws (see recordReceiverMask); in a
 *   second phase (`early`, the list of the first), only those the first did
 *   not draw.
 */
export type CullingPhase =
  | { readonly kind: 'early'; readonly history: GpuBuffer }
  | {
      readonly kind: 'late';
      readonly history: GpuBuffer;
      readonly pyramid: OcclusionPyramid;
      // The textures of its levels, by their names in the test.
      readonly textures: Readonly<Record<string, MaterialValue>>;
      // The list of the first phase whose candidates were drawn (the same
      // candidates, in the same order): undefined for the transparent
      // lists, which are not drawn in the first phase.
      readonly early?: string;
      // Whether the results are kept for the next frame.
      readonly remember: boolean;
    }
  | {
      readonly kind: 'shadow';
      // World to clip space of the tile.
      readonly matrix: ArrayLike<number>;
      // The receivers of the tile (recordReceiverMask, for an orthographic
      // matrix): without, every caster in the frustum is drawn.
      readonly mask?: GpuBuffer;
      readonly early?: string;
    };

/**
 * The cells of a side of the receiver mask of a shadow map: the farthest
 * receiver from the light in each of its 32 × 32 cells.
 */
export const MaskSize = 32;
// The cells of a side a caster is tested against, at most: those covering
// more are drawn.
const MaskSpan = 4;
/** The receivers a mask is made of, at most: beyond, every cell is covered. */
export const MaxMaskReceivers = 32768;
// The receivers of a thread of the mask (maskChunksGraph).
const MaskChunk = 256;
// Far below any depth: no receiver.
const NoReceiver = -1e30;

// The first three rows of a matrix (column-major), as the graphs read
// them: row0, row1, row2.
const matrixRows = (m: ArrayLike<number>): Record<string, number[]> => {
  const rows: Record<string, number[]> = {};
  for (let r = 0; r < 3; r++) {
    rows[`row${r}`] = [m[r], m[4 + r], m[8 + r], m[12 + r]];
  }
  return rows;
};

/**
 * visible[i]: 1 if the box of candidate i (center, then half extents, two
 * vec4 each) is on the inner side of the six planes, else 0. In the first
 * phase of the occlusion culling, only if its row was visible at the
 * previous frame; in the second, only if the depth pyramid does not hide
 * it and the first phase did not draw it (see CullingPhase).
 */
function testGraph(phase?: 'early' | PyramidTest) {
  const name =
    phase === undefined
      ? 'test'
      : phase === 'early'
        ? 'early test'
        : `late test ${phase.key}`;
  const { g, o, index } = setup(name);
  const { center, extent, inside } = frustumTest(g, o, index);
  const count = g.uniform('count', BuiltinTypes.u32);
  const within = o.less(index, count);
  let visible: Value = inside;
  if (phase !== undefined) {
    const history = g.storage('history', u32Array, {
      access: phase === 'early' ? 'read' : 'read-write',
    });
    // Past the end of the list: the row of the last candidate.
    const row = o.index(
      g.storage('rows', u32Array),
      o.select(o.sub(count, 1), index, within),
    );
    if (phase === 'early') {
      visible = o.select(false, o.equal(o.index(history, row), 1), inside);
    } else {
      // Without bounds (infinite extents): visible.
      const unbounded = o.greaterEqual(extent.swizzle('x'), 1e29);
      const unhidden = o.select(
        phase.test(g, o.sub(center, extent), o.add(center, extent)),
        true,
        unbounded,
      );
      const seen = o.select(false, unhidden, inside);
      g.write(history, {
        index: row,
        value: o.select(o.u32(0), o.u32(1), seen),
        when: o.select(
          false,
          o.equal(g.uniform('remember', BuiltinTypes.u32), 1),
          within,
        ),
      });
      // drawn[i]: 1 where the first phase drew the candidate.
      const drawn = o.select(
        false,
        o.equal(o.index(g.storage('drawn', u32Array), index), 1),
        o.equal(g.uniform('phased', BuiltinTypes.u32), 1),
      );
      visible = o.select(seen, false, drawn);
    }
  }
  g.write(g.storage('visible', u32Array, { access: 'read-write' }), {
    index,
    value: o.select(o.u32(0), o.u32(1), visible),
    when: within,
  });
  return finish(g);
}

type Ops = ReturnType<typeof setup>['o'];

// The box of candidate `index` (center, then half extents, two vec4 each)
// and whether it is on the inner side of the six planes.
function frustumTest(g: GraphBuilder, o: Ops, index: PortHandle) {
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
  return { center, extent, inside };
}

// A box (center, half extents) seen by an orthographic matrix (its rows
// row0, row1, row2): its center and half extents along x, y and z of the
// clip space.
function projectBox(g: GraphBuilder, o: Ops, center: Value, extent: Value) {
  return [0, 1, 2].map((r) => {
    const row = g.uniform(`row${r}`, BuiltinTypes.vec4f);
    const axis = row.swizzle('xyz');
    return {
      center: o.add(o.dot(axis, center), row.swizzle('w')),
      extent: o.dot(o.abs(axis), extent),
    };
  });
}

/**
 * visible[i] for the casters of a shadow map: 1 if the box of candidate i
 * is in the frustum of the tile and, with the mask (`useMask`), may shadow
 * a receiver: the farthest receiver of a cell it covers is not nearer to
 * the light than its nearest point. A caster covering more than MaskSpan
 * cells of a side is kept. In a second phase (`phased`), not those the
 * first drew (`drawn`).
 */
function shadowTestGraph() {
  const { g, o, index } = setup('shadow test');
  const { center, extent, inside } = frustumTest(g, o, index);
  const [x, y, z] = projectBox(g, o, center, extent);
  // The cell of a coordinate of the clip space, clamped to the mask.
  const cell = (v: Value) =>
    o.min(
      o.max(
        g.call(std.floor, {
          x: o.mul(o.add(v, 1), MaskSize / 2),
        } as Record<string, Value>),
        0,
      ),
      MaskSize - 1,
    );
  const x0 = cell(o.sub(x.center, x.extent));
  const x1 = cell(o.add(x.center, x.extent));
  const y0 = cell(o.sub(y.center, y.extent));
  const y1 = cell(o.add(y.center, y.extent));
  const big = o.or(
    o.greaterEqual(o.sub(x1, x0), MaskSpan),
    o.greaterEqual(o.sub(y1, y0), MaskSpan),
  );
  const u32 = (v: Value) =>
    g.call(std.convert, { value: v } as Record<string, Value>, {
      params: { to: BuiltinTypes.u32 },
    });
  const [cx0, cx1, cy0, cy1] = [x0, x1, y0, y1].map(u32);
  const mask = g.storage('mask', f32Array);
  const useMask = o.equal(g.uniform('useMask', BuiltinTypes.u32), 1);
  const span = o.select(o.u32(0), o.u32(MaskSpan), useMask);
  // The farthest receiver of the cells of the box.
  const farthest = g.fold(
    g.constant(BuiltinTypes.f32, NoReceiver),
    span,
    (state, j) =>
      g.fold(state, span, (s, i) => {
        const cx = o.add(cx0, i);
        const cy = o.add(cy0, j);
        const covered = o.and(o.lessEqual(cx, cx1), o.lessEqual(cy, cy1));
        const at = o.select(o.u32(0), o.add(o.mul(cy, MaskSize), cx), covered);
        return o.select(s, o.max(s, o.index(mask, at)), covered);
      }),
  );
  const nearest = o.sub(z.center, z.extent);
  const receives = o.select(
    true,
    o.or(big, o.lessEqual(nearest, farthest)),
    useMask,
  );
  const drawn = o.select(
    false,
    o.equal(o.index(g.storage('drawn', u32Array), index), 1),
    o.equal(g.uniform('phased', BuiltinTypes.u32), 1),
  );
  const visible = o.and(o.and(inside, receives), o.select(true, false, drawn));
  g.write(g.storage('visible', u32Array, { access: 'read-write' }), {
    index,
    value: o.select(o.u32(0), o.u32(1), visible),
    when: o.less(index, g.uniform('count', BuiltinTypes.u32)),
  });
  return finish(g);
}

/**
 * The visible candidates of a list, compacted by their prefix sum `sum`:
 * receivers[1 + k] the index of the k-th, receivers[0] their number. The
 * receivers of the shadow maps (see maskGraph).
 */
function receiversGraph() {
  const { g, o, index, previous } = setup('receivers');
  const sum = g.storage('sum', u32Array);
  const through = o.index(sum, index);
  const visible = o.equal(o.sub(through, previous(sum, index)), 1);
  const count = g.uniform('count', BuiltinTypes.u32);
  const receivers = g.storage('receivers', u32Array, { access: 'read-write' });
  g.write(receivers, {
    index: through,
    value: index,
    when: o.and(visible, o.less(index, count)),
  });
  g.write(receivers, {
    index: o.u32(0),
    value: through,
    when: o.equal(o.add(index, 1), count),
  });
  return finish(g);
}

/**
 * The receiver mask of a shadow map, in two graphs. First, a thread per
 * cell (MaskSize²) and per chunk of MaskChunk receivers (a list compacted
 * by receiversGraph, and their boxes): the farthest depth from the light
 * of those of the chunk whose box, seen by the orthographic matrix of the
 * tile and grown by `margin`, covers the cell (NoReceiver for none), in
 * `partial`.
 */
function maskChunksGraph() {
  const { g, o, index } = setup('receiver mask chunks');
  const cells = MaskSize * MaskSize;
  const cell = o.remainder(index, cells);
  const chunk = o.div(index, cells);
  const size = 2 / MaskSize;
  const cellX = o.sub(o.mul(o.f32(o.remainder(cell, MaskSize)), size), 1);
  const cellY = o.sub(o.mul(o.f32(o.div(cell, MaskSize)), size), 1);
  const receivers = g.storage('receivers', u32Array);
  const boxes = g.storage('boxes', vec4Array);
  const margin = g.uniform('margin', BuiltinTypes.f32);
  const total = o.min(
    o.index(receivers, o.u32(0)),
    g.uniform('cap', BuiltinTypes.u32),
  );
  const start = o.mul(chunk, MaskChunk);
  const farthest = g.fold(
    g.constant(BuiltinTypes.f32, NoReceiver),
    o.min(o.sub(o.max(total, start), start), MaskChunk),
    (state, k) => {
      const i = o.index(receivers, o.add(o.add(start, k), 1));
      const center = o.index(boxes, o.mul(i, 2)).swizzle('xyz');
      const extent = o.index(boxes, o.add(o.mul(i, 2), 1)).swizzle('xyz');
      const [x, y, z] = projectBox(g, o, center, extent);
      const overlaps = (axis: typeof x, low: Value) => {
        const reach = o.add(axis.extent, margin);
        return o.and(
          o.lessEqual(o.sub(axis.center, reach), o.add(low, size)),
          o.greaterEqual(o.add(axis.center, reach), low),
        );
      };
      return o.select(
        state,
        o.max(state, o.add(z.center, z.extent)),
        o.and(overlaps(x, cellX), overlaps(y, cellY)),
      );
    },
  );
  g.write(g.storage('partial', f32Array, { access: 'read-write' }), {
    index,
    value: farthest,
    when: o.less(chunk, g.uniform('chunks', BuiltinTypes.u32)),
  });
  return finish(g);
}

/**
 * Then a thread per cell: the farthest of its chunks, merged with
 * `previous` (the mask of other lists) unless `clear`. Beyond `cap`
 * receivers, every cell is covered.
 */
function maskGraph() {
  const { g, o, index } = setup('receiver mask');
  const cells = MaskSize * MaskSize;
  const total = o.index(g.storage('receivers', u32Array), o.u32(0));
  const cap = g.uniform('cap', BuiltinTypes.u32);
  const partial = g.storage('partial', f32Array);
  const used = o.div(o.add(o.min(total, cap), MaskChunk - 1), MaskChunk);
  const farthest = g.fold(
    g.constant(BuiltinTypes.f32, NoReceiver),
    used,
    (state, chunk) =>
      o.max(state, o.index(partial, o.add(o.mul(chunk, cells), index))),
  );
  const before = o.select(
    o.index(g.storage('previous', f32Array), index),
    g.constant(BuiltinTypes.f32, NoReceiver),
    o.equal(g.uniform('clear', BuiltinTypes.u32), 1),
  );
  g.write(g.storage('mask', f32Array, { access: 'read-write' }), {
    index,
    value: o.select(o.max(before, farthest), 1e30, o.less(cap, total)),
    when: o.less(index, cells),
  });
  return finish(g);
}

/** A step of the prefix sum (Hillis and Steele): to[i] = from[i] + from[i - offset]. */
export function scanGraph(prefix = 'culling') {
  const { g, o, index } = setup('scan', prefix);
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
  const runs = g.storage('runs', vec4uArray);
  const run = o.index(runs, o.mul(index, 2));
  // The first index and the base vertex of its mesh (in a MeshArena).
  const place = o.index(runs, o.add(o.mul(index, 2), 1));
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
    // drawIndirect: first vertex, first instance; drawIndexedIndirect:
    // first index, base vertex, first instance.
    o.select(place.swizzle('y'), place.swizzle('x'), indexed),
    o.select(firstInstance, place.swizzle('y'), indexed),
    o.select(o.u32(0), firstInstance, indexed),
  ];
  words.forEach((value, word) =>
    g.write(args, { index: o.add(at, word), value, when }),
  );
  return finish(g);
}

/**
 * The packing of the draws of the groups of runs drawn by one multiple
 * draw (see CulledRun.group), with a count read by the GPU: nonEmpty[r], 1
 * where run r has instances.
 */
function nonEmptyGraph() {
  const { g, o, index } = setup('non-empty runs');
  const args = g.storage('arguments', u32Array);
  g.write(g.storage('visible', u32Array, { access: 'read-write' }), {
    index,
    value: o.select(
      o.u32(0),
      o.u32(1),
      o.less(0, o.index(args, o.add(o.mul(index, ArgumentWords), 1))),
    ),
    when: o.less(index, g.uniform('runCount', BuiltinTypes.u32)),
  });
  return finish(g);
}

/**
 * The draws of the runs with instances, packed at the start of the range of
 * their group in `packed`, and their number at counts[first run of the
 * group], from the prefix sum of nonEmptyGraph.
 */
function packGraph() {
  const { g, o, index, previous } = setup('pack');
  const runs = g.storage('runs', vec4uArray);
  // x: first index, y: base vertex, z, w: the runs of its group.
  const place = o.index(runs, o.add(o.mul(index, 2), 1));
  const groupStart = place.swizzle('z');
  const groupEnd = place.swizzle('w');
  const sum = g.storage('sum', u32Array);
  const through = o.index(sum, index);
  const before = previous(sum, groupStart);
  const nonEmpty = o.equal(o.sub(through, previous(sum, index)), 1);
  const within = o.less(index, g.uniform('runCount', BuiltinTypes.u32));
  const args = g.storage('arguments', u32Array);
  const packed = g.storage('packed', u32Array, { access: 'read-write' });
  const to = o.mul(
    o.sub(o.add(groupStart, o.sub(through, before)), 1),
    ArgumentWords,
  );
  const from = o.mul(index, ArgumentWords);
  for (let word = 0; word < ArgumentWords; word++) {
    g.write(packed, {
      index: o.add(to, word),
      value: o.index(args, o.add(from, word)),
      when: o.select(false, nonEmpty, within),
    });
  }
  g.write(g.storage('counts', u32Array, { access: 'read-write' }), {
    index: groupStart,
    value: o.sub(through, before),
    when: o.select(false, o.equal(index, o.sub(groupEnd, 1)), within),
  });
  return finish(g);
}

/**
 * Records the prefix sum of `count` u32 of `from` (Hillis and Steele, ⌈log₂
 * count⌉ dispatches of `scan`, a scanGraph), between the two buffers of
 * `sums`: returns the buffer holding it (`from` itself for a single
 * element). `owner(k)`: the owner of the uniforms of the k-th dispatch.
 */
export function recordPrefixSum(
  runner: ComputeRunner,
  pass: GpuComputePassEncoder,
  scan: CompiledProgram,
  from: GpuBuffer,
  sums: readonly [GpuBuffer, GpuBuffer],
  count: number,
  owner: (k: number) => object,
): GpuBuffer {
  const [a, b] = sums;
  let sum = from;
  let k = 0;
  for (let offset = 1; offset < count; offset *= 2, k++) {
    const to = sum === a ? b : a;
    runner.record(pass, scan, {
      values: { from: sum, to, count, offset },
      workgroups: [Math.max(1, Math.ceil(count / Workgroup))],
      owner: owner(k),
    });
    sum = to;
  }
  return sum;
}

// The receiver mask of a shadow map: two buffers, each list of receivers
// merged from one into the other.
interface Mask {
  readonly buffers: readonly [GpuBuffer, GpuBuffer];
  readonly steps: object[];
}

interface Programs {
  readonly test: CompiledProgram;
  readonly early: CompiledProgram;
  readonly scan: CompiledProgram;
  readonly scatter: CompiledProgram;
  readonly arguments: CompiledProgram;
  readonly nonEmpty: CompiledProgram;
  readonly pack: CompiledProgram;
  readonly shadow: CompiledProgram;
  readonly receivers: CompiledProgram;
  readonly mask: CompiledProgram;
  readonly maskChunks: CompiledProgram;
}

/** A draw of the culled candidates: entries [start, start + count). */
export interface CulledRun {
  readonly start: number;
  readonly count: number;
  // The vertices, or the indices, of its mesh.
  readonly elements: number;
  readonly indexed: boolean;
  // Where its mesh is in the buffers of its MeshArena (0 elsewhere).
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  // The runs drawn with it by one multiple draw, [start, end) (itself
  // alone by default).
  readonly group?: readonly [number, number];
}

// The buffers of a list of candidates, grown as needed and kept from frame
// to frame.
interface CullingBuffers {
  readonly boxes: GpuBuffer;
  readonly rows: GpuBuffer;
  // What the test found visible (and drawn), a u32 per candidate.
  readonly visible: GpuBuffer;
  // The prefix sum, in ping-pong.
  readonly sums: readonly [GpuBuffer, GpuBuffer];
  readonly runs: GpuBuffer;
  readonly arguments: GpuBuffer;
  // The draws of the groups of runs packed, and their numbers (see
  // packGraph).
  readonly packed: GpuBuffer;
  readonly counts: GpuBuffer;
  // The runs with instances, a u32 each.
  readonly nonEmpty: GpuBuffer;
  // The visible candidates compacted, after their number (receiversGraph).
  readonly receivers: GpuBuffer;
  // The data written before upload, of the size of the buffers.
  readonly boxData: Float32Array<ArrayBuffer>;
  readonly runData: Uint32Array<ArrayBuffer>;
  // The owners of the dispatches of the steps: their own uniforms.
  readonly steps: object[];
  // The boxes and the rows tested by its last culling: its own, or those
  // kept on the GPU (CullingCandidates.persistent), and how many.
  source?: { readonly boxes: GpuBuffer; readonly rows: GpuBuffer };
  count: number;
}

const destroyBuffers = (list: CullingBuffers) => {
  for (const buffer of [
    list.boxes,
    list.rows,
    list.visible,
    ...list.sums,
    list.runs,
    list.arguments,
    list.packed,
    list.counts,
    list.nonEmpty,
    list.receivers,
  ]) {
    buffer.destroy();
  }
};

/**
 * What a culled list draws: the arguments of its runs, and the table its
 * instances were written into.
 */
export interface CulledDraws {
  readonly arguments: GpuBuffer;
  readonly table: GpuObjectTable;
  // With `pack`: the draws of each group of runs with instances, from the
  // offset of the first run of the group, and their number, a u32 at its
  // index (see CulledRun.group).
  readonly packed?: {
    readonly arguments: GpuBuffer;
    readonly counts: GpuBuffer;
  };
}

/** The candidates of a list culled on the GPU: see GpuCulling.record. */
export interface CullingCandidates {
  // The first instance reserved for them in the object table.
  readonly first: number;
  // The row of each candidate in the table. In the second phase of the
  // occlusion culling with a first (CullingPhase.early), only its length
  // is read: the rows and the bounds are those of the first.
  readonly rows: Uint32Array<ArrayBuffer>;
  readonly table: GpuObjectTable;
  // The world bounds of a candidate (undefined: always visible).
  readonly bounds: (index: number) => Aabb | undefined;
  readonly runs: readonly CulledRun[];
  // left, right, bottom, top, near, far: (nx, ny, nz, d), inside when
  // n · p + d ≥ 0.
  readonly planes: ArrayLike<number>;
  // How many candidates, when `rows` is not read (the second phase of the
  // occlusion culling): rows.length by default.
  readonly count?: number;
  // The phase of the occlusion culling on the GPU: none without it.
  readonly phase?: CullingPhase;
  // Packs the draws of the groups of runs with instances, for multiple
  // draws whose count the GPU writes (drawIndirectCount).
  readonly pack?: boolean;
  // Also compacts the visible candidates (their indices): the receivers
  // of the shadow maps (see GpuCulling.recordReceiverMask).
  readonly receivers?: boolean;
  // Candidates kept on the GPU (a GpuScene): their boxes (center, half
  // extents, two vec4f each) and rows, `count` of them, in buffers of
  // whole workgroups (64). `rows` and `bounds` are then not read.
  readonly persistent?: {
    readonly boxes: GpuBuffer;
    readonly rows: GpuBuffer;
    readonly count: number;
  };
}

/**
 * The culling of the instances of scene passes on the GPU, for the
 * backends with indirect draws and compute shaders. One list of buffers
 * per named list of candidates (a pass), reused from frame to frame.
 *
 * With the occlusion culling, in two phases (design/p24-gpu-driven.md
 * §3.4): a list is culled twice, first keeping the candidates whose row
 * was visible at the previous frame (the history of the view, a u32 per
 * row of the object table), then, once those are drawn and the depth
 * pyramid built from them, testing every candidate against it, drawing
 * those the first phase did not and keeping the visibility of all for the
 * next frame. Nothing waits for a readback: what moving reveals is drawn in
 * the frame it appears.
 */
export class GpuCulling {
  private _programs?: Programs;
  private readonly _late = new Map<string, CompiledProgram>();
  private readonly _runner: ComputeRunner;
  private readonly _lists = new Map<string, CullingBuffers>();
  private readonly _histories = new Map<string, GpuBuffer>();
  // The receiver masks of the shadow maps, by name, and the owners of
  // their dispatches.
  private readonly _masks = new Map<string, Mask>();
  private _noReceivers?: GpuBuffer;
  private _partial?: GpuBuffer;

  constructor(private readonly _backend: RenderBackend) {
    // The dispatches of a frame: two phases of the camera and of each
    // shadow map, a few lists each, ⌈log₂ n⌉ + 5 dispatches per list.
    this._runner = new ComputeRunner(_backend, { bindGroups: 4096 });
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
   * The visibility of the rows of a view at the previous frame, for the
   * occlusion culling in two phases: a u32 per row, 1 where visible, for at
   * least `rows` rows (without: the current one). Kept from frame to
   * frame; a larger one starts with every row hidden (drawn by the second
   * phase, if visible).
   */
  history(view: string, rows?: number): GpuBuffer {
    const current = this._histories.get(view);
    if (current && (rows === undefined || current.size >= rows * 4)) {
      return current;
    }
    rows ??= 0;
    current?.destroy();
    const size = Math.max(256, rows * 8);
    const buffer = this._backend.buffers.create({
      size,
      usage: ['storage', 'copy-dst'],
      label: `culling ${view} history`,
    });
    buffer.write(0, new ArrayBuffer(size));
    this._histories.set(view, buffer);
    return buffer;
  }

  /**
   * Records the culling of a list of candidates into a compute pass: their
   * rows (reserved in the object table, `first` the first instance), their
   * world bounds, and the runs drawn. Returns what the draws read. The
   * second phase of the occlusion culling reads the buffers of its first
   * (`phase.early`), recorded before into an earlier pass.
   */
  record(
    pass: GpuComputePassEncoder,
    name: string,
    candidates: CullingCandidates,
  ): CulledDraws {
    const {
      first,
      rows,
      table,
      bounds,
      runs,
      planes,
      phase,
      pack,
      persistent,
      receivers,
    } = candidates;
    const instances = table.instanceBuffer;
    if (!instances) {
      throw new Error('The object table has no instance buffer');
    }
    const count = persistent?.count ?? candidates.count ?? rows.length;
    const list = this.list(name, count, runs.length);
    const programs = this.programs();
    const groups = (n: number) =>
      [Math.max(1, Math.ceil(n / Workgroup))] as const;
    // The candidates of the first phase, tested again: their boxes and
    // rows, uploaded once.
    const earlyName =
      phase?.kind === 'late' || phase?.kind === 'shadow'
        ? phase.early
        : undefined;
    const early = earlyName ? this._lists.get(earlyName) : undefined;
    if (earlyName && !early) {
      throw new Error(`No first phase "${earlyName}" for "${name}"`);
    }
    // Uploaded by the CPU, or already on the GPU.
    const uploaded = !early && !persistent;
    const source = early?.source ?? persistent ?? list;
    list.source = source;
    list.count = count;

    // The boxes: center, then half extents (infinite without bounds).
    const boxes = list.boxData;
    for (let i = 0; i < (uploaded ? count : 0); i++) {
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
    if (uploaded) {
      list.boxes.write(0, boxes.buffer, 0, count * 32);
      list.rows.write(0, rows.buffer, rows.byteOffset, count * 4);
    }
    const runData = list.runData;
    runs.forEach((run, r) => {
      const o = r * 8;
      runData[o] = run.start;
      runData[o + 1] = run.start + run.count;
      runData[o + 2] = run.elements;
      runData[o + 3] = run.indexed ? 1 : 0;
      runData[o + 4] = run.firstIndex ?? 0;
      runData[o + 5] = run.baseVertex ?? 0;
      runData[o + 6] = run.group?.[0] ?? r;
      runData[o + 7] = run.group?.[1] ?? r + 1;
    });
    list.runs.write(0, runData.buffer, 0, runs.length * 32);

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
    const tested = {
      boxes: source.boxes,
      visible: list.visible,
      count,
      ...planeValues,
    };
    if (!phase) {
      this._runner.record(pass, programs.test, {
        values: tested,
        workgroups: groups(count),
        owner: step(0),
      });
    } else if (phase.kind === 'early') {
      this._runner.record(pass, programs.early, {
        values: { ...tested, rows: source.rows, history: phase.history },
        workgroups: groups(count),
        owner: step(0),
      });
    } else if (phase.kind === 'shadow') {
      this._runner.record(pass, programs.shadow, {
        values: {
          ...tested,
          ...matrixRows(phase.matrix),
          // Bound, but not read, without a mask or a first phase (not
          // `visible`: WebGPU binds no buffer as read-only and writable
          // storage in a dispatch).
          mask: phase.mask ?? this.mask(name).buffers[0],
          useMask: phase.mask ? 1 : 0,
          drawn: early?.visible ?? list.receivers,
          phased: early ? 1 : 0,
        },
        workgroups: groups(count),
        owner: step(0),
      });
    } else {
      this._runner.record(pass, this.lateProgram(phase.pyramid), {
        values: {
          ...tested,
          ...phase.pyramid.values,
          ...phase.textures,
          rows: source.rows,
          history: phase.history,
          // Bound, but not read, without a first phase (not `visible`:
          // WebGPU binds no buffer as read-only and writable storage in a
          // dispatch).
          drawn: early?.visible ?? list.receivers,
          phased: early ? 1 : 0,
          remember: phase.remember ? 1 : 0,
        },
        workgroups: groups(count),
        owner: step(0),
      });
    }
    const sum = recordPrefixSum(
      this._runner,
      pass,
      programs.scan,
      list.visible,
      list.sums,
      count,
      (k) => step(1 + k),
    );
    let k = 1 + Math.ceil(Math.log2(Math.max(count, 1)));
    this._runner.record(pass, programs.scatter, {
      values: { sum, rows: source.rows, instances, first, count },
      workgroups: groups(count),
      owner: step(k++),
    });
    if (receivers) {
      this._runner.record(pass, programs.receivers, {
        values: { sum, receivers: list.receivers, count },
        workgroups: groups(count),
        owner: step(k++),
      });
    }
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
    if (!pack) {
      return { arguments: list.arguments, table };
    }
    // The runs with instances, their prefix sum, the draws packed.
    this._runner.record(pass, programs.nonEmpty, {
      values: {
        arguments: list.arguments,
        visible: list.nonEmpty,
        runCount: runs.length,
      },
      workgroups: groups(runs.length),
      owner: step(k + 1),
    });
    const runSum = recordPrefixSum(
      this._runner,
      pass,
      programs.scan,
      list.nonEmpty,
      list.sums,
      runs.length,
      (j) => step(k + 2 + j),
    );
    this._runner.record(pass, programs.pack, {
      values: {
        runs: list.runs,
        sum: runSum,
        arguments: list.arguments,
        packed: list.packed,
        counts: list.counts,
        runCount: runs.length,
      },
      workgroups: groups(runs.length),
      owner: step(k + 2 + Math.ceil(Math.log2(Math.max(runs.length, 1)))),
    });
    return {
      arguments: list.arguments,
      table,
      packed: { arguments: list.packed, counts: list.counts },
    };
  }

  /**
   * Records the receiver mask of a shadow map (`name`, its tile, whose
   * matrix is orthographic): the receivers of the lists culled before in
   * the frame with `receivers` (the visible candidates of the camera), seen
   * from the light. Each of its MaskSize² cells holds the farthest depth of
   * the receivers covering it, their boxes grown by `margin` (clip space).
   * The casters of a 'shadow' phase with this mask are drawn only if their
   * shadow can fall on one of them.
   */
  recordReceiverMask(
    pass: GpuComputePassEncoder,
    name: string,
    matrix: ArrayLike<number>,
    lists: readonly string[],
    margin: number,
  ): GpuBuffer {
    const mask = this.mask(name);
    const programs = this.programs();
    const rows = matrixRows(matrix);
    const used = lists.flatMap((key) => {
      const list = this._lists.get(key);
      return list?.source ? [list] : [];
    });
    // Without receivers: a list of none, to clear the mask.
    if (!this._noReceivers) {
      this._noReceivers = this._backend.buffers.create({
        size: 256,
        usage: ['storage', 'copy-dst'],
        label: 'culling no receivers',
      });
      this._noReceivers.write(0, new ArrayBuffer(256));
    }
    const noBoxes = this._noReceivers;
    const sources =
      used.length > 0
        ? used.map((list) => ({
            receivers: list.receivers,
            boxes: (list.source as { boxes: GpuBuffer }).boxes,
            count: list.count,
          }))
        : [{ receivers: noBoxes, boxes: noBoxes, count: 0 }];
    const cells = MaskSize * MaskSize;
    // The chunks of the receivers, shared by the masks.
    const partial = (this._partial ??= this._backend.buffers.create({
      size: (MaxMaskReceivers / MaskChunk) * cells * 4,
      usage: ['storage'],
      label: 'culling receiver mask chunks',
    }));
    sources.forEach(({ receivers, boxes, count }, k) => {
      while (mask.steps.length <= 2 * k + 1) {
        mask.steps.push({});
      }
      // As many chunks as the list may have receivers (the GPU knows
      // how many it has).
      const chunks = Math.max(
        1,
        Math.ceil(Math.min(count, MaxMaskReceivers) / MaskChunk),
      );
      this._runner.record(pass, programs.maskChunks, {
        values: {
          receivers,
          boxes,
          ...rows,
          partial,
          margin,
          cap: MaxMaskReceivers,
          chunks,
        },
        workgroups: [(chunks * cells) / Workgroup],
        owner: mask.steps[2 * k],
      });
      this._runner.record(pass, programs.mask, {
        values: {
          receivers,
          partial,
          previous: mask.buffers[(k + 1) % 2],
          mask: mask.buffers[k % 2],
          cap: MaxMaskReceivers,
          clear: k === 0 ? 1 : 0,
        },
        workgroups: [cells / Workgroup],
        owner: mask.steps[2 * k + 1],
      });
    });
    return mask.buffers[(sources.length - 1) % 2];
  }

  destroy(): void {
    for (const list of this._lists.values()) {
      destroyBuffers(list);
    }
    this._lists.clear();
    for (const mask of this._masks.values()) {
      mask.buffers.forEach((buffer) => buffer.destroy());
    }
    this._masks.clear();
    this._noReceivers?.destroy();
    this._noReceivers = undefined;
    this._partial?.destroy();
    this._partial = undefined;
    for (const history of this._histories.values()) {
      history.destroy();
    }
    this._histories.clear();
    this._runner.destroy();
  }

  // The receiver mask of a shadow map, kept from frame to frame.
  private mask(name: string): Mask {
    let mask = this._masks.get(name);
    if (!mask) {
      const create = (k: number) =>
        this._backend.buffers.create({
          size: MaskSize * MaskSize * 4,
          usage: ['storage', 'copy-dst'],
          label: `culling ${name} mask ${k}`,
        });
      mask = { buffers: [create(0), create(1)], steps: [] };
      this._masks.set(name, mask);
    }
    return mask;
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
      runs: whole(runs) * 32,
      // Grown with the runs.
      arguments: whole(runs) * ArgumentWords * 4,
      counts: whole(runs) * 4,
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
      visible: create(needed.rows, 'visible'),
      sums: [create(needed.rows, 'sums 0'), create(needed.rows, 'sums 1')],
      runs: runBuffer,
      arguments: create(needed.arguments, 'arguments', [
        'storage',
        'indirect',
        'copy-src',
        'copy-dst',
      ]),
      packed: create(needed.arguments, 'packed', ['storage', 'indirect']),
      counts: create(needed.counts, 'counts', ['storage', 'indirect']),
      nonEmpty: create(needed.counts, 'non-empty runs'),
      // Their number first.
      receivers: create(needed.rows + 4, 'receivers'),
      boxData: new Float32Array(boxes.size / 4),
      runData: new Uint32Array(runBuffer.size / 4),
      steps: previous?.steps ?? [],
      count: 0,
    };
    this._lists.set(name, list);
    return list;
  }

  private programs(): Programs {
    if (!this._programs) {
      this._programs = {
        test: this.build(testGraph()),
        early: this.build(testGraph('early')),
        scan: this.build(scanGraph()),
        scatter: this.build(scatterGraph()),
        arguments: this.build(argumentsGraph()),
        nonEmpty: this.build(nonEmptyGraph()),
        pack: this.build(packGraph()),
        shadow: this.build(shadowTestGraph()),
        receivers: this.build(receiversGraph()),
        mask: this.build(maskGraph()),
        maskChunks: this.build(maskChunksGraph()),
      };
    }
    return this._programs;
  }

  // The test of the second phase, against a pyramid: one per key.
  private lateProgram(pyramid: PyramidTest): CompiledProgram {
    let program = this._late.get(pyramid.key);
    if (!program) {
      program = this.build(testGraph(pyramid));
      this._late.set(pyramid.key, program);
    }
    return program;
  }

  private build(graph: ReturnType<typeof finish>): CompiledProgram {
    return compile(graph, { capabilities: this._backend.capabilities });
  }
}
