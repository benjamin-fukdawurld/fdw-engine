import { Frustum } from '@fdw/engine-geometry';
import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { DirectionalLight, PointLight, SpotLight } from '../light';
import { GraphBuilder } from '@fdw/engine-shader';
import {
  colorGraph,
  FakeBuffer,
  fakeBackend,
  rowOf,
  surface,
  triangle,
} from '../testing/fakeBackend';
import { Transform } from '../Transform';
import { Material } from './Material';
import { Mesh } from './Mesh';
import type { OcclusionCuller } from './occlusion';
import { Renderer } from './Renderer';
import { RenderGraph } from '../graph/RenderGraph';
import {
  AllLayers,
  RenderItem,
  RenderSource,
  WorldRenderItem,
} from './RenderSource';

// The fake cameras see 1000 units around them, from -1000 to 1000 in depth.
const setup = () => {
  const { backend, log } = fakeBackend();
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  return { renderer, log, camera };
};

const itemAt = (
  x: number,
  material = new Material({ graph: colorGraph() })
) => ({
  mesh: triangle(),
  material,
  transform: new Transform({ position: { x, y: 0, z: 0 } }),
});

const floatsOf = (buffer: FakeBuffer) => [...new Float32Array(buffer.data)];

describe('Renderer culling', () => {
  it('draws only the items the camera sees', () => {
    const { renderer, log, camera } = setup();
    renderer.render({
      items: [itemAt(0), itemAt(5000), itemAt(-990)],
      camera,
      surface,
    });
    expect(log.draws).toHaveLength(2);
    expect(renderer.stats.get('scene')).toEqual(
      expect.objectContaining({ visible: 2, drawn: 2 })
    );
  });

  it('follows the items and the camera from frame to frame', () => {
    const { renderer, log, camera } = setup();
    const far = itemAt(5000);
    const items = [itemAt(0), far];
    renderer.render({ items, camera, surface });
    expect(log.draws).toHaveLength(1);
    far.transform.position = { x: 10 };
    renderer.render({ items, camera, surface });
    expect(log.draws).toHaveLength(3);
    camera.position = { x: 4000 };
    renderer.render({ items, camera, surface });
    expect(log.draws).toHaveLength(3);
  });

  it('queries a source for the camera, then for each shadow map', () => {
    const { renderer, log, camera } = setup();
    const items = [itemAt(0), itemAt(5)];
    const queries: { frustum: Frustum; layers: number; view: string }[] = [];
    const source: RenderSource = {
      query: (frustum, layers, visit, view) => {
        queries.push({ frustum, layers, view });
        items.forEach(visit);
      },
      lights: () => [new DirectionalLight({ castShadow: true })],
    };
    renderer.render({ source, camera, surface, layers: 0b101 });
    // The camera, then the light.
    expect(queries).toHaveLength(2);
    expect(queries.map((query) => query.layers)).toEqual([0b101, 0b101]);
    expect(queries.map((query) => query.view)).toEqual(['camera', 'shadow']);
    expect(queries[0].frustum.containsPoint([0, 0, 0])).toBe(true);
    expect(renderer.stats.get('scene')).toEqual({
      visible: 2,
      occluded: 0,
      drawn: 2,
      drawCalls: 2,
      lights: 1,
      shadowMaps: 1,
      casters: 2,
    });
    // Two shadow draws, then the two items.
    expect(log.draws).toHaveLength(4);
  });

  it('has no shadow map when nothing is visible', () => {
    const { renderer, camera } = setup();
    renderer.render({
      items: [itemAt(5000)],
      lights: [new DirectionalLight({ castShadow: true })],
      camera,
      surface,
    });
    expect(renderer.stats.get('scene')).toEqual(
      expect.objectContaining({ visible: 0, shadowMaps: 0 })
    );
  });

  it('draws with the world matrices given by the source', () => {
    const { renderer, log, camera } = setup();
    const matrix = new Float32Array(16);
    [0, 5, 10, 15].forEach((i) => (matrix[i] = 1));
    matrix[12] = 3;
    const world = { matrix, version: 0 };
    const item: WorldRenderItem = {
      mesh: triangle(),
      material: new Material({ graph: colorGraph() }),
      world,
    };
    const source: RenderSource = { query: (_f, _l, visit) => visit(item) };
    renderer.render({ source, camera, surface });
    expect(rowOf(log, 0)[12]).toBe(3);
    // Same version: not written again.
    renderer.render({ source, camera, surface });
    expect(log.rowWrites).toHaveLength(1);
    matrix[12] = 4;
    (world as { version: number }).version++;
    renderer.render({ source, camera, surface });
    expect(log.rowWrites).toHaveLength(2);
    expect(rowOf(log, 0)[12]).toBe(4);
  });

  it('refuses an item without transform nor world matrix', () => {
    const { renderer, camera } = setup();
    // A source written in JavaScript could give one.
    const item = {
      mesh: triangle(),
      material: new Material({ graph: colorGraph() }),
    } as unknown as RenderItem;
    expect(() => renderer.render({ items: [item], camera, surface })).toThrow(
      /without transform nor world matrix/
    );
  });

  it('leaves out the lights that cannot reach the view', () => {
    const { renderer, camera } = setup();
    const lamp = (x: number) =>
      new PointLight({ position: { x, y: 0, z: 0 }, quadraticAttenuation: 1 });
    // A white lamp with a quadratic attenuation reaches 16 units.
    renderer.render({
      items: [itemAt(0)],
      lights: [lamp(0), lamp(1100), lamp(-1014)],
      camera,
      surface,
    });
    expect(renderer.stats.get('scene')?.lights).toBe(2);
  });

  it('keeps the strongest lights when too many reach the view', () => {
    const { renderer, log, camera } = setup();
    const lights = Array.from(
      { length: 20 },
      (_, i) =>
        new PointLight({
          position: { x: i * 10, y: 0, z: 0 },
          linearAttenuation: 0.01,
        })
    );
    renderer.render({ items: [itemAt(0)], lights, camera, surface });
    expect(renderer.stats.get('scene')?.lights).toBe(16);
    // The 16 nearest of the receiver: x from 0 to 150.
    const frame = log.buffers.find(
      (b) => b.label === 'scene frame uniforms'
    ) as FakeBuffer;
    expect(floatsOf(frame)).toContain(150);
    expect(floatsOf(frame)).not.toContain(190);
  });

  it('gives all the layers by default', () => {
    const { renderer, camera } = setup();
    const layers: number[] = [];
    renderer.render({
      source: { query: (_f, mask) => layers.push(mask) },
      camera,
      surface,
    });
    expect(layers).toEqual([AllLayers]);
  });

  it('leaves out what no bounded light reaches, with cullUnlit', () => {
    const { renderer, camera } = setup();
    // A spot at the origin shining along -x, and a lamp whose light dies
    // within 16 units.
    const spot = new SpotLight({
      position: { x: 0, y: 0, z: 0 },
      direction: { x: -1, y: 0, z: 0 },
      outerCutoff: 20,
      quadraticAttenuation: 1,
    });
    const g = new GraphBuilder('lit');
    g.surface({ shadingModel: 'phong', baseColor: [1, 1, 1] });
    const lit = new Material({ graph: g.build() });
    // The lit models need normals.
    const withNormals = new Mesh({
      description: {
        vertexBuffers: [
          {
            stride: 24,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float32x3', offset: 0 },
              { semantic: 'normal', format: 'float32x3', offset: 12 },
            ],
          },
        ],
        vertexCount: 3,
      },
      vertices: [new Float32Array(18)],
    });
    const litAt = (x: number) => ({ ...itemAt(x, lit), mesh: withNormals });
    const items = [
      litAt(-5), // in the cone
      litAt(5), // behind the spot: black
      itemAt(5), // unlit: drawn anyway
    ];
    renderer.render({
      items,
      lights: [spot],
      camera,
      surface,
      cullUnlit: true,
    });
    expect(renderer.stats.get('scene')?.drawn).toBe(2);
    // A directional light reaches everything: nothing is left out.
    renderer.render({
      items,
      lights: [spot, new DirectionalLight()],
      camera,
      surface,
      cullUnlit: true,
    });
    expect(renderer.stats.get('scene')?.drawn).toBe(3);
    // Off by default.
    renderer.render({ items, lights: [spot], camera, surface });
    expect(renderer.stats.get('scene')?.drawn).toBe(3);
  });
});

describe('Renderer occlusion culling', () => {
  // A culler leaving out the items of a set, recording its calls.
  const culler = (hidden: Set<object>) => {
    const calls: string[] = [];
    const occlusion: OcclusionCuller = {
      begin: (view) => calls.push(`begin ${view.name}`),
      visible: (item, bounds) => {
        calls.push(`visible ${bounds ? 'bounded' : 'unbounded'}`);
        return !hidden.has(item);
      },
      addPasses: (graph, context) => {
        calls.push(`passes ${context.name} ${context.depth.name}`);
        expect(context.renderer).toBeInstanceOf(Renderer);
      },
    };
    return { occlusion, calls };
  };

  it('leaves out the items the culler finds hidden, and counts them', () => {
    const { renderer, log, camera } = setup();
    const hidden = itemAt(1);
    const { occlusion, calls } = culler(new Set([hidden]));
    renderer.render({
      items: [itemAt(0), hidden, itemAt(5000)],
      camera,
      surface,
      occlusion,
    });
    expect(log.draws).toHaveLength(1);
    expect(renderer.stats.get('scene')).toMatchObject({
      visible: 1,
      occluded: 1,
      drawn: 1,
    });
    // Asked for the items in the frustum only, then given the depth of the
    // opaque items.
    expect(calls).toEqual([
      'begin scene',
      'visible bounded',
      'visible bounded',
      'passes scene scene depth',
    ]);
  });

  it('only asks the culler in the passes of the transparent items', () => {
    const { renderer, camera } = setup();
    const { occlusion, calls } = culler(new Set());
    const graph = new RenderGraph();
    const opaque = renderer.addScenePasses(graph, {
      items: [itemAt(0)],
      camera,
      outputs: { depth: { format: 'r32float', value: 'view-depth' } },
      include: 'opaque',
      occlusion,
    });
    renderer.addScenePasses(graph, {
      items: [itemAt(0)],
      camera,
      target: graph.createTexture('color', { format: 'rgba8unorm' }),
      format: 'rgba8unorm',
      depth: opaque.depth,
      include: 'transparent',
      name: 'transparent',
      occlusion,
    });
    expect(calls).toEqual([
      'begin scene',
      'visible bounded',
      'passes scene scene depth',
      'visible bounded',
    ]);
  });

  it('refuses multisampling: the depth would not be read', () => {
    const { backend } = fakeBackend();
    const renderer = new Renderer(backend, { samples: 4 });
    const { occlusion } = culler(new Set());
    expect(() =>
      renderer.render({
        items: [itemAt(0)],
        camera: new Camera({ position: { x: 0, y: 0, z: 10 } }),
        surface,
        occlusion,
      })
    ).toThrow(/samples: 1/);
  });

  it('gives the graph of render() the size of the surface', () => {
    const { renderer, camera } = setup();
    let size: unknown;
    renderer.render({
      items: [itemAt(0)],
      camera,
      surface,
      occlusion: {
        begin: () => undefined,
        visible: () => true,
        addPasses: (graph, { depth }) => {
          size = graph.pixelSize(depth);
        },
      },
    });
    const target = surface.getCurrentTarget();
    expect(size).toEqual({ width: target.width, height: target.height });
  });
});
