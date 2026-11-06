import { Aabb, Obb } from '@fdw/engine-geometry';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { buildNavMesh } from './buildNavMesh';
import { NavAgent } from './NavAgent';
import { NavMesh, type NavPoint } from './NavMesh';
import { sceneVolumes } from './sceneVolumes';

const p = (x: number, y: number, z: number): NavPoint => ({ x, y, z });

// A floor of 10 × 10 m from the origin, its top at 0, and a wall across
// it at z = 5, from x = 0 to 7: the way around is by x > 7.
const floor = new Aabb([0, -1, 0], [10, 0, 10]);
const wall = new Aabb([0, 0, 4.5], [7, 3, 5.5]);
const region = new Aabb([0, -1, 0], [10, 4, 10]);

const pathLength = (path: NavPoint[]) =>
  path.reduce(
    (total, point, i) =>
      i > 0
        ? total + Math.hypot(point.x - path[i - 1].x, point.z - path[i - 1].z)
        : 0,
    0,
  );

describe('NavMesh', () => {
  // Two triangles of a unit square, then a third beside them.
  const square = () =>
    NavMesh.fromTriangles(
      [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 1],
      [0, 2, 1, 0, 3, 2, 1, 2, 5, 1, 5, 4],
    );

  it('links the triangles sharing an edge', () => {
    const mesh = square();
    expect(mesh.polygonCount).toBe(4);
    expect(mesh.neighbors(0).sort()).toEqual([1, 2]);
  });

  it('leaves out the steep triangles and welds the vertices', () => {
    const mesh = NavMesh.fromTriangles([
      // Flat, two triangles not indexed but sharing an edge.
      0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1,
      // A wall.
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect(mesh.polygonCount).toBe(2);
    expect(mesh.neighbors(0)).toEqual([1]);
    expect(mesh.vertices.length).toBe(4 * 3);
  });

  it('finds the closest point, on or beside the mesh', () => {
    const mesh = square();
    const inside = mesh.closestPoint(p(0.25, 0.5, 0.75));
    expect(inside?.point).toEqual(p(0.25, 0, 0.75));
    const beside = mesh.closestPoint(p(-0.5, 0, 0.5));
    expect(beside?.point.x).toBeCloseTo(0);
    expect(beside?.point.z).toBeCloseTo(0.5);
    expect(mesh.closestPoint(p(-5, 0, 0))).toBeUndefined();
  });

  it('goes straight when nothing is in the way', () => {
    const mesh = square();
    const path = mesh.findPath(p(0.1, 0, 0.5), p(1.9, 0, 0.5));
    expect(path).toEqual([p(0.1, 0, 0.5), p(1.9, 0, 0.5)]);
  });

  it('saves and loads its data', () => {
    const mesh = square();
    const again = new NavMesh(
      JSON.parse(JSON.stringify(mesh.toData())) as ReturnType<
        NavMesh['toData']
      >,
    );
    expect(again.polygonCount).toBe(mesh.polygonCount);
    expect(again.findPath(p(0.1, 0, 0.5), p(1.9, 0, 0.5))).toEqual(
      mesh.findPath(p(0.1, 0, 0.5), p(1.9, 0, 0.5)),
    );
    expect(mesh.lines().length).toBe(4 * 3 * 6);
  });

  it('refuses a polygon of unknown vertices', () => {
    expect(
      () => new NavMesh({ vertices: [0, 0, 0], polygons: [[0, 1, 2]] }),
    ).toThrow(/no vertex 1/);
  });
});

describe('buildNavMesh', () => {
  it('walks around a wall, away from it by the radius', () => {
    const mesh = buildNavMesh({
      bounds: region,
      volumes: [floor, wall],
      agentRadius: 0.5,
    });
    const path = mesh.findPath(p(2, 0, 2), p(2, 0, 8));
    expect(path).toBeDefined();
    const corners = path as NavPoint[];
    expect(corners[0]).toEqual(p(2, 0, 2));
    expect(corners[corners.length - 1]).toEqual(p(2, 0, 8));
    // Around the end of the wall, kept at its radius (to half a cell).
    const turns = corners.slice(1, -1);
    expect(turns.length).toBeGreaterThanOrEqual(1);
    for (const corner of turns) {
      const x = Math.max(corner.x - 7, 0);
      const z = Math.max(4.5 - corner.z, corner.z - 5.5, 0);
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(0.5 - 0.125);
      expect(corner.x).toBeLessThan(8);
    }
    expect(pathLength(corners)).toBeLessThan(16);
    expect(pathLength(corners)).toBeGreaterThan(2 * Math.hypot(5.5, 3) - 0.1);
  });

  it('takes the shorter door, whatever the size of the polygons', () => {
    // A wall across a room of 20 m, a door at each end: the left one is
    // the shorter way.
    const mesh = buildNavMesh({
      bounds: new Aabb([-10, -1, -10], [10, 3, 10]),
      volumes: [
        new Aabb([-10, -1, -10], [10, 0, 10]),
        new Aabb([-6, 0, -2], [3, 1.5, -1.6]),
        new Aabb([5, 0, -2], [10, 1.5, -1.6]),
      ],
      cellSize: 0.2,
      agentRadius: 0.35,
    });
    const path = mesh.findPath(p(0, 0, 0), p(-8, 0, -8)) as NavPoint[];
    for (const corner of path) {
      expect(corner.x).toBeLessThanOrEqual(0);
    }
  });

  it('gathers the flat floor in few polygons', () => {
    const mesh = buildNavMesh({ bounds: region, volumes: [floor] });
    // 40 × 40 cells, the edges cut by the radius: one rectangle.
    expect(mesh.polygonCount).toBe(1);
  });

  it('keeps a floor under a bridge and the bridge, apart', () => {
    // A bridge 3 m above the floor, too high to step on.
    const bridge = new Aabb([4, 2.8, 0], [6, 3, 10]);
    const mesh = buildNavMesh({
      bounds: region,
      volumes: [floor, bridge],
      agentRadius: 0.25,
    });
    const under = mesh.closestPoint(p(5, 0.5, 5));
    const over = mesh.closestPoint(p(5, 3.2, 5));
    expect(under?.point.y).toBeCloseTo(0);
    expect(over?.point.y).toBeCloseTo(3);
    expect(mesh.findPath(p(5, 0, 5), p(5, 3, 5))).toBeUndefined();
    // Partial: as close as the floor gets.
    const partial = mesh.findPath(p(5, 0, 5), p(5, 3, 5), { partial: true });
    expect(partial?.[partial.length - 1].y).toBeCloseTo(0);
  });

  it('climbs the steps and a ramp, not a ledge', () => {
    const steps = [0.3, 0.6, 0.9].map(
      (top, i) => new Aabb([2 + i, 0, 0], [10, top, 10]),
    );
    const mesh = buildNavMesh({
      bounds: region,
      volumes: [floor, ...steps],
      agentRadius: 0.25,
    });
    const path = mesh.findPath(p(1, 0, 5), p(8, 0.9, 5));
    expect(path?.[path.length - 1].y).toBeCloseTo(0.9);

    const ledge = buildNavMesh({
      bounds: region,
      volumes: [floor, new Aabb([5, 0, 0], [10, 1, 10])],
      agentRadius: 0.25,
    });
    expect(ledge.findPath(p(1, 0, 5), p(8, 1, 5))).toBeUndefined();

    // A ramp: a box turned 15° around z, up toward +x.
    const angle = (15 * Math.PI) / 180;
    const ramp = new Obb(
      [5, -0.5 + 2.5 * Math.sin(angle), 5],
      [2.6, 0.5, 2],
      [
        [Math.cos(angle), Math.sin(angle), 0],
        [-Math.sin(angle), Math.cos(angle), 0],
        [0, 0, 1],
      ],
    );
    const slope = buildNavMesh({
      bounds: region,
      volumes: [floor, ramp],
      agentRadius: 0.25,
    });
    const top = slope.closestPoint(p(7, 2, 5));
    expect(top?.point.y).toBeGreaterThan(0.8);
    expect(slope.findPath(p(1, 0, 5), top?.point as NavPoint)).toBeDefined();
  });

  it('stands on a ground function', () => {
    const mesh = buildNavMesh({
      bounds: new Aabb([0, -5, 0], [10, 5, 10]),
      ground: (x) => x * 0.1,
    });
    const point = mesh.closestPoint(p(5, 1, 5));
    expect(point?.point.y).toBeCloseTo(0.5, 1);
  });

  it('reads the volumes of a scene', () => {
    const scene = new Scene();
    scene.root.add({ name: 'wall' });
    const volumes = sceneVolumes(scene, { bounds: region });
    // No renderer: no volume.
    expect(volumes).toEqual([]);
    expect(sceneVolumes(scene)).toEqual([]);
  });
});

describe('NavAgent', () => {
  it('follows the corners at its speed and stops at the end', () => {
    const mesh = buildNavMesh({
      bounds: region,
      volumes: [floor, wall],
      agentRadius: 0.5,
    });
    const agent = new NavAgent(mesh, { speed: 2 });
    const position = p(2, 0, 2);
    expect(agent.setDestination(position, p(2, 0, 8))).toBe(true);
    let steps = 0;
    while (!agent.idle && steps < 1000) {
      const step = agent.update(position, 0.1);
      expect(Math.hypot(step.x, step.z)).toBeLessThanOrEqual(0.2 + 1e-9);
      position.x += step.x;
      position.z += step.z;
      steps++;
    }
    expect(position.x).toBeCloseTo(2);
    expect(position.z).toBeCloseTo(8);
    expect(agent.destination).toBeUndefined();
    expect(agent.update(position, 0.1)).toEqual(p(0, 0, 0));
  });

  it('finds a new path when pushed away, none when there is none', () => {
    const mesh = buildNavMesh({ bounds: region, volumes: [floor] });
    const agent = new NavAgent(mesh, { speed: 1, maxDeviation: 0.5 });
    agent.setDestination(p(1, 0, 1), p(9, 0, 1));
    const step = agent.update(p(1, 0, 5), 0.1);
    // Toward the end from where it is now.
    expect(step.x).toBeGreaterThan(0);
    expect(step.z).toBeLessThan(0);
    expect(agent.remaining(p(1, 0, 5))).toBeCloseTo(Math.hypot(8, 4), 1);
    expect(agent.setDestination(p(1, 0, 1), p(50, 0, 50))).toBe(false);
    expect(agent.idle).toBe(true);
  });
});
