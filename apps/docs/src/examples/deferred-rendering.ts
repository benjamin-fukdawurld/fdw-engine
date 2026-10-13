import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  TextureHandle,
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

// Deferred rendering: the scene passes write what the lighting needs (the
// G-buffer) instead of a color; a full screen pass lights each pixel once,
// with the shading model of the materials; the transparent objects are then
// drawn over it, in forward. Click to switch between the deferred image,
// the forward one, and the textures of the G-buffer.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // --- The G-buffer: what the shading model needs, in three textures.
  // The normal in world space and the depth, in an rgba16float.
  const n = new GraphBuilder('normal and depth');
  n.functionOutput(
    'value',
    n.call(std.extend, {
      xyz: n.functionInput('worldNormal', BuiltinTypes.vec3f),
      w: n.functionInput('viewDepth', BuiltinTypes.f32),
    })
  );
  const normalDepth = defineFunction(n.build(), { id: 'example.normalDepth' });
  // The roughness and the metallic factor, in two channels of an rgba8unorm.
  const p = new GraphBuilder('material properties');
  p.functionOutput(
    'value',
    p.call(std.vec4, {
      x: p.functionInput('roughness', BuiltinTypes.f32),
      y: p.functionInput('metallic', BuiltinTypes.f32),
      w: 1,
    })
  );
  const properties = defineFunction(p.build(), { id: 'example.properties' });
  const outputs = {
    baseColor: { format: 'rgba8unorm', value: 'base-color' },
    normalDepth: { format: 'rgba16float', value: normalDepth },
    properties: { format: 'rgba8unorm', value: properties },
  } as const;

  // --- The lighting pass: each pixel of the G-buffer, lit by the PBR model.
  const g = new GraphBuilder('deferred lighting');
  const uv = g.builtin('screen-uv');
  const read = (name: string) =>
    g.call(std.textureSample, {
      texture: g.texture(name),
      sampler: g.sampler(`${name}Sampler`),
      uv,
    });
  const baseColor = read('baseColor').swizzle('rgb');
  const geometry = read('normalDepth');
  const normal = geometry.swizzle('xyz');
  const depth = geometry.swizzle('w');
  const material = read('properties');
  // The point of the pixel, in the world, from its depth.
  const position = g.call('camera.positionFromDepth', {
    uv,
    viewDepth: depth,
  });
  const lit = g.call('lighting.pbr', {
    baseColor,
    normal,
    roughness: material.swizzle('x'),
    metallic: material.swizzle('y'),
    worldPosition: g.call(std.extend, { xyz: position, w: 1 }),
  });
  // 0: the lit image; 1, 2, 3: the textures of the G-buffer.
  const mode = g.uniform('mode', BuiltinTypes.f32);
  const shown = (value: number, color: PortHandle, otherwise: PortHandle) =>
    g.call(std.select, {
      ifFalse: otherwise,
      ifTrue: color,
      condition: g.call(std.greater, { a: mode, b: value - 0.5 }),
    });
  const color = shown(
    3,
    material.swizzle('xyz'),
    shown(
      2,
      g.call(std.add, { a: g.call(std.mul, { a: normal, b: 0.5 }), b: 0.5 }),
      shown(1, baseColor, lit.swizzle('rgb'))
    )
  );
  // Where no object was drawn (depth 0), the background.
  g.fullscreen({
    color: g.call(std.select, {
      ifFalse: [0.02, 0.02, 0.03, 1],
      ifTrue: g.call(std.extend, { xyz: color }),
      condition: g.call(std.greater, { a: depth, b: 0 }),
    }),
  });
  // One texel of the G-buffer per pixel: no filtering.
  const nearest = backend.textures.createSampler({
    minFilter: 'nearest',
    magFilter: 'nearest',
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  });
  const lighting = new Material({
    graph: g.build(),
    values: {
      baseColorSampler: nearest,
      normalDepthSampler: nearest,
      propertiesSampler: nearest,
      mode: 0,
    },
  });

  // --- The output: the linear colors, encoded in sRGB for the screen.
  const o = new GraphBuilder('output');
  const hdr = o.call(std.textureSample, {
    texture: o.texture('hdr'),
    sampler: o.sampler('hdrSampler'),
    uv: o.builtin('screen-uv'),
  });
  o.fullscreen({
    color: o.call(std.extend, {
      xyz: o.call('color.linearToSrgb', { color: hdr.swizzle('rgb') }),
    }),
  });
  const output = new Material({
    graph: o.build(),
    values: { hdrSampler: nearest },
  });

  // --- The scene: pillars and balls on a floor, lit by 15 small lights.
  const pbr = (
    color: [number, number, number],
    roughness: number,
    metallic = 0,
    alpha?: number
  ) => {
    const m = new GraphBuilder('pbr');
    m.surface({
      shadingModel: 'pbr',
      baseColor: color,
      roughness,
      metallic,
      ...(alpha !== undefined ? { alpha } : {}),
    });
    return new Material({
      graph: m.build(),
      ...(alpha !== undefined ? { renderState: { alphaMode: 'blend' } } : {}),
    });
  };
  const cube = createCube();
  const sphere = createSphere(32, 16);
  const floor = pbr([0.45, 0.45, 0.45], 0.5);
  const stone = pbr([0.7, 0.65, 0.6], 0.8);
  const gold = pbr([1, 0.78, 0.34], 0.3, 1);
  const plastic = pbr([0.2, 0.4, 0.9], 0.25);
  const glass = pbr([0.5, 0.9, 0.8], 0.1, 0, 0.4);
  const at = (
    x: number,
    y: number,
    z: number,
    scale: { x: number; y: number; z: number }
  ) => new Transform({ position: { x, y, z }, scale });
  const items = [
    {
      mesh: cube,
      material: floor,
      transform: at(0, -0.05, 0, { x: 12, y: 0.1, z: 8 }),
    },
  ];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * 2 * Math.PI;
    items.push({
      mesh: cube,
      material: stone,
      transform: at(3 * Math.cos(angle), 0.75, 2 * Math.sin(angle), {
        x: 0.4,
        y: 1.5,
        z: 0.4,
      }),
    });
  }
  for (const [x, z, material] of [
    [-1, 0.4, gold],
    [0.9, -0.3, plastic],
    [0, -1.2, gold],
    [0.2, 1.1, plastic],
  ] as const) {
    items.push({
      mesh: sphere,
      material,
      transform: at(x, 0.4, z, { x: 0.8, y: 0.8, z: 0.8 }),
    });
  }
  // Transparent: drawn in forward, over the lit G-buffer.
  items.push({
    mesh: sphere,
    material: glass,
    transform: at(-0.2, 0.6, 0, { x: 1.2, y: 1.2, z: 1.2 }),
  });

  // A dim sun, for the ambient light, and 15 colored lamps, close to the
  // ground, each lighting a small area.
  const sun = new DirectionalLight({
    direction: { x: -0.3, y: -1, z: -0.4 },
    ambient: { x: 0.04, y: 0.04, z: 0.04 },
    diffuse: { x: 0.1, y: 0.1, z: 0.1 },
    specular: { x: 0, y: 0, z: 0 },
  });
  const lamps = [...Array(15)].map((_, i) => {
    const hue = i / 15;
    const channel = (offset: number) =>
      0.5 + 0.5 * Math.cos(2 * Math.PI * (hue + offset));
    const color = { x: channel(0), y: channel(1 / 3), z: channel(2 / 3) };
    return new PointLight({
      ambient: { x: 0, y: 0, z: 0 },
      diffuse: color,
      specular: color,
      constantAttenuation: 1,
      linearAttenuation: 0,
      quadraticAttenuation: 10,
    });
  });
  const lights = [sun, ...lamps];

  const camera = new Camera({
    position: { x: 0, y: 4.2, z: 6.4 },
    rotation: axisAngle(1, 0, 0, -0.55),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  const modes = [
    'deferred',
    'forward',
    'G-buffer: base color',
    'G-buffer: normals',
    'G-buffer: roughness and metallic',
  ];
  let current = 0;
  const show = () => info(`${modes[current]} (click to switch)`);
  show();
  canvas.addEventListener('click', () => {
    current = (current + 1) % modes.length;
    lighting.setValue('mode', Math.max(current - 1, 0));
    show();
  });

  onFrame((time) => {
    // The lamps turn around the center, each at its radius and speed.
    lamps.forEach((lamp, i) => {
      const angle = time * (0.3 + 0.05 * (i % 4)) + (i / 15) * 2 * Math.PI;
      const radius = 1.2 + (1.6 * ((i * 7) % 15)) / 15;
      lamp.position = {
        x: radius * Math.cos(angle),
        y: 0.25 + 0.15 * (i % 3),
        z: radius * Math.sin(angle),
      };
    });
    const target = surface.getCurrentTarget();
    const graph = new RenderGraph();
    let color: TextureHandle;
    if (current === 1) {
      // Forward: every object lit as it is drawn.
      color = renderer.addScenePasses(graph, {
        items,
        camera,
        lights,
        target: graph.createTexture('color', { format: 'rgba16float' }),
        format: 'rgba16float',
        linear: true,
      }).color;
    } else {
      // 1. The G-buffer: the opaque objects, without lighting.
      const scene = renderer.addScenePasses(graph, {
        items,
        camera,
        lights,
        include: 'opaque',
        outputs,
      });
      // 2. The lighting: one full screen pass.
      const lit = renderer.addFullscreenPass(graph, 'lighting', {
        material: lighting,
        inputs: {
          baseColor: scene.outputs.baseColor,
          normalDepth: scene.outputs.normalDepth,
          properties: scene.outputs.properties,
        },
        // The shadow maps, when the lights cast shadows.
        ...(scene.shadows ? { shadows: scene.shadows } : {}),
        target: graph.createTexture('color', { format: 'rgba16float' }),
        format: 'rgba16float',
      });
      // 3. The transparent objects, over it, tested against the depth of
      // the G-buffer.
      color =
        current === 0
          ? renderer.addScenePasses(graph, {
              name: 'transparent',
              items,
              camera,
              lights,
              include: 'transparent',
              depth: scene.depth,
              target: lit,
              format: 'rgba16float',
              load: 'load',
              linear: true,
            }).color
          : lit;
    }
    // 4. The output, into the surface.
    renderer.addFullscreenPass(graph, 'output', {
      material: output,
      inputs: { hdr: color },
      target: graph.importTexture('surface', target),
      format: surface.format,
    });
    runner.execute(graph);
    surface.present();
  });
};

export default example;
