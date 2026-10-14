import {
  Camera,
  Material,
  Renderer,
  RenderGraph,
  RenderItem,
  Transform,
} from '@fdw/engine-core';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '@fdw/engine-core/testing';
import { compile } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { testGraph, firstLevelGraph, nextLevelGraph } from './graphs';
import { OcclusionCulling } from './OcclusionCulling';

// The fake cameras see 1000 units around them, from -1000 to 1000 in depth.
const setup = () => {
  const { backend, log } = fakeBackend();
  // What the test of each box answers, by slot: visible by default.
  let answer: (slot: number) => boolean = () => true;
  backend.textures.readTexture = async (_texture, region) => {
    const bytes = new Uint8Array((region?.width ?? 0) * (region?.height ?? 0));
    bytes.forEach((_, slot) => (bytes[slot] = answer(slot) ? 255 : 0));
    return bytes.buffer;
  };
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  const occlusion = new OcclusionCulling();
  const items: RenderItem[] = [-2, 0, 2].map((x) => ({
    mesh: triangle(),
    material: new Material({ graph: colorGraph() }),
    transform: new Transform({ position: { x, y: 0, z: 0 } }),
  }));
  const frame = async (list = items) => {
    renderer.render({ items: list, camera, surface, occlusion });
    // The results arrive after the frame.
    await new Promise((resolve) => setTimeout(resolve));
    return renderer.stats.get('scene');
  };
  return {
    backend,
    log,
    renderer,
    camera,
    occlusion,
    items,
    frame,
    answer: (next: (slot: number) => boolean) => (answer = next),
  };
};

describe('OcclusionCulling', () => {
  it('adds the pyramid, the test and the readback after the opaque items', async () => {
    const { log, frame } = setup();
    await frame();
    // The surface of the fake backend: 4 × 4 pixels, 2 levels.
    expect(log.renderPasses).toEqual([
      'scene opaque',
      'scene occlusion level 0',
      'scene occlusion level 1',
      'scene occlusion test',
    ]);
    expect(
      log.textures.map(({ label, format, dimensions }) => ({
        label,
        format,
        dimensions,
      }))
    ).toEqual(
      expect.arrayContaining([
        {
          label: 'occlusion boxes',
          format: 'rgba32float',
          dimensions: { width: 512, height: 4 },
        },
        {
          label: 'occlusion results',
          format: 'r8unorm',
          dimensions: { width: 256, height: 4 },
        },
      ])
    );
  });

  it('leaves out the items found hidden, from the next frame', async () => {
    const { frame, answer, occlusion, items } = setup();
    // The item in the middle is hidden.
    answer((slot) => slot !== 1);
    expect(await frame()).toMatchObject({ visible: 3, occluded: 0 });
    expect(occlusion.stats).toEqual({ tested: 3, hidden: 1, latency: 0 });
    expect(await frame()).toMatchObject({ visible: 2, occluded: 1 });
    expect(occlusion.isHidden(items[1])).toBe(true);
    expect(occlusion.isHidden(items[0])).toBe(false);
    // Still tested: found visible again, drawn again.
    answer(() => true);
    await frame();
    expect(await frame()).toMatchObject({ visible: 3, occluded: 0 });
  });

  it('forgets what it found of the items out of view', async () => {
    const { frame, answer, items } = setup();
    answer(() => false);
    await frame();
    expect(await frame()).toMatchObject({ visible: 0, occluded: 3 });
    // Out of view for a frame, then back: drawn until tested again.
    await frame([]);
    answer(() => true);
    expect(await frame(items)).toMatchObject({ visible: 3, occluded: 0 });
  });

  it('waits for its results before testing again', async () => {
    const { log, renderer, camera, occlusion, items } = setup();
    // Without waiting: two tests at most in flight.
    for (let i = 0; i < 4; i++) {
      renderer.render({ items, camera, surface, occlusion });
    }
    expect(
      log.renderPasses.filter((name) => name === 'scene occlusion test')
    ).toHaveLength(2);
  });

  it('grows the boxes by the motion of the camera', async () => {
    const { backend, camera, frame } = setup();
    const written: Float32Array[] = [];
    backend.textures.writeTexture = (_texture, data) =>
      written.push(new Float32Array(data.buffer, data.byteOffset, 8).slice());
    await frame();
    camera.position = { x: 3, y: 4, z: 10 };
    await frame();
    // The box of the first item, min then max, grown by 2 × 5.
    const [still, moved] = written;
    expect(moved[0]).toBeCloseTo(still[0] - 10);
    expect(moved[4]).toBeCloseTo(still[4] + 10);
  });

  it('needs the size of the frame', () => {
    const { renderer, camera, occlusion, items } = setup();
    const graph = new RenderGraph();
    expect(() =>
      renderer.addScenePasses(graph, {
        items,
        camera,
        target: graph.createTexture('color', { format: 'rgba8unorm' }),
        format: 'rgba8unorm',
        occlusion,
      })
    ).toThrow(/new RenderGraph\(\{ size \}\)/);
  });
});

describe('the graphs of the occlusion culling', () => {
  it('compile, the test for any number of levels', () => {
    for (const graph of [
      firstLevelGraph(),
      nextLevelGraph(),
      testGraph(1),
      testGraph(12),
    ]) {
      expect(() => compile(graph)).not.toThrow();
    }
  });
});
