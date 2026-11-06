import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { Transform } from '../Transform';
import {
  colorGraph,
  fakeBackend,
  FakeBuffer,
  surface,
  triangle,
} from '../testing/fakeBackend';
import { std } from '@fdw/engine-shader';
import { DirectionalLight } from '../light';
import { GpuScene } from './GpuScene';
import { Material } from './Material';
import type { OcclusionCuller } from './occlusion';
import { Renderer, RenderOptions } from './Renderer';

const setup = (indirectDraw = true) => {
  const { backend, log } = fakeBackend({
    maxVaryings: 16,
    storageBuffers: true,
    compute: true,
    objectTable: true,
    indirectDraw,
  });
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  const mesh = triangle();
  const red = new Material({ graph: colorGraph() });
  const blue = new Material({ graph: colorGraph() });
  const glass = new Material({
    graph: colorGraph(),
    renderState: { alphaMode: 'blend' },
  });
  const at = (x: number) => new Transform({ position: { x, y: 0, z: 0 } });
  // Two runs (red, blue), and a transparent item drawn as usual.
  const items = [
    { mesh, material: red, transform: at(-1) },
    { mesh, material: red, transform: at(1) },
    { mesh, material: blue, transform: at(0) },
    { mesh, material: glass, transform: at(0.5) },
  ];
  const scene = new GpuScene();
  items.forEach((item) => scene.add(item));
  const render = (options: Partial<RenderOptions> = {}) =>
    renderer.render({
      gpuScene: scene,
      camera,
      surface,
      gpuCulling: true,
      ...options,
    });
  const buffer = (label: string) =>
    log.buffers.find((b) => b.label === `gpu scene ${label}`) as FakeBuffer;
  return { log, renderer, items, scene, render, buffer };
};

describe('GpuScene', () => {
  it('keeps its items on the GPU: a run per mesh and material', () => {
    const { log, renderer, render, buffer } = setup();
    render();
    // The boxes and the rows of the three opaque items, uploaded once.
    expect(buffer('boxes').writes).toBe(1);
    expect(buffer('rows').writes).toBe(1);
    expect(log.computePasses).toEqual(['scene culling']);
    // A draw per run, the transparent item with the others.
    expect(log.draws.map((draw) => draw.indirect?.offset)).toEqual([0, 20, 0]);
    expect(renderer.stats.get('scene')).toMatchObject({
      visible: 4,
      drawCalls: 3,
    });
    // The next frame writes nothing of them.
    render();
    expect(buffer('boxes').writes).toBe(1);
    expect(buffer('rows').writes).toBe(1);
  });

  it('writes only the items touched, and the dynamic ones', () => {
    const { items, scene, render, buffer } = setup();
    render();
    items[0].transform.position = { x: -2 };
    scene.touch(items[0]);
    render();
    // One box and one row: 32 and 4 bytes.
    expect(buffer('boxes').writes).toBe(2);
    expect(buffer('boxes').data.byteLength).toBe(32);
    expect(buffer('rows').data.byteLength).toBe(4);
    scene.add(items[1], { dynamic: true });
    // Laid out again (an option changed), then written at each frame.
    render();
    expect(buffer('boxes').data.byteLength).toBe(3 * 32);
    render();
    render();
    expect(buffer('boxes').writes).toBe(5);
  });

  it('follows its changes from a cursor per renderer', () => {
    const { items, scene } = setup();
    const cursor = scene.cursor;
    const version = scene.version;
    scene.touch(items[0]).touch(items[2]);
    expect(scene.touchedSince(cursor)).toEqual([items[0], items[2]]);
    expect(scene.touchedSince(cursor + 1)).toEqual([items[2]]);
    expect(scene.touchedSince(scene.cursor)).toEqual([]);
    // Laid out again: the touches are forgotten.
    scene.remove(items[2]);
    expect(scene.version).toBe(version + 1);
    expect(scene.touchedSince(scene.cursor)).toEqual([]);
  });

  it('culls its shadow casters on the GPU, against the receivers the camera draws', () => {
    const { log, render } = setup();
    const sun = new DirectionalLight({
      direction: { x: 0, y: -1, z: -1 },
      castShadow: true,
    });
    render({ lights: [sun] });
    // After the camera: the receiver mask and the casters of the tile.
    expect(log.computePasses).toEqual([
      'scene culling',
      'scene shadows culling',
    ]);
    const pipelines = log.dispatches.map((dispatch) => dispatch.pipeline);
    expect(pipelines).toContain('culling receivers');
    expect(
      pipelines.slice(pipelines.indexOf('culling receiver mask chunks')),
    ).toEqual([
      // The receivers of the GpuScene, then the transparent ones: by
      // chunks, then merged.
      'culling receiver mask chunks',
      'culling receiver mask',
      'culling receiver mask chunks',
      'culling receiver mask',
      'culling shadow test',
      'culling scan',
      'culling scan',
      'culling scatter',
      'culling arguments',
    ]);
    expect(log.renderPasses).toEqual([
      'scene shadows',
      'scene opaque',
      'scene transparent',
    ]);
    // The two runs of the casters, drawn indirectly into the tile.
    // (Then the two runs of the camera, and the transparent item.)
    expect(log.draws.map((draw) => draw.indirect?.offset)).toEqual([
      0, 20, 0, 20, 0,
    ]);
  });

  it('draws over the shadow maps the casters the second phase needs', () => {
    const { log, render } = setup();
    const sun = new DirectionalLight({
      direction: { x: 0, y: -1, z: -1 },
      castShadow: true,
    });
    const occlusion: OcclusionCuller = {
      begin: () => undefined,
      visible: () => true,
      addPasses: () => undefined,
      addPyramid: () => ({
        levels: [],
        names: [],
        key: 'none',
        values: {},
        test: (g, low) =>
          g.call(std.greaterEqual, { a: low.swizzle('x'), b: -1e38 }),
      }),
    };
    render({ lights: [sun], occlusion });
    expect(log.computePasses).toEqual([
      'scene culling',
      'scene shadows culling',
      'scene occlusion culling',
      'scene shadows late culling',
    ]);
    expect(log.renderPasses).toEqual([
      'scene shadows',
      'scene opaque',
      'scene shadows late',
      'scene opaque late',
      'scene transparent',
    ]);
    // The second loads the atlas of the first.
    const late = log.passes[log.renderPasses.indexOf('scene shadows late')];
    expect(late.depthAttachment?.load).toBe('load');
  });

  it('is a list of items where the backend cannot cull on the GPU', () => {
    const { log, renderer, render } = setup(false);
    render();
    expect(log.computePasses).toEqual([]);
    expect(log.draws.map((draw) => draw.instances)).toEqual([2, 1, 1]);
    expect(renderer.stats.get('scene')).toMatchObject({ visible: 4 });
  });
});
