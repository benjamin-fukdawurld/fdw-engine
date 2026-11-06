import { Aabb, Ray, type Volume } from '@fdw/engine-geometry';
import type { NavLinkData, NavMeshData } from './NavMesh';

// The voxelization of the navigation meshes, shared by buildNavMesh (one
// region) and TiledNavMesh (a region per tile): the solids of each column
// of cells, the floors with room above them, linked to their neighbors,
// eroded by the radius of the agent, gathered in rectangles.

/** What a region of a navigation mesh is built from. */
export interface VoxelOptions {
  /** The region to cover. */
  readonly bounds: Aabb;
  /**
   * The solids, in the world: the walls, the floors, the steps, the
   * bridges. Their tops are walked on; their sides block.
   */
  readonly volumes?: Iterable<Volume>;
  /** A ground under everything (a terrain): its height at x, z. */
  readonly ground?: (x: number, z: number) => number;
  /** The side of a cell, in meters. Default 0.25. */
  readonly cellSize?: number;
  /** How far from the walls the agents stay. Default 0.4. */
  readonly agentRadius?: number;
  /** The room an agent needs above a floor. Default 1.8. */
  readonly agentHeight?: number;
  /** The highest step an agent climbs. Default 0.4. */
  readonly maxClimb?: number;
  /** The steepest slope an agent walks, in radians. Default 45°. */
  readonly maxSlope?: number;
  /**
   * How far the floors gathered in a polygon may be from its height, in
   * meters. Default 0.01 (a quarter of `maxClimb` if lower): flat floors.
   * More on a terrain, for fewer polygons: a path is laid on the ground
   * from above, its heights within this.
   */
  readonly heightTolerance?: number;
}

/** @internal The options, with their defaults, and the grid of cells. */
export interface Settings {
  readonly cell: number;
  readonly radius: number;
  readonly height: number;
  readonly climb: number;
  // The tangent of the steepest slope.
  readonly slope: number;
  readonly tolerance: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxY: number;
  readonly columnsX: number;
  readonly columnsZ: number;
  readonly ground: ((x: number, z: number) => number) | undefined;
}

/** @internal */
export function settingsOf(options: VoxelOptions): Settings {
  const cell = options.cellSize ?? 0.25;
  const climb = options.maxClimb ?? 0.4;
  const { min, max } = options.bounds;
  const columnsX = Math.max(1, Math.ceil((max[0] - min[0]) / cell));
  const columnsZ = Math.max(1, Math.ceil((max[2] - min[2]) / cell));
  if (columnsX * columnsZ > 16_000_000) {
    throw new Error(
      `A navigation mesh of ${columnsX} × ${columnsZ} cells: make the cells larger`,
    );
  }
  return {
    cell,
    radius: options.agentRadius ?? 0.4,
    height: options.agentHeight ?? 1.8,
    climb,
    slope: Math.tan(options.maxSlope ?? Math.PI / 4),
    tolerance: options.heightTolerance ?? Math.min(0.01, climb / 4),
    minX: min[0],
    minY: min[1],
    minZ: min[2],
    maxY: max[1],
    columnsX,
    columnsZ,
    ground: options.ground,
  };
}

/** @internal A range of cells: x0 ≤ x < x1, z0 ≤ z < z1. */
export interface CellRange {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/** @internal A volume and its bounds. */
export type Bounded = readonly [Volume, Aabb];

/** @internal */
export function bounded(volumes: Iterable<Volume> | undefined): Bounded[] {
  const out: Bounded[] = [];
  for (const volume of volumes ?? []) {
    const box = volume.bounds(new Aabb());
    if (!box.isEmpty()) out.push([volume, box]);
  }
  return out;
}

/** @internal A rectangle of the mesh: its cells, its height. */
export interface Rect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly y: number;
}

/**
 * @internal A floor of a cell at the edge of a region, linked to a floor
 * of the neighbor cell outside: where the portals between two regions go.
 */
export interface Edge {
  readonly rect: number;
  readonly floor: number;
  // The floor it is linked to, across.
  readonly across: number;
}

/** @internal What a region gives: its rectangles, their portals, its edges. */
export interface RegionMesh {
  readonly rects: Rect[];
  // Between the rectangles of the region, by their index.
  readonly links: {
    a: number;
    b: number;
    d: number;
    line: number;
    lo: number;
    hi: number;
  }[];
  // By `x,z,d`: the floors of the cell x, z linked across its side d.
  readonly edges: Map<string, Edge[]>;
}

// A walkable surface of a column: its floor, the solid above it.
interface Span {
  readonly floor: number;
  readonly ceiling: number;
  // The spans of the 4 neighbor columns it leads to (−1: none): −x, +x,
  // −z, +z.
  readonly next: Int32Array;
  // Its column, in the cells of the whole grid.
  readonly x: number;
  readonly z: number;
  // Its distance to the edge, then its rectangle.
  distance: number;
  rect: number;
  kept: boolean;
}

const dx = [-1, 1, 0, 0];
const dz = [0, 0, -1, 1];

// The intervals of the volumes over the columns of a range: bottom, top,
// bottom, top… per column.
function rasterize(
  s: Settings,
  range: CellRange,
  volumes: readonly Bounded[],
): number[][] {
  const width = range.x1 - range.x0;
  const out: number[][] = Array.from(
    { length: width * (range.z1 - range.z0) },
    () => [],
  );
  const down = new Ray([0, 0, 0], [0, -1, 0]);
  const up = new Ray([0, 0, 0], [0, 1, 0]);
  const X0 = s.minX + range.x0 * s.cell;
  const Z0 = s.minZ + range.z0 * s.cell;
  const X1 = s.minX + range.x1 * s.cell;
  const Z1 = s.minZ + range.z1 * s.cell;
  for (const [volume, box] of volumes) {
    if (
      box.max[0] < X0 ||
      box.min[0] > X1 ||
      box.max[2] < Z0 ||
      box.min[2] > Z1
    ) {
      continue;
    }
    const exact = volume.kind === 'aabb';
    const x0 = Math.max(range.x0, Math.floor((box.min[0] - s.minX) / s.cell));
    const x1 = Math.min(
      range.x1 - 1,
      Math.floor((box.max[0] - s.minX) / s.cell),
    );
    const z0 = Math.max(range.z0, Math.floor((box.min[2] - s.minZ) / s.cell));
    const z1 = Math.min(
      range.z1 - 1,
      Math.floor((box.max[2] - s.minZ) / s.cell),
    );
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cx = s.minX + (x + 0.5) * s.cell;
        const cz = s.minZ + (z + 0.5) * s.cell;
        const column = out[(z - range.z0) * width + (x - range.x0)];
        if (exact) {
          if (
            cx >= box.min[0] &&
            cx <= box.max[0] &&
            cz >= box.min[2] &&
            cz <= box.max[2]
          ) {
            column.push(box.min[1], box.max[1]);
          }
          continue;
        }
        const top = box.max[1] + 1;
        const bottom = box.min[1] - 1;
        down.origin[0] = cx;
        down.origin[1] = top;
        down.origin[2] = cz;
        const t = volume.raycast(down);
        if (t === undefined) continue;
        up.origin[0] = cx;
        up.origin[1] = bottom;
        up.origin[2] = cz;
        const u = volume.raycast(up);
        column.push(u === undefined ? top - t : bottom + u, top - t);
      }
    }
  }
  return out;
}

/**
 * @internal The rectangles of the cells of `own`, from the solids of the
 * cells around them too (`pad` cells more on each side, within the grid):
 * the erosion of the cells of the edge sees the walls beyond. The
 * obstacles carve: no floor where they stand.
 */
export function buildRegion(
  s: Settings,
  own: CellRange,
  pad: number,
  volumes: readonly Bounded[],
  obstacles: readonly Bounded[] = [],
): RegionMesh {
  const range: CellRange = {
    x0: Math.max(0, own.x0 - pad),
    z0: Math.max(0, own.z0 - pad),
    x1: Math.min(s.columnsX, own.x1 + pad),
    z1: Math.min(s.columnsZ, own.z1 + pad),
  };
  const width = range.x1 - range.x0;
  const depth = range.z1 - range.z0;
  const solids = rasterize(s, range, volumes);
  const carved = obstacles.length > 0 ? rasterize(s, range, obstacles) : [];

  // The floors of each column, with room above them, but where an
  // obstacle stands.
  const columns: number[][] = [];
  const spans: Span[] = [];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const x = range.x0 + i;
      const z = range.z0 + j;
      const cx = s.minX + (x + 0.5) * s.cell;
      const cz = s.minZ + (z + 0.5) * s.cell;
      const intervals: [number, number][] = [];
      const list = solids[j * width + i];
      for (let k = 0; k < list.length; k += 2) {
        intervals.push([list[k], list[k + 1]]);
      }
      if (s.ground) {
        intervals.push([-Infinity, s.ground(cx, cz)]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      // Merged where they touch.
      const merged: [number, number][] = [];
      for (const interval of intervals) {
        const last = merged[merged.length - 1];
        if (last && interval[0] <= last[1] + 1e-4) {
          last[1] = Math.max(last[1], interval[1]);
        } else {
          merged.push([interval[0], interval[1]]);
        }
      }
      const carving = carved[j * width + i] ?? [];
      const column: number[] = [];
      for (let k = 0; k < merged.length; k++) {
        const floor = merged[k][1];
        const ceiling = k + 1 < merged.length ? merged[k + 1][0] : Infinity;
        if (ceiling - floor < s.height || floor < s.minY || floor > s.maxY) {
          continue;
        }
        // An obstacle from below the floor (within a step) to the height
        // of the agent above it.
        let blocked = false;
        for (let c = 0; c < carving.length && !blocked; c += 2) {
          blocked =
            carving[c + 1] > floor - s.climb && carving[c] < floor + s.height;
        }
        if (blocked) continue;
        column.push(spans.length);
        spans.push({
          floor,
          ceiling,
          next: new Int32Array([-1, -1, -1, -1]),
          x,
          z,
          distance: Infinity,
          rect: -1,
          kept: true,
        });
      }
      columns.push(column);
    }
  }
  const columnOf = (x: number, z: number) =>
    columns[(z - range.z0) * width + (x - range.x0)];

  // The links to the neighbors: within a step (or a slope), with room for
  // the agent on both.
  const reach = Math.max(s.climb, s.cell * s.slope);
  for (const span of spans) {
    for (let d = 0; d < 4; d++) {
      const x = span.x + dx[d];
      const z = span.z + dz[d];
      if (x < range.x0 || z < range.z0 || x >= range.x1 || z >= range.z1) {
        continue;
      }
      let best = -1;
      let bestStep = Infinity;
      for (const index of columnOf(x, z)) {
        const other = spans[index];
        const step = Math.abs(other.floor - span.floor);
        const room =
          Math.min(other.ceiling, span.ceiling) -
          Math.max(other.floor, span.floor);
        if (step <= reach && room >= s.height && step < bestStep) {
          best = index;
          bestStep = step;
        }
      }
      span.next[d] = best;
    }
  }

  // Too steep: the slope across the span, from its two neighbors.
  for (const span of spans) {
    let slope2 = 0;
    for (const [a, b] of [
      [0, 1],
      [2, 3],
    ]) {
      const na = span.next[a];
      const nb = span.next[b];
      if (na >= 0 && nb >= 0) {
        const slope = (spans[nb].floor - spans[na].floor) / (2 * s.cell);
        slope2 += slope * slope;
      }
    }
    if (slope2 > s.slope * s.slope) {
      span.kept = false;
    }
  }
  for (const span of spans) {
    for (let d = 0; d < 4; d++) {
      const n = span.next[d];
      if (n >= 0 && (!span.kept || !spans[n].kept)) {
        span.next[d] = -1;
      }
    }
  }

  // The distance to the edge: 0 for the spans missing a neighbor (but at
  // the sides of the padded range, where the grid goes on), then spread
  // through the links (straight and diagonal).
  const inside = (span: Span, d: number) => {
    const x = span.x + dx[d];
    const z = span.z + dz[d];
    const inGrid = x >= 0 && z >= 0 && x < s.columnsX && z < s.columnsZ;
    const inRange =
      x >= range.x0 && z >= range.z0 && x < range.x1 && z < range.z1;
    return inGrid && !inRange;
  };
  erode(spans, s.cell, inside);
  const margin = s.radius - s.cell / 2;
  for (const span of spans) {
    if (span.distance < margin - 1e-6) {
      span.kept = false;
    }
  }
  const isOwn = (span: Span) =>
    span.x >= own.x0 && span.x < own.x1 && span.z >= own.z0 && span.z < own.z1;
  const linked = (span: Span, d: number): Span | undefined => {
    const n = span.next[d];
    return n >= 0 && spans[n].kept ? spans[n] : undefined;
  };
  const linkedOwn = (span: Span, d: number): Span | undefined => {
    const other = linked(span, d);
    return other && isOwn(other) ? other : undefined;
  };

  // The rectangles: runs of floors within the tolerance along x, grown
  // along z.
  const rects: Rect[] = [];
  for (let z = own.z0; z < own.z1; z++) {
    for (let x = own.x0; x < own.x1; x++) {
      for (const index of columnOf(x, z)) {
        const first = spans[index];
        if (!first.kept || first.rect >= 0) continue;
        const y = first.floor;
        const near = (span: Span) => Math.abs(span.floor - y) <= s.tolerance;
        const id = rects.length;
        // Along x, as long as the spans are linked.
        const row: Span[] = [first];
        for (;;) {
          const next = linkedOwn(row[row.length - 1], 1);
          if (!next || next.rect >= 0 || !near(next)) break;
          row.push(next);
        }
        // Along z, whole rows linked to the row before.
        const rows: Span[][] = [row];
        for (;;) {
          const previous = rows[rows.length - 1];
          const candidate: Span[] = [];
          for (let i = 0; i < previous.length; i++) {
            const below = linkedOwn(previous[i], 3);
            if (
              !below ||
              below.rect >= 0 ||
              !near(below) ||
              (i > 0 && linked(candidate[i - 1], 1) !== below)
            ) {
              break;
            }
            candidate.push(below);
          }
          if (candidate.length !== previous.length) break;
          rows.push(candidate);
        }
        let sum = 0;
        for (const r of rows) {
          for (const span of r) {
            span.rect = id;
            sum += span.floor;
          }
        }
        rects.push({
          x0: x,
          z0: z,
          x1: x + row.length,
          z1: z + rows.length,
          y: sum / (row.length * rows.length),
        });
      }
    }
  }

  // The portals where the spans of two rectangles are linked (a pair of
  // rectangles and a side: the range of the edge it covers); the edges
  // linked outside the region.
  const portals = new Map<
    string,
    { a: number; b: number; d: number; line: number; lo: number; hi: number }
  >();
  const edges = new Map<string, Edge[]>();
  for (const span of spans) {
    if (!span.kept || span.rect < 0) continue;
    for (let d = 0; d < 4; d++) {
      const other = linked(span, d);
      if (!other) continue;
      if (!isOwn(other)) {
        const key = `${span.x},${span.z},${d}`;
        let list = edges.get(key);
        if (!list) edges.set(key, (list = []));
        list.push({ rect: span.rect, floor: span.floor, across: other.floor });
        continue;
      }
      if ((d !== 1 && d !== 3) || other.rect === span.rect) continue;
      addPortal(portals, span.rect, other.rect, d, span.x, span.z);
    }
  }
  return { rects, links: [...portals.values()], edges };
}

/** @internal Adds the side d of the cell x, z to the portal of rectangles a, b. */
export function addPortal(
  portals: Map<
    string,
    { a: number; b: number; d: number; line: number; lo: number; hi: number }
  >,
  a: number,
  b: number,
  d: number,
  x: number,
  z: number,
): void {
  const key = `${a},${b},${d}`;
  const line = d === 1 ? x + 1 : z + 1;
  const lo = d === 1 ? z : x;
  const portal = portals.get(key);
  if (portal) {
    portal.lo = Math.min(portal.lo, lo);
    portal.hi = Math.max(portal.hi, lo + 1);
  } else {
    portals.set(key, { a, b, d, line, lo, hi: lo + 1 });
  }
}

/**
 * @internal The mesh of regions side by side: their rectangles, the
 * portals inside each, and those across their edges.
 */
export function assemble(
  s: Settings,
  regions: readonly RegionMesh[],
): NavMeshData {
  const vertices: number[] = [];
  const polygons: number[][] = [];
  const rects: Rect[] = [];
  const portals = new Map<
    string,
    { a: number; b: number; d: number; line: number; lo: number; hi: number }
  >();
  // The edges of all the regions, the rectangles by their global index.
  const edges = new Map<string, Edge[]>();
  for (const region of regions) {
    const offset = rects.length;
    for (const r of region.rects) {
      const index = vertices.length / 3;
      const X0 = s.minX + r.x0 * s.cell;
      const X1 = s.minX + r.x1 * s.cell;
      const Z0 = s.minZ + r.z0 * s.cell;
      const Z1 = s.minZ + r.z1 * s.cell;
      vertices.push(X0, r.y, Z0, X0, r.y, Z1, X1, r.y, Z1, X1, r.y, Z0);
      polygons.push([index, index + 1, index + 2, index + 3]);
      rects.push(r);
    }
    for (const link of region.links) {
      portals.set(`${link.a + offset},${link.b + offset},${link.d}`, {
        ...link,
        a: link.a + offset,
        b: link.b + offset,
      });
    }
    for (const [key, list] of region.edges) {
      let all = edges.get(key);
      if (!all) edges.set(key, (all = []));
      for (const edge of list) all.push({ ...edge, rect: edge.rect + offset });
    }
  }
  // Across the edges: a floor linked to one of the next cell, linked back.
  for (const [key, list] of edges) {
    const [x, z, d] = key.split(',').map(Number);
    if (d !== 1 && d !== 3) continue;
    const across = edges.get(`${x + dx[d]},${z + dz[d]},${d - 1}`);
    if (!across) continue;
    for (const edge of list) {
      const other = across.find(
        (o) =>
          Math.abs(o.floor - edge.across) < 1e-4 &&
          Math.abs(o.across - edge.floor) < 1e-4,
      );
      if (other) addPortal(portals, edge.rect, other.rect, d, x, z);
    }
  }
  const links: NavLinkData[] = [];
  for (const { a, b, d, line, lo, hi } of portals.values()) {
    const y = (rects[a].y + rects[b].y) / 2;
    if (d === 1) {
      const x = s.minX + line * s.cell;
      links.push({
        a,
        b,
        portal: [x, y, s.minZ + lo * s.cell, x, y, s.minZ + hi * s.cell],
      });
    } else {
      const z = s.minZ + line * s.cell;
      links.push({
        a,
        b,
        portal: [s.minX + lo * s.cell, y, z, s.minX + hi * s.cell, y, z],
      });
    }
  }
  return { vertices, polygons, links };
}

// The distance of each span to the nearest edge of the walkable area, in
// meters: a Dijkstra from the spans missing a neighbor (but those missing
// it because it is outside the region built: `outside`).
function erode(
  spans: Span[],
  cell: number,
  outside: (span: Span, d: number) => boolean,
): void {
  const queue: number[] = [];
  spans.forEach((span, index) => {
    if (!span.kept) return;
    let edge = false;
    for (let d = 0; d < 4; d++) {
      const n = span.next[d];
      if ((n < 0 && !outside(span, d)) || (n >= 0 && !spans[n].kept)) {
        edge = true;
      }
    }
    if (edge) {
      span.distance = 0;
      queue.push(index);
    }
  });
  const diagonal = cell * Math.SQRT2;
  // A queue in rounds: the distances grow by cell or diagonal; a few
  // passes settle them.
  let current = queue;
  while (current.length > 0) {
    const next: number[] = [];
    for (const index of current) {
      const span = spans[index];
      for (let d = 0; d < 4; d++) {
        const n = span.next[d];
        if (n < 0) continue;
        const other = spans[n];
        if (other.kept && span.distance + cell < other.distance - 1e-9) {
          other.distance = span.distance + cell;
          next.push(n);
        }
        // The diagonals: through this neighbor, then a side turn.
        for (const t of d < 2 ? [2, 3] : [0, 1]) {
          const m = other.next[t];
          if (m < 0) continue;
          const corner = spans[m];
          if (
            corner.kept &&
            span.distance + diagonal < corner.distance - 1e-9
          ) {
            corner.distance = span.distance + diagonal;
            next.push(m);
          }
        }
      }
    }
    current = next;
  }
}
