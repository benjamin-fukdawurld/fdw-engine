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
import type { PortHandle } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Screen space ambient occlusion: the scene passes write the normals and
// the depths; a full screen pass estimates, for each pixel, how much of the
// geometry around it hides the sky; a second one blurs the estimate; a
// third darkens the ambient light by it. Click to switch between the image
// with occlusion, without it, and the occlusion alone.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // --- The G-buffer: the normal in view space and the depth, in one texture.
  const n = new GraphBuilder('normal and depth');
  n.functionOutput(
    'value',
    n.call(std.extend, {
      xyz: n.functionInput('viewNormal', BuiltinTypes.vec3f),
      w: n.functionInput('viewDepth', BuiltinTypes.f32),
    })
  );
  const normalDepth = defineFunction(n.build(), { id: 'example.normalDepth' });

  // --- The occlusion pass.
  // The samples: 16 points in the half sphere above the surface (z up), of
  // radius 1, more of them close to the center.
  const count = 16;
  const kernel = [...Array(count)].map((_, i) => {
    const angle = i * 2.39996; // The golden angle: evenly spread around z.
    const z = 1 - (i + 0.5) / count; // From the normal to the horizon.
    const side = Math.sqrt(1 - z * z);
    const scale = 0.1 + 0.9 * (((i * 7) % count) / count) ** 2;
    return [
      side * Math.cos(angle) * scale,
      side * Math.sin(angle) * scale,
      Math.max(z, 0.1) * scale,
    ];
  });

  const o = new GraphBuilder('ssao');
  const gbuffer = o.texture('gbuffer');
  const gbufferSampler = o.sampler('gbufferSampler');
  const read = (uv: PortHandle) =>
    o.call(std.textureSample, {
      texture: gbuffer,
      sampler: gbufferSampler,
      uv,
    });
  // The projection scale (projection[0][0], projection[1][1]): from the view
  // space to the screen and back.
  const projection = o.uniform('projection', BuiltinTypes.vec2f);
  const radius = o.uniform('radius', BuiltinTypes.f32, { default: 0.5 });
  const bias = o.uniform('bias', BuiltinTypes.f32, { default: 0.025 });
  const power = o.uniform('power', BuiltinTypes.f32, { default: 2 });

  // The point of the pixel, in view space, from its depth.
  const uv = o.builtin('screen-uv');
  const center = read(uv);
  const normal = o.call(std.normalize, { x: center.swizzle('xyz') });
  const depth = center.swizzle('w');
  const ndc = o.call(std.mul, {
    a: o.call(std.sub, { a: o.call(std.mul, { a: uv, b: 2 }), b: 1 }),
    b: [1, -1],
  });
  const xy = o.call(std.div, {
    a: o.call(std.mul, { a: ndc, b: depth }),
    b: projection,
  });
  const position = o.call(std.vec3, {
    x: xy.swizzle('x'),
    y: xy.swizzle('y'),
    z: o.call(std.mul, { a: depth, b: -1 }),
  });

  // A frame around the normal, turned by an angle that changes from pixel
  // to pixel over a 4 × 4 tile: 16 angles, so that the 16 samples cover
  // many directions in each tile. The blur averages the tile.
  const cell = o.call(std.floor, {
    x: o.call(std.mul, {
      a: o.call(std.fract, {
        x: o.call(std.mul, {
          a: o.builtin('frag-coord').swizzle('xy'),
          b: 0.25,
        }),
      }),
      b: 4,
    }),
  });
  const angle = o.call(std.mul, {
    a: o.call(std.dot, { a: cell, b: [1, 4] }),
    b: (2 * Math.PI * 7) / 16,
  });
  // Any vector not along the normal gives a tangent.
  const helper = o.call(std.select, {
    ifFalse: [1, 0, 0],
    ifTrue: [0, 1, 0],
    condition: o.call(std.less, {
      a: o.call(std.abs, { x: normal.swizzle('y') }),
      b: 0.9,
    }),
  });
  const t0 = o.call(std.normalize, {
    x: o.call(std.cross, { a: helper, b: normal }),
  });
  const b0 = o.call(std.cross, { a: normal, b: t0 });
  const tangent = o.call(std.add, {
    a: o.call(std.mul, { a: t0, b: o.call(std.cos, { x: angle }) }),
    b: o.call(std.mul, { a: b0, b: o.call(std.sin, { x: angle }) }),
  });
  const bitangent = o.call(std.cross, { a: normal, b: tangent });
  const frame = o.call(std.mat3, { c0: tangent, c1: bitangent, c2: normal });

  // Each sample: a point near the surface, projected on the screen. It is
  // hidden when the scene, at that pixel, is closer to the camera than it.
  let hidden: PortHandle | number = 0;
  for (const offset of kernel) {
    const point = o.call(std.add, {
      a: position,
      b: o.call(std.mul, {
        a: o.call(std.transform3, { matrix: frame, vector: offset }),
        b: radius,
      }),
    });
    const pointDepth = o.call(std.mul, { a: point.swizzle('z'), b: -1 });
    const pointUv = o.call(std.add, {
      a: o.call(std.mul, {
        a: o.call(std.div, {
          a: o.call(std.mul, { a: point.swizzle('xy'), b: projection }),
          b: pointDepth,
        }),
        b: [0.5, -0.5],
      }),
      b: 0.5,
    });
    const sceneDepth = read(pointUv).swizzle('w');
    // 1 when the scene is in front of the point (and is not the background,
    // of depth 0).
    const inFront = o.call(std.mul, {
      a: o.call(std.step, {
        edge: o.call(std.add, { a: sceneDepth, b: bias }),
        x: pointDepth,
      }),
      b: o.call(std.step, { edge: 0.0001, x: sceneDepth }),
    });
    // Less and less as the scene there is farther from the pixel than the
    // radius: an object far in front does not darken the wall behind it.
    const near = o.call(std.smoothstep, {
      low: 0,
      high: 1,
      x: o.call(std.div, {
        a: radius,
        b: o.call(std.max, {
          a: o.call(std.abs, {
            x: o.call(std.sub, { a: depth, b: sceneDepth }),
          }),
          b: 0.0001,
        }),
      }),
    });
    hidden = o.call(std.add, {
      a: hidden,
      b: o.call(std.mul, { a: inFront, b: near }),
    });
  }
  // 1: open to the sky, 0: fully hidden; raised to a power to strengthen
  // it. The background is open.
  const open = o.call(std.select, {
    ifFalse: 1,
    ifTrue: o.call(std.pow, {
      base: o.call(std.sub, {
        a: 1,
        b: o.call(std.div, { a: hidden, b: count }),
      }),
      exponent: power,
    }),
    condition: o.call(std.greater, { a: depth, b: 0 }),
  });
  o.fullscreen({ color: o.call(std.vec4, { x: open, w: 1 }) });
  // Clamped to the edges: a sample off the screen must not read the other
  // side.
  const clamped = {
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  } as const;
  const linear = backend.textures.createSampler(clamped);
  // The depths must not be blended between objects: nearest.
  const nearest = backend.textures.createSampler({
    ...clamped,
    minFilter: 'nearest',
    magFilter: 'nearest',
  });
  const ssao = new Material({
    graph: o.build(),
    values: { gbufferSampler: nearest },
  });

  // --- The blur: the average of 4 × 4 pixels, which removes the pattern of
  // the tile. Each linear sample, between 4 pixels, averages them: 4
  // samples read the 16.
  const b = new GraphBuilder('ssao blur');
  const blurUv = b.builtin('screen-uv');
  const texel = b.uniform('texel', BuiltinTypes.vec2f);
  const occlusionTexture = b.texture('occlusion');
  const occlusionSampler = b.sampler('occlusionSampler');
  let sum: PortHandle | number = 0;
  for (const [dx, dy] of [
    [-0.5, -0.5],
    [1.5, -0.5],
    [-0.5, 1.5],
    [1.5, 1.5],
  ]) {
    sum = b.call(std.add, {
      a: sum,
      b: b
        .call(std.textureSample, {
          texture: occlusionTexture,
          sampler: occlusionSampler,
          uv: b.call(std.add, {
            a: blurUv,
            b: b.call(std.mul, { a: texel, b: [dx, dy] }),
          }),
        })
        .swizzle('x'),
    });
  }
  b.fullscreen({
    color: b.call(std.vec4, { x: b.call(std.mul, { a: sum, b: 0.25 }), w: 1 }),
  });
  const blur = new Material({
    graph: b.build(),
    values: { occlusionSampler: linear },
  });

  // --- The composition: the ambient light only is darkened. The scene
  // passes added ambient × baseColor: remove the part that is hidden. The
  // colors are linear (linear: true in the scene passes): encoded here.
  const c = new GraphBuilder('compose');
  const at = c.builtin('screen-uv');
  const sample = (name: string) =>
    c.call(std.textureSample, {
      texture: c.texture(name),
      sampler: c.sampler(`${name}Sampler`),
      uv: at,
    });
  const color = sample('color').swizzle('rgb');
  const ambient = c.call(std.mul, {
    a: c.uniform('ambient', BuiltinTypes.vec3f),
    b: sample('baseColor').swizzle('rgb'),
  });
  const blurred = sample('occlusion');
  const occlusion = blurred.swizzle('x');
  const occluded = c.call(std.sub, {
    a: color,
    b: c.call(std.mul, {
      a: ambient,
      b: c.call(std.sub, { a: 1, b: occlusion }),
    }),
  });
  // 0: with occlusion, 1: without, 2: the occlusion alone.
  const mode = c.uniform('mode', BuiltinTypes.f32);
  const srgb = (linear: PortHandle) =>
    c.call('color.linearToSrgb', { color: linear });
  const shown = c.call(std.select, {
    ifFalse: c.call(std.select, {
      ifFalse: srgb(occluded),
      ifTrue: srgb(color),
      condition: c.call(std.greater, { a: mode, b: 0.5 }),
    }),
    ifTrue: blurred.swizzle('xxx'),
    condition: c.call(std.greater, { a: mode, b: 1.5 }),
  });
  c.fullscreen({ color: c.call(std.extend, { xyz: shown }) });
  const compose = new Material({
    graph: c.build(),
    values: {
      colorSampler: nearest,
      baseColorSampler: nearest,
      occlusionSampler: nearest,
      mode: 0,
    },
  });

  // --- The scene: boxes and balls on a floor, against a wall.
  const lit = (baseColor: [number, number, number]) => {
    const m = new GraphBuilder('lit');
    m.surface({ shadingModel: 'phong', baseColor });
    return new Material({ graph: m.build() });
  };
  const white = lit([0.85, 0.85, 0.85]);
  const orange = lit([0.9, 0.5, 0.2]);
  const blue = lit([0.3, 0.5, 0.9]);
  const cube = createCube();
  const sphere = createSphere();
  const box = (
    position: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    material = white
  ) => ({
    mesh: cube,
    material,
    transform: new Transform({ position, scale: size }),
  });
  const spinning = new Transform({
    position: { x: 1.3, y: 0.4, z: 0.3 },
    scale: { x: 0.8, y: 0.8, z: 0.8 },
  });
  const items = [
    box({ x: 0, y: -0.05, z: 0 }, { x: 8, y: 0.1, z: 6 }),
    box({ x: 0, y: 1.5, z: -2 }, { x: 8, y: 3, z: 0.2 }),
    box({ x: -1.6, y: 0.5, z: -1.4 }, { x: 1, y: 1, z: 1 }, orange),
    box({ x: -1.6, y: 1.3, z: -1.4 }, { x: 0.6, y: 0.6, z: 0.6 }, orange),
    { mesh: cube, material: blue, transform: spinning },
    {
      mesh: sphere,
      material: white,
      transform: new Transform({
        position: { x: -0.1, y: 0.5, z: -0.2 },
        scale: { x: 0.5, y: 0.5, z: 0.5 },
      }),
    },
    {
      mesh: sphere,
      material: blue,
      transform: new Transform({
        position: { x: 0.2, y: 0.3, z: 1 },
        scale: { x: 0.3, y: 0.3, z: 0.3 },
      }),
    },
  ];
  const fov = 45;
  const aspect = 16 / 9;
  const camera = new Camera({
    position: { x: 0, y: 2.4, z: 4.6 },
    rotation: axisAngle(1, 0, 0, -0.4),
    projection: { type: 'perspective', fov, aspect, near: 0.1, far: 100 },
  });
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  ssao.setValue('projection', [f / aspect, f]);
  const sun = new DirectionalLight({
    direction: { x: -0.6, y: -1, z: -0.5 },
    ambient: { x: 0.6, y: 0.6, z: 0.6 },
    diffuse: { x: 0.4, y: 0.4, z: 0.4 },
  });
  compose.setValue('ambient', [sun.ambient.x, sun.ambient.y, sun.ambient.z]);
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  const modes = ['with occlusion', 'without occlusion', 'occlusion alone'];
  let current = 0;
  info(`${modes[current]} (click to switch)`);
  canvas.addEventListener('click', () => {
    current = (current + 1) % modes.length;
    compose.setValue('mode', current);
    info(`${modes[current]} (click to switch)`);
  });

  onFrame((time) => {
    spinning.rotation = axisAngle(0, 1, 0, time * 0.5);
    const target = surface.getCurrentTarget();
    blur.setValue('texel', [1 / target.width, 1 / target.height]);

    const graph = new RenderGraph();
    // 1. The scene: the lit color, and the G-buffer.
    const scene = renderer.addScenePasses(graph, {
      items,
      camera,
      lights: [sun],
      target: graph.createTexture('color', { format: 'rgba16float' }),
      format: 'rgba16float',
      // The colors as the materials compute them, before their encoding:
      // the composition subtracts light.
      linear: true,
      // Linear: about 0.1 once encoded.
      clearColor: { r: 0.01, g: 0.01, b: 0.014, a: 1 },
      outputs: {
        gbuffer: { format: 'rgba16float', value: normalDepth },
        baseColor: { format: 'rgba8unorm', value: 'base-color' },
      },
    });
    // 2. The occlusion, 3. its blur.
    const raw = renderer.addFullscreenPass(graph, 'ssao', {
      material: ssao,
      inputs: { gbuffer: scene.outputs.gbuffer },
      target: graph.createTexture('occlusion', { format: 'r8unorm' }),
      format: 'r8unorm',
    });
    const smooth = renderer.addFullscreenPass(graph, 'ssao blur', {
      material: blur,
      inputs: { occlusion: raw },
      target: graph.createTexture('blurred occlusion', { format: 'r8unorm' }),
      format: 'r8unorm',
    });
    // 4. The composition, into the surface.
    renderer.addFullscreenPass(graph, 'compose', {
      material: compose,
      inputs: {
        color: scene.color,
        baseColor: scene.outputs.baseColor,
        occlusion: smooth,
      },
      target: graph.importTexture('surface', target),
      format: surface.format,
    });
    runner.execute(graph);
    surface.present();
  });
};

export default example;
