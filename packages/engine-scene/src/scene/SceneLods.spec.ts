import { Camera, Material } from '@fdw/engine-core';
import { colorGraph, triangle } from '@fdw/engine-core/testing';
import { Frustum } from '@fdw/engine-geometry';
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../systems/Scheduler';
import { Scene } from './Scene';
import { findLodGroups, SceneLods } from './SceneLods';

// Everything from -1000 to 1000.
const everything = () => {
  const m = new Float32Array(16);
  m[0] = 0.001;
  m[5] = 0.001;
  m[10] = 0.0005;
  m[14] = 0.5;
  m[15] = 1;
  return Frustum.fromMatrix(m);
};

const drawn = (scene: Scene, view: 'camera' | 'shadow' = 'camera') => {
  const entities: number[] = [];
  scene.query(
    everything(),
    0xffffffff,
    (item) => entities.push((item as unknown as { entity: number }).entity),
    view,
  );
  return entities.sort((a, b) => a - b);
};

// A group at the origin, three levels of a renderer each (the second of
// two renderers, one of them a child), named as a modeling tool does.
const setup = (options?: ConstructorParameters<typeof SceneLods>[1]) => {
  const scene = new Scene();
  const lods = new SceneLods(scene, options);
  const material = new Material({ graph: colorGraph() });
  const group = scene.root.add({ name: 'tree' });
  const levels = [0, 1, 2].map((i) =>
    group.add({ name: `tree_LOD${i}` }).setMesh(triangle(), material),
  );
  levels[1].add().setMesh(triangle(), material);
  lods.add(group, [
    { nodes: [levels[0]], maxDistance: 10 },
    { nodes: [levels[1]], maxDistance: 50 },
    { nodes: [levels[2]], maxDistance: 100 },
  ]);
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: 1,
      near: 0.1,
      far: 1000,
    },
  });
  const at = (z: number) => {
    camera.position = { x: 0, y: 0, z };
    lods.update(camera);
    return lods.level(group);
  };
  return { scene, lods, group, levels, camera, at };
};

describe('SceneLods', () => {
  it('draws the first level until the first update', () => {
    const { scene, levels } = setup();
    expect(drawn(scene)).toEqual([levels[0].entity]);
  });

  it('draws the level of the distance, the same in the shadow maps', () => {
    const { scene, levels, at } = setup();
    expect(at(30)).toBe(1);
    const second = [levels[1].entity, levels[1].children[0].entity];
    expect(drawn(scene)).toEqual(second);
    expect(drawn(scene, 'shadow')).toEqual(second);
    expect(at(80)).toBe(2);
    expect(drawn(scene)).toEqual([levels[2].entity]);
    // Beyond the last level: nothing.
    expect(at(200)).toBe(-1);
    expect(drawn(scene)).toEqual([]);
    expect(at(5)).toBe(0);
    expect(drawn(scene)).toEqual([levels[0].entity]);
  });

  it('does not flicker at the boundaries', () => {
    const { at } = setup();
    expect(at(9)).toBe(0);
    // Past 10 by less than 10 %: still the first level.
    expect(at(10.5)).toBe(0);
    expect(at(11.5)).toBe(1);
    // Back under 10, but not under 9: still the second.
    expect(at(9.5)).toBe(1);
    expect(at(8.5)).toBe(0);
  });

  it('draws finer levels further with a narrower field of view', () => {
    const { camera, lods, group } = setup();
    camera.projection = {
      type: 'perspective',
      fov: 20,
      aspect: 1,
      near: 0.1,
      far: 1000,
    };
    camera.position = { x: 0, y: 0, z: 25 };
    lods.update(camera);
    // tan 10° / tan 30° ≈ 0.3: 25 counts as 7.6.
    expect(lods.level(group)).toBe(0);
  });

  it('coarsens sooner with a bias below 1', () => {
    const { lods, at } = setup();
    lods.bias = 0.5;
    expect(at(8)).toBe(1);
  });

  it('follows the group as it moves', () => {
    const { group, at } = setup();
    group.transform.position = { z: 100 };
    expect(at(95)).toBe(0);
  });

  it('shows every level again when the group is removed', () => {
    const { scene, lods, group, levels, at } = setup();
    at(80);
    lods.remove(group);
    expect(drawn(scene)).toHaveLength(4);
    expect(levels.every((level) => level.visible)).toBe(true);
  });

  it('takes the entities of a batch as levels', () => {
    const scene = new Scene();
    const lods = new SceneLods(scene);
    const material = new Material({ graph: colorGraph() });
    const positions = [0, 0, 0, 0, 0, 40];
    const near = scene.createBatch({
      count: 2,
      positions,
      mesh: triangle(),
      material,
    });
    const far = scene.createBatch({
      count: 2,
      positions,
      mesh: triangle(),
      material,
    });
    for (let i = 0; i < 2; i++) {
      lods.add(near[i], [
        { nodes: [near[i]], maxDistance: 20 },
        { nodes: [far[i]], maxDistance: 100 },
      ]);
    }
    const camera = new Camera();
    lods.update(camera);
    expect(drawn(scene)).toEqual([near[0], far[1]].sort((a, b) => a - b));
  });

  it('chooses the levels in the render phase', () => {
    const { lods, group, camera } = setup();
    const scheduler = new Scheduler();
    lods.install(scheduler, camera);
    camera.position = { x: 0, y: 0, z: 30 };
    scheduler.update(1 / 60);
    expect(lods.level(group)).toBe(1);
  });
});

describe('findLodGroups', () => {
  it('finds the levels by their names, finest first', () => {
    const scene = new Scene();
    const group = scene.root.add({ name: 'fir' });
    const second = group.add({ name: 'fir_LOD1' });
    const first = group.add({ name: 'fir_LOD0' });
    group.add({ name: 'fir_collider' });
    scene.root.add({ name: 'rock' });
    expect(findLodGroups(scene.root)).toEqual([
      { group, levels: [first, second] },
    ]);
  });
});
