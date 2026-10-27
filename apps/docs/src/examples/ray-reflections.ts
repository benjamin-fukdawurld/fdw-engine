import {
  Camera,
  DirectionalLight,
  Material,
  RenderGraph,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import {
  RayOcclusion,
  RayReflections,
  RayScene,
  reflectionOutputs,
} from '@fdw/engine-raytracing';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Reflections and ambient occlusion by rays, over a G-buffer: the scene
// passes write the point, the normal and the roughness, the base color
// and the metalness of each pixel; the rays leave from there. Click to
// switch between the image with both, the reflections alone, the
// occlusion alone, and the rasterized image.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    metallic: g.uniform('metallic', BuiltinTypes.f32),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  const graph = g.build();
  const material = (
    baseColor: [number, number, number],
    metallic: number,
    roughness: number,
  ) => new Material({ graph, values: { baseColor, metallic, roughness } });
  const lampGraph = new GraphBuilder('lamp');
  lampGraph.surface({ baseColor: [4, 2.2, 0.8] });

  // A polished floor, a mirror ball, a gold one, boxes and a glowing bar.
  const cube = createCube();
  const sphere = createSphere(48, 24);
  const item = (
    mesh: typeof cube,
    look: Material,
    position: { x: number; y: number; z: number },
    scale = { x: 1, y: 1, z: 1 },
  ): RenderItem => ({
    mesh,
    material: look,
    transform: new Transform({ position, scale }),
  });
  const spinning = item(cube, material([0.2, 0.45, 0.85], 0, 0.5), {
    x: 1.4,
    y: 0.5,
    z: 0,
  });
  const items = [
    item(
      cube,
      material([0.1, 0.1, 0.12], 0, 0.08),
      { x: 0, y: -0.05, z: 0 },
      { x: 12, y: 0.1, z: 10 },
    ),
    item(
      cube,
      material([0.8, 0.78, 0.74], 0, 0.8),
      { x: 0, y: 1.5, z: -3 },
      { x: 12, y: 3, z: 0.2 },
    ),
    item(
      sphere,
      material([0.95, 0.95, 0.95], 1, 0.02),
      { x: -1.4, y: 0.7, z: 0 },
      { x: 1.4, y: 1.4, z: 1.4 },
    ),
    item(
      sphere,
      material([1, 0.75, 0.3], 1, 0.3),
      { x: 0, y: 0.45, z: 1.4 },
      { x: 0.9, y: 0.9, z: 0.9 },
    ),
    item(
      cube,
      new Material({ graph: lampGraph.build() }),
      { x: 0, y: 2.2, z: -2.8 },
      { x: 4, y: 0.15, z: 0.15 },
    ),
    spinning,
  ];
  const sun = new DirectionalLight({
    direction: { x: -0.4, y: -1, z: -0.5 },
    ambient: { x: 0.12, y: 0.13, z: 0.15 },
    diffuse: { x: 1.2, y: 1.15, z: 1.05 },
    specular: { x: 1.2, y: 1.15, z: 1.05 },
    castShadow: true,
  });
  const camera = new Camera({
    position: { x: 0, y: 2.2, z: 5.5 },
    rotation: axisAngle(1, 0, 0, -0.32),
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sky = { r: 0.5, g: 0.6, b: 0.75, a: 1 };

  if (!backend.capabilities?.rayQuery) {
    // WebGL2: no rays, the rasterized image.
    onFrame((time) => {
      spinning.transform.rotation = axisAngle(0, 1, 0, time * 0.5);
      renderer.render({
        items,
        camera,
        surface,
        time,
        lights: [sun],
        clearColor: sky,
      });
      info('rasterized: tracing rays needs WebGPU');
    });
    return;
  }

  const scene = new RayScene(backend);
  const reflections = new RayReflections(renderer, scene, {
    maxRoughness: 0.4,
    sky: {
      zenith: { x: 0.25, y: 0.35, z: 0.55 },
      horizon: { x: 0.5, y: 0.6, z: 0.75 },
      ground: { x: 0.1, y: 0.1, z: 0.1 },
    },
  });
  const occlusion = new RayOcclusion(renderer, scene, {
    radius: 0.8,
    samples: 6,
  });

  // The occlusion darkens the image (its ambient part, mostly), or shows
  // alone.
  const c = new GraphBuilder('darken');
  const pixel = c.call(
    std.convert,
    { value: c.builtin('frag-coord').swizzle('xy') },
    { params: { to: BuiltinTypes.vec2i } },
  );
  const load = (name: string) =>
    c.call(std.textureLoad, { texture: c.texture(name), coords: pixel });
  const open = load('occlusion').swizzle('x');
  const strength = c.uniform('strength', BuiltinTypes.f32);
  const alone = c.uniform('alone', BuiltinTypes.f32);
  const color = c.call(std.mul, {
    a: load('color').swizzle('xyz'),
    b: c.call(std.mix, { a: 1, b: open, t: strength }),
  });
  c.fullscreen({
    color: c.call(std.extend, {
      xyz: c.call(std.mix, {
        a: color,
        b: c.call(std.vec3, { x: open, y: open, z: open }),
        t: alone,
      }),
    }),
  });
  const darken = new Material({
    graph: c.build(),
    values: { strength: 0.8, alone: 0 },
  });

  const modes = ['both', 'reflections', 'occlusion', 'rasterized'] as const;
  let mode = 0;
  canvas.addEventListener('click', () => {
    mode = (mode + 1) % modes.length;
  });

  onFrame((time) => {
    spinning.transform.rotation = axisAngle(0, 1, 0, time * 0.5);
    info(`${modes[mode]} · click to switch`);
    if (modes[mode] === 'rasterized') {
      renderer.render({
        items,
        camera,
        surface,
        time,
        lights: [sun],
        clearColor: sky,
      });
      return;
    }
    scene.update({ items });
    const current = surface.getCurrentTarget();
    const graph = new RenderGraph({
      size: { width: current.width, height: current.height },
    });
    // The image and its G-buffer, in linear colors; the shadows traced too.
    const passes = renderer.addScenePasses(graph, {
      items,
      camera,
      time,
      lights: [sun],
      clearColor: sky,
      target: graph.createTexture('hdr', { format: 'rgba16float' }),
      format: 'rgba16float',
      linear: true,
      samples: 1,
      outputs: reflectionOutputs(),
      rays: { scene, shadows: true },
    });
    const gbuffer = {
      position: passes.outputs.position,
      normal: passes.outputs.normal,
    };
    let image = passes.color;
    if (modes[mode] !== 'occlusion') {
      image = reflections.addPasses(graph, {
        camera,
        lights: [sun],
        color: image,
        baseColor: passes.outputs.baseColor,
        ...gbuffer,
      });
    }
    if (modes[mode] !== 'reflections') {
      darken.setValue('alone', modes[mode] === 'occlusion' ? 1 : 0);
      image = renderer.addFullscreenPass(graph, 'darken', {
        material: darken,
        inputs: {
          color: image,
          occlusion: occlusion.addPasses(graph, gbuffer),
        },
        target: graph.createTexture('darkened', { format: 'rgba16float' }),
        format: 'rgba16float',
      });
    }
    renderer.addToneMappingPass(graph, {
      hdr: image,
      target: graph.importTexture('surface', current),
      format: surface.format,
    });
    renderer.executeGraph(graph);
    surface.present();
  });
};

export default example;
