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
import { FakeInputSource, Input } from '@fdw/engine-input';
import { axisAngle, createCube, createSphere } from './geometry';
import { followAspect, SceneFactory } from './scene';

// A lab for the screen space reflections: the scene of the reflections
// tutorial, a camera to turn around it, the parameters of the search and
// views of what it finds. The planar mirror is the reference: what the
// reflections should look like.
//
// Mouse: drag to turn, wheel to zoom. Keys:
// - M: matte floor, planar mirror, screen space reflections.
// - T: the method: the back faces (a hit between the depths of the front
//   and back faces), the crossings (halved, then tested on the jump of
//   depth) or a thickness (behind the image by less than it, at a step).
// - 1 to 5: the image, the reflection alone, what the rays find (green: a
//   surface; cyan: just behind an object, its color taken; blue: rejected,
//   the ray passes behind an object; red: nothing),
//   the distance of the hit, the residue (how far behind the image the
//   first crossing ends after the halvings).
// - [ ]: fewer or more steps. ; ': shorter or longer steps.
// - , .: thinner or thicker (the thickness, or the largest jump of depth
//   of a hit). O P: less or more of the slope of the depth in that jump.
//   K L: thinner or thicker behind the objects (crossings).
//   R: the halvings on or off.

export interface SsrParameters {
  steps: number;
  stepLength: number;
  // The thickness: scale × how much deeper the ray goes in one step + bias.
  thicknessScale: number;
  thicknessBias: number;
  refinements: number;
  method: 'thickness' | 'crossings' | 'back faces';
  // The crossings: the largest depth behind the image after the halvings
  // for a hit; more is the edge of an object the ray passes behind.
  gap: number;
  // The crossings: up to how far behind the edge of an object a ray passing
  // behind it takes its color, when nothing else is met.
  behindThickness: number;
  // The crossings: the largest depth behind the image for a hit grows with
  // the slope of the depth around the point (pixels × this).
  slopeScale: number;
}

export const defaultSsrParameters: SsrParameters = {
  steps: 40,
  stepLength: 0.1,
  thicknessScale: 2,
  thicknessBias: 0.15,
  refinements: 6,
  method: 'back faces',
  gap: 0.05,
  behindThickness: 0,
  slopeScale: 2,
};

const views = [
  'image',
  'reflection',
  'hits (green) / behind (blue) / none (red)',
  'distance of the hit',
  'residue of the halvings',
];
const methods: SsrParameters['method'][] = [
  'back faces',
  'crossings',
  'thickness',
];
const modes = ['matte floor', 'planar mirror', 'screen space reflections'];

export const createSsrScene: SceneFactory = (
  backend,
  surface,
  context = {},
) => {
  const input = new Input(context.input ?? new FakeInputSource());
  const parameters = { ...defaultSsrParameters };

  // --- The environment: a sky and a checkered ground, on a cube texture.
  const faceSize = 64;
  const faces = new Uint8Array(faceSize * faceSize * 4 * 6);
  const sun = [0.5, 0.6, -0.6];
  const sunLength = Math.hypot(...sun);
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
  const environmentValues = { environment, environmentSampler };

  // The texture and sampler nodes of a graph, by name.
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

  // --- Chrome.
  const c = new GraphBuilder('chrome');
  const reflectedView = c.call(std.reflect, {
    incident: c.call(std.normalize, {
      x: c.call(std.sub, {
        a: worldPosition(c),
        b: c.engine('camera.position'),
      }),
    }),
    normal: worldNormal(c),
  });
  c.surface({
    shadingModel: 'unlit',
    baseColor: c.call(std.mul, {
      a: sampleEnvironment(
        c,
        reflectedView,
        c.call(std.mul, {
          a: c.uniform('roughness', BuiltinTypes.f32),
          b: levels - 1,
        }),
      ),
      b: [0.95, 0.93, 0.88],
    }),
  });
  const chromeGraph = c.build();

  // --- The floors.
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

  // --- The G-buffer: the world normal and the view depth.
  const n = new GraphBuilder('normal and depth');
  n.functionOutput(
    'value',
    n.call(std.extend, {
      xyz: n.functionInput('worldNormal', BuiltinTypes.vec3f),
      w: n.functionInput('viewDepth', BuiltinTypes.f32),
    }),
  );
  const normalDepth = defineFunction(n.build(), { id: 'ssr.normalDepth' });

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

  // --- The composition, rebuilt when a parameter written in the graph
  // changes (the numbers of steps and of halvings, the method); the
  // lengths are uniforms.
  const buildCompose = ({ steps, refinements, method }: SsrParameters) => {
    const r = new GraphBuilder('ssr compose');
    const uv = r.builtin('screen-uv');
    const geometry = read(r, 'normalDepth', uv);
    const depth = geometry.swizzle('w');
    const color = read(r, 'color', uv).swizzle('rgb');
    const strength = read(r, 'reflectivity', uv).swizzle('x');
    const stepLength = r.uniform('stepLength', BuiltinTypes.f32);
    const thicknessScale = r.uniform('thicknessScale', BuiltinTypes.f32);
    const thicknessBias = r.uniform('thicknessBias', BuiltinTypes.f32);
    const gap = r.uniform('gap', BuiltinTypes.f32);
    const behindThickness = r.uniform('behindThickness', BuiltinTypes.f32);
    const slopeScale = r.uniform('slopeScale', BuiltinTypes.f32);
    const texel = r.uniform('texel', BuiltinTypes.vec2f);
    const view = r.uniform('view', BuiltinTypes.f32);
    const position = r.call('camera.positionFromDepth', {
      uv,
      viewDepth: depth,
    });
    const ray = r.call(std.reflect, {
      incident: r.call(std.normalize, {
        x: r.call(std.sub, { a: position, b: r.engine('camera.position') }),
      }),
      normal: r.call(std.normalize, { x: geometry.swizzle('xyz') }),
    });
    const and = (values: (PortHandle | number)[]) =>
      values.reduce((a, b) => r.call(std.mul, { a, b })) as PortHandle;
    const not = (value: PortHandle) => r.call(std.sub, { a: 1, b: value });
    const choose = (
      condition: PortHandle,
      ifTrue: PortHandle | number | number[],
      ifFalse: PortHandle | number | number[],
    ) =>
      r.call(std.select, {
        ifFalse,
        ifTrue,
        condition: r.call(std.greater, { a: condition, b: 0.5 }),
      });
    // A point of the ray at a distance t: where it is on the screen, how far
    // it is behind the depth of the image there, and whether there is an
    // object there, on the screen.
    const probe = (t: PortHandle) => {
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
      const pointDepth = r.call(std.mul, {
        a: r
          .call(std.transform, {
            matrix: r.engine('camera.view'),
            vector: r.call(std.extend, { xyz: point }),
          })
          .swizzle('z'),
        b: -1,
      });
      const sceneDepth = read(r, 'normalDepth', pointUv).swizzle('w');
      const backDepth = read(r, 'backDepth', pointUv).swizzle('w');
      return {
        uv: pointUv,
        behind: r.call(std.sub, { a: pointDepth, b: sceneDepth }),
        // In front of the back faces there: inside the object.
        beforeBack: r.call(std.step, {
          edge: pointDepth,
          x: r.call(std.add, { a: backDepth, b: gap }),
        }),
        valid: and([
          r.call(std.step, { edge: 0.0001, x: sceneDepth }),
          r.call(std.step, { edge: 0, x: pointUv.swizzle('x') }),
          r.call(std.step, { edge: pointUv.swizzle('x'), x: 1 }),
          r.call(std.step, { edge: 0, x: pointUv.swizzle('y') }),
          r.call(std.step, { edge: pointUv.swizzle('y'), x: 1 }),
        ]),
      };
    };
    const marched = Array.from({ length: steps }, (_, i) => {
      const t = r.call(std.mul, { a: stepLength, b: i + 1 });
      return { t, ...probe(t) };
    });
    // The halvings between a distance t - stepLength (in front of the
    // image) and t (behind it): the last point behind the image, and how
    // far behind it is.
    // How much the depth of the image changes from a pixel to the next
    // around a point, on the side of the surface: of the two neighbors on
    // an axis, the closer depth (the other may be across an edge).
    const slope = (at: PortHandle) => {
      const center = read(r, 'normalDepth', at).swizzle('w');
      const side = (offset: PortHandle) =>
        r.call(std.abs, {
          x: r.call(std.sub, {
            a: read(
              r,
              'normalDepth',
              r.call(std.add, { a: at, b: offset }),
            ).swizzle('w'),
            b: center,
          }),
        });
      const axis = (offset: PortHandle) =>
        r.call(std.min, {
          a: side(offset),
          b: side(r.call(std.mul, { a: offset, b: -1 })),
        });
      return r.call(std.max, {
        a: axis(r.call(std.mul, { a: texel, b: [1, 0] })),
        b: axis(r.call(std.mul, { a: texel, b: [0, 1] })),
      });
    };
    // A point between the front and the back faces of an object.
    const inside = (point: ReturnType<typeof probe>) =>
      and([
        point.valid,
        r.call(std.step, { edge: 0.005, x: point.behind }),
        point.beforeBack,
      ]);
    const refine = (
      t: PortHandle,
      uv0: PortHandle,
      behind0: PortHandle,
      test = (point: ReturnType<typeof probe>) =>
        r.call(std.step, { edge: 0.000001, x: point.behind }),
    ) => {
      let near: PortHandle = r.call(std.sub, { a: t, b: stepLength });
      let far = t;
      let farUv = uv0;
      let farBehind = behind0;
      for (let i = 0; i < refinements; i++) {
        const middle = r.call(std.mul, {
          a: r.call(std.add, { a: near, b: far }),
          b: 0.5,
        });
        const point = probe(middle);
        const behind = r.call(std.greater, { a: test(point), b: 0.5 });
        farUv = r.call(std.select, {
          ifFalse: farUv,
          ifTrue: point.uv,
          condition: behind,
        });
        farBehind = r.call(std.select, {
          ifFalse: farBehind,
          ifTrue: point.behind,
          condition: behind,
        });
        far = r.call(std.select, {
          ifFalse: far,
          ifTrue: middle,
          condition: behind,
        });
        near = r.call(std.select, {
          ifFalse: middle,
          ifTrue: near,
          condition: behind,
        });
      }
      return { t: far, uv: farUv, behind: farBehind };
    };
    // The first step of the ray (from the last one to the first) where a
    // condition holds.
    const first = (condition: (i: number) => PortHandle) => {
      let t: PortHandle = marched[steps - 1].t;
      let uvFound: PortHandle = marched[steps - 1].uv;
      let behind: PortHandle = marched[steps - 1].behind;
      let found: PortHandle | number = 0;
      for (let i = steps - 1; i >= 0; i--) {
        const holds = condition(i);
        t = choose(holds, marched[i].t, t);
        uvFound = choose(holds, marched[i].uv, uvFound);
        behind = choose(holds, marched[i].behind, behind);
        found = r.call(std.max, { a: found, b: holds });
      }
      return { t, uv: uvFound, behind, found };
    };

    // What each method finds: a point on the screen (found), or a crossing
    // rejected (the ray passes behind an object), and the distance.
    let hitUv: PortHandle;
    let found: PortHandle;
    let rejected: PortHandle;
    let hitT: PortHandle;
    let residue: PortHandle;
    // A surface met, not a guess behind an object.
    let surface: PortHandle;
    if (method === 'back faces') {
      // The first step inside an object, between the depth of its front
      // faces and of its back faces: a ray passing behind an object is
      // behind its back faces too. No thickness to guess, for closed
      // objects; an object hidden behind another is not known.
      const hit = first((i) => inside(marched[i]));
      const refined = refine(hit.t, hit.uv, hit.behind, inside);
      hitUv = refinements > 0 ? refined.uv : hit.uv;
      hitT = refined.t;
      residue = refined.behind;
      found = hit.found as PortHandle;
      surface = found;
      rejected = r.call(std.mul, {
        a: not(found),
        b: first((i) =>
          r.call(std.mul, {
            a: marched[i].valid,
            b: r.call(std.step, { edge: 0.005, x: marched[i].behind }),
          }),
        ).found as PortHandle,
      });
    } else if (method === 'thickness') {
      // The first step behind the image by less than a thickness: whether
      // it is accepted depends on where the step falls.
      const stepDepth = r.call(std.abs, {
        x: r
          .call(std.transform, {
            matrix: r.engine('camera.view'),
            vector: r.call(std.extend, { xyz: ray, w: 0 }),
          })
          .swizzle('z'),
      });
      const thickness = r.call(std.add, {
        a: r.call(std.mul, {
          a: stepDepth,
          b: r.call(std.mul, { a: stepLength, b: thicknessScale }),
        }),
        b: thicknessBias,
      });
      const behindAt = (i: number) =>
        r.call(std.mul, {
          a: marched[i].valid,
          b: r.call(std.step, { edge: 0.01, x: marched[i].behind }),
        });
      const hit = first((i) =>
        r.call(std.mul, {
          a: behindAt(i),
          b: r.call(std.step, { edge: marched[i].behind, x: thickness }),
        }),
      );
      const refined = refine(hit.t, hit.uv, hit.behind);
      hitUv = refinements > 0 ? refined.uv : hit.uv;
      hitT = refined.t;
      residue = refined.behind;
      found = hit.found as PortHandle;
      surface = found;
      rejected = r.call(std.mul, {
        a: not(found),
        b: first(behindAt).found as PortHandle,
      });
    } else {
      // The crossings: a step behind the image, the step before in front
      // of it. Halved, a crossing ends on the surface met (behind it by
      // almost nothing), or on the edge of an object the ray passes behind
      // (behind it by the jump of depth at the edge): the test no longer
      // depends on where the steps fall. The second crossing is tried when
      // the first is rejected: what is behind the object.
      const inFront = (i: number) =>
        r.call(std.step, { edge: marched[i].behind, x: 0.005 });
      // The point of the pixel itself, at the start: in front.
      const crossing = (i: number) =>
        i === 0
          ? and([not(inFront(0)), marched[0].valid])
          : and([inFront(i - 1), not(inFront(i)), marched[i].valid]);
      const candidates: {
        hit: PortHandle;
        found: PortHandle;
        uv: PortHandle;
        t: PortHandle;
        behind: PortHandle;
      }[] = [];
      let after: PortHandle | number = 0;
      for (let k = 0; k < 2; k++) {
        const start = after;
        const crossed = first((i) =>
          r.call(std.mul, {
            a: crossing(i),
            b: r.call(std.step, { edge: start, x: marched[i].t }),
          }),
        );
        const refined = refine(crossed.t, crossed.uv, crossed.behind);
        candidates.push({
          ...refined,
          found: crossed.found as PortHandle,
          hit: r.call(std.mul, {
            a: crossed.found,
            b: r.call(std.step, {
              edge: refined.behind,
              x: r.call(std.add, {
                a: gap,
                b: r.call(std.mul, {
                  a: slope(refined.uv),
                  b: slopeScale,
                }),
              }),
            }),
          }),
        });
        after = r.call(std.add, { a: crossed.t, b: 0.0001 });
      }
      // In order: a surface met first, a surface behind an object, or the
      // object the ray passes just behind (its hidden side, unknown: its
      // visible side is the best guess). Each test is on the depths after
      // the halvings, not on where the steps fall.
      const [a, b] = candidates;
      const passes = and([
        a.found,
        not(b.hit),
        r.call(std.step, { edge: a.behind, x: behindThickness }),
      ]);
      const take = (pick: (c: (typeof candidates)[0]) => PortHandle) =>
        choose(b.hit, choose(a.hit, pick(a), pick(b)), pick(a));
      hitUv = take((c) => c.uv);
      hitT = take((c) => c.t);
      residue = a.behind;
      surface = r.call(std.max, { a: a.hit, b: b.hit });
      found = r.call(std.max, { a: surface, b: passes });
      rejected = r.call(std.mul, { a: not(surface), b: a.found });
    }

    const reflection = r.call(std.mix, {
      a: sampleEnvironment(r, ray),
      b: read(r, 'color', hitUv).swizzle('rgb'),
      t: found,
    });
    const image = withSky(
      r,
      r.call(std.add, {
        a: color,
        b: r.call(std.mul, { a: reflection, b: strength }),
      }),
      depth,
    );

    // The views of the lab, on the reflective pixels; the others dimmed.
    const reflective = r.call(std.greater, { a: strength, b: 0 });
    const onReflective = (value: PortHandle) =>
      r.call(std.select, {
        ifFalse: r.call(std.mul, { a: withSky(r, color, depth), b: 0.3 }),
        ifTrue: value,
        condition: reflective,
      });
    const hitColors = choose(
      surface,
      [0.1, 0.8, 0.2],
      choose(
        found,
        [0.1, 0.8, 0.9],
        choose(rejected, [0.1, 0.3, 0.9], [0.8, 0.1, 0.1]),
      ),
    );
    const gray = (value: PortHandle) =>
      r.call(std.mul, { a: [1, 1, 1], b: value });
    const distanceView = gray(
      r.call(std.mul, {
        a: found,
        b: r.call(std.div, {
          a: hitT,
          b: r.call(std.mul, { a: stepLength, b: steps }),
        }),
      }),
    );
    // How far behind the image the first crossing ends after the halvings:
    // black on a surface, red at 0.1 and more (the edge of an object).
    const residueView = r.call(std.mix, {
      a: [0, 0, 0],
      b: [1, 0.2, 0.1],
      t: r.call(std.saturate, { x: r.call(std.mul, { a: residue, b: 10 }) }),
    });
    const choices = [
      image,
      onReflective(r.call(std.mul, { a: reflection, b: found })),
      onReflective(hitColors),
      onReflective(distanceView),
      onReflective(residueView),
    ];
    let shown: PortHandle = choices[0];
    choices.forEach((choice, i) => {
      if (i > 0) {
        shown = r.call(std.select, {
          ifFalse: shown,
          ifTrue: choice,
          condition: r.call(std.greater, { a: view, b: i - 0.5 }),
        });
      }
    });
    r.fullscreen({
      color: r.call(std.extend, {
        xyz: r.call('color.linearToSrgb', { color: shown }),
      }),
    });
    return new Material({
      graph: r.build(),
      values: {
        ...environmentValues,
        colorSampler: linear,
        normalDepthSampler: nearest,
        reflectivitySampler: nearest,
        backDepthSampler: nearest,
      },
    });
  };
  let compose = buildCompose(parameters);
  let view = 0;
  let mode = 2;

  // --- The scene.
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
    material: floors[mode],
    transform: new Transform({
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
  const mirrored = new Camera({ projection });
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  // The orbit of the camera around the middle of the balls.
  const orbit = { yaw: 0, pitch: -0.32, distance: 6.9 };
  const target = { x: 0, y: 0.3, z: 0 };
  let last = { x: 0.5, y: 0.5 };

  const show = () =>
    context.info?.(
      `${modes[mode]} · view ${view + 1}: ${views[view]} · ` +
        `${parameters.steps} steps × ${parameters.stepLength.toFixed(3)} · ` +
        (parameters.method === 'thickness'
          ? `thickness ${parameters.thicknessScale.toFixed(2)} × step + ` +
            `${parameters.thicknessBias.toFixed(3)} · `
          : parameters.method === 'crossings'
            ? `crossings, jump < ${parameters.gap.toFixed(3)}, ` +
              `+ ${parameters.slopeScale.toFixed(1)} px of slope, ` +
              `behind < ${parameters.behindThickness.toFixed(2)} · `
            : `back faces + ${parameters.gap.toFixed(3)} · `) +
        `${parameters.refinements} halvings`,
    );

  const handleKeys = () => {
    const k = input.keyboard;
    let rebuild = false;
    if (k.pressed('KeyM')) {
      mode = (mode + 1) % modes.length;
      ground.material = floors[mode];
    }
    views.forEach((_, i) => {
      if (k.pressed(`Digit${i + 1}`)) {
        view = i;
      }
    });
    if (k.pressed('BracketLeft')) {
      parameters.steps = Math.max(4, parameters.steps - 8);
      rebuild = true;
    }
    if (k.pressed('BracketRight')) {
      parameters.steps = Math.min(128, parameters.steps + 8);
      rebuild = true;
    }
    if (k.pressed('KeyK')) {
      parameters.behindThickness = Math.max(
        0,
        parameters.behindThickness - 0.1,
      );
    }
    if (k.pressed('KeyL')) {
      parameters.behindThickness += 0.1;
    }
    if (k.pressed('KeyO')) {
      parameters.slopeScale = Math.max(0, parameters.slopeScale - 0.5);
    }
    if (k.pressed('KeyP')) {
      parameters.slopeScale += 0.5;
    }
    if (k.pressed('KeyT')) {
      parameters.method = methods[(methods.indexOf(parameters.method) + 1) % 3];
      rebuild = true;
    }
    if (k.pressed('KeyR')) {
      parameters.refinements = parameters.refinements > 0 ? 0 : 6;
      rebuild = true;
    }
    if (k.pressed('Semicolon')) {
      parameters.stepLength /= 1.25;
    }
    if (k.pressed('Quote')) {
      parameters.stepLength *= 1.25;
    }
    if (k.pressed('Comma')) {
      parameters.gap /= 1.5;
      parameters.thicknessBias /= 1.5;
      parameters.thicknessScale /= 1.25;
    }
    if (k.pressed('Period')) {
      parameters.gap *= 1.5;
      parameters.thicknessBias *= 1.5;
      parameters.thicknessScale *= 1.25;
    }
    if (rebuild) {
      compose = buildCompose(parameters);
    }
  };

  const updateCamera = () => {
    const pointer = input.pointer;
    if (pointer.isDown(0)) {
      orbit.yaw -= (pointer.x - last.x) * 4;
      orbit.pitch = Math.min(
        -0.05,
        Math.max(-1.4, orbit.pitch - (pointer.y - last.y) * 3),
      );
    }
    last = { x: pointer.x, y: pointer.y };
    orbit.distance = Math.min(
      20,
      Math.max(1.5, orbit.distance * 1.1 ** pointer.wheel),
    );
    const { yaw, pitch, distance } = orbit;
    camera.position = {
      x: target.x + distance * Math.sin(yaw) * Math.cos(pitch),
      y: target.y - distance * Math.sin(pitch),
      z: target.z + distance * Math.cos(yaw) * Math.cos(pitch),
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
    const { x, y, z } = camera.position;
    mirrored.position = { x, y: -y, z };
    mirrored.rotation = {
      x: -rotation.x,
      y: rotation.y,
      z: -rotation.z,
      w: rotation.w,
    };
    followAspect(camera, surface);
    followAspect(mirrored, surface);
  };

  return {
    frame: () => {
      input.update();
      handleKeys();
      updateCamera();
      show();
      compose
        .setValue('stepLength', parameters.stepLength)
        .setValue('thicknessScale', parameters.thicknessScale)
        .setValue('thicknessBias', parameters.thicknessBias)
        .setValue('gap', parameters.gap)
        .setValue('behindThickness', parameters.behindThickness)
        .setValue('slopeScale', parameters.slopeScale)
        .setValue('texel', [1 / surface.width, 1 / surface.height])
        .setValue('view', view);

      const graph = new RenderGraph();
      const outputs = {
        normalDepth: { format: 'rgba16float', value: normalDepth },
        reflectivity: { format: 'r8unorm', value: 'material', default: 0 },
      } as const;
      let inputs: Record<string, TextureHandle> = {};
      if (mode === 1) {
        const reflection = renderer.addScenePasses(graph, {
          name: 'mirror',
          items: objects,
          camera: mirrored,
          lights: [light],
          target: graph.createTexture('mirror color', {
            format: 'rgba16float',
          }),
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
          target: graph.createTexture('mirror image', {
            format: 'rgba16float',
          }),
          format: 'rgba16float',
        });
        inputs = { mirror };
      }
      // The depth of the back faces, for the thickness of the objects.
      const back = renderer.addScenePasses(graph, {
        name: 'back faces',
        items,
        camera,
        lights: [light],
        faces: 'back',
        shadows: false,
        outputs: { backDepth: outputs.normalDepth },
      });
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
      renderer.addFullscreenPass(graph, 'compose', {
        material: compose,
        inputs: {
          color: scene.color,
          normalDepth: scene.outputs.normalDepth,
          reflectivity: scene.outputs.reflectivity,
          backDepth: back.outputs.backDepth,
        },
        target: graph.importTexture('surface', surface.getCurrentTarget()),
        format: surface.format,
      });
      runner.execute(graph);
      surface.present();
    },
    destroy: () => {
      input.dispose();
      renderer.destroy();
    },
  };
};
