import {
  Camera,
  DirectionalLight,
  Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import {
  BuiltinTypes,
  defineFunction,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import { axisAngle, createCube } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// The scene passes write, besides the color, the normals, the depths and
// the identifiers of the objects, each in its texture; a full screen pass
// shows the four, one per quarter of the screen.
const example: Example = ({ backend, surface, onFrame }) => {
  // The outputs, as function graphs of the values of the surface. The
  // normal in view space, from [-1, 1] to [0, 1].
  const n = new GraphBuilder('encode normal');
  n.functionOutput(
    'value',
    n.call(std.extend, {
      xyz: n.call(std.add, {
        a: n.call(std.mul, {
          a: n.functionInput('viewNormal', BuiltinTypes.vec3f),
          b: 0.5,
        }),
        b: 0.5,
      }),
    })
  );
  const encodeNormal = defineFunction(n.build(), { id: 'example.normal' });

  // The distance to the camera, from 2 (white) to 6 (black).
  const d = new GraphBuilder('encode depth');
  d.functionOutput(
    'value',
    d.call(std.saturate, {
      x: d.call(std.sub, {
        a: 1.5,
        b: d.call(std.mul, {
          a: d.functionInput('viewDepth', BuiltinTypes.f32),
          b: 0.25,
        }),
      }),
    })
  );
  const encodeDepth = defineFunction(d.build(), { id: 'example.depth' });

  // A color per identifier: its fractional parts by three factors.
  const c = new GraphBuilder('identifier color');
  const id = c.call(
    std.convert,
    { value: c.functionInput('objectId', BuiltinTypes.u32) },
    { params: { to: BuiltinTypes.f32 } }
  );
  c.functionOutput(
    'value',
    c.call(std.extend, {
      xyz: c.call(std.fract, {
        x: c.call(std.mul, { a: id, b: [0.61, 0.37, 0.83] }),
      }),
    })
  );
  const identifierColor = defineFunction(c.build(), { id: 'example.id' });

  // The composition: each quarter of the screen shows a texture.
  const g = new GraphBuilder('quarters');
  const uv = g.builtin('screen-uv');
  const local = g.call(std.fract, { x: g.call(std.mul, { a: uv, b: 2 }) });
  const sample = (name: string) =>
    g
      .call(std.textureSample, {
        texture: g.texture(name),
        sampler: g.sampler('quarterSampler'),
        uv: local,
      })
      .swizzle('rgb');
  const right = g.call(std.greater, { a: uv.swizzle('x'), b: 0.5 });
  const bottom = g.call(std.greater, { a: uv.swizzle('y'), b: 0.5 });
  const top = g.call(std.select, {
    ifFalse: sample('color'),
    ifTrue: sample('normal'),
    condition: right,
  });
  const below = g.call(std.select, {
    ifFalse: sample('depth').swizzle('xxx'),
    ifTrue: sample('id'),
    condition: right,
  });
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: g.call(std.select, {
        ifFalse: top,
        ifTrue: below,
        condition: bottom,
      }),
    }),
  });
  const quarters = new Material({
    graph: g.build(),
    values: { quarterSampler: backend.textures.createSampler() },
  });

  const material = new Material({
    graph: (() => {
      const m = new GraphBuilder('lit');
      m.surface({ shadingModel: 'phong', baseColor: [0.9, 0.5, 0.2] });
      return m.build();
    })(),
  });
  const cube = createCube();
  const transforms = [-1.3, 0, 1.3].map(
    (x, i) => new Transform({ position: { x, y: 0, z: -i * 0.8 } })
  );
  const camera = new Camera({
    position: { x: 0, y: 0, z: 4 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sun = new DirectionalLight({ direction: { x: -1, y: -1, z: -1 } });
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  onFrame((time) => {
    transforms.forEach((transform, i) => {
      transform.rotation = axisAngle(Math.SQRT1_2, Math.SQRT1_2, 0, time + i);
    });
    const graph = new RenderGraph();
    const scene = renderer.addScenePasses(graph, {
      // The identifiers of the objects: 1, 2, 3.
      items: transforms.map((transform, i) => ({
        mesh: cube,
        material,
        transform,
        id: i + 1,
      })),
      camera,
      lights: [sun],
      target: graph.createTexture('color', { format: 'rgba8unorm' }),
      format: 'rgba8unorm',
      clearColor: { r: 0.1, g: 0.1, b: 0.12, a: 1 },
      outputs: {
        normal: { format: 'rgba8unorm', value: encodeNormal },
        depth: { format: 'r8unorm', value: encodeDepth },
        id: { format: 'rgba8unorm', value: identifierColor },
      },
    });
    renderer.addFullscreenPass(graph, 'quarters', {
      material: quarters,
      inputs: { color: scene.color, ...scene.outputs },
      target: graph.importTexture('surface', surface.getCurrentTarget()),
      format: surface.format,
    });
    runner.execute(graph);
    surface.present();
  });
};

export default example;
