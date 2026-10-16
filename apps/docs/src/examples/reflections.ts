import {
  Camera,
  DirectionalLight,
  Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  TextureHandle,
  Transform,
} from '@fdw/engine-core';
import { fullMipLevelCount } from '@fdw/engine-backend';
import {
  BuiltinTypes,
  defineFunction,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Three kinds of reflections. Chrome balls reflect an environment map (a
// cube texture), blurrier as they get rougher. The floor reflects the
// scene: click to switch between a matte floor, a planar mirror (the scene
// rendered a second time, seen from below the floor) and screen space
// reflections (the image itself, followed along the reflected rays).
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // --- The environment: a sky and a checkered ground, computed for each
  // texel of the six faces of a cube texture, with its mipmaps.
  const faceSize = 64;
  const faces = new Uint8Array(faceSize * faceSize * 4 * 6);
  const sun = [0.5, 0.6, -0.6];
  const sunLength = Math.hypot(...sun);
  // The direction of a texel of a face, from its coordinates in [-1, 1]
  // (the convention of WebGPU, Vulkan and OpenGL alike).
  const directions = [
    (u: number, v: number) => [1, -v, -u],
    (u: number, v: number) => [-1, -v, u],
    (u: number, v: number) => [u, 1, v],
    (u: number, v: number) => [u, -1, -v],
    (u: number, v: number) => [u, -v, 1],
    (u: number, v: number) => [-u, -v, -1],
  ];
  const sky = ([x, y, z]: number[]): number[] => {
    const length = Math.hypot(x, y, z);
    [x, y, z] = [x / length, y / length, z / length];
    if (y >= 0) {
      const sunDot = (x * sun[0] + y * sun[1] + z * sun[2]) / sunLength;
      if (sunDot > 0.995) {
        return [1, 0.95, 0.8];
      }
      const t = Math.sqrt(y);
      const glow = Math.max(sunDot, 0) ** 32 * 0.4;
      return [
        0.75 - 0.5 * t + glow,
        0.85 - 0.4 * t + glow,
        0.95 - 0.15 * t + glow * 0.5,
      ];
    }
    // The ground, a checker of 1 unit seen from 1 above.
    const cell =
      (Math.floor(x / -y) + Math.floor(z / -y)) % 2 === 0 ? 0.35 : 0.25;
    return [cell, cell * 0.9, cell * 0.8];
  };
  directions.forEach((direction, face) => {
    for (let y = 0; y < faceSize; y++) {
      for (let x = 0; x < faceSize; x++) {
        const u = ((x + 0.5) / faceSize) * 2 - 1;
        const v = ((y + 0.5) / faceSize) * 2 - 1;
        const color = sky(direction(u, v));
        faces.set(
          [
            ...color.map((c) => Math.round(Math.min(c, 1) ** (1 / 2.2) * 255)),
            255,
          ],
          ((face * faceSize + y) * faceSize + x) * 4,
        );
      }
    }
  });
  const levels = fullMipLevelCount({ width: faceSize });
  const environment = backend.textures.createTexture({
    type: 'cube',
    format: 'rgba8unorm-srgb',
    dimensions: { width: faceSize, height: faceSize, layers: 6 },
    mipLevelCount: levels,
    source: faces,
  });
  const environmentSampler = backend.textures.createSampler({
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  });
  const nearest = backend.textures.createSampler({
    minFilter: 'nearest',
    magFilter: 'nearest',
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  });
  const linear = backend.textures.createSampler({
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  });

  // The texture and sampler nodes of a graph, by name: declared once,
  // read as often as needed.
  const declared = new WeakMap<GraphBuilder, Map<string, PortHandle[]>>();
  const binding = (g: GraphBuilder, name: string, cube = false) => {
    let names = declared.get(g);
    if (!names) {
      names = new Map();
      declared.set(g, names);
    }
    let found = names.get(name);
    if (!found) {
      found = [
        g.texture(name, cube ? { dimension: 'cube' } : {}),
        g.sampler(`${name}Sampler`),
      ];
      names.set(name, found);
    }
    return { texture: found[0], sampler: found[1] };
  };
  const read = (g: GraphBuilder, name: string, uv: PortHandle) =>
    g.call(std.textureSample, { ...binding(g, name), uv });

  // The environment seen in a direction, blurrier at higher levels.
  const sampleEnvironment = (
    g: GraphBuilder,
    direction: PortHandle,
    level: PortHandle | number = 0,
  ) =>
    g
      .call(std.textureSampleCubeLevel, {
        ...binding(g, 'environment', true),
        direction,
        level,
      })
      .swizzle('rgb');

  // The position and the normal of a surface in the world, per fragment.
  const worldPosition = (g: GraphBuilder) =>
    g
      .call(std.perFragment, {
        value: g.call(std.transform, {
          matrix: g.engine('object.world'),
          vector: g.call(std.extend, {
            xyz: g.attribute('position', BuiltinTypes.vec3f),
          }),
        }),
      })
      .swizzle('xyz');
  const worldNormal = (g: GraphBuilder) =>
    g.call(std.normalize, {
      x: g.call(std.perFragment, {
        value: g.call(std.transform3, {
          matrix: g.engine('object.normalMatrix'),
          vector: g.attribute('normal', BuiltinTypes.vec3f),
        }),
      }),
    });

  // --- Chrome: the environment in the reflected direction, at a level of
  // detail that grows with the roughness.
  const c = new GraphBuilder('chrome');
  const view = c.call(std.sub, {
    a: worldPosition(c),
    b: c.engine('camera.position'),
  });
  const reflected = c.call(std.reflect, {
    incident: c.call(std.normalize, { x: view }),
    normal: worldNormal(c),
  });
  const roughness = c.uniform('roughness', BuiltinTypes.f32);
  c.surface({
    shadingModel: 'unlit',
    baseColor: c.call(std.mul, {
      a: sampleEnvironment(
        c,
        reflected,
        c.call(std.mul, { a: roughness, b: levels - 1 }),
      ),
      b: [0.95, 0.93, 0.88],
    }),
  });
  const chromeGraph = c.build();
  const environmentValues = { environment, environmentSampler };

  // --- The floors: a checker, darkened where it reflects.
  const reflectivity = 0.5;
  const floor = (kind: 'matte' | 'mirror' | 'screen space') => {
    const g = new GraphBuilder(`${kind} floor`);
    const position = worldPosition(g);
    const checker = g.call(std.step, {
      edge: 0.5,
      x: g.call(std.fract, {
        x: g.call(std.mul, {
          a: g.call(std.add, {
            a: g.call(std.floor, { x: position.swizzle('x') }),
            b: g.call(std.floor, { x: position.swizzle('z') }),
          }),
          b: 0.5,
        }),
      }),
    });
    const base = g.call(std.mix, {
      a: [0.5, 0.48, 0.45],
      b: [0.2, 0.2, 0.22],
      t: checker,
    });
    let emissive: PortHandle | undefined;
    if (kind === 'mirror') {
      // The mirror image, at the position of the pixel on the screen; it
      // was rendered upside down (see the mirrored camera).
      const clip = g.call(std.perFragment, {
        value: g.call(std.transform, {
          matrix: g.engine('camera.viewProjection'),
          vector: g.call(std.extend, { xyz: position }),
        }),
      });
      const uv = g.call(std.add, {
        a: g.call(std.mul, {
          a: g.call(std.div, { a: clip.swizzle('xy'), b: clip.swizzle('w') }),
          b: 0.5,
        }),
        b: 0.5,
      });
      emissive = g.call(std.mul, {
        a: read(g, 'mirror', uv).swizzle('rgb'),
        b: reflectivity,
      });
    }
    if (kind === 'screen space') {
      // Written in the 'reflectivity' output of the scene passes, for the
      // screen space reflections pass.
      g.output('reflectivity', reflectivity);
    }
    g.surface({
      shadingModel: 'phong',
      baseColor: g.call(std.mul, {
        a: base,
        b: kind === 'matte' ? 1 : 1 - reflectivity,
      }),
      specular: [0.2, 0.2, 0.2],
      ...(emissive ? { emissive } : {}),
    });
    return new Material({
      graph: g.build(),
      values: kind === 'mirror' ? { mirrorSampler: linear } : {},
    });
  };
  const floors = [floor('matte'), floor('mirror'), floor('screen space')];

  // --- The G-buffer of the composition: the world normal and the depth.
  const n = new GraphBuilder('normal and depth');
  n.functionOutput(
    'value',
    n.call(std.extend, {
      xyz: n.functionInput('worldNormal', BuiltinTypes.vec3f),
      w: n.functionInput('viewDepth', BuiltinTypes.f32),
    }),
  );
  const normalDepth = defineFunction(n.build(), { id: 'example.normalDepth' });

  // --- The sky behind the objects: where the depth is 0, the environment
  // in the direction of the pixel.
  const withSky = (g: GraphBuilder, color: PortHandle, depth: PortHandle) => {
    const uv = g.builtin('screen-uv');
    const direction = g.call(std.sub, {
      a: g.call('camera.positionFromDepth', { uv, viewDepth: 1 }),
      b: g.engine('camera.position'),
    });
    return g.call(std.select, {
      ifFalse: sampleEnvironment(g, direction),
      ifTrue: color,
      condition: g.call(std.greater, { a: depth, b: 0 }),
    });
  };
  // The mirror image with its sky, in linear colors.
  const m = new GraphBuilder('mirror sky');
  const mirrorUv = m.builtin('screen-uv');
  m.fullscreen({
    color: m.call(std.extend, {
      xyz: withSky(
        m,
        read(m, 'color', mirrorUv).swizzle('rgb'),
        read(m, 'normalDepth', mirrorUv).swizzle('w'),
      ),
    }),
  });
  const mirrorSky = new Material({
    graph: m.build(),
    values: {
      ...environmentValues,
      colorSampler: nearest,
      normalDepthSampler: nearest,
    },
  });

  // --- The composition: the sky, the screen space reflections, then the
  // encoding for the screen.
  const r = new GraphBuilder('compose');
  const uv = r.builtin('screen-uv');
  const geometry = read(r, 'normalDepth', uv);
  const depth = geometry.swizzle('w');
  const color = read(r, 'color', uv).swizzle('rgb');
  const strength = read(r, 'reflectivity', uv).swizzle('x');
  // The point of the pixel and the reflected ray, in the world.
  const position = r.call('camera.positionFromDepth', { uv, viewDepth: depth });
  const ray = r.call(std.reflect, {
    incident: r.call(std.normalize, {
      x: r.call(std.sub, { a: position, b: r.engine('camera.position') }),
    }),
    normal: r.call(std.normalize, { x: geometry.swizzle('xyz') }),
  });
  // A point along the ray, at a distance t: where it is on the screen, and
  // whether it is inside an object there: behind the depth of its front
  // faces (the image), in front of the depth of its back faces.
  const probe = (t: PortHandle | number) => {
    const point = r.call(std.add, {
      a: position,
      b: r.call(std.mul, { a: ray, b: t }),
    });
    const clip = r.call(std.transform, {
      matrix: r.engine('camera.viewProjection'),
      vector: r.call(std.extend, { xyz: point }),
    });
    const pointUv = r.call(std.add, {
      a: r.call(std.mul, {
        a: r.call(std.div, { a: clip.swizzle('xy'), b: clip.swizzle('w') }),
        b: [0.5, -0.5],
      }),
      b: 0.5,
    });
    // The depth of the point along the axis of the camera.
    const pointDepth = r.call(std.mul, {
      a: r
        .call(std.transform, {
          matrix: r.engine('camera.view'),
          vector: r.call(std.extend, { xyz: point }),
        })
        .swizzle('z'),
      b: -1,
    });
    const front = read(r, 'normalDepth', pointUv).swizzle('w');
    const back = read(r, 'backDepth', pointUv).swizzle('w');
    // 1 when all hold: behind the front faces, in front of the back faces
    // (with a margin for the precision of the depths); an object there
    // (depth > 0); on the screen.
    const conditions = [
      r.call(std.step, {
        edge: r.call(std.add, { a: front, b: 0.005 }),
        x: pointDepth,
      }),
      r.call(std.step, {
        edge: pointDepth,
        x: r.call(std.add, { a: back, b: 0.05 }),
      }),
      r.call(std.step, { edge: 0.0001, x: front }),
      r.call(std.step, { edge: 0, x: pointUv.swizzle('x') }),
      r.call(std.step, { edge: pointUv.swizzle('x'), x: 1 }),
      r.call(std.step, { edge: 0, x: pointUv.swizzle('y') }),
      r.call(std.step, { edge: pointUv.swizzle('y'), x: 1 }),
    ];
    return {
      uv: pointUv,
      inside: conditions.reduce((a, b) => r.call(std.mul, { a, b })),
    };
  };
  // Points along the ray, projected on the screen: the first one inside an
  // object is what the ray meets. A ray passing behind an object is behind
  // its back faces too: it goes on. The graph has no loops: the steps are
  // written one by one.
  const steps = 40;
  const stepLength = 0.1;
  const hits = Array.from({ length: steps }, (_, i) => ({
    t: (i + 1) * stepLength,
    ...probe((i + 1) * stepLength),
  }));
  // The first hit: chosen from the last step to the first.
  let hitUv: PortHandle = hits[steps - 1].uv;
  let far: PortHandle | number = hits[steps - 1].t;
  let found: PortHandle | number = 0;
  for (let i = steps - 1; i >= 0; i--) {
    const isHit = r.call(std.greater, { a: hits[i].inside, b: 0.5 });
    hitUv = r.call(std.select, {
      ifFalse: hitUv,
      ifTrue: hits[i].uv,
      condition: isHit,
    });
    far = r.call(std.select, {
      ifFalse: far,
      ifTrue: hits[i].t,
      condition: isHit,
    });
    found = r.call(std.max, { a: found, b: hits[i].inside });
  }
  // The hit lies between the step before (outside) and the step found
  // (inside): halved a few times, it lands on the surface instead of on
  // the steps, which drew bands.
  let near: PortHandle = r.call(std.sub, { a: far, b: stepLength });
  for (let i = 0; i < 6; i++) {
    const middle = r.call(std.mul, {
      a: r.call(std.add, { a: near, b: far }),
      b: 0.5,
    });
    const point = probe(middle);
    const inside = r.call(std.greater, { a: point.inside, b: 0.5 });
    hitUv = r.call(std.select, {
      ifFalse: hitUv,
      ifTrue: point.uv,
      condition: inside,
    });
    far = r.call(std.select, {
      ifFalse: far,
      ifTrue: middle,
      condition: inside,
    });
    near = r.call(std.select, {
      ifFalse: middle,
      ifTrue: near,
      condition: inside,
    });
  }
  // What the ray meets in the image, else the environment.
  const reflection = r.call(std.mix, {
    a: sampleEnvironment(r, ray),
    b: read(r, 'color', hitUv).swizzle('rgb'),
    t: found,
  });
  const reflectedColor = r.call(std.add, {
    a: color,
    b: r.call(std.mul, { a: reflection, b: strength }),
  });
  r.fullscreen({
    color: r.call(std.extend, {
      xyz: r.call('color.linearToSrgb', {
        color: withSky(r, reflectedColor, depth),
      }),
    }),
  });
  const compose = new Material({
    graph: r.build(),
    values: {
      ...environmentValues,
      colorSampler: linear,
      normalDepthSampler: nearest,
      reflectivitySampler: nearest,
      backDepthSampler: nearest,
    },
  });

  // --- The scene: chrome balls of growing roughness, two boxes, a floor.
  const sphere = createSphere(48, 24);
  const cube = createCube();
  const balls = [0, 0.25, 0.5, 0.75].map((value, i) => ({
    mesh: sphere,
    material: new Material({
      graph: chromeGraph,
      values: { ...environmentValues, roughness: value },
    }),
    transform: new Transform({
      position: { x: -2.1 + i * 1.4, y: 0.6, z: 0 },
      scale: { x: 1.1, y: 1.1, z: 1.1 },
    }),
  }));
  const box = (color: [number, number, number], x: number, z: number) => {
    const g = new GraphBuilder('box');
    g.surface({ shadingModel: 'phong', baseColor: color });
    return {
      mesh: cube,
      material: new Material({ graph: g.build() }),
      transform: new Transform({
        position: { x, y: 0.5, z },
        scale: { x: 0.8, y: 1, z: 0.8 },
      }),
    };
  };
  const objects = [
    ...balls,
    box([0.9, 0.3, 0.2], -1.2, -1.8),
    box([0.2, 0.6, 0.9], 1.6, -1.6),
  ];
  const ground = {
    mesh: cube,
    material: floors[0],
    transform: new Transform({
      // The top face at y = 0: the plane of the mirror.
      position: { x: 0, y: -0.05, z: 0 },
      scale: { x: 10, y: 0.1, z: 8 },
    }),
  };
  const items = [...objects, ground];

  const light = new DirectionalLight({
    direction: { x: -0.5, y: -0.6, z: 0.6 },
    ambient: { x: 0.35, y: 0.38, z: 0.45 },
    diffuse: { x: 0.9, y: 0.85, z: 0.75 },
  });
  const projection = {
    type: 'perspective',
    fov: 45,
    aspect: 16 / 9,
    near: 0.1,
    far: 50,
  } as const;
  const camera = new Camera({ projection });
  // The camera seen in the floor (the plane y = 0): below it, turned the
  // other way up and down. Its image is the mirror image upside down.
  const mirrored = new Camera({ projection });
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  const modes = ['matte floor', 'planar mirror', 'screen space reflections'];
  let current = 0;
  const show = () => info(`${modes[current]} (click to switch)`);
  show();
  canvas.addEventListener('click', () => {
    current = (current + 1) % modes.length;
    ground.material = floors[current];
    show();
  });

  onFrame((time) => {
    const yaw = 0.35 * Math.sin(time * 0.25);
    const pitch = -0.32;
    camera.position = {
      x: 6.5 * Math.sin(yaw),
      y: 2.4,
      z: 6.5 * Math.cos(yaw),
    };
    const q1 = axisAngle(0, 1, 0, yaw);
    const q2 = axisAngle(1, 0, 0, pitch);
    const rotation = {
      x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
      y: q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
      z: q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
      w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
    };
    camera.rotation = rotation;
    // Mirrored by the plane y = 0: y of the position, x and z of the
    // rotation change sign.
    const { x, y, z } = camera.position;
    mirrored.position = { x, y: -y, z };
    mirrored.rotation = {
      x: -rotation.x,
      y: rotation.y,
      z: -rotation.z,
      w: rotation.w,
    };

    const target = surface.getCurrentTarget();
    const graph = new RenderGraph();
    const outputs = {
      normalDepth: { format: 'rgba16float', value: normalDepth },
      reflectivity: { format: 'r8unorm', value: 'material', default: 0 },
    } as const;
    let inputs: Record<string, TextureHandle> = {};
    if (current === 1) {
      // 1. The mirror image: the objects (not the floor), seen from the
      // mirrored camera, with the sky.
      const reflection = renderer.addScenePasses(graph, {
        name: 'mirror',
        items: objects,
        camera: mirrored,
        lights: [light],
        target: graph.createTexture('mirror color', { format: 'rgba16float' }),
        format: 'rgba16float',
        linear: true,
        outputs: { normalDepth: outputs.normalDepth },
      });
      const mirror = renderer.addFullscreenPass(graph, 'mirror sky', {
        material: mirrorSky,
        inputs: {
          color: reflection.color,
          normalDepth: reflection.outputs.normalDepth,
        },
        target: graph.createTexture('mirror image', { format: 'rgba16float' }),
        format: 'rgba16float',
      });
      // Read by the material of the floor.
      inputs = { mirror };
    }
    // 2. The depth of the back faces of the objects (in the 'w' of the
    // same function): how thick they are, for the screen space reflections.
    const back = renderer.addScenePasses(graph, {
      name: 'back faces',
      items,
      camera,
      faces: 'back',
      shadows: false,
      outputs: { backDepth: outputs.normalDepth },
    });
    // 3. The scene, in linear colors, with its G-buffer.
    const scene = renderer.addScenePasses(graph, {
      items,
      camera,
      lights: [light],
      target: graph.createTexture('color', { format: 'rgba16float' }),
      format: 'rgba16float',
      linear: true,
      outputs,
      inputs,
    });
    // 4. The sky, the screen space reflections, the encoding.
    renderer.addFullscreenPass(graph, 'compose', {
      material: compose,
      inputs: {
        color: scene.color,
        normalDepth: scene.outputs.normalDepth,
        reflectivity: scene.outputs.reflectivity,
        backDepth: back.outputs.backDepth,
      },
      target: graph.importTexture('surface', target),
      format: surface.format,
    });
    runner.execute(graph);
    surface.present();
  });
};

export default example;
