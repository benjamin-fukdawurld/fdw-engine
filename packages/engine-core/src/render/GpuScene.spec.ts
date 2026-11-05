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
import { GpuScene } from './GpuScene';
import { Material } from './Material';
import { Renderer } from './Renderer';

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
  const render = () =>
    renderer.render({ gpuScene: scene, camera, surface, gpuCulling: true });
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

  it('is a list of items where the backend cannot cull on the GPU', () => {
    const { log, renderer, render } = setup(false);
    render();
    expect(log.computePasses).toEqual([]);
    expect(log.draws.map((draw) => draw.instances)).toEqual([2, 1, 1]);
    expect(renderer.stats.get('scene')).toMatchObject({ visible: 4 });
  });
});
