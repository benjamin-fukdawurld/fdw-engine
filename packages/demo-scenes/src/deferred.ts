import {
  Camera,
  DirectionalLight,
  Material,
  pickIds,
  PointLight,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  RenderItem,
  TextureHandle,
  Transform,
} from '@fdw/engine-core';
import type { GpuTexture, RenderBackend, Surface } from '@fdw/engine-backend';
import {
  BuiltinTypes,
  defineFunction,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { axisAngle, createCube, createSphere } from './geometry';
import { followAspect } from './scene';
import type { Scene, SceneContext, SceneFactory } from './scene';

// The demo of P2b: what the scene passes write besides the color, used
// together. A room of pillars, boxes and balls lit by a sun and 12 lamps:
// - forward or deferred (D): in forward, a pre-pass writes the normals and
//   the depths, and the materials read the occlusion as they are drawn; in
//   deferred, the G-buffer is lit by one full screen pass, the transparent
//   ball drawn in forward over it;
// - the screen space ambient occlusion (O), computed from the normals and
//   depths, darkens the ambient light only (the occlusion of PBR);
// - the selection at the pixel: the passes write the identifier of each
//   object; hovering one highlights it, a click selects it, a drag selects
//   the objects in the rectangle (C clears the selection).
// Right drag turns the camera, the wheel zooms. V (or 1 to 3) shows the
// image, the occlusion alone, the normals.

const views = ['image', 'ambient occlusion', 'normals'];
const background = [0.02, 0.025, 0.035] as const;

export interface DeferredSceneOptions {
  // Deferred at first (the default), or forward.
  readonly deferred?: boolean;
}

export function createDeferred(
  options: DeferredSceneOptions = {},
): SceneFactory {
  return (backend, surface, context = {}) =>
    deferredScene(backend, surface, context, options);
}

export const createDeferredScene: SceneFactory = createDeferred();

function deferredScene(
  backend: RenderBackend,
  surface: Surface,
  context: SceneContext,
  options: DeferredSceneOptions,
): Scene {
  const input = new Input(context.input ?? new FakeInputSource());
  const clamped = {
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  } as const;
  const linear = backend.textures.createSampler(clamped);
  // The G-buffer: one texel per pixel, never blended between objects.
  const nearest = backend.textures.createSampler({
    ...clamped,
    minFilter: 'nearest',
    magFilter: 'nearest',
  });

  // --- What the scene passes write besides the color.
  // The normal in world space and the depth in the view, in an rgba16float.
  const n = new GraphBuilder('normal and depth');
  n.functionOutput(
    'value',
    n.call(std.extend, {
      xyz: n.functionInput('worldNormal', BuiltinTypes.vec3f),
      w: n.functionInput('viewDepth', BuiltinTypes.f32),
    }),
  );
  const normalDepth = defineFunction(n.build(), {
    id: 'deferred.normalDepth',
  });
  // The roughness and the metallic factor, in an rgba8unorm.
  const p = new GraphBuilder('material properties');
  p.functionOutput(
    'value',
    p.call(std.vec4, {
      x: p.functionInput('roughness', BuiltinTypes.f32),
      y: p.functionInput('metallic', BuiltinTypes.f32),
      w: 1,
    }),
  );
  const properties = defineFunction(p.build(), { id: 'deferred.properties' });

  // --- The materials: PBR, their values in uniforms (the color changes
  // with the selection). Two graphs: the G-buffer one, without lighting
  // (deferred, and the pre-pass of forward), and the lit one, which reads
  // the occlusion of its pixel, computed before it is drawn.
  const surfaceGraph = (lit: boolean, alpha?: number) => {
    const g = new GraphBuilder(lit ? 'lit' : 'g-buffer');
    const occlusion = lit
      ? {
          occlusion: g
            .call(std.textureLoad, {
              texture: g.texture('occlusion'),
              coords: g.call(
                std.convert,
                { value: g.builtin('frag-coord').swizzle('xy') },
                { params: { to: BuiltinTypes.vec2i } },
              ),
            })
            .swizzle('x'),
        }
      : {};
    g.surface({
      shadingModel: 'pbr',
      baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
      roughness: g.uniform('roughness', BuiltinTypes.f32),
      metallic: g.uniform('metallic', BuiltinTypes.f32),
      ...occlusion,
      ...(alpha !== undefined ? { alpha } : {}),
    });
    return g.build();
  };
  const gbufferGraph = surfaceGraph(false);
  const litGraph = surfaceGraph(true);

  // --- The ambient occlusion: 16 points in the half sphere above each
  // pixel, hidden or not by the depth of the scene (see the tutorial
  // "Ambient occlusion"); the normals of the G-buffer are in world space,
  // turned into the view here.
  const count = 16;
  const kernel = [...Array(count)].map((_, i) => {
    const angle = i * 2.39996; // The golden angle: evenly spread around z.
    const z = 1 - (i + 0.5) / count;
    const side = Math.sqrt(1 - z * z);
    const scale = 0.1 + 0.9 * (((i * 7) % count) / count) ** 2;
    return [
      side * Math.cos(angle) * scale,
      side * Math.sin(angle) * scale,
      Math.max(z, 0.1) * scale,
    ];
  });
  const o = new GraphBuilder('ssao');
  const gbuffer = o.texture('normalDepth');
  const gbufferSampler = o.sampler('normalDepthSampler');
  const read = (uv: PortHandle) =>
    o.call(std.textureSample, {
      texture: gbuffer,
      sampler: gbufferSampler,
      uv,
    });
  const projection = o.uniform('projection', BuiltinTypes.vec2f);
  const radius = o.uniform('radius', BuiltinTypes.f32, { default: 0.5 });
  const bias = o.uniform('bias', BuiltinTypes.f32, { default: 0.025 });
  const power = o.uniform('power', BuiltinTypes.f32, { default: 2 });
  // 0: no occlusion, 1: all of it.
  const strength = o.uniform('strength', BuiltinTypes.f32, { default: 1 });
  const uv = o.builtin('screen-uv');
  const center = read(uv);
  const normal = o.call(std.normalize, {
    x: o
      .call(std.transform, {
        matrix: o.engine('camera.view'),
        vector: o.call(std.extend, { xyz: center.swizzle('xyz'), w: 0 }),
      })
      .swizzle('xyz'),
  });
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
  // A frame around the normal, turned over a 4 × 4 tile that the blur
  // averages.
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
    const inFront = o.call(std.mul, {
      a: o.call(std.step, {
        edge: o.call(std.add, { a: sceneDepth, b: bias }),
        x: pointDepth,
      }),
      b: o.call(std.step, { edge: 0.0001, x: sceneDepth }),
    });
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
  o.fullscreen({
    color: o.call(std.vec4, {
      x: o.call(std.mix, { a: 1, b: open, t: strength }),
      w: 1,
    }),
  });
  const ssao = new Material({
    graph: o.build(),
    values: { normalDepthSampler: nearest },
  });

  // The blur: 4 linear samples average 4 × 4 pixels.
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

  // --- The deferred lighting: each pixel of the G-buffer lit once by the
  // PBR model, the occlusion as its own.
  const l = new GraphBuilder('deferred lighting');
  const at = l.builtin('screen-uv');
  const sample = (name: string) =>
    l.call(std.textureSample, {
      texture: l.texture(name),
      sampler: l.sampler(`${name}Sampler`),
      uv: at,
    });
  const geometry = sample('normalDepth');
  const material = sample('properties');
  const lit = l.call('lighting.pbr', {
    baseColor: sample('baseColor').swizzle('rgb'),
    normal: geometry.swizzle('xyz'),
    roughness: material.swizzle('x'),
    metallic: material.swizzle('y'),
    occlusion: sample('occlusion').swizzle('x'),
    worldPosition: l.call(std.extend, {
      xyz: l.call('camera.positionFromDepth', {
        uv: at,
        viewDepth: geometry.swizzle('w'),
      }),
      w: 1,
    }),
  });
  l.fullscreen({
    color: l.call(std.select, {
      ifFalse: [...background, 1],
      ifTrue: l.call(std.extend, { xyz: lit.swizzle('rgb') }),
      condition: l.call(std.greater, { a: geometry.swizzle('w'), b: 0 }),
    }),
  });
  const lighting = new Material({
    graph: l.build(),
    values: {
      baseColorSampler: nearest,
      normalDepthSampler: nearest,
      propertiesSampler: nearest,
      occlusionSampler: nearest,
    },
  });

  // --- The output: the image encoded in sRGB, or a texture of the
  // G-buffer; the rectangle being dragged over it.
  const s = new GraphBuilder('output');
  const screen = s.builtin('screen-uv');
  const readOutput = (name: string) =>
    s.call(std.textureSample, {
      texture: s.texture(name),
      sampler: s.sampler(`${name}Sampler`),
      uv: screen,
    });
  const view = s.uniform('view', BuiltinTypes.f32);
  const choose = (value: number, ifTrue: PortHandle, ifFalse: PortHandle) =>
    s.call(std.select, {
      ifFalse,
      ifTrue,
      condition: s.call(std.greater, { a: view, b: value - 0.5 }),
    });
  const shown = choose(
    2,
    s.call(std.add, {
      a: s.call(std.mul, {
        a: readOutput('normalDepth').swizzle('xyz'),
        b: 0.5,
      }),
      b: 0.5,
    }),
    choose(
      1,
      readOutput('occlusion').swizzle('xxx'),
      s.call('color.linearToSrgb', {
        color: readOutput('hdr').swizzle('rgb'),
      }),
    ),
  );
  // The rectangle (left, top, right, bottom, in uv): a border of 1 pixel
  // and a light fill. Outside of the screen when nothing is dragged.
  const rectangle = s.uniform('rectangle', BuiltinTypes.vec4f, {
    default: [-1, -1, -1, -1],
  });
  const pixel = s.uniform('pixel', BuiltinTypes.vec2f);
  const inside = (low: PortHandle, high: PortHandle) => {
    const both = s.call(std.mul, {
      a: s.call(std.step, { edge: low, x: screen }),
      b: s.call(std.step, { edge: screen, x: high }),
    });
    return s.call(std.mul, { a: both.swizzle('x'), b: both.swizzle('y') });
  };
  const outer = inside(rectangle.swizzle('xy'), rectangle.swizzle('zw'));
  const inner = inside(
    s.call(std.add, { a: rectangle.swizzle('xy'), b: pixel }),
    s.call(std.sub, { a: rectangle.swizzle('zw'), b: pixel }),
  );
  const cover = s.call(std.add, {
    a: s.call(std.sub, { a: outer, b: inner }),
    b: s.call(std.mul, { a: inner, b: 0.2 }),
  });
  s.fullscreen({
    color: s.call(std.extend, {
      xyz: s.call(std.mix, { a: shown, b: [0.4, 0.7, 1], t: cover }),
    }),
  });
  const output = new Material({
    graph: s.build(),
    values: {
      hdrSampler: nearest,
      occlusionSampler: nearest,
      normalDepthSampler: nearest,
      view: 0,
    },
  });

  // --- The scene: a floor in the corner of two walls, pillars, boxes and
  // balls, a glass ball.
  const cube = createCube();
  const sphere = createSphere(32, 16);
  type Color = [number, number, number];
  interface SceneObject {
    readonly id?: number;
    readonly mesh: typeof cube;
    readonly transform: Transform;
    readonly color: Color;
    readonly gbuffer: Material;
    readonly lit: Material;
  }
  const objects: SceneObject[] = [];
  // The identifiers of the selectable objects, from 1 (0: none).
  let nextId = 1;
  const add = (
    mesh: typeof cube,
    position: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number },
    color: Color,
    { roughness = 0.6, metallic = 0, pickable = true } = {},
  ) => {
    const values = { baseColor: color, roughness, metallic };
    const object: SceneObject = {
      ...(pickable ? { id: nextId++ } : {}),
      mesh,
      transform: new Transform({ position, scale }),
      color,
      gbuffer: new Material({ graph: gbufferGraph, values }),
      lit: new Material({ graph: litGraph, values }),
    };
    objects.push(object);
    return object;
  };
  const room = { pickable: false, roughness: 0.8 };
  add(
    cube,
    { x: 0, y: -0.05, z: 0 },
    { x: 12, y: 0.1, z: 9 },
    [0.5, 0.5, 0.5],
    room,
  );
  add(
    cube,
    { x: 0, y: 2, z: -4.5 },
    { x: 12, y: 4, z: 0.2 },
    [0.7, 0.68, 0.65],
    room,
  );
  add(
    cube,
    { x: -6, y: 2, z: 0 },
    { x: 0.2, y: 4, z: 9 },
    [0.65, 0.68, 0.7],
    room,
  );
  for (let i = 0; i < 5; i++) {
    add(
      cube,
      { x: -4 + i * 2, y: 1.25, z: -3.6 },
      { x: 0.5, y: 2.5, z: 0.5 },
      [0.75, 0.7, 0.62],
      { roughness: 0.85 },
    );
  }
  // A pile of boxes in the corner, and others on the floor.
  const boxes: [number, number, number, number, Color][] = [
    [-5.2, 0.4, -3.7, 0.8, [0.85, 0.45, 0.2]],
    [-4.3, 0.35, -3.8, 0.7, [0.25, 0.55, 0.85]],
    [-5.2, 1.15, -3.7, 0.7, [0.85, 0.75, 0.3]],
    [-5.1, 0.3, -2.8, 0.6, [0.3, 0.7, 0.4]],
    [2.2, 0.35, 0.8, 0.7, [0.8, 0.3, 0.35]],
    [3.1, 0.3, 1.6, 0.6, [0.6, 0.4, 0.8]],
    [2.6, 1.0, 1.1, 0.6, [0.85, 0.85, 0.85]],
  ];
  const spinning: Transform[] = [];
  for (const [x, y, z, size, color] of boxes) {
    spinning.push(
      add(cube, { x, y, z }, { x: size, y: size, z: size }, color).transform,
    );
  }
  const balls: [number, number, Color, number, number][] = [
    [-2.4, -0.6, [1, 0.78, 0.34], 0.3, 1],
    [-1.2, 1.2, [0.2, 0.4, 0.9], 0.25, 0],
    [0, -1.4, [0.95, 0.95, 0.95], 0.15, 1],
    [1.2, -0.2, [0.9, 0.3, 0.2], 0.5, 0],
    [-3.4, 1.6, [0.3, 0.8, 0.6], 0.4, 0],
  ];
  for (const [x, z, color, roughness, metallic] of balls) {
    add(sphere, { x, y: 0.4, z }, { x: 0.8, y: 0.8, z: 0.8 }, color, {
      roughness,
      metallic,
    });
  }
  // Transparent: drawn in forward, over the lit G-buffer; not selectable
  // (the transparent items write no outputs).
  const glass: RenderItem = {
    mesh: sphere,
    material: new Material({
      graph: surfaceGraph(true, 0.35),
      values: { baseColor: [0.5, 0.9, 0.8], roughness: 0.1, metallic: 0 },
      renderState: { alphaMode: 'blend' },
    }),
    transform: new Transform({
      position: { x: 0.2, y: 0.7, z: 1.8 },
      scale: { x: 1.4, y: 1.4, z: 1.4 },
    }),
  };
  // The same objects with their two materials. The identifier goes with
  // the transform (the row of the object): both lists give it, or the
  // last pass drawn would clear it.
  const itemsWith = (material: (object: SceneObject) => Material) =>
    objects.map((object): RenderItem => ({
      mesh: object.mesh,
      material: material(object),
      transform: object.transform,
      ...(object.id !== undefined ? { id: object.id } : {}),
    }));
  const gbufferItems = itemsWith((object) => object.gbuffer);
  const litItems = [...itemsWith((object) => object.lit), glass];

  // The light: a sun casting shadows, enough ambient light for the
  // occlusion to show, and 12 lamps turning close to the floor.
  const sun = new DirectionalLight({
    direction: { x: 0.5, y: -1, z: -0.4 },
    ambient: { x: 0.3, y: 0.31, z: 0.34 },
    diffuse: { x: 0.6, y: 0.55, z: 0.5 },
    specular: { x: 0.6, y: 0.55, z: 0.5 },
    castShadow: true,
  });
  const lamps = [...Array(12)].map((_, i) => {
    const channel = (offset: number) =>
      0.5 + 0.5 * Math.cos(2 * Math.PI * (i / 12 + offset));
    const color = { x: channel(0), y: channel(1 / 3), z: channel(2 / 3) };
    return new PointLight({
      ambient: { x: 0, y: 0, z: 0 },
      diffuse: color,
      specular: color,
      constantAttenuation: 1,
      linearAttenuation: 0,
      quadraticAttenuation: 6,
    });
  });
  const lights = [sun, ...lamps];

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 60,
    },
  });
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  // --- The state.
  let deferred = options.deferred ?? true;
  let occlusionOn = true;
  let viewIndex = 0;
  let hover = 0;
  let selection = new Set<number>();
  const orbit = { yaw: 0.35, pitch: -0.5, distance: 9 };
  const pivot = { x: -0.5, y: 0.6, z: -0.5 };
  let destroyed = false;

  // The identifiers, of the size of the surface: created here to read them
  // back (copy-src).
  let ids: GpuTexture | undefined;
  const idTexture = () => {
    const { width, height } = surface;
    if (ids?.dimensions.width !== width || ids.dimensions.height !== height) {
      ids?.destroy();
      ids = backend.textures.createTexture({
        label: 'identifiers',
        type: '2d',
        format: 'r32uint',
        dimensions: { width, height },
        usage: ['render-attachment', 'copy-src'],
      });
    }
    return ids;
  };
  // One read of the hovered pixel at a time: the next one waits for it.
  let reading = false;
  let dragStart: { x: number; y: number } | undefined;
  const pick = async (
    region: Parameters<typeof pickIds>[2],
  ): Promise<number[]> => {
    if (!ids || destroyed) {
      return [];
    }
    try {
      return await pickIds(backend, ids, region);
    } catch {
      // The texture replaced (resized) or the scene gone meanwhile.
      return [];
    }
  };

  // The colors follow the selection: lighter when hovered, blue when
  // selected.
  const painted = new Map<number, string>();
  const paint = () => {
    for (const object of objects) {
      const id = object.id;
      if (id === undefined) {
        continue;
      }
      const state = selection.has(id)
        ? 'selected'
        : id === hover
          ? 'hover'
          : '';
      if (painted.get(id) === state) {
        continue;
      }
      painted.set(id, state);
      const [r, g, b] = object.color;
      const color: Color =
        state === 'selected'
          ? [0.15 + r * 0.15, 0.4 + g * 0.15, 1]
          : state === 'hover'
            ? [r * 0.5 + 0.5, g * 0.5 + 0.5, b * 0.5 + 0.4]
            : object.color;
      object.gbuffer.setValue('baseColor', color);
      object.lit.setValue('baseColor', color);
    }
  };

  const handleInput = () => {
    const k = input.keyboard;
    if (k.pressed('KeyD')) {
      deferred = !deferred;
    }
    if (k.pressed('KeyO')) {
      occlusionOn = !occlusionOn;
      ssao.setValue('strength', occlusionOn ? 1 : 0);
    }
    if (k.pressed('KeyV')) {
      viewIndex = (viewIndex + 1) % views.length;
    }
    views.forEach((_, i) => {
      if (k.pressed(`Digit${i + 1}`)) {
        viewIndex = i;
      }
    });
    if (k.pressed('KeyC')) {
      selection = new Set();
    }

    const pointer = input.pointer;
    // Right drag: the camera turns; the wheel: it comes closer.
    if (pointer.isDown(2)) {
      orbit.yaw -= pointer.dx * 4;
      orbit.pitch = Math.min(
        -0.05,
        Math.max(-1.4, orbit.pitch - pointer.dy * 3),
      );
    }
    orbit.distance = Math.min(
      25,
      Math.max(2, orbit.distance * 1.1 ** pointer.wheel),
    );

    // Left: a click selects the object under the pointer, a drag those in
    // the rectangle.
    const at = { x: pointer.x * surface.width, y: pointer.y * surface.height };
    if (pointer.pressed(0)) {
      dragStart = at;
    }
    if (pointer.released(0) && dragStart) {
      const from = dragStart;
      dragStart = undefined;
      const dragged = Math.abs(at.x - from.x) + Math.abs(at.y - from.y) > 4;
      void pick(
        dragged
          ? {
              x: from.x,
              y: from.y,
              width: at.x - from.x,
              height: at.y - from.y,
            }
          : at,
      ).then((picked) => {
        selection = new Set(picked);
      });
    } else if (pointer.moved && !reading) {
      reading = true;
      void pick(at).then(([id = 0]) => {
        hover = id;
        reading = false;
      });
    }
    output.setValue(
      'rectangle',
      dragStart
        ? [
            Math.min(dragStart.x, at.x) / surface.width,
            Math.min(dragStart.y, at.y) / surface.height,
            Math.max(dragStart.x, at.x) / surface.width,
            Math.max(dragStart.y, at.y) / surface.height,
          ]
        : [-1, -1, -1, -1],
    );
  };

  const updateCamera = () => {
    const { yaw, pitch, distance } = orbit;
    camera.position = {
      x: pivot.x + distance * Math.sin(yaw) * Math.cos(pitch),
      y: pivot.y - distance * Math.sin(pitch),
      z: pivot.z + distance * Math.cos(yaw) * Math.cos(pitch),
    };
    const q1 = axisAngle(0, 1, 0, yaw);
    const q2 = axisAngle(1, 0, 0, pitch);
    camera.rotation = {
      x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
      y: q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
      z: q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
      w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
    };
    followAspect(camera, surface);
    const projection = camera.projection;
    if (projection.type === 'perspective') {
      const f = 1 / Math.tan((projection.fov * Math.PI) / 360);
      ssao.setValue('projection', [f / projection.aspect, f]);
    }
  };

  const show = () =>
    context.info?.(
      `${deferred ? 'deferred' : 'forward'} (D) · occlusion ` +
        `${occlusionOn ? 'on' : 'off'} (O) · ${views[viewIndex]} (V) · ` +
        `hover ${hover || '—'} · selected ` +
        `${[...selection].sort((a, b) => a - b).join(', ') || '—'} (C)`,
    );

  return {
    frame: (time) => {
      input.update();
      handleInput();
      updateCamera();
      paint();
      show();
      spinning.forEach((transform, i) => {
        if (i >= 4) {
          transform.rotation = axisAngle(0, 1, 0, time * 0.4 + i);
        }
      });
      lamps.forEach((lamp, i) => {
        const angle = time * (0.25 + 0.05 * (i % 3)) + (i / 12) * 2 * Math.PI;
        const r = 1.5 + (2.5 * ((i * 5) % 12)) / 12;
        lamp.position = {
          x: -0.5 + r * Math.cos(angle),
          y: 0.3 + 0.2 * (i % 3),
          z: -0.5 + r * Math.sin(angle) * 0.8,
        };
      });
      blur.setValue('texel', [1 / surface.width, 1 / surface.height]);
      output
        .setValue('view', viewIndex)
        .setValue('pixel', [1 / surface.width, 1 / surface.height]);

      const graph = new RenderGraph();
      const id = {
        format: 'r32uint',
        value: 'object-id',
        target: graph.importTexture('identifiers', idTexture()),
      } as const;
      // 1. The G-buffer (deferred), or the normals and depths only (the
      // pre-pass of forward): what the occlusion reads, and the
      // identifiers.
      const prepass = deferred
        ? renderer.addScenePasses(graph, {
            items: gbufferItems,
            camera,
            lights,
            include: 'opaque',
            outputs: {
              baseColor: { format: 'rgba8unorm', value: 'base-color' },
              normalDepth: { format: 'rgba16float', value: normalDepth },
              properties: { format: 'rgba8unorm', value: properties },
              id,
            },
          })
        : renderer.addScenePasses(graph, {
            name: 'pre-pass',
            items: gbufferItems,
            camera,
            lights,
            include: 'opaque',
            shadows: false,
            outputs: {
              normalDepth: { format: 'rgba16float', value: normalDepth },
              id,
            },
          });
      const normals = prepass.outputs.normalDepth;
      // 2. The occlusion, blurred.
      const raw = renderer.addFullscreenPass(graph, 'ssao', {
        material: ssao,
        inputs: { normalDepth: normals },
        target: graph.createTexture('raw occlusion', { format: 'r8unorm' }),
        format: 'r8unorm',
      });
      const occlusion = renderer.addFullscreenPass(graph, 'ssao blur', {
        material: blur,
        inputs: { occlusion: raw },
        target: graph.createTexture('occlusion', { format: 'r8unorm' }),
        format: 'r8unorm',
      });
      // 3. The lit image.
      let color: TextureHandle;
      if (deferred) {
        const outputs = prepass.outputs as Record<string, TextureHandle>;
        const litImage = renderer.addFullscreenPass(graph, 'lighting', {
          material: lighting,
          inputs: {
            baseColor: outputs['baseColor'],
            normalDepth: normals,
            properties: outputs['properties'],
            occlusion,
          },
          ...(prepass.shadows ? { shadows: prepass.shadows } : {}),
          target: graph.createTexture('color', { format: 'rgba16float' }),
          format: 'rgba16float',
        });
        // The transparent ball over it, tested against the G-buffer depth.
        color =
          renderer.addScenePasses(graph, {
            name: 'transparent',
            items: litItems,
            camera,
            lights,
            include: 'transparent',
            shadows: false,
            depth: prepass.depth,
            target: litImage,
            format: 'rgba16float',
            load: 'load',
            linear: true,
            inputs: { occlusion },
          }).color ?? litImage;
      } else {
        // Every object lit as it is drawn, reading its occlusion.
        const target = graph.createTexture('color', { format: 'rgba16float' });
        color =
          renderer.addScenePasses(graph, {
            items: litItems,
            camera,
            lights,
            target,
            format: 'rgba16float',
            linear: true,
            clearColor: {
              r: background[0],
              g: background[1],
              b: background[2],
              a: 1,
            },
            inputs: { occlusion },
          }).color ?? target;
      }
      // 4. Into the surface.
      renderer.addFullscreenPass(graph, 'output', {
        material: output,
        inputs: { hdr: color, occlusion, normalDepth: normals },
        target: graph.importTexture('surface', surface.getCurrentTarget()),
        format: surface.format,
      });
      runner.execute(graph);
      surface.present();
    },
    destroy: () => {
      destroyed = true;
      input.dispose();
      ids?.destroy();
      cube.destroy();
      sphere.destroy();
      renderer.destroy();
    },
  };
}
