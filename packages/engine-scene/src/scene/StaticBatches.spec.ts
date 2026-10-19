import { Camera, Material, Mesh, Renderer } from '@fdw/engine-core';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '@fdw/engine-core/testing';
import { Aabb, Frustum } from '@fdw/engine-geometry';
import { describe, expect, it } from 'vitest';
import { NodeFlags, Scene } from './Scene';
import { StaticBatch, StaticBatches } from './StaticBatches';

const material = () => new Material({ graph: colorGraph() });

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

// What the camera query gives: entities, and batches by their entities.
const seen = (scene: Scene) => {
  const items: (number | number[])[] = [];
  scene.query(
    box10(),
    0xffffffff,
    (item) =>
      items.push(
        item instanceof StaticBatch
          ? [...item.entities]
          : (item as unknown as { entity: number }).entity,
      ),
    'camera',
  );
  return items;
};

// n static renderers of their own mesh, along x from 1, with one material:
// in the same cell.
const decor = (scene: Scene, n: number, shared = material()) =>
  Array.from({ length: n }, (_, i) =>
    scene.root
      .add({ position: { x: i + 1 }, static: true })
      .setMesh(triangle(), shared),
  );

describe('StaticBatches', () => {
  it('draws the static renderers of a cell and of a material as one', () => {
    const scene = new Scene();
    const nodes = decor(scene, 3);
    const other = scene.root
      .add({ position: { x: 5 }, static: true })
      .setMesh(triangle(), material());
    const moving = scene.root
      .add({ position: { x: 6 } })
      .setMesh(
        triangle(),
        nodes[0].scene.MeshRenderer.material[nodes[0].entity] as Material,
      );
    const batches = new StaticBatches(scene);
    expect(seen(scene)).toEqual(
      expect.arrayContaining([
        other.entity,
        moving.entity,
        nodes.map((node) => node.entity),
      ]),
    );
    expect(seen(scene)).toHaveLength(3);
    expect(batches.stats).toMatchObject({
      batches: 1,
      batched: 3,
      vertices: 9,
    });
    expect(scene.NodeState.flags[nodes[1].entity] & NodeFlags.Batched).toBe(
      NodeFlags.Batched,
    );
    // The other queries still find them.
    const found: number[] = [];
    scene.queryVolumeEntities(
      Aabb.fromPoints([
        [-10, -10, -10],
        [10, 10, 10],
      ]),
      (e) => {
        found.push(e);
      },
    );
    expect(found).toEqual(expect.arrayContaining(nodes.map((n) => n.entity)));
    // Each vertex knows its object.
    const batch = batches.batchOf(nodes[2].entity) as StaticBatch;
    expect(Array.from(batch.mesh.vertices[1] as Uint32Array)).toEqual(
      nodes.flatMap((node) => Array(3).fill(scene.objectId(node.entity))),
    );
    expect(scene.entityOf(scene.objectId(nodes[2].entity))).toBe(
      nodes[2].entity,
    );
  });

  it('rebuilds a batch when one of its renderers changes', () => {
    const scene = new Scene();
    const nodes = decor(scene, 3);
    const batches = new StaticBatches(scene);
    const first = batches.batchOf(nodes[0].entity) as StaticBatch;
    expect(batches.stats.rebuilds).toBe(1);

    // Moved: rebuilt, in world space.
    nodes[1].transform.position = { x: 0, y: 2, z: 0 };
    const moved = batches.batchOf(nodes[0].entity) as StaticBatch;
    expect(moved).not.toBe(first);
    expect(first.mesh.destroyed).toBe(true);
    expect(moved.bounds.max[1]).toBe(2);

    // Hidden: left out, the others still batched.
    nodes[0].visible = false;
    expect(seen(scene)).toEqual([[nodes[1].entity, nodes[2].entity]]);
    nodes[0].visible = true;
    expect(seen(scene)).toEqual([nodes.map((node) => node.entity)]);

    // Another material: drawn alone.
    nodes[2].setMesh(triangle(), material());
    expect(seen(scene)).toEqual(
      expect.arrayContaining([
        [nodes[0].entity, nodes[1].entity],
        nodes[2].entity,
      ]),
    );

    // Removed: one left, drawn alone.
    nodes[1].remove();
    expect(seen(scene).sort()).toEqual([nodes[0].entity, nodes[2].entity]);
    expect(batches.stats.batches).toBe(0);

    // No longer static.
    const more = decor(scene, 2);
    expect(batches.stats.batches).toBe(1);
    more[0].static = false;
    expect(batches.stats.batches).toBe(0);
  });

  it('groups by cell, and splits the large groups', () => {
    const scene = new Scene();
    const shared = material();
    for (const x of [-100, -99, 100, 101]) {
      scene.root
        .add({ position: { x }, static: true })
        .setMesh(triangle(), shared);
    }
    const batches = new StaticBatches(scene, { cellSize: 10 });
    expect(batches.batches.map((batch) => batch.entities.length)).toEqual([
      2, 2,
    ]);
    batches.destroy();

    const small = new StaticBatches(scene, { cellSize: 1000, maxVertices: 6 });
    expect(small.batches.map((batch) => batch.entities.length)).toEqual([2, 2]);
  });

  it('leaves out what cannot be merged', () => {
    const scene = new Scene();
    const transparent = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'blend' },
    });
    decor(scene, 2, transparent);
    const lines = () =>
      new Mesh({
        description: {
          vertexBuffers: [
            {
              stride: 12,
              stepMode: 'vertex',
              attributes: [
                { semantic: 'position', format: 'float32x3', offset: 0 },
              ],
            },
          ],
          vertexCount: 2,
          topology: 'line-list',
        },
        vertices: [new Float32Array(6)],
      });
    const shared = material();
    scene.root.add({ static: true }).setMesh(lines(), shared);
    scene.root.add({ static: true }).setMesh(lines(), shared);
    const kept = decor(scene, 2);
    const batches = new StaticBatches(scene, {
      filter: (entity) => entity !== kept[0].entity,
    });
    expect(batches.stats.batches).toBe(0);
  });

  it('draws a heterogeneous set in fewer calls', () => {
    const { backend } = fakeBackend();
    const renderer = new Renderer(backend);
    const scene = new Scene();
    decor(scene, 10);
    const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
    renderer.render({ source: scene, camera, surface });
    expect(renderer.stats.get('scene')?.drawCalls).toBe(10);
    const batches = new StaticBatches(scene);
    renderer.render({ source: scene, camera, surface });
    expect(renderer.stats.get('scene')?.drawCalls).toBe(1);
    batches.destroy();
    renderer.render({ source: scene, camera, surface });
    expect(renderer.stats.get('scene')?.drawCalls).toBe(10);
  });
});
