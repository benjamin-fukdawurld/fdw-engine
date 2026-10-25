import { Ops } from '@fdw/engine-ocean';
import { arrayType, BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { MaterialGraphData, PortHandle } from '@fdw/engine-shader';
import { bodiesInGraph, bodyDistanceInGraph, readBody } from '../bodies';
import { and } from '../smoke/grid';
import { tensileDistance } from './cpu';
import { InactiveKey, ParticleLayout, poly6 } from './kernels';

// The compute graphs of a fluid of particles (position-based fluids,
// Macklin and Müller 2013), one thread per particle (or per cell, per
// column), in workgroups of 64. The positions, velocities and predicted
// positions are vec4 (xyz, 0); the sort entries vec4u (key, index, 0, 0);
// the ranges of the cells two buffers of vec4u (the start, the end: x).

const vec4Array = arrayType(BuiltinTypes.vec4f);
const vec4uArray = arrayType(BuiltinTypes.vec4u);
export const particleWorkgroup = 64;

function setup(name: string) {
  const g = new GraphBuilder(`particles ${name}`);
  const o = new Ops(g);
  const index = g.builtin('global-invocation-id').swizzle('x');
  return { g, o, index };
}

// a == b, for booleans.
const same = (o: Ops, a: PortHandle, b: PortHandle) =>
  o.select(o.select(true, false, b), b, a);

const finish = (g: GraphBuilder) => {
  g.compute({ workgroupSize: [particleWorkgroup, 1, 1] });
  return g.build();
};

// Whether the thread is a particle in use.
const activeOf = (o: Ops, index: PortHandle) =>
  o.less(index, o.g.uniform('active', BuiltinTypes.u32, { default: 0 }));

/** The point moved out of the bodies and into the box, by the radius of a particle. */
function collideInGraph(
  o: Ops,
  layout: ParticleLayout,
  point: PortHandle,
): PortHandle {
  const r = layout.radius;
  const bodies = bodiesInGraph(o.g);
  const out = o.g.fold(point, bodies.count, (p, k) => {
    const contact = bodyDistanceInGraph(o, readBody(o, bodies, k), p);
    const depth = o.sub(contact.swizzle('w'), r);
    return o.select(
      p,
      o.sub(p, o.mul(contact.swizzle('xyz'), depth)),
      o.less(depth, 0),
    );
  });
  return o.clamp(
    out,
    layout.min.map((v) => v + r),
    layout.max.map((v) => v - r),
  );
}

/** The cell of a point (vec3u), clamped into the box, and its key. */
function cellInGraph(o: Ops, layout: ParticleLayout, point: PortHandle) {
  const raw = o.floor(o.div(o.sub(point, [...layout.min]), layout.h));
  const clamped = o.clamp(
    raw,
    [0, 0, 0],
    layout.cells.map((c) => c - 1),
  );
  const cell = o.convert(clamped, BuiltinTypes.vec3u);
  return { cell, key: keyOf(o, layout, cell) };
}

const keyOf = (o: Ops, layout: ParticleLayout, cell: PortHandle) =>
  o.add(
    o.mul(
      o.add(o.mul(cell.swizzle('z'), layout.cells[1]), cell.swizzle('y')),
      layout.cells[0],
    ),
    cell.swizzle('x'),
  );

/**
 * The prediction: the velocity under gravity over dt, the position it
 * leads to, out of the bodies and in the box. The particles not in use stay.
 */
export function predictGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('predict');
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const gravity = g.uniform('gravity', BuiltinTypes.f32, { default: 9.81 });
  const p = o.index(g.storage('positions', vec4Array), index).swizzle('xyz');
  const v = o.sub(
    o.index(g.storage('velocities', vec4Array), index).swizzle('xyz'),
    o.vec3(0, o.mul(gravity, dt), 0),
  );
  const moved = collideInGraph(o, layout, o.add(p, o.mul(v, dt)));
  g.write(g.storage('predicted', vec4Array, { access: 'read-write' }), {
    index,
    value: o.extend(o.select(p, moved, activeOf(o, index)), 0),
    when: o.less(index, layout.count),
  });
  return finish(g);
}

/** The sort entries: the key of the cell of each predicted position (the last key for the particles not in use), and the particle. */
export function keysGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('keys');
  const p = o.index(g.storage('predicted', vec4Array), index).swizzle('xyz');
  const key = o.select(
    o.u32(InactiveKey),
    cellInGraph(o, layout, p).key,
    activeOf(o, index),
  );
  g.write(g.storage('entries', vec4uArray, { access: 'read-write' }), {
    index,
    value: g.call(std.uvec4, { x: key, y: index, z: 0, w: 0 }),
    when: o.less(index, layout.count),
  });
  return finish(g);
}

/**
 * A stage of a bitonic sort of the entries by (key, particle): element i
 * meets element i ^ j and keeps the smaller one if its block (i & k) goes
 * up and it is the lower of the two, the larger one otherwise. The stage
 * (j, k) is in the `stage` buffer (x, y): one buffer per stage, every
 * dispatch binds its own.
 */
export function sortGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('sort');
  const stage = o.index(g.storage('stage', vec4uArray), 0);
  const j = stage.swizzle('x');
  const k = stage.swizzle('y');
  const entries = g.storage('entries', vec4uArray);
  const mine = o.index(entries, index);
  const other = o.index(entries, o.xor(index, j));
  // (key, particle) of mine before other's.
  const before = o.select(
    o.less(mine.swizzle('x'), other.swizzle('x')),
    o.less(mine.swizzle('y'), other.swizzle('y')),
    o.equal(mine.swizzle('x'), other.swizzle('x')),
  );
  const ascending = o.equal(o.and(index, k), 0);
  const lower = o.equal(o.and(index, j), 0);
  // Keep the smaller one when the order of the block and the place agree.
  const smaller = same(o, ascending, lower);
  const keepMine = same(o, before, smaller);
  g.write(g.storage('sorted', vec4uArray, { access: 'read-write' }), {
    index,
    value: o.select(other, mine, keepMine),
    when: o.less(index, layout.count),
  });
  return finish(g);
}

/** Empties the ranges of the cells (one thread per cell). */
export function clearCellsGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('clear cells');
  const count = layout.cells[0] * layout.cells[1] * layout.cells[2];
  const zero = g.constant(BuiltinTypes.vec4u, [0, 0, 0, 0]);
  for (const name of ['cellStarts', 'cellEnds']) {
    g.write(g.storage(name, vec4uArray, { access: 'read-write' }), {
      index,
      value: zero,
      when: o.less(index, count),
    });
  }
  return finish(g);
}

/** The ranges of the cells: where the sorted keys change, the start of one cell and the end of the other. */
export function cellRangesGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('cell ranges');
  const entries = g.storage('entries', vec4uArray);
  const key = o.index(entries, index).swizzle('x');
  const n = layout.count;
  const previous = o
    .index(entries, o.select(index, o.sub(index, 1), o.greater(index, 0)))
    .swizzle('x');
  const next = o
    .index(entries, o.select(index, o.add(index, 1), o.less(index, n - 1)))
    .swizzle('x');
  const used = and(o, o.notEqual(key, o.u32(InactiveKey)), o.less(index, n));
  const first = o.select(o.notEqual(key, previous), true, o.equal(index, 0));
  const last = o.select(o.notEqual(key, next), true, o.equal(index, n - 1));
  g.write(g.storage('cellStarts', vec4uArray, { access: 'read-write' }), {
    index: key,
    value: g.call(std.uvec4, { x: index, y: 0, z: 0, w: 0 }),
    when: and(o, used, first),
  });
  g.write(g.storage('cellEnds', vec4uArray, { access: 'read-write' }), {
    index: key,
    value: g.call(std.uvec4, { x: o.add(index, 1), y: 0, z: 0, w: 0 }),
    when: and(o, used, last),
  });
  return finish(g);
}

/** The particles in the order of the sort: positions, velocities, predictions. */
export function reorderGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('reorder');
  const from = o.index(g.storage('entries', vec4uArray), index).swizzle('y');
  for (const name of ['positions', 'velocities', 'predicted']) {
    const capitalized = name[0].toUpperCase() + name.slice(1);
    g.write(
      g.storage(`sorted${capitalized}`, vec4Array, { access: 'read-write' }),
      {
        index,
        value: o.index(g.storage(name, vec4Array), from),
        when: o.less(index, layout.count),
      },
    );
  }
  return finish(g);
}

/**
 * Folds over the neighbors of a point: each particle of the 27 cells
 * around (those of a cell up to `maxPerCell`), from `initial`.
 */
function neighborsInGraph(
  o: Ops,
  layout: ParticleLayout,
  point: PortHandle,
  initial: PortHandle | number | number[],
  body: (state: PortHandle, j: PortHandle) => PortHandle,
): PortHandle {
  const g = o.g;
  const starts = g.storage('cellStarts', vec4uArray);
  const ends = g.storage('cellEnds', vec4uArray);
  const raw = o.floor(o.div(o.sub(point, [...layout.min]), layout.h));
  const base = o.convert(
    o.clamp(
      raw,
      [0, 0, 0],
      layout.cells.map((c) => c - 1),
    ),
    BuiltinTypes.vec3i,
  );
  return g.fold(initial, 27, (state, n) => {
    const offset = o.sub(
      o.convert(
        g.call(std.uvec3, {
          x: o.remainder(n, 3),
          y: o.remainder(o.div(n, 3), 3),
          z: o.div(n, 9),
        }),
        BuiltinTypes.vec3i,
      ),
      g.constant(BuiltinTypes.vec3i, [1, 1, 1]),
    );
    const cell = o.add(base, offset);
    const within = (axis: 'x' | 'y' | 'z', size: number) =>
      and(
        o,
        o.greaterEqual(cell.swizzle(axis), 0),
        o.less(cell.swizzle(axis), size),
      );
    const inside = and(
      o,
      within('x', layout.cells[0]),
      and(o, within('y', layout.cells[1]), within('z', layout.cells[2])),
    );
    const key = keyOf(
      o,
      layout,
      o.convert(
        o.clamp(
          cell,
          g.constant(BuiltinTypes.vec3i, [0, 0, 0]),
          g.constant(
            BuiltinTypes.vec3i,
            layout.cells.map((c) => c - 1),
          ),
        ),
        BuiltinTypes.vec3u,
      ),
    );
    const start = o.index(starts, key).swizzle('x');
    const end = o.index(ends, key).swizzle('x');
    const count = o.select(
      o.u32(0),
      o.min(o.sub(o.max(end, start), start), layout.maxPerCell),
      inside,
    );
    return g.fold(state, count, (s, m) => body(s, o.add(start, m)));
  });
}

// The poly6 kernel and the factor of the spiky gradient (∇W = factor × r),
// in a graph, of the squared distance.
function kernelsInGraph(o: Ops, layout: ParticleLayout, r2: PortHandle) {
  const h = layout.h;
  const inside = o.less(r2, h * h);
  const d = o.max(o.sub(h * h, r2), 0);
  const w = o.select(
    0,
    o.mul(o.mul(o.mul(d, d), d), 315 / (64 * Math.PI * h ** 9)),
    inside,
  );
  const r = o.sqrt(r2);
  const near = o.max(o.sub(h, r), 0);
  const gradient = o.select(
    0,
    o.div(o.mul(o.mul(near, near), -45 / (Math.PI * h ** 6)), o.max(r, 1e-9)),
    and(o, inside, o.greater(r, 1e-9)),
  );
  return { w, gradient };
}

/**
 * The constraint of density of each particle: λ = −C / (Σ |∇C|² + ε),
 * C = max(ρ / ρ0 − 1, 0); vec4 (λ, ρ / ρ0, 0, 0).
 */
export function lambdaGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('lambda');
  const predicted = g.storage('predicted', vec4Array);
  const p = o.index(predicted, index).swizzle('xyz');
  const rho0 = layout.restDensity;
  const around = (j: PortHandle) => {
    const r = o.sub(p, o.index(predicted, j).swizzle('xyz'));
    const r2 = o.dot(r, r);
    return { r, r2, ...kernelsInGraph(o, layout, r2) };
  };
  // The gradient of C with respect to the particle, and the density.
  const sums = neighborsInGraph(o, layout, p, [0, 0, 0, 0], (state, j) => {
    const n = around(j);
    return o.add(state, o.extend(o.mul(n.r, o.div(n.gradient, rho0)), n.w));
  });
  // The squared gradients with respect to the neighbors.
  const squares = neighborsInGraph(o, layout, p, 0, (state, j) => {
    const n = around(j);
    const factor = o.div(n.gradient, rho0);
    return o.add(state, o.mul(o.mul(factor, factor), n.r2));
  });
  const density = o.div(sums.swizzle('w'), rho0);
  const constraint = o.max(o.sub(density, 1), 0);
  const gradient = sums.swizzle('xyz');
  const lambda = o.div(
    o.mul(constraint, -1),
    o.add(o.add(o.dot(gradient, gradient), squares), layout.relaxation),
  );
  g.write(g.storage('lambdas', vec4Array, { access: 'read-write' }), {
    index,
    value: o.vec4(o.select(0, lambda, activeOf(o, index)), density, 0, 0),
    when: o.less(index, layout.count),
  });
  return finish(g);
}

/**
 * The correction of the positions: Δp = Σ (λi + λj + s_corr) ∇W / ρ0,
 * s_corr the artificial pressure against clumping; then out of the bodies
 * and into the box.
 */
export function deltaGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('delta');
  const predicted = g.storage('predicted', vec4Array);
  const lambdas = g.storage('lambdas', vec4Array);
  const tensile = g.uniform('tensile', BuiltinTypes.f32, { default: 0.03 });
  const p = o.index(predicted, index).swizzle('xyz');
  const lambda = o.index(lambdas, index).swizzle('x');
  const reference = poly6((tensileDistance * layout.h) ** 2, layout.h);
  const corrective = o.div(o.mul(tensile, -1), layout.restGradients);
  const delta = neighborsInGraph(o, layout, p, [0, 0, 0], (state, j) => {
    const r = o.sub(p, o.index(predicted, j).swizzle('xyz'));
    const k = kernelsInGraph(o, layout, o.dot(r, r));
    const ratio = o.div(k.w, reference);
    const ratio2 = o.mul(ratio, ratio);
    const s = o.mul(corrective, o.mul(ratio2, ratio2));
    const weight = o.div(
      o.mul(
        o.add(o.add(lambda, o.index(lambdas, j).swizzle('x')), s),
        k.gradient,
      ),
      layout.restDensity,
    );
    return o.add(state, o.mul(r, weight));
  });
  const moved = collideInGraph(o, layout, o.add(p, delta));
  g.write(g.storage('nextPredicted', vec4Array, { access: 'read-write' }), {
    index,
    value: o.extend(o.select(p, moved, activeOf(o, index)), 0),
    when: o.less(index, layout.count),
  });
  return finish(g);
}

/** The velocities from the motion: v = (p* − p) / dt. */
export function velocityGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('velocity');
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const p = o.index(g.storage('positions', vec4Array), index);
  const q = o.index(g.storage('predicted', vec4Array), index);
  const v = o.index(g.storage('velocities', vec4Array), index);
  g.write(g.storage('nextVelocities', vec4Array, { access: 'read-write' }), {
    index,
    value: o.select(
      v,
      o.extend(o.div(o.sub(q, p).swizzle('xyz'), dt), 0),
      activeOf(o, index),
    ),
    when: o.less(index, layout.count),
  });
  return finish(g);
}

/**
 * The viscosity (XSPH): each velocity drawn toward its neighbors'; then
 * the step is done: the positions are the predictions.
 */
export function viscosityGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('viscosity');
  const predicted = g.storage('predicted', vec4Array);
  const velocities = g.storage('velocities', vec4Array);
  const viscosity = g.uniform('viscosity', BuiltinTypes.f32, { default: 0.02 });
  const maxSpeed = g.uniform('maxSpeed', BuiltinTypes.f32, { default: 8 });
  const q = o.index(predicted, index);
  const p = q.swizzle('xyz');
  const v = o.index(velocities, index).swizzle('xyz');
  const sum = neighborsInGraph(o, layout, p, [0, 0, 0], (state, j) => {
    const r = o.sub(p, o.index(predicted, j).swizzle('xyz'));
    const w = o.div(
      kernelsInGraph(o, layout, o.dot(r, r)).w,
      layout.restDensity,
    );
    return o.add(
      state,
      o.mul(o.sub(o.index(velocities, j).swizzle('xyz'), v), w),
    );
  });
  const out = o.add(v, o.mul(sum, viscosity));
  const speed = o.length(out);
  const limited = o.mul(out, o.min(o.div(maxSpeed, o.max(speed, 1e-6)), 1));
  const active = activeOf(o, index);
  const when = o.less(index, layout.count);
  g.write(g.storage('nextVelocities', vec4Array, { access: 'read-write' }), {
    index,
    value: o.extend(o.select(v, limited, active), 0),
    when,
  });
  g.write(g.storage('nextPositions', vec4Array, { access: 'read-write' }), {
    index,
    value: q,
    when,
  });
  return finish(g);
}

/**
 * The surface of the liquid over each column of cells (x, z), for what
 * floats: from the top, the first cell holding `columnCount` particles or
 * more; the highest of them (plus a radius) and their mean velocity. vec4
 * (height, velocity x, velocity z, 1 if found); the minimum of the box
 * where the column is dry.
 */
export function columnsGraph(layout: ParticleLayout): MaterialGraphData {
  const { g, o, index } = setup('columns');
  const [gx, gy, gz] = layout.cells;
  const starts = g.storage('cellStarts', vec4uArray);
  const ends = g.storage('cellEnds', vec4uArray);
  const positions = g.storage('positions', vec4Array);
  const velocities = g.storage('velocities', vec4Array);
  const least = g.uniform('columnCount', BuiltinTypes.u32, { default: 3 });
  const x = o.remainder(index, gx);
  const z = o.div(index, gx);
  const found = g.fold([layout.min[1], 0, 0, 0], gy, (state, k) => {
    const y = o.sub(gy - 1, k);
    const key = o.add(o.mul(o.add(o.mul(z, gy), y), gx), x);
    const start = o.index(starts, key).swizzle('x');
    const end = o.index(ends, key).swizzle('x');
    const count = o.sub(o.max(end, start), start);
    const full = and(
      o,
      o.greaterEqual(count, least),
      o.less(state.swizzle('w'), 0.5),
    );
    // The highest particle of the cell, and the sum of their velocities.
    const cell = g.fold(
      [layout.min[1], 0, 0, 0],
      o.min(count, layout.maxPerCell),
      (s, m) => {
        const particle = o.add(start, m);
        const v = o.index(velocities, particle);
        return o.vec4(
          o.max(s.swizzle('x'), o.index(positions, particle).swizzle('y')),
          o.add(s.swizzle('y'), v.swizzle('x')),
          o.add(s.swizzle('z'), v.swizzle('z')),
          0,
        );
      },
    );
    const visited = o.convert(
      o.max(o.min(count, layout.maxPerCell), 1),
      BuiltinTypes.f32,
    );
    return o.select(
      state,
      o.vec4(
        o.add(cell.swizzle('x'), layout.radius),
        o.div(cell.swizzle('y'), visited),
        o.div(cell.swizzle('z'), visited),
        1,
      ),
      full,
    );
  });
  g.write(g.storage('columns', vec4Array, { access: 'read-write' }), {
    index,
    value: found,
    when: o.less(index, gx * gz),
  });
  return finish(g);
}
