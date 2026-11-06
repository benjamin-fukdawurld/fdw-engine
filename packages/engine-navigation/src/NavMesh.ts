// A navigation mesh: convex polygons on the walkable surfaces, linked by
// portals; the paths found by A* over the polygons, then pulled tight
// through the portals (the funnel algorithm). y is up; the polygons are
// read from above, in x and z.

/** A point. */
export interface NavPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * A link between two polygons: the segment of their common edge, crossed
 * both ways.
 */
export interface NavLinkData {
  readonly a: number;
  readonly b: number;
  /** The two ends of the portal: x, y, z, then x, y, z. */
  readonly portal: readonly [number, number, number, number, number, number];
}

/** A navigation mesh as plain data: what it is made of, serializable. */
export interface NavMeshData {
  /** x, y, z per vertex. */
  readonly vertices: ArrayLike<number>;
  /** Convex polygons: their vertices in order around them. */
  readonly polygons: readonly (readonly number[])[];
  /**
   * The portals between the polygons. Absent: the edges the polygons
   * share (the same two vertices) become their portals.
   */
  readonly links?: readonly NavLinkData[];
}

/** Options of {@link NavMesh.fromTriangles}. */
export interface FromTrianglesOptions {
  /** The steepest triangle kept, in radians. Default 45°. */
  readonly maxSlope?: number;
  /** Vertices closer than this are welded. Default 1e-4. */
  readonly weld?: number;
}

/** Options of {@link NavMesh.findPath}. */
export interface PathOptions {
  /**
   * When the end cannot be reached: a path to the reachable point closest
   * to it rather than none. Default false.
   */
  readonly partial?: boolean;
  /** How far from the mesh the start and the end may be. Default 2. */
  readonly maxDistance?: number;
}

/** A point on the mesh: its polygon and its position. */
export interface NavLocation {
  readonly polygon: number;
  readonly point: NavPoint;
}

interface Link {
  readonly to: number;
  // The ends of the portal.
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
}

interface Polygon {
  readonly vertices: readonly number[];
  readonly links: Link[];
  // The center and the bounds in x and z.
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  // The plane: nx·x + ny·y + nz·z = d.
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly d: number;
}

// Which side of a → b, from above, c is: < 0 on the left, > 0 on the
// right (x to the right, z toward the viewer).
const side = (
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): number => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

const golden = (Math.sqrt(5) - 1) / 2;

const distance = (a: NavPoint, b: NavPoint): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/**
 * A navigation mesh: where agents can walk, and the paths between two
 * points. Built from the volumes of a scene ({@link buildNavMesh}), from
 * triangles ({@link NavMesh.fromTriangles}) or from its data.
 *
 * @example
 * ```ts
 * const navMesh = buildNavMesh({ bounds, volumes, agentRadius: 0.4 });
 * const path = navMesh.findPath(start, end); // the corners, start to end
 * ```
 */
export class NavMesh {
  readonly vertices: Float32Array;
  private readonly _polygons: Polygon[];
  private readonly _bins: number[][];
  private readonly _binSize: number;
  private readonly _binMinX: number;
  private readonly _binMinZ: number;
  private readonly _binsX: number;
  private readonly _binsZ: number;
  private readonly _data: NavMeshData;

  constructor(data: NavMeshData) {
    this._data = data;
    this.vertices = Float32Array.from(data.vertices);
    const v = this.vertices;
    this._polygons = data.polygons.map((indices) => {
      if (indices.length < 3) {
        throw new Error('A polygon of a navigation mesh needs 3 vertices');
      }
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      // Newell's normal.
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < indices.length; i++) {
        const a = indices[i] * 3;
        const b = indices[(i + 1) % indices.length] * 3;
        if (a + 2 >= v.length || a < 0) {
          throw new Error(`A polygon has no vertex ${indices[i]}`);
        }
        cx += v[a];
        cy += v[a + 1];
        cz += v[a + 2];
        minX = Math.min(minX, v[a]);
        maxX = Math.max(maxX, v[a]);
        minZ = Math.min(minZ, v[a + 2]);
        maxZ = Math.max(maxZ, v[a + 2]);
        nx += (v[a + 1] - v[b + 1]) * (v[a + 2] + v[b + 2]);
        ny += (v[a + 2] - v[b + 2]) * (v[a] + v[b]);
        nz += (v[a] - v[b]) * (v[a + 1] + v[b + 1]);
      }
      const n = indices.length;
      cx /= n;
      cy /= n;
      cz /= n;
      const length = Math.hypot(nx, ny, nz) || 1;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      nx /= length;
      ny /= length;
      nz /= length;
      return {
        vertices: indices,
        links: [],
        cx,
        cy,
        cz,
        minX,
        minZ,
        maxX,
        maxZ,
        nx,
        ny,
        nz,
        d: nx * cx + ny * cy + nz * cz,
      };
    });
    for (const link of data.links ?? sharedEdges(data.polygons, v)) {
      const [ax, ay, az, bx, by, bz] = link.portal;
      const a = this._polygons[link.a];
      const b = this._polygons[link.b];
      if (!a || !b) {
        throw new Error(`A link joins unknown polygons ${link.a}, ${link.b}`);
      }
      a.links.push({ to: link.b, ax, ay, az, bx, by, bz });
      b.links.push({ to: link.a, ax, ay, az, bx, by, bz });
    }

    // The bins of the polygons in x and z, to find them by point.
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let size = 0;
    for (const p of this._polygons) {
      minX = Math.min(minX, p.minX);
      minZ = Math.min(minZ, p.minZ);
      maxX = Math.max(maxX, p.maxX);
      maxZ = Math.max(maxZ, p.maxZ);
      size += Math.max(p.maxX - p.minX, p.maxZ - p.minZ);
    }
    const count = this._polygons.length;
    const extent = Math.max(maxX - minX, maxZ - minZ, 1e-6);
    // About one polygon a bin, at most 256 bins a side.
    this._binSize = Math.max(count > 0 ? size / count : 1, extent / 256, 1e-3);
    this._binMinX = count > 0 ? minX : 0;
    this._binMinZ = count > 0 ? minZ : 0;
    this._binsX = count > 0 ? Math.floor((maxX - minX) / this._binSize) + 1 : 1;
    this._binsZ = count > 0 ? Math.floor((maxZ - minZ) / this._binSize) + 1 : 1;
    this._bins = Array.from({ length: this._binsX * this._binsZ }, () => []);
    this._polygons.forEach((p, index) => {
      const [x0, z0] = this.bin(p.minX, p.minZ);
      const [x1, z1] = this.bin(p.maxX, p.maxZ);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          this._bins[z * this._binsX + x].push(index);
        }
      }
    });
  }

  /**
   * A navigation mesh of the walkable triangles of a mesh: those no
   * steeper than `maxSlope`, their vertices welded, linked by their
   * shared edges. The agents walk on the triangles themselves: model them
   * away from the walls by the radius of the agents.
   */
  static fromTriangles(
    positions: ArrayLike<number>,
    indices?: ArrayLike<number>,
    options: FromTrianglesOptions = {},
  ): NavMesh {
    const maxSlope = options.maxSlope ?? Math.PI / 4;
    const weld = options.weld ?? 1e-4;
    const minNormalY = Math.cos(maxSlope);
    const count = indices ? indices.length : positions.length / 3;
    const vertices: number[] = [];
    const welded = new Map<string, number>();
    const vertex = (i: number): number => {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const key = `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
      let index = welded.get(key);
      if (index === undefined) {
        index = vertices.length / 3;
        vertices.push(x, y, z);
        welded.set(key, index);
      }
      return index;
    };
    const polygons: number[][] = [];
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = indices ? indices[t] : t;
      const i1 = indices ? indices[t + 1] : t + 1;
      const i2 = indices ? indices[t + 2] : t + 2;
      const ux = positions[i1 * 3] - positions[i0 * 3];
      const uy = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
      const uz = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
      const vx = positions[i2 * 3] - positions[i0 * 3];
      const vy = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
      const vz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      // Either winding: the ground seen from above or from below.
      if (length === 0 || Math.abs(ny) / length < minNormalY) {
        continue;
      }
      const a = vertex(i0);
      const b = vertex(i1);
      const c = vertex(i2);
      if (a !== b && b !== c && a !== c) {
        polygons.push([a, b, c]);
      }
    }
    return new NavMesh({ vertices, polygons });
  }

  /** The number of polygons. */
  get polygonCount(): number {
    return this._polygons.length;
  }

  /** The vertices of a polygon, in order around it. */
  polygonVertices(polygon: number): readonly number[] {
    return this.polygonAt(polygon).vertices;
  }

  /** The polygons a polygon is linked to. */
  neighbors(polygon: number): number[] {
    return this.polygonAt(polygon).links.map((link) => link.to);
  }

  /** The center of a polygon. */
  center(polygon: number): NavPoint {
    const p = this.polygonAt(polygon);
    return { x: p.cx, y: p.cy, z: p.cz };
  }

  /** The data of the mesh: to save it, or to build it again. */
  toData(): NavMeshData {
    const links: NavLinkData[] = [];
    this._polygons.forEach((p, a) => {
      for (const link of p.links) {
        if (link.to > a) {
          links.push({
            a,
            b: link.to,
            portal: [link.ax, link.ay, link.az, link.bx, link.by, link.bz],
          });
        }
      }
    });
    return {
      vertices: Array.from(this.vertices),
      polygons: this._data.polygons.map((polygon) => [...polygon]),
      links,
    };
  }

  private polygonAt(polygon: number): Polygon {
    const p = this._polygons[polygon];
    if (!p) {
      throw new Error(`The navigation mesh has no polygon ${polygon}`);
    }
    return p;
  }

  private bin(x: number, z: number): [number, number] {
    const bx = Math.floor((x - this._binMinX) / this._binSize);
    const bz = Math.floor((z - this._binMinZ) / this._binSize);
    return [
      Math.min(Math.max(bx, 0), this._binsX - 1),
      Math.min(Math.max(bz, 0), this._binsZ - 1),
    ];
  }

  // The height of the plane of a polygon at x, z.
  private heightAt(p: Polygon, x: number, z: number): number {
    return p.ny > 1e-6 ? (p.d - p.nx * x - p.nz * z) / p.ny : p.cy;
  }

  // Whether x, z is inside a polygon, from above: on the same side of
  // every edge.
  private contains(p: Polygon, x: number, z: number): boolean {
    const v = this.vertices;
    const indices = p.vertices;
    let sign = 0;
    for (let i = 0; i < indices.length; i++) {
      const a = indices[i] * 3;
      const b = indices[(i + 1) % indices.length] * 3;
      const s = side(v[a], v[a + 2], v[b], v[b + 2], x, z);
      if (Math.abs(s) < 1e-9) continue;
      if (sign === 0) sign = Math.sign(s);
      else if (Math.sign(s) !== sign) return false;
    }
    return true;
  }

  // The closest point of a polygon to x, z, from above, written in out.
  private closestIn(p: Polygon, x: number, z: number, out: NavPoint): void {
    if (this.contains(p, x, z)) {
      out.x = x;
      out.z = z;
    } else {
      const v = this.vertices;
      const indices = p.vertices;
      let best = Infinity;
      for (let i = 0; i < indices.length; i++) {
        const a = indices[i] * 3;
        const b = indices[(i + 1) % indices.length] * 3;
        const ex = v[b] - v[a];
        const ez = v[b + 2] - v[a + 2];
        const l2 = ex * ex + ez * ez;
        const t =
          l2 > 0
            ? Math.min(
                Math.max(((x - v[a]) * ex + (z - v[a + 2]) * ez) / l2, 0),
                1,
              )
            : 0;
        const px = v[a] + ex * t;
        const pz = v[a + 2] + ez * t;
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < best) {
          best = d;
          out.x = px;
          out.z = pz;
        }
      }
    }
    out.y = this.heightAt(p, out.x, out.z);
  }

  /**
   * The point of the mesh closest to `point` (within `maxDistance`), and
   * its polygon; under or over the point first: the floor of a bridge, or
   * the ground below it.
   */
  closestPoint(point: NavPoint, maxDistance = 2): NavLocation | undefined {
    const scratch = { x: 0, y: 0, z: 0 };
    let best: NavLocation | undefined;
    let bestDistance = maxDistance;
    const [cx, cz] = this.bin(point.x, point.z);
    const rings = Math.ceil(maxDistance / this._binSize) + 1;
    const seen = new Set<number>();
    for (let ring = 0; ring <= rings; ring++) {
      for (let z = cz - ring; z <= cz + ring; z++) {
        for (let x = cx - ring; x <= cx + ring; x++) {
          if (
            x < 0 ||
            z < 0 ||
            x >= this._binsX ||
            z >= this._binsZ ||
            (Math.abs(x - cx) !== ring && Math.abs(z - cz) !== ring)
          ) {
            continue;
          }
          for (const index of this._bins[z * this._binsX + x]) {
            if (seen.has(index)) continue;
            seen.add(index);
            const p = this._polygons[index];
            this.closestIn(p, point.x, point.z, scratch);
            const d = distance(point, scratch);
            if (d < bestDistance || (d === bestDistance && !best)) {
              bestDistance = d;
              best = { polygon: index, point: { ...scratch } };
            }
          }
        }
      }
      // A ring further cannot be closer than (ring) bins.
      if (best && ring * this._binSize > bestDistance) {
        break;
      }
    }
    return best;
  }

  /**
   * A path from `start` to `end`: its corners, from the start to the end,
   * both brought onto the mesh. Undefined when one is off the mesh, or the
   * end cannot be reached (unless `partial`).
   */
  findPath(
    start: NavPoint,
    end: NavPoint,
    options: PathOptions = {},
  ): NavPoint[] | undefined {
    const maxDistance = options.maxDistance ?? 2;
    const from = this.closestPoint(start, maxDistance);
    const to = this.closestPoint(end, maxDistance);
    if (!from || !to) {
      return undefined;
    }
    const corridor = this.findCorridor(from, to, options.partial ?? false);
    if (!corridor) {
      return undefined;
    }
    let target = to.point;
    const last = corridor[corridor.length - 1];
    if (last !== to.polygon) {
      // Partial: the point of the last polygon closest to the end.
      const scratch = { x: 0, y: 0, z: 0 };
      this.closestIn(this._polygons[last], end.x, end.z, scratch);
      target = scratch;
    }
    return this.pull(from.point, target, corridor);
  }

  /**
   * The polygons from the start to the end (A* over the polygons, through
   * the points of the portals on the way to the end); with `partial`, to the polygon closest to
   * the end when it cannot be reached.
   */
  private findCorridor(
    from: NavLocation,
    to: NavLocation,
    partial: boolean,
  ): number[] | undefined {
    const count = this._polygons.length;
    const g = new Float64Array(count).fill(Infinity);
    const parent = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    // Where the path enters each polygon: a point of its portal.
    const px = new Float64Array(count);
    const py = new Float64Array(count);
    const pz = new Float64Array(count);
    const goal = to.point;
    const heap = new Heap();
    const h = (x: number, y: number, z: number) =>
      Math.hypot(goal.x - x, goal.y - y, goal.z - z);
    g[from.polygon] = 0;
    px[from.polygon] = from.point.x;
    py[from.polygon] = from.point.y;
    pz[from.polygon] = from.point.z;
    heap.push(from.polygon, h(from.point.x, from.point.y, from.point.z));
    let closest = from.polygon;
    let closestH = Infinity;
    while (heap.size > 0) {
      const current = heap.pop();
      if (closed[current]) continue;
      closed[current] = 1;
      const hc = h(px[current], py[current], pz[current]);
      if (hc < closestH) {
        closestH = hc;
        closest = current;
      }
      if (current === to.polygon) {
        break;
      }
      for (const link of this._polygons[current].links) {
        const next = link.to;
        if (closed[next]) continue;
        // The point of the portal on the shortest way from where the path
        // entered this polygon to the end: the length through it is
        // convex along the portal, a golden-section search finds it.
        const ox = px[current];
        const oy = py[current];
        const oz = pz[current];
        const ex = link.bx - link.ax;
        const ey = link.by - link.ay;
        const ez = link.bz - link.az;
        const through = (t: number) => {
          const x = link.ax + ex * t;
          const y = link.ay + ey * t;
          const z = link.az + ez * t;
          return (
            Math.hypot(x - ox, y - oy, z - oz) +
            Math.hypot(goal.x - x, goal.y - y, goal.z - z)
          );
        };
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 16; i++) {
          const m1 = hi - golden * (hi - lo);
          const m2 = lo + golden * (hi - lo);
          if (through(m1) < through(m2)) hi = m2;
          else lo = m1;
        }
        const t = (lo + hi) / 2;
        const mx = link.ax + ex * t;
        const my = link.ay + ey * t;
        const mz = link.az + ez * t;
        const cost =
          g[current] +
          Math.hypot(mx - px[current], my - py[current], mz - pz[current]);
        if (cost < g[next]) {
          g[next] = cost;
          parent[next] = current;
          px[next] = mx;
          py[next] = my;
          pz[next] = mz;
          heap.push(next, cost + h(mx, my, mz));
        }
      }
    }
    let last = to.polygon;
    if (!closed[last]) {
      if (!partial) return undefined;
      last = closest;
    }
    const corridor: number[] = [];
    for (let p = last; p >= 0; p = parent[p]) {
      corridor.push(p);
    }
    return corridor.reverse();
  }

  /**
   * The corners of the shortest path through the portals of a corridor
   * (the "simple stupid funnel" of Mikko Mononen), from above; the
   * heights from the portals.
   */
  private pull(start: NavPoint, end: NavPoint, corridor: number[]): NavPoint[] {
    // The portals, left and right for an agent going through them.
    const lefts: NavPoint[] = [start];
    const rights: NavPoint[] = [start];
    for (let i = 0; i + 1 < corridor.length; i++) {
      const p = this._polygons[corridor[i]];
      const link = p.links.find((l) => l.to === corridor[i + 1]) as Link;
      const a = { x: link.ax, y: link.ay, z: link.az };
      const b = { x: link.bx, y: link.by, z: link.bz };
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      if (side(p.cx, p.cz, mx, mz, a.x, a.z) < 0) {
        lefts.push(a);
        rights.push(b);
      } else {
        lefts.push(b);
        rights.push(a);
      }
    }
    lefts.push(end);
    rights.push(end);

    const path: NavPoint[] = [{ ...start }];
    let apex = start;
    let left = lefts[0];
    let right = rights[0];
    let apexIndex = 0;
    let leftIndex = 0;
    let rightIndex = 0;
    const same = (a: NavPoint, b: NavPoint) =>
      (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 1e-12;
    const add = (point: NavPoint) => {
      if (!same(path[path.length - 1], point)) path.push({ ...point });
    };
    for (let i = 1; i < lefts.length; i++) {
      const pl = lefts[i];
      const pr = rights[i];
      // The right side, tightened.
      if (side(apex.x, apex.z, right.x, right.z, pr.x, pr.z) <= 0) {
        if (
          same(apex, right) ||
          side(apex.x, apex.z, left.x, left.z, pr.x, pr.z) > 0
        ) {
          right = pr;
          rightIndex = i;
        } else {
          // Over the left side: its end is a corner.
          add(left);
          apex = left;
          apexIndex = leftIndex;
          left = apex;
          right = apex;
          leftIndex = apexIndex;
          rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
      // The left side, tightened.
      if (side(apex.x, apex.z, left.x, left.z, pl.x, pl.z) >= 0) {
        if (
          same(apex, left) ||
          side(apex.x, apex.z, right.x, right.z, pl.x, pl.z) < 0
        ) {
          left = pl;
          leftIndex = i;
        } else {
          add(right);
          apex = right;
          apexIndex = rightIndex;
          left = apex;
          right = apex;
          leftIndex = apexIndex;
          rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
    }
    add(end);
    if (path.length === 1) path.push({ ...end });
    return path;
  }

  /**
   * The outlines of the polygons, as line segments (x, y, z of each end),
   * lifted by `lift`: for a debug view.
   */
  lines(lift = 0.02): Float32Array<ArrayBuffer> {
    let count = 0;
    for (const p of this._polygons) count += p.vertices.length;
    const out = new Float32Array(count * 6);
    const v = this.vertices;
    let o = 0;
    for (const p of this._polygons) {
      const indices = p.vertices;
      for (let i = 0; i < indices.length; i++) {
        const a = indices[i] * 3;
        const b = indices[(i + 1) % indices.length] * 3;
        out[o++] = v[a];
        out[o++] = v[a + 1] + lift;
        out[o++] = v[a + 2];
        out[o++] = v[b];
        out[o++] = v[b + 1] + lift;
        out[o++] = v[b + 2];
      }
    }
    return out;
  }
}

// The portals of polygons sharing an edge: the same two vertices.
function sharedEdges(
  polygons: readonly (readonly number[])[],
  v: Float32Array,
): NavLinkData[] {
  const edges = new Map<string, number>();
  const links: NavLinkData[] = [];
  polygons.forEach((indices, polygon) => {
    for (let i = 0; i < indices.length; i++) {
      const a = indices[i];
      const b = indices[(i + 1) % indices.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = edges.get(key);
      if (other === undefined) {
        edges.set(key, polygon);
      } else if (other !== polygon) {
        links.push({
          a: other,
          b: polygon,
          portal: [
            v[a * 3],
            v[a * 3 + 1],
            v[a * 3 + 2],
            v[b * 3],
            v[b * 3 + 1],
            v[b * 3 + 2],
          ],
        });
      }
    }
  });
  return links;
}

// A binary heap of polygons by cost.
class Heap {
  private readonly _items: number[] = [];
  private readonly _costs: number[] = [];

  get size(): number {
    return this._items.length;
  }

  push(item: number, cost: number): void {
    const items = this._items;
    const costs = this._costs;
    let i = items.length;
    items.push(item);
    costs.push(cost);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (costs[parent] <= cost) break;
      items[i] = items[parent];
      costs[i] = costs[parent];
      i = parent;
    }
    items[i] = item;
    costs[i] = cost;
  }

  pop(): number {
    const items = this._items;
    const costs = this._costs;
    const top = items[0];
    const item = items.pop() as number;
    const cost = costs.pop() as number;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mc = cost;
        if (l < n && costs[l] < mc) {
          m = l;
          mc = costs[l];
        }
        if (r < n && costs[r] < mc) {
          m = r;
          mc = costs[r];
        }
        if (m === i) break;
        items[i] = items[m];
        costs[i] = costs[m];
        i = m;
      }
      items[i] = item;
      costs[i] = cost;
    }
    return top;
  }
}
