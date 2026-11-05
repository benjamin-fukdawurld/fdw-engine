import type {
  GpuBuffer,
  GpuComputePassEncoder,
  Mat4,
  RenderBackend,
} from '@fdw/engine-backend';
import { arrayType, BuiltinTypes, compile, std } from '@fdw/engine-shader';
import type { CompiledProgram, PortHandle } from '@fdw/engine-shader';
import { ComputeRunner } from '../compute/ComputeRunner';
import {
  finish,
  recordPrefixSum,
  scanGraph,
  setup,
  Workgroup,
} from './gpuCulling';
import type { Value } from './gpuCulling';
import { LightClusterCount, LightClusterTiles } from './lightClusters';

// The assignment of the bounded lights to the clusters of a view on the GPU
// (design/p24-gpu-driven.md §3.5): the same grid as LightClusters.assign,
// computed by compute graphs without atomics.
//
// 1. The tiles of each light in each slice (a thread per light and slice):
//    the rectangle of tiles covered by the part of its sphere in the
//    slice, computed as on the CPU.
// 2. The pairs (a thread per cluster and light, cluster-major): 1 where
//    the rectangle of the light in the slice of the cluster holds its tile.
// 3. Their prefix sum, as for the culling of the instances.
// 4. The lists: each pair found written at its rank, after the headers;
//    the pairs being cluster-major, then in the order of the lights, the
//    lists are those of the CPU.
// 5. The headers: the first element and the length of each list.

const { x: TilesX, y: TilesY, slices: Slices } = LightClusterTiles;
const Header = LightClusterCount * 2;

/**
 * The most bounded lights a view assigns on the GPU: its pairs (one per
 * cluster and light) are dispatched along x, in at most 65535 workgroups.
 * Beyond, the CPU assigns them.
 */
export const MaxGpuClusterLights = 1024;

const vec4Array = arrayType(BuiltinTypes.vec4f);
const u32Array = arrayType(BuiltinTypes.u32);

const prefix = 'light clusters';

/**
 * rects[light × slices + slice]: the tiles (x0, y0, x1, y1) the sphere of
 * a light covers in a slice, as floats; (1, 1, 0, 0) where it covers none.
 * Grown by a little (the f32 rounding): a light may be listed in a cluster
 * the CPU leaves out, where it gives less than LightThreshold, never the
 * opposite.
 */
function rectsGraph() {
  const { g, o, index } = setup('tiles', prefix);
  const f = (value: number) => g.constant(BuiltinTypes.f32, value);
  const light = o.div(index, Slices);
  const slice = o.f32(o.remainder(index, Slices));
  const sphere = o.index(g.storage('spheres', vec4Array), light);
  const view = g.uniform('view', BuiltinTypes.mat4f);
  const projection = g.uniform('projection', BuiltinTypes.mat4f);
  // near, far, scale, bias of the slices (see lightClusterMembers).
  const depths = g.uniform('depths', BuiltinTypes.vec4f);
  const near = depths.swizzle('x');
  const far = depths.swizzle('y');
  const center = g.call(std.transform, {
    matrix: view,
    vector: g.call(std.extend, { xyz: sphere.swizzle('xyz'), w: 1 }),
  });
  const cx = center.swizzle('x');
  const cy = center.swizzle('y');
  const d = o.mul(center.swizzle('z'), -1);
  const r = sphere.swizzle('w');
  const sliceOf = (depth: Value) =>
    g.call(std.clamp, {
      x: g.call(std.floor, {
        x: o.add(
          o.mul(
            g.call(std.log2, { x: o.max(depth, 1e-6) }),
            depths.swizzle('z'),
          ),
          depths.swizzle('w'),
        ),
      }),
      low: 0,
      high: Slices - 1,
    });
  // near × (far / near)^(k / slices).
  const depthOf = (k: Value) =>
    o.mul(
      near,
      g.call(std.exp2, {
        x: o.mul(g.call(std.log2, { x: o.div(far, near) }), o.div(k, Slices)),
      }),
    );
  const z0 = o.select(depthOf(slice), near, o.equal(slice, 0));
  const z1 = o.select(
    depthOf(o.add(slice, 1)),
    far,
    o.equal(slice, Slices - 1),
  );
  const depth = g.call(std.clamp, { x: d, low: z0, high: z1 });
  const offset = o.sub(depth, d);
  const radius = g.call(std.sqrt, {
    x: o.max(o.sub(o.mul(r, r), o.mul(offset, offset)), 0),
  });
  const zMin = o.max(o.sub(depth, radius), z0);
  const zMax = o.min(o.add(depth, radius), z1);
  let low: PortHandle | undefined;
  let high: PortHandle | undefined;
  let behind: Value = false;
  for (let c = 0; c < 8; c++) {
    const corner = g.call(std.transform, {
      matrix: projection,
      vector: g.call(std.vec4, {
        x: c & 1 ? o.add(cx, radius) : o.sub(cx, radius),
        y: c & 2 ? o.add(cy, radius) : o.sub(cy, radius),
        z: o.mul(c & 4 ? zMax : zMin, -1),
        w: f(1),
      }),
    });
    const w = corner.swizzle('w');
    behind = o.or(behind, o.lessEqual(w, 1e-9));
    const ndc = o.div(corner.swizzle('xy'), w);
    low = low ? o.min(low, ndc) : ndc;
    high = high ? o.max(high, ndc) : ndc;
  }
  // Behind the camera: the whole screen.
  const lowest = o.select(low as PortHandle, [-1, -1], behind);
  const highest = o.select(high as PortHandle, [1, 1], behind);
  const tiles = g.constant(BuiltinTypes.vec2f, [TilesX, TilesY]);
  const tileOf = (ndc: Value) =>
    g.call(std.clamp, {
      x: g.call(std.floor, {
        x: o.mul(o.add(o.mul(ndc, 0.5), 0.5), tiles),
      }),
      low: [0, 0],
      high: [TilesX - 1, TilesY - 1],
    });
  const first = tileOf(o.sub(lowest, 1e-4));
  const last = tileOf(o.add(highest, 1e-4));
  const onScreen = o.and(
    o.and(
      o.greaterEqual(highest.swizzle('x'), -1),
      o.lessEqual(lowest.swizzle('x'), 1),
    ),
    o.and(
      o.greaterEqual(highest.swizzle('y'), -1),
      o.lessEqual(lowest.swizzle('y'), 1),
    ),
  );
  // Bounded (r > 0), between the near and far planes, in the slices of the
  // sphere, on the screen.
  const covers = o.and(
    o.and(
      o.and(o.greaterEqual(r, 1e-30), o.greaterEqual(o.add(d, r), near)),
      o.lessEqual(o.sub(d, r), far),
    ),
    o.and(
      o.and(
        o.greaterEqual(slice, sliceOf(o.sub(d, r))),
        o.lessEqual(slice, sliceOf(o.add(d, r))),
      ),
      onScreen,
    ),
  );
  g.write(g.storage('rects', vec4Array, { access: 'read-write' }), {
    index,
    value: o.select(
      [1, 1, 0, 0],
      g.call(std.vec4, {
        x: first.swizzle('x'),
        y: first.swizzle('y'),
        z: last.swizzle('x'),
        w: last.swizzle('y'),
      }),
      covers,
    ),
    when: o.less(index, g.uniform('count', BuiltinTypes.u32)),
  });
  return finish(g);
}

/**
 * visible[cluster × lights + light]: 1 where the light covers the tile of
 * the cluster in its slice.
 */
function pairsGraph() {
  const { g, o, index } = setup('pairs', prefix);
  const lights = g.uniform('lights', BuiltinTypes.u32);
  const cluster = o.div(index, lights);
  const light = o.remainder(index, lights);
  const tileX = o.f32(o.remainder(cluster, TilesX));
  const tileY = o.f32(o.remainder(o.div(cluster, TilesX), TilesY));
  const slice = o.div(cluster, TilesX * TilesY);
  const rect = o.index(
    g.storage('rects', vec4Array),
    o.add(o.mul(light, Slices), slice),
  );
  const covers = o.and(
    o.and(
      o.greaterEqual(tileX, rect.swizzle('x')),
      o.lessEqual(tileX, rect.swizzle('z')),
    ),
    o.and(
      o.greaterEqual(tileY, rect.swizzle('y')),
      o.lessEqual(tileY, rect.swizzle('w')),
    ),
  );
  g.write(g.storage('visible', u32Array, { access: 'read-write' }), {
    index,
    value: o.select(o.u32(0), o.u32(1), covers),
    when: o.less(index, g.uniform('count', BuiltinTypes.u32)),
  });
  return finish(g);
}

/**
 * The lists: the light of each pair found, as its index in the pool
 * (`first` the first bounded light), at grid[header + rank].
 */
function listsGraph() {
  const { g, o, index, previous } = setup('lists', prefix);
  const sum = g.storage('sum', u32Array);
  const through = o.index(sum, index);
  const found = o.equal(o.sub(through, previous(sum, index)), 1);
  const lights = g.uniform('lights', BuiltinTypes.u32);
  g.write(g.storage('grid', u32Array, { access: 'read-write' }), {
    index: o.add(Header - 1, through),
    value: o.add(
      g.uniform('first', BuiltinTypes.u32),
      o.remainder(index, lights),
    ),
    when: o.and(o.less(index, g.uniform('count', BuiltinTypes.u32)), found),
  });
  return finish(g);
}

/** The headers: grid[2c] the first element of the list of c, grid[2c + 1] its length. */
function headersGraph() {
  const { g, o, index, previous } = setup('headers', prefix);
  const sum = g.storage('sum', u32Array);
  const lights = g.uniform('lights', BuiltinTypes.u32);
  const start = o.mul(index, lights);
  const before = previous(sum, start);
  const through = previous(sum, o.add(start, lights));
  const grid = g.storage('grid', u32Array, { access: 'read-write' });
  const when = o.less(index, LightClusterCount);
  g.write(grid, { index: o.mul(index, 2), value: o.add(Header, before), when });
  g.write(grid, {
    index: o.add(o.mul(index, 2), 1),
    value: o.sub(through, before),
    when,
  });
  return finish(g);
}

interface Programs {
  readonly rects: CompiledProgram;
  readonly pairs: CompiledProgram;
  readonly scan: CompiledProgram;
  readonly lists: CompiledProgram;
  readonly headers: CompiledProgram;
}

/** What the light clusters of a view are computed from: see GpuLightClusters.record. */
export interface GpuClusterLights {
  // The bounding sphere of each bounded light in the world (x, y, z,
  // radius; a radius of 0 for a light that reaches nothing), see
  // lightSpheres.
  readonly spheres: Float32Array<ArrayBuffer>;
  // The number of lights in `spheres`.
  readonly count: number;
  // The index in the pool of the first of them.
  readonly first: number;
  readonly view: Mat4;
  readonly projection: Mat4;
  // The near and far planes, the scale and the bias of the slices (see
  // sliceParameters).
  readonly depths: readonly [number, number, number, number];
}

/**
 * The size in bytes of a light grid filled on the GPU for `lights` bounded
 * lights: the headers, and a list element per cluster and light at most.
 */
export const gpuLightGridSize = (lights: number): number =>
  (Header + LightClusterCount * Math.max(lights, 1)) * 4;

/**
 * Fills the light grid of views on the GPU (see LightClusters, which does
 * it on the CPU): the same lists, for the backends with compute shaders,
 * up to MaxGpuClusterLights bounded lights.
 */
export class GpuLightClusters {
  private _programs?: Programs;
  private readonly _runner: ComputeRunner;
  // The buffers of each view, grown as needed.
  private readonly _views = new Map<
    string,
    {
      spheres: GpuBuffer;
      rects: GpuBuffer;
      visible: GpuBuffer;
      sums: [GpuBuffer, GpuBuffer];
      lights: number;
      steps: object[];
    }
  >();

  constructor(private readonly _backend: RenderBackend) {
    this._runner = new ComputeRunner(_backend);
  }

  /**
   * Records the assignment of the lights of a view into a compute pass:
   * writes `grid`, of gpuLightGridSize(lights.count) bytes at least.
   */
  record(
    pass: GpuComputePassEncoder,
    view: string,
    lights: GpuClusterLights,
    grid: GpuBuffer,
  ): void {
    const count = Math.max(lights.count, 1);
    if (count > MaxGpuClusterLights) {
      throw new Error(
        `${lights.count} bounded lights: at most ${MaxGpuClusterLights} on the GPU`,
      );
    }
    const buffers = this.buffers(view, count);
    const programs = this.programs();
    const step = (k: number) => {
      while (buffers.steps.length <= k) {
        buffers.steps.push({});
      }
      return buffers.steps[k];
    };
    const groups = (n: number) => [Math.ceil(n / Workgroup)] as const;
    // Without light, one that reaches nothing.
    const spheres =
      lights.count > 0 ? lights.spheres : new Float32Array([0, 0, 0, 0]);
    buffers.spheres.write(0, spheres.buffer, spheres.byteOffset, count * 16);

    const rects = count * Slices;
    this._runner.record(pass, programs.rects, {
      values: {
        spheres: buffers.spheres,
        rects: buffers.rects,
        view: lights.view,
        projection: lights.projection,
        depths: [...lights.depths],
        count: rects,
      },
      workgroups: groups(rects),
      owner: step(0),
    });
    const pairs = count * LightClusterCount;
    this._runner.record(pass, programs.pairs, {
      values: {
        rects: buffers.rects,
        visible: buffers.visible,
        lights: count,
        count: pairs,
      },
      workgroups: groups(pairs),
      owner: step(1),
    });
    const sum = recordPrefixSum(
      this._runner,
      pass,
      programs.scan,
      buffers.visible,
      buffers.sums,
      pairs,
      (k) => step(2 + k),
    );
    const k = 2 + Math.ceil(Math.log2(pairs));
    this._runner.record(pass, programs.lists, {
      values: { sum, grid, lights: count, first: lights.first, count: pairs },
      workgroups: groups(pairs),
      owner: step(k),
    });
    this._runner.record(pass, programs.headers, {
      values: { sum, grid, lights: count },
      workgroups: groups(LightClusterCount),
      owner: step(k + 1),
    });
  }

  destroy(): void {
    for (const buffers of this._views.values()) {
      for (const buffer of [
        buffers.spheres,
        buffers.rects,
        buffers.visible,
        ...buffers.sums,
      ]) {
        buffer.destroy();
      }
    }
    this._views.clear();
    this._runner.destroy();
  }

  // The buffers of a view for `lights` lights: those of the previous
  // frames, or larger ones (twice what is needed).
  private buffers(view: string, lights: number) {
    const current = this._views.get(view);
    if (current && current.lights >= lights) {
      return current;
    }
    const capacity = Math.min(
      Math.max(lights, (current?.lights ?? 0) * 2, 16),
      MaxGpuClusterLights,
    );
    if (current) {
      for (const buffer of [
        current.spheres,
        current.rects,
        current.visible,
        ...current.sums,
      ]) {
        buffer.destroy();
      }
    }
    // Whole workgroups: the threads past the end read the buffers too.
    const whole = (n: number) => Math.ceil(n / Workgroup) * Workgroup;
    const create = (size: number, label: string) =>
      this._backend.buffers.create({
        size: Math.max(size, 256),
        usage: ['storage', 'copy-dst'],
        label: `${prefix} ${view} ${label}`,
      });
    const pairs = whole(capacity * LightClusterCount) * 4;
    const buffers = {
      spheres: create(capacity * 16, 'spheres'),
      rects: create(whole(capacity * Slices) * 16, 'tiles'),
      visible: create(pairs, 'pairs'),
      sums: [create(pairs, 'sums 0'), create(pairs, 'sums 1')] as [
        GpuBuffer,
        GpuBuffer,
      ],
      lights: capacity,
      steps: current?.steps ?? [],
    };
    this._views.set(view, buffers);
    return buffers;
  }

  private programs(): Programs {
    if (!this._programs) {
      const build = (graph: ReturnType<typeof finish>) =>
        compile(graph, { capabilities: this._backend.capabilities });
      this._programs = {
        rects: build(rectsGraph()),
        pairs: build(pairsGraph()),
        scan: build(scanGraph(prefix)),
        lists: build(listsGraph()),
        headers: build(headersGraph()),
      };
    }
    return this._programs;
  }
}
