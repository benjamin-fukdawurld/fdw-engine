import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  Renderer,
  SpotLight,
} from '@fdw/engine-core';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '@fdw/engine-core/testing';
import {
  Aabb,
  Capsule,
  Frustum,
  LinearIndex,
  Ray,
  Sphere,
} from '@fdw/engine-geometry';
import { describe, expect, it, vi } from 'vitest';
import { Scene } from './Scene';

const material = () => new Material({ graph: colorGraph() });

// A quarter turn around y, as a quaternion.
const quarterTurnY = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

// An orthographic box from -10 to 10 around the origin, depth from 0 to 1.
const box10 = () => {
  const m = new Float32Array(16);
  m[0] = 0.1;
  m[5] = 0.1;
  m[10] = 0.05;
  m[14] = 0.5;
  m[15] = 1;
  return Frustum.fromMatrix(m);
};

const seen = (
  scene: Scene,
  frustum: Frustum,
  view: 'camera' | 'shadow' = 'camera'
) => {
  const entities: number[] = [];
  scene.query(
    frustum,
    0xffffffff,
    (item) => entities.push((item as unknown as { entity: number }).entity),
    view
  );
  return entities.sort((a, b) => a - b);
};

describe('Scene', () => {
  it('computes the world matrices of a hierarchy', () => {
    const scene = new Scene();
    const parent = scene.root.add({
      position: { x: 10 },
      rotation: quarterTurnY,
    });
    const child = parent.add({
      position: { x: 1 },
      scale: { x: 2, y: 2, z: 2 },
    });
    // The child, 1 along the x axis of its parent, turned to -z.
    const m = child.worldMatrix;
    expect(m[12]).toBeCloseTo(10, 6);
    expect(m[14]).toBeCloseTo(-1, 6);
    // Its x axis: the quarter turn of (2, 0, 0).
    expect([m[0], m[1], m[2]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      0, 0, -2,
    ]);
    expect(child.worldPosition).toEqual({
      x: expect.closeTo(10, 6),
      y: 0,
      z: expect.closeTo(-1, 6),
    });
  });

  it('recomputes only the invalidated branches, when they are read', () => {
    const scene = new Scene();
    const a = scene.root.add({ name: 'a' });
    const a1 = a.add();
    const b = scene.root.add({ name: 'b' });
    scene.flush();
    const version = (node: typeof a) => scene.WorldMatrix.version[node.entity];
    const before = [a, a1, b].map(version);
    a.transform.position = { y: 3 };
    a.transform.position = { y: 4 };
    // Read in the middle of a frame: up to date.
    expect(a1.worldPosition.y).toBe(4);
    scene.flush();
    expect([a, a1, b].map(version)).toEqual([
      before[0] + 1,
      before[1] + 1,
      before[2],
    ]);
  });

  it('keeps its index up to date before each query', () => {
    const scene = new Scene();
    const mesh = triangle();
    const near = scene.root
      .add({ position: { x: 1 } })
      .setMesh(mesh, material());
    const far = scene.root
      .add({ position: { x: 50 } })
      .setMesh(mesh, material());
    expect(seen(scene, box10())).toEqual([near.entity]);
    far.transform.position = { x: -5 };
    near.transform.position = { x: 100 };
    expect(seen(scene, box10())).toEqual([far.entity]);
    // Through a parent.
    far.parent?.add(far);
    const holder = scene.root.add({ position: { x: 200 } });
    holder.add(far);
    expect(seen(scene, box10())).toEqual([]);
  });

  it('hides the hidden nodes and their descendants, and filters by layers', () => {
    const scene = new Scene();
    const mesh = triangle();
    const group = scene.root.add();
    const inside = group.add({ layers: 0b01 }).setMesh(mesh, material());
    const other = scene.root.add({ layers: 0b10 }).setMesh(mesh, material());
    group.visible = false;
    expect(seen(scene, box10())).toEqual([other.entity]);
    group.visible = true;
    expect(seen(scene, box10())).toEqual(
      [inside.entity, other.entity].sort((a, b) => a - b)
    );
    const layer2: number[] = [];
    scene.query(
      box10(),
      0b10,
      (item) => layer2.push((item as unknown as { entity: number }).entity),
      'camera'
    );
    expect(layer2).toEqual([other.entity]);
  });

  it('indexes the static nodes at once, and warns when one moves', () => {
    const scene = new Scene();
    const mesh = triangle();
    const walls = Array.from({ length: 50 }, (_, i) =>
      scene.root
        .add({ position: { x: i - 25 }, static: true })
        .setMesh(mesh, material())
    );
    // Points (the test triangle has its vertices at the origin): from -9 to
    // 9, the walls at ±10 are on the planes, outside after rounding.
    expect(seen(scene, box10())).toHaveLength(19);
    const versions = walls.map(
      (wall) => scene.WorldMatrix.version[wall.entity]
    );
    scene.flush();
    expect(walls.map((wall) => scene.WorldMatrix.version[wall.entity])).toEqual(
      versions
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    walls[0].transform.position = { x: 0 };
    walls[1].transform.position = { x: 1 };
    expect(seen(scene, box10())).toHaveLength(21);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('answers the queries of the application', () => {
    const scene = new Scene();
    const mesh = triangle();
    const nodes = [3, 6, 9].map((x) =>
      scene.root.add({ position: { x, y: 0, z: 0 } }).setMesh(mesh, material())
    );
    // A volume of its own: a capsule above the last one.
    nodes[2].setMesh(mesh, material(), {
      volume: new Capsule([9, -10, 0], [9, 10, 0], 0.5),
    });
    const hits: [number, number][] = [];
    scene.raycast(new Ray([0, 0, 0], [1, 0, 0]), (node, distance) => {
      hits.push([node.entity, Math.round(distance * 10) / 10]);
    });
    expect(hits.map(([entity]) => entity)).toEqual(
      nodes.map((node) => node.entity)
    );
    expect(hits[2][1]).toBe(8.5);
    const near: number[] = [];
    scene.queryVolume(new Sphere([3, 0, 0], 1), (node) => {
      near.push(node.entity);
    });
    expect(near).toEqual([nodes[0].entity]);
    // Only the first hit.
    let count = 0;
    scene.raycast(new Ray([0, 0, 0], [1, 0, 0]), () => {
      count++;
      return false;
    });
    expect(count).toBe(1);
  });

  it('moves the lights and cameras with their nodes', () => {
    const scene = new Scene();
    const player = scene.root.add({ position: { x: 5 } });
    const spot = new SpotLight();
    const lamp = player
      .add({ position: { y: 2 }, rotation: quarterTurnY })
      .setLight(spot);
    const camera = new Camera();
    player.add({ position: { z: 10 } }).setCamera(camera);
    expect(scene.lights()).toEqual([spot]);
    expect(spot.position).toMatchObject({ x: 5, y: 2, z: 0 });
    // Its -z axis turned a quarter around y: -x.
    expect(spot.direction.x).toBeCloseTo(-1, 6);
    expect(camera.position).toMatchObject({ x: 5, y: 0, z: 10 });
    player.transform.position = { x: 7 };
    scene.flush();
    expect(spot.position.x).toBe(7);
    expect(camera.position.x).toBe(7);
    lamp.visible = false;
    expect(scene.lights()).toEqual([]);
  });

  it('gives handles that know when their entity is gone', () => {
    const scene = new Scene();
    const parent = scene.root.add({ name: 'parent' });
    const child = parent.add({ name: 'child' }).setMesh(triangle(), material());
    expect(scene.node(child.entity)).toBe(child);
    expect(scene.find('child')).toBe(child);
    expect(parent.children).toEqual([child]);
    parent.remove();
    expect(child.alive).toBe(false);
    expect(() => child.name).toThrow(/was removed/);
    expect(seen(scene, box10())).toEqual([]);
    expect(scene.root.children).toEqual([]);
    // The index of the removed entities is reused by a new node.
    const reused = scene.root.add();
    expect(reused === child).toBe(false);
  });

  it('remembers what the cameras kept, and culls only their queries', () => {
    const scene = new Scene();
    const mesh = triangle();
    const a = scene.root.add().setMesh(mesh, material());
    const b = scene.root.add({ position: { x: 2 } }).setMesh(mesh, material());
    scene.occlusion = { visible: (_scene, entity) => entity !== b.entity };
    expect(seen(scene, box10(), 'camera')).toEqual([a.entity]);
    expect(seen(scene, box10(), 'shadow')).toEqual(
      [a.entity, b.entity].sort((x, y) => x - y)
    );
    expect(a.lastVisible).toBe(scene.cameraQueries);
    expect(b.lastVisible).toBe(0);
  });

  it('gives the results of a linear search', () => {
    // Many nodes moving under moving parents: the scene and a brute force
    // search over the world bounds agree.
    const scene = new Scene();
    const mesh = triangle();
    let seed = 1;
    const random = () =>
      ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const groups = Array.from({ length: 10 }, () =>
      scene.root.add({ position: { x: random() * 30 } })
    );
    const leaves = Array.from({ length: 300 }, (_, i) =>
      groups[i % 10]
        .add({
          position: { x: random() * 20, y: random() * 20, z: random() * 20 },
        })
        .setMesh(mesh, material())
    );
    for (let round = 0; round < 5; round++) {
      groups.forEach(
        (group) => (group.transform.position = { x: random() * 30 })
      );
      leaves
        .slice(0, 100)
        .forEach((leaf) => (leaf.transform.position = { y: random() * 30 }));
      const linear = new LinearIndex<number>();
      for (const leaf of leaves) {
        linear.insert(leaf.entity, scene.bounds(new Aabb(), leaf.entity));
      }
      const frustum = box10();
      const expected: number[] = [];
      linear.queryFrustum(frustum, (entity) => expected.push(entity));
      expect(seen(scene, frustum)).toEqual(expected.sort((a, b) => a - b));
    }
  });
});

describe('Scene with a Renderer', () => {
  it('draws what the camera sees, with the world matrices of the nodes', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    const scene = new Scene();
    const mesh = triangle();
    for (let i = 0; i < 100; i++) {
      scene.root.add({ position: { x: i * 100 } }).setMesh(mesh, material());
    }
    const sun = new DirectionalLight({ castShadow: true });
    scene.root.add().setLight(sun);
    const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
    renderer.render({ source: scene, camera, surface });
    // The fake camera sees 1000 units around it: from 0 to 900.
    expect(renderer.stats.get('scene')).toEqual(
      expect.objectContaining({
        visible: 10,
        drawn: 10,
        lights: 1,
        shadowMaps: 1,
      })
    );
    const objects = log.buffers.filter(
      (buffer) => buffer.label === 'object uniforms'
    );
    expect(objects).toHaveLength(10);
    const floats = new Float32Array(objects[3].data);
    expect(floats[12] % 100).toBe(0);
    // A point light far away lights nothing visible.
    scene.root
      .add({ position: { x: 5000 } })
      .setLight(new PointLight({ quadraticAttenuation: 1 }));
    renderer.render({ source: scene, camera, surface });
    expect(renderer.stats.get('scene')?.lights).toBe(1);
  });
});
