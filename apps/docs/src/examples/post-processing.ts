import {
  Camera,
  DirectionalLight,
  Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import { axisAngle, createCube } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// The scene drawn into a texture, then a sepia tone and a vignette applied
// by a full screen pass.
const example: Example = ({ backend, surface, onFrame }) => {
  // The effect: a graph ending with output.fullscreen, reading the scene.
  const g = new GraphBuilder('sepia vignette');
  const uv = g.builtin('screen-uv');
  const color = g
    .call(std.textureSample, {
      texture: g.texture('scene'),
      sampler: g.sampler('sceneSampler'),
      uv,
    })
    .swizzle('rgb');
  const gray = g.call(std.dot, { a: color, b: [0.299, 0.587, 0.114] });
  const sepia = g.call(std.mul, { a: gray, b: [1.07, 0.74, 0.43] });
  const toned = g.call(std.mix, {
    a: color,
    b: sepia,
    t: g.uniform('amount', BuiltinTypes.f32),
  });
  // Darker away from the center of the screen: 1 up to 0.3 from it, 0 from
  // 0.8.
  const distance = g.call(std.length, {
    x: g.call(std.sub, { a: uv, b: 0.5 }),
  });
  const vignette = g.call(std.sub, {
    a: 1,
    b: g.call(std.smoothstep, { low: 0.3, high: 0.8, x: distance }),
  });
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: g.call(std.mul, { a: toned, b: vignette }),
    }),
  });
  const effect = new Material({
    graph: g.build(),
    values: { sceneSampler: backend.textures.createSampler() },
  });

  const material = new Material({
    graph: (() => {
      const m = new GraphBuilder('lit');
      m.surface({ shadingModel: 'phong', baseColor: [0.2, 0.6, 1] });
      return m.build();
    })(),
  });
  const cube = createCube();
  const transforms = [-1.5, 0, 1.5].map(
    (x) => new Transform({ position: { x, y: 0, z: 0 } })
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
    effect.setValue('amount', 0.5 + 0.5 * Math.sin(time));

    // A render graph per frame: its compilation and its textures are reused
    // from one frame to the next.
    const graph = new RenderGraph();
    // The image of the surface: the frame, whose size the transient
    // textures take by default.
    const output = graph.importTexture('surface', surface.getCurrentTarget());
    const scene = renderer.addScenePasses(graph, {
      items: transforms.map((transform) => ({
        mesh: cube,
        material,
        transform,
      })),
      camera,
      lights: [sun],
      // A transient texture, from a pool reused between frames.
      target: graph.createTexture('scene', { format: 'rgba8unorm' }),
      format: 'rgba8unorm',
      clearColor: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
    });
    renderer.addFullscreenPass(graph, 'sepia vignette', {
      material: effect,
      inputs: { scene },
      target: output,
      format: surface.format,
    });
    runner.execute(graph);
    surface.present();
  });
};

export default example;
