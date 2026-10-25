import { Ops } from '@fdw/engine-ocean';
import { arrayType, BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { MaterialGraphData, PortHandle } from '@fdw/engine-shader';
import { bodiesInGraph, bodySpanInGraph, readBody } from '../bodies';

// The compute graphs of the shallow water, one thread per cell (i along x,
// j along z), in workgroups of 8 × 8. The cells hold (depth, occupancy,
// velocity x, velocity z), the fluxes the water leaving toward the four
// neighbors (-x, +x, -z, +z), in m³/s.

const vec4Array = arrayType(BuiltinTypes.vec4f);
const f32Array = arrayType(BuiltinTypes.f32);
export const workgroupSize = [8, 8, 1] as const;

/** The grid of a {@link ShallowWater}, as its graphs bake it. */
export interface ShallowGrid {
  readonly nx: number;
  readonly nz: number;
  /** The side of a cell, in meters. */
  readonly cell: number;
  /** The corner of the grid (x, z): cell (0, 0) spans it to + cell. */
  readonly origin: { readonly x: number; readonly z: number };
  /** Whether the water leaves by the edges (true), or meets walls. */
  readonly open: boolean;
}

// a && b, for booleans: the graphs have no logical operators.
const and = (o: Ops, a: PortHandle, b: PortHandle) => o.select(false, b, a);

// The thread: its cell, its index, whether it is in the grid, its
// neighbors (the cell itself past an edge).
function cellOf(o: Ops, grid: ShallowGrid) {
  const id = o.g.builtin('global-invocation-id');
  const i = id.swizzle('x');
  const j = id.swizzle('y');
  const index = o.add(o.mul(j, grid.nx), i);
  const inside = and(o, o.less(i, grid.nx), o.less(j, grid.nz));
  const has = {
    left: o.greater(i, 0),
    right: o.less(i, grid.nx - 1),
    back: o.greater(j, 0),
    front: o.less(j, grid.nz - 1),
  };
  const neighbor = {
    left: o.select(index, o.sub(index, 1), has.left),
    right: o.select(index, o.add(index, 1), has.right),
    back: o.select(index, o.sub(index, grid.nx), has.back),
    front: o.select(index, o.add(index, grid.nx), has.front),
  };
  return { id, i, j, index, inside, has, neighbor };
}

/**
 * The fluxes: each one grows by dt · g · cell · (H - H of the neighbor),
 * H = ground + depth + occupancy, damped, never negative; then all of a
 * cell scaled down so that it does not give more water than it has. Past
 * an edge: no flux toward a wall, toward a dry cell of the same ground if
 * the edges are open.
 */
export function fluxGraph(grid: ShallowGrid): MaterialGraphData {
  const g = new GraphBuilder('shallow water flux');
  const o = new Ops(g);
  const c = cellOf(o, grid);
  const ground = g.storage('ground', f32Array);
  const cells = g.storage('cells', vec4Array);
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const gravity = g.uniform('gravity', BuiltinTypes.f32, { default: 9.81 });
  const damping = g.uniform('damping', BuiltinTypes.f32, { default: 0.2 });
  const here = o.index(cells, c.index);
  const depth = here.swizzle('x');
  const groundHere = o.index(ground, c.index);
  const surface = (index: PortHandle, state: PortHandle) =>
    o.add(
      o.add(o.index(ground, index), state.swizzle('x')),
      state.swizzle('y'),
    );
  const h = o.add(o.add(groundHere, depth), here.swizzle('y'));
  const previous = o.index(g.storage('flux', vec4Array), c.index);
  const keep = o.max(o.sub(1, o.mul(damping, dt)), 0);
  const gain = o.mul(o.mul(dt, gravity), grid.cell);
  const toward = (
    side: 'left' | 'right' | 'back' | 'front',
    component: 'x' | 'y' | 'z' | 'w',
  ) => {
    const other = surface(c.neighbor[side], o.index(cells, c.neighbor[side]));
    // Past the edge: a dry cell of the same ground, or a wall.
    const beyond = grid.open ? groundHere : h;
    const neighborHeight = o.select(beyond, other, c.has[side]);
    return o.max(
      o.add(
        o.mul(previous.swizzle(component), keep),
        o.mul(gain, o.sub(h, neighborHeight)),
      ),
      0,
    );
  };
  const flux = o.vec4(
    toward('left', 'x'),
    toward('right', 'y'),
    toward('back', 'z'),
    toward('front', 'w'),
  );
  const total = o.dot(flux, [1, 1, 1, 1]);
  const water = o.mul(depth, grid.cell * grid.cell);
  const scale = o.min(o.div(water, o.max(o.mul(total, dt), 1e-12)), 1);
  g.write(g.storage('nextFlux', vec4Array, { access: 'read-write' }), {
    index: c.index,
    value: o.mul(flux, scale),
    when: c.inside,
  });
  g.compute({ workgroupSize });
  return g.build();
}

/**
 * The depths: the water in and out by the fluxes, the sources, the
 * velocity from the fluxes through the cell; then the occupancy of the
 * bodies, which raises the surface of the column: the part of each body
 * under the water alone, times `stiffness`, up to the whole body. The
 * water under a floating body drains until its surface meets the water
 * around: with a stiffness k, a body pushes k / (k + 1) of the water it
 * displaces aside. Not more: a column whose occupancy would follow the
 * surface exactly has no stable state, it rings.
 */
export function depthGraph(grid: ShallowGrid): MaterialGraphData {
  const g = new GraphBuilder('shallow water depth');
  const o = new Ops(g);
  const c = cellOf(o, grid);
  const ground = g.storage('ground', f32Array);
  const cells = g.storage('cells', vec4Array);
  const fluxes = g.storage('flux', vec4Array);
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const here = o.index(cells, c.index);
  const out = o.index(fluxes, c.index);
  // What the neighbors send this way; nothing from past the edges.
  const from = (side: 'left' | 'right' | 'back' | 'front', component: string) =>
    o.select(
      0,
      o.index(fluxes, c.neighbor[side]).swizzle(component),
      c.has[side],
    );
  const inLeft = from('left', 'y');
  const inRight = from('right', 'x');
  const inBack = from('back', 'w');
  const inFront = from('front', 'z');
  const area = grid.cell * grid.cell;
  const inflow = o.add(o.add(inLeft, inRight), o.add(inBack, inFront));
  const outflow = o.dot(out, [1, 1, 1, 1]);
  const depth = here.swizzle('x');
  // The sources: a rate (m³/s) over a disc.
  const x = o.add(
    grid.origin.x + grid.cell / 2,
    o.mul(o.convert(c.i, BuiltinTypes.f32), grid.cell),
  );
  const z = o.add(
    grid.origin.z + grid.cell / 2,
    o.mul(o.convert(c.j, BuiltinTypes.f32), grid.cell),
  );
  const xz = o.vec2(x, z);
  // The sources: a depth per second over a disc (see sourceRates).
  const sources = g.storage('sources', vec4Array);
  const sourceCount = g.uniform('sourceCount', BuiltinTypes.u32, {
    default: 0,
  });
  const added = g.fold(0, sourceCount, (sum, k) => {
    const source = o.index(sources, k);
    const radius = source.swizzle('z');
    const offset = o.sub(xz, source.swizzle('xy'));
    const inDisc = o.lessEqual(o.dot(offset, offset), o.mul(radius, radius));
    return o.add(sum, o.select(0, source.swizzle('w'), inDisc));
  });
  const next = o.max(
    o.add(
      depth,
      o.add(o.div(o.mul(o.sub(inflow, outflow), dt), area), o.mul(added, dt)),
    ),
    0,
  );
  // The water through the cell, per meter of width, over its mean depth.
  const mean = o.mul(o.add(depth, next), 0.5);
  const through = (
    a: PortHandle,
    b: PortHandle,
    c2: PortHandle,
    d: PortHandle,
  ) => o.mul(o.add(o.sub(a, b), o.sub(c2, d)), 0.5);
  const flowX = through(inLeft, out.swizzle('x'), out.swizzle('y'), inRight);
  const flowZ = through(inBack, out.swizzle('z'), out.swizzle('w'), inFront);
  const wet = o.greater(mean, 1e-3);
  const per = o.div(1, o.mul(o.max(mean, 0.01), grid.cell));
  const u = o.select(0, o.mul(flowX, per), wet);
  const w = o.select(0, o.mul(flowZ, per), wet);
  // The bodies in the column: `stiffness` times their part under the
  // water alone, up to their whole span above the ground.
  const groundHere = o.index(ground, c.index);
  const top = o.add(groundHere, next);
  const stiffness = g.uniform('stiffness', BuiltinTypes.f32, { default: 6 });
  const bodies = bodiesInGraph(g);
  const occupancy = g.fold(0, bodies.count, (sum, k) => {
    const span = bodySpanInGraph(o, readBody(o, bodies, k), xz);
    const low = o.max(span.swizzle('x'), groundHere);
    const high = span.swizzle('y');
    const under = o.max(o.sub(o.min(high, top), low), 0);
    return o.add(
      sum,
      o.min(o.mul(under, stiffness), o.max(o.sub(high, low), 0)),
    );
  });
  g.write(g.storage('nextCells', vec4Array, { access: 'read-write' }), {
    index: c.index,
    value: o.vec4(next, occupancy, u, w),
    when: c.inside,
  });
  g.compute({ workgroupSize });
  return g.build();
}

/**
 * The surface for the rendering: its height (the dry cells a little under
 * the ground: the edge of the water cuts the terrain), its slopes (central
 * differences over the wet neighbors), the speed of the water (-1 where
 * the cell is dry: the material discards it).
 */
export function surfaceGraph(grid: ShallowGrid): MaterialGraphData {
  const g = new GraphBuilder('shallow water surface');
  const o = new Ops(g);
  const c = cellOf(o, grid);
  const ground = g.storage('ground', f32Array);
  const cells = g.storage('cells', vec4Array);
  const dry = g.uniform('dryDepth', BuiltinTypes.f32, { default: 0.002 });
  const drop = g.uniform('dryDrop', BuiltinTypes.f32, { default: 0.05 });
  const heightOf = (index: PortHandle) => {
    const state = o.index(cells, index);
    return o.add(
      o.add(o.index(ground, index), state.swizzle('x')),
      state.swizzle('y'),
    );
  };
  const here = o.index(cells, c.index);
  const h = heightOf(c.index);
  const wetHere = o.greater(here.swizzle('x'), dry);
  // A neighbor's height if it is wet and in the grid, else this one's.
  const around = (side: 'left' | 'right' | 'back' | 'front') => {
    const index = c.neighbor[side];
    const wet = o.greater(o.index(cells, index).swizzle('x'), dry);
    return o.select(h, heightOf(index), and(o, c.has[side], wet));
  };
  const slope = (minus: PortHandle, plus: PortHandle) =>
    o.div(o.sub(plus, minus), 2 * grid.cell);
  // The speed of the water; -1 where it is dry.
  const speed = o.select(-1, o.length(here.swizzle('zw')), wetHere);
  g.write(g.storage('surface', vec4Array, { access: 'read-write' }), {
    index: c.index,
    value: o.vec4(
      o.select(o.sub(o.index(ground, c.index), drop), h, wetHere),
      slope(around('left'), around('right')),
      slope(around('back'), around('front')),
      speed,
    ),
    when: c.inside,
  });
  g.compute({ workgroupSize });
  return g.build();
}
