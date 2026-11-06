import { Aabb, Ray, type Volume } from '@fdw/engine-geometry';
import { NavMesh, type NavLinkData } from './NavMesh';

/** Options of {@link buildNavMesh}. */
export interface BuildNavMeshOptions {
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
}

// A walkable surface of a column: its floor, the solid above it.
interface Span {
  readonly floor: number;
  readonly ceiling: number;
  // The spans of the 4 neighbor columns it leads to (−1: none): −x, +x,
  // −z, +z.
  readonly next: Int32Array;
  // Its column.
  readonly x: number;
  readonly z: number;
  // Its distance to the edge, then its rectangle.
  distance: number;
  rect: number;
  kept: boolean;
}

const dx = [-1, 1, 0, 0];
const dz = [0, 0, -1, 1];

/**
 * A navigation mesh of the volumes of a region: the region cut in columns
 * of `cellSize`, the solids of each column found by rays, the tops of the
 * solids with room above them for the agent kept as floors, linked to
 * their neighbors within a step, the floors closer to an edge than the
 * radius of the agent dropped; then the flat floors gathered in
 * rectangles, the polygons of the mesh.
 *
 * Everything walkable is in the mesh, the tops of the walls too when an
 * agent fits there: they are islands, not linked to the rest.
 *
 * @example
 * ```ts
 * const navMesh = buildNavMesh({
 *   bounds: new Aabb([-20, -1, -20], [20, 5, 20]),
 *   volumes: sceneVolumes(scene),
 *   agentRadius: 0.4,
 * });
 * ```
 */
export function buildNavMesh(options: BuildNavMeshOptions): NavMesh {
  const cell = options.cellSize ?? 0.25;
  const radius = options.agentRadius ?? 0.4;
  const height = options.agentHeight ?? 1.8;
  const climb = options.maxClimb ?? 0.4;
  const maxSlope = Math.tan(options.maxSlope ?? Math.PI / 4);
  const { min, max } = options.bounds;
  const columnsX = Math.max(1, Math.ceil((max[0] - min[0]) / cell));
  const columnsZ = Math.max(1, Math.ceil((max[2] - min[2]) / cell));
  if (columnsX * columnsZ > 16_000_000) {
    throw new Error(
      `A navigation mesh of ${columnsX} × ${columnsZ} cells: make the cells larger`,
    );
  }

  // The solid intervals of each column: bottom, top, bottom, top…
  const solids: number[][] = Array.from(
    { length: columnsX * columnsZ },
    () => [],
  );
  const box = new Aabb();
  const down = new Ray([0, 0, 0], [0, -1, 0]);
  const up = new Ray([0, 0, 0], [0, 1, 0]);
  for (const volume of options.volumes ?? []) {
    volume.bounds(box);
    if (
      box.isEmpty() ||
      box.max[0] < min[0] ||
      box.min[0] > max[0] ||
      box.max[2] < min[2] ||
      box.min[2] > max[2]
    ) {
      continue;
    }
    const exact = volume.kind === 'aabb';
    const x0 = Math.max(0, Math.floor((box.min[0] - min[0]) / cell));
    const x1 = Math.min(columnsX - 1, Math.floor((box.max[0] - min[0]) / cell));
    const z0 = Math.max(0, Math.floor((box.min[2] - min[2]) / cell));
    const z1 = Math.min(columnsZ - 1, Math.floor((box.max[2] - min[2]) / cell));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cx = min[0] + (x + 0.5) * cell;
        const cz = min[2] + (z + 0.5) * cell;
        if (exact) {
          if (
            cx >= box.min[0] &&
            cx <= box.max[0] &&
            cz >= box.min[2] &&
            cz <= box.max[2]
          ) {
            solids[z * columnsX + x].push(box.min[1], box.max[1]);
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
        solids[z * columnsX + x].push(
          u === undefined ? top - t : bottom + u,
          top - t,
        );
      }
    }
  }

  // The floors of each column, with room above them.
  const columns: number[][] = [];
  const spans: Span[] = [];
  for (let z = 0; z < columnsZ; z++) {
    for (let x = 0; x < columnsX; x++) {
      const cx = min[0] + (x + 0.5) * cell;
      const cz = min[2] + (z + 0.5) * cell;
      const intervals: [number, number][] = [];
      const list = solids[z * columnsX + x];
      for (let i = 0; i < list.length; i += 2) {
        intervals.push([list[i], list[i + 1]]);
      }
      if (options.ground) {
        intervals.push([-Infinity, options.ground(cx, cz)]);
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
      const column: number[] = [];
      for (let i = 0; i < merged.length; i++) {
        const floor = merged[i][1];
        const ceiling = i + 1 < merged.length ? merged[i + 1][0] : Infinity;
        if (ceiling - floor >= height && floor >= min[1] && floor <= max[1]) {
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
      }
      columns.push(column);
    }
  }

  // The links to the neighbors: within a step (or a slope), with room for
  // the agent on both.
  const reach = Math.max(climb, cell * maxSlope);
  for (const span of spans) {
    for (let d = 0; d < 4; d++) {
      const x = span.x + dx[d];
      const z = span.z + dz[d];
      if (x < 0 || z < 0 || x >= columnsX || z >= columnsZ) continue;
      let best = -1;
      let bestStep = Infinity;
      for (const index of columns[z * columnsX + x]) {
        const other = spans[index];
        const step = Math.abs(other.floor - span.floor);
        const room =
          Math.min(other.ceiling, span.ceiling) -
          Math.max(other.floor, span.floor);
        if (step <= reach && room >= height && step < bestStep) {
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
        const s = (spans[nb].floor - spans[na].floor) / (2 * cell);
        slope2 += s * s;
      }
    }
    if (slope2 > maxSlope * maxSlope) {
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

  // The distance to the edge: 0 for the spans missing a neighbor, then
  // spread through the links (straight and diagonal).
  erode(spans, cell);
  const margin = radius - cell / 2;
  for (const span of spans) {
    if (span.distance < margin - 1e-6) {
      span.kept = false;
    }
  }
  const linked = (span: Span, d: number): Span | undefined => {
    const n = span.next[d];
    return n >= 0 && spans[n].kept ? spans[n] : undefined;
  };

  // The rectangles: runs of flat spans along x, grown along z.
  const flat = Math.min(0.01, climb / 4);
  const rects: { x0: number; z0: number; x1: number; z1: number; y: number }[] =
    [];
  for (let z = 0; z < columnsZ; z++) {
    for (let x = 0; x < columnsX; x++) {
      for (const index of columns[z * columnsX + x]) {
        const first = spans[index];
        if (!first.kept || first.rect >= 0) continue;
        const y = first.floor;
        const id = rects.length;
        // Along x, as long as the spans are linked.
        const row: Span[] = [first];
        for (;;) {
          const last = row[row.length - 1];
          const next = linked(last, 1);
          if (!next || next.rect >= 0 || Math.abs(next.floor - y) > flat) {
            break;
          }
          row.push(next);
        }
        // Along z, whole rows linked to the row before.
        const rows: Span[][] = [row];
        for (;;) {
          const previous = rows[rows.length - 1];
          const candidate: Span[] = [];
          for (let i = 0; i < previous.length; i++) {
            const below = linked(previous[i], 3);
            if (
              !below ||
              below.rect >= 0 ||
              Math.abs(below.floor - y) > flat ||
              (i > 0 && linked(candidate[i - 1], 1) !== below)
            ) {
              break;
            }
            candidate.push(below);
          }
          if (candidate.length !== previous.length) break;
          rows.push(candidate);
        }
        for (const r of rows) {
          for (const span of r) span.rect = id;
        }
        rects.push({
          x0: x,
          z0: z,
          x1: x + row.length,
          z1: z + rows.length,
          y,
        });
      }
    }
  }

  // The polygons, and the portals where their spans are linked.
  const vertices: number[] = [];
  const polygons: number[][] = [];
  for (const r of rects) {
    const index = vertices.length / 3;
    const X0 = min[0] + r.x0 * cell;
    const X1 = min[0] + r.x1 * cell;
    const Z0 = min[2] + r.z0 * cell;
    const Z1 = min[2] + r.z1 * cell;
    vertices.push(X0, r.y, Z0, X0, r.y, Z1, X1, r.y, Z1, X1, r.y, Z0);
    polygons.push([index, index + 1, index + 2, index + 3]);
  }
  // A portal per pair of rectangles and side: the range of the edge it
  // covers.
  const portals = new Map<
    string,
    { a: number; b: number; d: number; line: number; lo: number; hi: number }
  >();
  for (const span of spans) {
    if (!span.kept) continue;
    for (const d of [1, 3]) {
      const other = linked(span, d);
      if (!other || other.rect === span.rect) continue;
      const key = `${span.rect},${other.rect},${d}`;
      const line = d === 1 ? span.x + 1 : span.z + 1;
      const lo = d === 1 ? span.z : span.x;
      const portal = portals.get(key);
      if (portal) {
        portal.lo = Math.min(portal.lo, lo);
        portal.hi = Math.max(portal.hi, lo + 1);
      } else {
        portals.set(key, {
          a: span.rect,
          b: other.rect,
          d,
          line,
          lo,
          hi: lo + 1,
        });
      }
    }
  }
  const links: NavLinkData[] = [];
  for (const { a, b, d, line, lo, hi } of portals.values()) {
    const y = (rects[a].y + rects[b].y) / 2;
    if (d === 1) {
      const x = min[0] + line * cell;
      links.push({
        a,
        b,
        portal: [x, y, min[2] + lo * cell, x, y, min[2] + hi * cell],
      });
    } else {
      const z = min[2] + line * cell;
      links.push({
        a,
        b,
        portal: [min[0] + lo * cell, y, z, min[0] + hi * cell, y, z],
      });
    }
  }
  return new NavMesh({ vertices, polygons, links });
}

// The distance of each span to the nearest edge of the walkable area, in
// meters: a Dijkstra from the spans missing a neighbor.
function erode(spans: Span[], cell: number): void {
  const queue: number[] = [];
  spans.forEach((span, index) => {
    if (!span.kept) return;
    let edge = false;
    for (let d = 0; d < 4; d++) {
      const n = span.next[d];
      if (n < 0 || !spans[n].kept) edge = true;
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
