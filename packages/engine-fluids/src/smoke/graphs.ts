import { Ops } from '@fdw/engine-ocean';
import { arrayType, BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { MaterialGraphData, PortHandle } from '@fdw/engine-shader';
import {
  bodiesInGraph,
  bodyDistanceInGraph,
  bodyVelocityInGraph,
  readBody,
} from '../bodies';
import {
  and,
  Axis,
  axesOf,
  axisIndex,
  cellLattice,
  faceLattice,
  faceSize,
  isFlat,
  latticeIndexInGraph,
  latticeThread,
  or,
  sampleLattice,
  VolumeGrid,
  volumeWorkgroup,
} from './grid';

// The compute graphs of the smoke (stable fluids, Stam 1999), on a
// staggered grid (MAC, Harlow and Welch): the velocity across each face of
// the cells, the rest at their centers. The velocity buffer holds, at
// entry (i, j, k), the velocities across the three low faces of cell
// (i, j, k) (one entry more along each axis: the far faces). The cells
// hold the scalars (density of smoke, temperature), the solids (1 in an
// obstacle, its velocity), the pressure (the pressure, the divergence),
// the vorticity (its vector, its norm), the shade for the rendering.

const vec4Array = arrayType(BuiltinTypes.vec4f);

/** How fast the noise of a turbulent emitter rises through it, in its sizes per second. */
export const flickerSpeed = 3;

/** A face of the box of a grid. */
export type GridFace = '-x' | '+x' | '-y' | '+y' | '-z' | '+z';

/** A grid of smoke as its graphs bake it: the cells, and the open faces. */
export interface SmokeLayout extends VolumeGrid {
  /** Where the smoke leaves the box; the other faces are walls. */
  readonly open: readonly GridFace[];
}

const unit = (axis: Axis): [number, number, number] => [
  axis === 'x' ? 1 : 0,
  axis === 'y' ? 1 : 0,
  axis === 'z' ? 1 : 0,
];
const cellCount = (grid: VolumeGrid) => [grid.nx, grid.ny, grid.nz];
const cellSizeOf = (grid: VolumeGrid): [number, number, number] => [
  grid.nx,
  grid.ny,
  grid.nz,
];
const notOf = (o: Ops, value: PortHandle) => o.select(true, false, value);

function setup(name: string, grid: SmokeLayout, over: 'cells' | 'faces') {
  const g = new GraphBuilder(`smoke ${name}`);
  const o = new Ops(g);
  const t = latticeThread(
    o,
    over === 'cells' ? cellSizeOf(grid) : faceSize(grid),
  );
  return { g, o, t };
}

// The velocity at a point: each component read on its own faces.
function velocityAt(
  o: Ops,
  grid: SmokeLayout,
  velocity: PortHandle,
  point: PortHandle,
): PortHandle {
  const component = (axis: Axis) =>
    sampleLattice(o, grid, faceLattice(grid, axis), velocity, point).swizzle(
      axis,
    );
  return o.vec3(
    component('x'),
    component('y'),
    isFlat(grid) ? 0 : component('z'),
  );
}

// The face of the thread's entry across an axis: whether the entry is such
// a face, the cells on its two sides and whether they exist, where the
// face is in the world.
function faceOf(
  o: Ops,
  grid: SmokeLayout,
  t: ReturnType<typeof latticeThread>,
  axis: Axis,
) {
  const n = cellCount(grid);
  let valid: PortHandle = o.lessEqual(t.coordinate[axis], n[axisIndex[axis]]);
  for (const b of axesOf(grid)) {
    if (b !== axis) {
      valid = and(o, valid, o.less(t.coordinate[b], n[axisIndex[b]]));
    }
  }
  const hasBefore = o.greater(t.coordinate[axis], 0);
  const hasAfter = o.less(t.coordinate[axis], n[axisIndex[axis]]);
  const cells = cellSizeOf(grid);
  // Clamped into the grid: the far faces' after cell does not exist.
  const after = latticeIndexInGraph(
    o,
    cells,
    o.min(
      t.id,
      o.g.constant(BuiltinTypes.vec3u, [grid.nx - 1, grid.ny - 1, grid.nz - 1]),
    ),
  );
  const before = o.select(
    after,
    latticeIndexInGraph(
      o,
      cells,
      o.sub(t.id, o.g.constant(BuiltinTypes.vec3u, unit(axis))),
    ),
    hasBefore,
  );
  const lattice = faceLattice(grid, axis);
  const position = o.add(
    o.mul(
      o.add(o.convert(t.id, BuiltinTypes.vec3f), [...lattice.offset]),
      grid.cell,
    ),
    [grid.origin.x, grid.origin.y, grid.origin.z],
  );
  return { valid, hasBefore, hasAfter, before, after, position };
}

// A velocity across a face, bound by what is on its sides: an obstacle's
// velocity next to one (the cell after the face first), 0 at a wall, free
// across an open face or between two cells of air.
function constrainFace(
  o: Ops,
  grid: SmokeLayout,
  solids: PortHandle,
  face: ReturnType<typeof faceOf>,
  axis: Axis,
  value: PortHandle,
): PortHandle {
  const solidAfter = o.index(solids, face.after);
  const solidBefore = o.index(solids, face.before);
  const isSolid = (solid: PortHandle) => o.greater(solid.swizzle('x'), 0.5);
  const component = axis === 'x' ? 'y' : axis === 'y' ? 'z' : 'w';
  const openBefore = grid.open.includes(`-${axis}` as GridFace);
  const openAfter = grid.open.includes(`+${axis}` as GridFace);
  // Past an edge: a wall (0), or free.
  const atEdge = o.select(
    openAfter ? value : 0,
    openBefore ? value : 0,
    notOf(o, face.hasBefore),
  );
  const inside = o.select(
    o.select(value, solidBefore.swizzle(component), isSolid(solidBefore)),
    solidAfter.swizzle(component),
    isSolid(solidAfter),
  );
  const edge = or(o, notOf(o, face.hasBefore), notOf(o, face.hasAfter));
  return o.select(inside, atEdge, edge);
}

const cellCenter = (o: Ops, grid: VolumeGrid, id: PortHandle) =>
  o.add(o.mul(o.add(o.convert(id, BuiltinTypes.vec3f), 0.5), grid.cell), [
    grid.origin.x,
    grid.origin.y,
    grid.origin.z,
  ]);

/**
 * The obstacles: each cell whose center is in a body takes its velocity
 * (vec4: 1, the velocity of its surface there); the others (0, 0).
 */
export function solidsGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('solids', grid, 'cells');
  const center = cellCenter(o, grid, t.id);
  const bodies = bodiesInGraph(g);
  const solid = g.fold([0, 0, 0, 0], bodies.count, (state, k) => {
    const body = readBody(o, bodies, k);
    const inBody = o.less(bodyDistanceInGraph(o, body, center).swizzle('w'), 0);
    const v = bodyVelocityInGraph(o, body, center);
    return o.select(
      state,
      o.vec4(1, v.swizzle('x'), v.swizzle('y'), v.swizzle('z')),
      inBody,
    );
  });
  g.write(g.storage('solids', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: solid,
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

// The emitters: their strength at a point (1 in the inner half of the
// sphere, fading to 0 at its surface), their three vec4.
function emittersInGraph(o: Ops) {
  const g = o.g;
  const buffer = g.storage('emitters', vec4Array);
  const count = g.uniform('emitterCount', BuiltinTypes.u32, { default: 0 });
  const slot = (k: PortHandle, n: number) =>
    o.index(buffer, o.add(o.mul(k, 3), n));
  const strength = (k: PortHandle, point: PortHandle) => {
    const sphere = slot(k, 0);
    const distance = o.length(o.sub(point, sphere.swizzle('xyz')));
    const radius = sphere.swizzle('w');
    return o.sub(1, o.smoothstep(o.mul(radius, 0.5), radius, distance));
  };
  return { count, slot, strength };
}

/**
 * The advection of the velocity: each face traces the velocity back over
 * dt (a midpoint step) and takes the velocity across it it finds there;
 * then the forces (the heat lifts, the smoke weighs), the emitters that
 * blow, the obstacles and the walls.
 */
export function advectVelocityGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('advect velocity', grid, 'faces');
  const velocity = g.storage('velocity', vec4Array);
  const scalars = g.storage('scalars', vec4Array);
  const solids = g.storage('solids', vec4Array);
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const buoyancy = g.uniform('buoyancy', BuiltinTypes.f32, { default: 1 });
  const weight = g.uniform('weight', BuiltinTypes.f32, { default: 0.05 });
  const emitters = emittersInGraph(o);
  const component = (axis: Axis) => {
    const face = faceOf(o, grid, t, axis);
    const v1 = velocityAt(o, grid, velocity, face.position);
    const middle = o.sub(face.position, o.mul(v1, o.mul(dt, 0.5)));
    const v2 = velocityAt(o, grid, velocity, middle);
    const from = o.sub(face.position, o.mul(v2, dt));
    let value = sampleLattice(
      o,
      grid,
      faceLattice(grid, axis),
      velocity,
      from,
    ).swizzle(axis);
    if (axis === 'y') {
      const here = sampleLattice(
        o,
        grid,
        cellLattice(grid),
        scalars,
        face.position,
      );
      value = o.add(
        value,
        o.mul(
          o.sub(
            o.mul(buoyancy, here.swizzle('y')),
            o.mul(weight, here.swizzle('x')),
          ),
          dt,
        ),
      );
    }
    // The emitters that blow: their velocity, weighted by their strength.
    const blown = g.fold([0, 0], emitters.count, (state, k) => {
      const blow = emitters.slot(k, 2);
      const s = o.mul(emitters.strength(k, face.position), blow.swizzle('w'));
      return o.add(state, o.vec2(o.mul(blow.swizzle(axis), s), s));
    });
    const blowing = o.min(blown.swizzle('y'), 1);
    value = o.mix(
      value,
      o.div(blown.swizzle('x'), o.max(blown.swizzle('y'), 1e-6)),
      blowing,
    );
    return o.select(
      0,
      constrainFace(o, grid, solids, face, axis, value),
      face.valid,
    );
  };
  g.write(g.storage('nextVelocity', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.vec4(
      component('x'),
      component('y'),
      isFlat(grid) ? 0 : component('z'),
      0,
    ),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

/**
 * The advection of the scalars: each cell traces the velocity back over dt
 * and takes the smoke and the heat it finds there; then the emitters pour,
 * the smoke thins, the heat goes. None in the obstacles.
 */
export function advectScalarsGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('advect scalars', grid, 'cells');
  const velocity = g.storage('velocity', vec4Array);
  const scalars = g.storage('scalars', vec4Array);
  const solid = o.index(g.storage('solids', vec4Array), t.index);
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const center = cellCenter(o, grid, t.id);
  const v1 = velocityAt(o, grid, velocity, center);
  const middle = o.sub(center, o.mul(v1, o.mul(dt, 0.5)));
  const v2 = velocityAt(o, grid, velocity, middle);
  const from = o.sub(center, o.mul(v2, dt));
  const carried = sampleLattice(o, grid, cellLattice(grid), scalars, from);
  const emitters = emittersInGraph(o);
  const time = g.uniform('time', BuiltinTypes.f32, { default: 0 });
  // Density added, temperature reached; flickering where the emitter is
  // turbulent (a noise rising through it).
  const poured = g.fold([0, 0], emitters.count, (state, k) => {
    const sphere = emitters.slot(k, 0);
    const rates = emitters.slot(k, 1);
    const noise = g.call('noise.simplex3', {
      point: o.sub(
        o.div(o.mul(center, 2), sphere.swizzle('w')),
        o.vec3(0, o.mul(time, flickerSpeed), 0),
      ),
    });
    const flicker = o.sub(
      1,
      o.mul(rates.swizzle('z'), o.add(o.mul(noise, 0.5), 0.5)),
    );
    const s = o.mul(emitters.strength(k, center), flicker);
    return o.vec2(
      o.add(state.swizzle('x'), o.mul(o.mul(rates.swizzle('x'), s), dt)),
      o.max(state.swizzle('y'), o.mul(rates.swizzle('y'), s)),
    );
  });
  const decay = g.uniform('densityDecay', BuiltinTypes.f32, { default: 0.05 });
  const cooling = g.uniform('cooling', BuiltinTypes.f32, { default: 0.8 });
  const density = o.div(
    o.add(carried.swizzle('x'), poured.swizzle('x')),
    o.add(1, o.mul(dt, decay)),
  );
  const temperature = o.div(
    o.max(carried.swizzle('y'), poured.swizzle('y')),
    o.add(1, o.mul(dt, cooling)),
  );
  g.write(g.storage('nextScalars', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.select(
      o.vec4(density, temperature, 0, 0),
      [0, 0, 0, 0],
      o.greater(solid.swizzle('x'), 0.5),
    ),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

// The velocity at the center of a cell (vec3u coordinates): the mean of
// its two faces across each axis.
function centerVelocity(
  o: Ops,
  grid: SmokeLayout,
  velocity: PortHandle,
  ijk: PortHandle,
): PortHandle {
  const size = faceSize(grid);
  const low = o.index(velocity, latticeIndexInGraph(o, size, ijk));
  const high = (axis: Axis) =>
    o
      .index(
        velocity,
        latticeIndexInGraph(
          o,
          size,
          o.add(ijk, o.g.constant(BuiltinTypes.vec3u, unit(axis))),
        ),
      )
      .swizzle(axis);
  return o.mul(
    o.vec3(
      o.add(low.swizzle('x'), high('x')),
      o.add(low.swizzle('y'), high('y')),
      isFlat(grid) ? 0 : o.add(low.swizzle('z'), high('z')),
    ),
    0.5,
  );
}

// The coordinates of the neighbor of a cell along an axis, the cell itself
// past an edge.
function neighborCell(
  o: Ops,
  grid: VolumeGrid,
  ijk: PortHandle,
  axis: Axis,
  side: -1 | 1,
): PortHandle {
  const n = cellCount(grid)[axisIndex[axis]];
  const offset = o.g.constant(BuiltinTypes.vec3u, unit(axis));
  const at = ijk.swizzle(axis);
  return side < 0
    ? o.select(ijk, o.sub(ijk, offset), o.greater(at, 0))
    : o.select(ijk, o.add(ijk, offset), o.less(at, n - 1));
}

/**
 * The vorticity at the centers of the cells: ω = ∇ × u, from the velocities
 * at the centers around (vec4: ω, |ω|); its z alone in a plane.
 */
export function vorticityGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('vorticity', grid, 'cells');
  const velocity = g.storage('velocity', vec4Array);
  const d = (axis: Axis) =>
    o.div(
      o.sub(
        centerVelocity(o, grid, velocity, neighborCell(o, grid, t.id, axis, 1)),
        centerVelocity(
          o,
          grid,
          velocity,
          neighborCell(o, grid, t.id, axis, -1),
        ),
      ),
      2 * grid.cell,
    );
  const dx = d('x');
  const dy = d('y');
  let curl: PortHandle;
  if (isFlat(grid)) {
    curl = o.vec3(0, 0, o.sub(dx.swizzle('y'), dy.swizzle('x')));
  } else {
    const dz = d('z');
    curl = o.vec3(
      o.sub(dy.swizzle('z'), dz.swizzle('y')),
      o.sub(dz.swizzle('x'), dx.swizzle('z')),
      o.sub(dx.swizzle('y'), dy.swizzle('x')),
    );
  }
  g.write(g.storage('vorticity', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.extend(curl, o.length(curl)),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

/**
 * The vorticity confinement (Fedkiw et al.): the force ε · cell · (N × ω)
 * at the centers, N the direction in which |ω| grows, brought to the faces
 * (the mean of their two cells): the swirls that the advection blurs away.
 */
export function confineGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('confine', grid, 'faces');
  const velocity = g.storage('velocity', vec4Array);
  const vorticity = g.storage('vorticity', vec4Array);
  const solids = g.storage('solids', vec4Array);
  const dt = g.uniform('dt', BuiltinTypes.f32);
  const epsilon = g.uniform('confinement', BuiltinTypes.f32, { default: 2 });
  const cells = cellSizeOf(grid);
  const read = (ijk: PortHandle) =>
    o.index(vorticity, latticeIndexInGraph(o, cells, ijk));
  // The force at the center of a cell.
  const force = (ijk: PortHandle) => {
    const norm = (axis: Axis, side: -1 | 1) =>
      read(neighborCell(o, grid, ijk, axis, side)).swizzle('w');
    const gradient = o.vec3(
      o.sub(norm('x', 1), norm('x', -1)),
      o.sub(norm('y', 1), norm('y', -1)),
      isFlat(grid) ? 0 : o.sub(norm('z', 1), norm('z', -1)),
    );
    const n = o.div(gradient, o.max(o.length(gradient), 1e-6));
    return o.mul(
      o.cross(n, read(ijk).swizzle('xyz')),
      o.mul(epsilon, grid.cell),
    );
  };
  // The cell after the face, clamped into the grid.
  const after = o.min(
    t.id,
    o.g.constant(BuiltinTypes.vec3u, [grid.nx - 1, grid.ny - 1, grid.nz - 1]),
  );
  const here = force(after);
  const current = o.index(velocity, t.index);
  const component = (axis: Axis) => {
    const face = faceOf(o, grid, t, axis);
    const before = force(neighborCell(o, grid, after, axis, -1));
    const mean = o.mul(o.add(here.swizzle(axis), before.swizzle(axis)), 0.5);
    const value = o.add(current.swizzle(axis), o.mul(mean, dt));
    return o.select(
      0,
      constrainFace(o, grid, solids, face, axis, value),
      face.valid,
    );
  };
  g.write(g.storage('nextVelocity', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.vec4(
      component('x'),
      component('y'),
      isFlat(grid) ? 0 : component('z'),
      0,
    ),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

/**
 * The divergence of each cell, from the velocities across its faces,
 * beside the pressure of the last frame (where the solve starts): vec4
 * (pressure, divergence, 0, 0).
 */
export function divergenceGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('divergence', grid, 'cells');
  const velocity = g.storage('velocity', vec4Array);
  const size = faceSize(grid);
  const low = o.index(velocity, latticeIndexInGraph(o, size, t.id));
  const divergence = o.div(
    o.sum(
      axesOf(grid).map((axis) =>
        o.sub(
          o
            .index(
              velocity,
              latticeIndexInGraph(
                o,
                size,
                o.add(t.id, o.g.constant(BuiltinTypes.vec3u, unit(axis))),
              ),
            )
            .swizzle(axis),
          low.swizzle(axis),
        ),
      ),
    ),
    grid.cell,
  );
  const previous = o
    .index(g.storage('pressure', vec4Array), t.index)
    .swizzle('x');
  g.write(g.storage('nextPressure', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.vec4(previous, divergence, 0, 0),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

/**
 * A step of Jacobi of the pressure: p = (Σ p of the neighbors − cell² ·
 * divergence) / their number, over the neighbors of air (0 past an open
 * face); the obstacles and the walls are left out (no flow through them).
 */
export function jacobiGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('pressure', grid, 'cells');
  const pressure = g.storage('pressure', vec4Array);
  const solids = g.storage('solids', vec4Array);
  const cells = cellSizeOf(grid);
  const here = o.index(pressure, t.index);
  // (p, 1) for each neighbor that counts.
  const terms = axesOf(grid).flatMap((axis) =>
    ([-1, 1] as const).map((side) => {
      const n = cellCount(grid)[axisIndex[axis]];
      const at = t.coordinate[axis];
      const has = side < 0 ? o.greater(at, 0) : o.less(at, n - 1);
      const neighbor = latticeIndexInGraph(
        o,
        cells,
        neighborCell(o, grid, t.id, axis, side),
      );
      const solid = o.greater(o.index(solids, neighbor).swizzle('x'), 0.5);
      const open = grid.open.includes(
        `${side < 0 ? '-' : '+'}${axis}` as GridFace,
      );
      const inside = o.select(
        o.vec2(o.index(pressure, neighbor).swizzle('x'), 1),
        o.vec2(0, 0),
        solid,
      );
      return o.select(o.vec2(0, open ? 1 : 0), inside, has);
    }),
  );
  const sum = o.sum(terms);
  const next = o.select(
    0,
    o.div(
      o.sub(sum.swizzle('x'), o.mul(here.swizzle('y'), grid.cell * grid.cell)),
      o.max(sum.swizzle('y'), 1),
    ),
    o.greater(sum.swizzle('y'), 0),
  );
  g.write(g.storage('nextPressure', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.vec4(next, here.swizzle('y'), 0, 0),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

/**
 * The projection: each face loses the difference of pressure across it
 * (u −= ∇p), the velocity without divergence; obstacles and walls bound
 * it.
 */
export function projectGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('project', grid, 'faces');
  const velocity = g.storage('velocity', vec4Array);
  const pressure = g.storage('pressure', vec4Array);
  const solids = g.storage('solids', vec4Array);
  const current = o.index(velocity, t.index);
  const component = (axis: Axis) => {
    const face = faceOf(o, grid, t, axis);
    // Past an edge, the pressure is 0 (open; walls are bound below).
    const p = (cell: PortHandle, has: PortHandle) =>
      o.select(0, o.index(pressure, cell).swizzle('x'), has);
    const value = o.sub(
      current.swizzle(axis),
      o.div(
        o.sub(p(face.after, face.hasAfter), p(face.before, face.hasBefore)),
        grid.cell,
      ),
    );
    return o.select(
      0,
      constrainFace(o, grid, solids, face, axis, value),
      face.valid,
    );
  };
  g.write(g.storage('nextVelocity', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.vec4(
      component('x'),
      component('y'),
      isFlat(grid) ? 0 : component('z'),
      0,
    ),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}

/**
 * The light of the sun through the smoke, for the rendering: from each
 * cell toward the sun, `lightSteps` steps of a cell, the density summed;
 * vec4 (density, transmittance, temperature, 0).
 */
export function shadeGraph(grid: SmokeLayout): MaterialGraphData {
  const { g, o, t } = setup('shade', grid, 'cells');
  const scalars = g.storage('scalars', vec4Array);
  const toSun = o.normalize(
    g.uniform('sunDirection', BuiltinTypes.vec3f, { default: [0, 1, 0] }),
  );
  const extinction = g.uniform('extinction', BuiltinTypes.f32, { default: 8 });
  const steps = g.uniform('lightSteps', BuiltinTypes.u32, { default: 24 });
  const center = cellCenter(o, grid, t.id);
  const step = o.mul(toSun, grid.cell);
  const total = g.fold(0, steps, (sum, k) => {
    const at = o.add(
      center,
      o.mul(step, o.add(o.convert(k, BuiltinTypes.f32), 0.5)),
    );
    return o.add(
      sum,
      sampleLattice(o, grid, cellLattice(grid), scalars, at, 'zero').swizzle(
        'x',
      ),
    );
  });
  const here = o.index(scalars, t.index);
  const light = o.exp(o.mul(o.mul(total, grid.cell), o.mul(extinction, -1)));
  g.write(g.storage('shade', vec4Array, { access: 'read-write' }), {
    index: t.index,
    value: o.vec4(here.swizzle('x'), light, here.swizzle('y'), 0),
    when: t.inside,
  });
  g.compute({ workgroupSize: volumeWorkgroup(grid) });
  return g.build();
}
