import type { ValueSource } from '../graph/MaterialGraphData';
import type { MacroContext, MacroDefinition } from '../graph/NodeDefinition';
import { composeSwizzles } from '../graph/swizzle';
import type { ConstantValue } from '../types/ConstantValue';
import { generic } from '../types/PortType';
import { ShaderType, BuiltinTypes } from '../types/ShaderType';

const any = generic('T', 'any');

/**
 * Inputs given to {@link call}.
 *
 * @group Standard library
 */
export type MacroInputs = Readonly<
  Record<string, ValueSource | ConstantValue | undefined>
>;

/**
 * Helpers for macro bodies: call a function node and get its output, swizzle
 * a value.
 *
 * @group Standard library
 */
export const call = (
  context: MacroContext,
  type: string,
  inputs: MacroInputs,
): ValueSource => context.add(type, {}, inputs)();

/**
 * Helper for macro bodies: reads an engine value.
 *
 * @group Standard library
 */
export const engineValue = (
  context: MacroContext,
  value: string,
): ValueSource => context.add('input.engine', { value })();

/**
 * Helper for macro bodies: selects components of a value.
 *
 * @group Standard library
 */
export function swizzle(source: ValueSource, mask: string): ValueSource {
  if (!('ref' in source)) {
    throw new Error('A literal cannot be swizzled');
  }
  const combined = source.swizzle
    ? composeSwizzles(source.swizzle, mask)
    : mask;
  if (!combined) {
    throw new Error(`Invalid swizzle .${mask} of .${source.swizzle}`);
  }
  return { ref: source.ref, swizzle: combined };
}

/**
 * Chooses one of two values from a static parameter: only the chosen branch
 * is compiled, the other one is removed as dead code.
 */
export const staticSwitch: MacroDefinition = {
  id: 'macro.staticSwitch',
  category: 'macro',
  description: 'ifTrue when the feature is truthy, ifFalse otherwise.',
  params: { feature: { kind: 'string', required: true } },
  inputs: () => [
    { name: 'ifTrue', type: any },
    { name: 'ifFalse', type: any },
  ],
  outputs: () => [{ name: 'result', type: any }],
  expand: (context) => {
    const chosen = context.feature(context.params['feature'] as string)
      ? 'ifTrue'
      : 'ifFalse';
    return { result: context.input(chosen) as ValueSource };
  },
};

/**
 * A vertex attribute when the mesh has it, a fallback value otherwise: one
 * material for meshes with and without vertex colors, tangents…
 */
export const optionalAttribute: MacroDefinition = {
  id: 'macro.optionalAttribute',
  category: 'macro',
  params: {
    semantic: { kind: 'string', required: true },
    type: { kind: 'type', required: true },
  },
  inputs: (params) => [
    { name: 'fallback', type: params['type'] as ShaderType },
  ],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
  expand: (context) => {
    const { semantic, type } = context.params;
    return {
      value: context.feature(`hasAttribute.${semantic}`)
        ? context.add('input.attribute', { semantic, type })()
        : (context.input('fallback') as ValueSource),
    };
  },
};

/**
 * Applies a function node `count` times: result = body(…body(body(initial))).
 * The body node type needs a 'value' input, and may have an 'index' input
 * receiving the iteration number (0, 1, 2…).
 */
export const repeat: MacroDefinition = {
  id: 'macro.repeat',
  category: 'macro',
  params: {
    body: { kind: 'string', required: true },
    count: { kind: 'number', required: true },
  },
  inputs: () => [{ name: 'initial', type: any }],
  outputs: () => [{ name: 'result', type: any }],
  expand: (context) => {
    const body = context.params['body'] as string;
    const count = context.params['count'] as number;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`count must be a non-negative integer, got ${count}`);
    }
    const withIndex = context.hasInput(body, 'index');
    let value = context.input('initial') as ValueSource;
    for (let index = 0; index < count; index++) {
      value = call(context, body, withIndex ? { value, index } : { value });
    }
    return { result: value };
  },
};

// Direction transformed by the normal matrix and normalized per fragment:
// interpolated directions are not unit vectors.
function worldDirection(
  context: MacroContext,
  vector: ValueSource,
): ValueSource {
  const transformed = call(context, 'std.transform3', {
    matrix: engineValue(context, 'object.normalMatrix'),
    vector,
  });
  return call(context, 'std.normalize', {
    x: call(context, 'std.perFragment', { value: transformed }),
  });
}

/** World-space normal of the fragment from the mesh normals. */
export const vertexNormal = (context: MacroContext): ValueSource =>
  worldDirection(
    context,
    context.add('input.attribute', {
      semantic: 'normal',
      type: BuiltinTypes.vec3f,
    })(),
  );

// The world position of the fragment, from the position attribute (before
// any positionOffset).
export function worldPosition(context: MacroContext): ValueSource {
  const local = call(context, 'std.extend', {
    xyz: context.add('input.attribute', {
      semantic: 'position',
      type: BuiltinTypes.vec3f,
    })(),
    w: 1,
  });
  const world = call(context, 'std.transform', {
    matrix: engineValue(context, 'object.world'),
    vector: local,
  });
  return swizzle(call(context, 'std.perFragment', { value: world }), 'xyz');
}

// The uv of a macro: its 'uv' input, else the uv attribute of the mesh, per
// fragment; undefined without either.
function fragmentUv(context: MacroContext): ValueSource | undefined {
  const given = context.input('uv');
  if (given) {
    return given;
  }
  if (!context.feature('hasAttribute.uv')) {
    return undefined;
  }
  return call(context, 'std.perFragment', {
    value: context.add('input.attribute', {
      semantic: 'uv',
      type: BuiltinTypes.vec2f,
    })(),
  });
}

/**
 * The tangent frame of the fragment, in world space: the tangent t (along
 * +u), the bitangent b (along -v: up in the image, the OpenGL convention of
 * normal maps, as in glTF) and the normal n. From the tangents of the mesh
 * when it has them (xyz: tangent, w: handedness, see computeTangents); else
 * from the screen space derivatives of the position and of the uv (a
 * cotangent frame, Schüler 2013); undefined without uv either.
 */
function tangentFrame(
  context: MacroContext,
  n: ValueSource,
): { t: ValueSource; b: ValueSource } | undefined {
  if (context.feature('hasAttribute.tangent')) {
    const tangent = context.add('input.attribute', {
      semantic: 'tangent',
      type: BuiltinTypes.vec4f,
    })();
    const t = worldDirection(context, swizzle(tangent, 'xyz'));
    return {
      t,
      b: call(context, 'std.mul', {
        a: call(context, 'std.cross', { a: n, b: t }),
        b: swizzle(tangent, 'w'),
      }),
    };
  }
  const uv = fragmentUv(context);
  if (!uv) {
    return undefined;
  }
  const position = worldPosition(context);
  const dp1 = call(context, 'std.dpdx', { x: position });
  const dp2 = call(context, 'std.dpdy', { x: position });
  const duv1 = call(context, 'std.dpdx', { x: uv });
  const duv2 = call(context, 'std.dpdy', { x: uv });
  // Perpendiculars to the screen axes in the plane of the surface (the
  // screen y points down: the opposite of Schüler's crosses).
  const dp2perp = call(context, 'std.cross', { a: n, b: dp2 });
  const dp1perp = call(context, 'std.cross', { a: dp1, b: n });
  const along = (component: string) =>
    call(context, 'std.add', {
      a: call(context, 'std.mul', {
        a: dp2perp,
        b: swizzle(duv1, component),
      }),
      b: call(context, 'std.mul', {
        a: dp1perp,
        b: swizzle(duv2, component),
      }),
    });
  // Normalized: the uv may stretch differently along u and v. A small
  // epsilon where the uv does not change.
  const unit = (vector: ValueSource) =>
    call(context, 'std.div', {
      a: vector,
      b: call(context, 'std.max', {
        a: call(context, 'std.length', { x: vector }),
        b: 1e-12,
      }),
    });
  return {
    t: unit(along('x')),
    // dP/dv points down in the image: the bitangent is its opposite.
    b: call(context, 'std.mul', { a: unit(along('y')), b: -1 }),
  };
}

// The normal of the macro: its 'normal' input, else the vertex normal.
const macroNormal = (context: MacroContext): ValueSource =>
  context.input('normal')
    ? call(context, 'std.normalize', {
        x: context.input('normal') as ValueSource,
      })
    : vertexNormal(context);

/**
 * World-space normal perturbed by a tangent-space normal map (OpenGL
 * convention: green up, as in glTF). The tangent frame comes from the
 * tangents of the mesh when it has them, else from the screen space
 * derivatives of the position and of the uv (the `uv` input, else the uv of
 * the mesh). Without tangents nor uv, the map is ignored.
 */
export const normalMapping: MacroDefinition = {
  id: 'macro.normalMapping',
  category: 'macro',
  inputs: () => [
    // Texel of the normal map, in [0, 1].
    { name: 'sample', type: BuiltinTypes.vec3f },
    { name: 'strength', type: BuiltinTypes.f32, default: 1 },
    // The uv the map is read at, for the frame without tangents.
    { name: 'uv', type: BuiltinTypes.vec2f, optional: true },
    // The normal to perturb (world space); the vertex normal by default.
    { name: 'normal', type: BuiltinTypes.vec3f, optional: true },
  ],
  outputs: () => [{ name: 'normal', type: BuiltinTypes.vec3f }],
  expand: (context) => {
    const n = macroNormal(context);
    const frame = tangentFrame(context, n);
    if (!frame) {
      return { normal: n };
    }
    const { t, b } = frame;

    // From [0, 1] to [-1, 1], with the xy deviation scaled by the strength.
    const m = call(context, 'std.sub', {
      a: call(context, 'std.mul', { a: context.input('sample'), b: 2 }),
      b: 1,
    });
    const strength = context.input('strength');
    const along = (axis: ValueSource, component: string, scaled: boolean) =>
      call(context, 'std.mul', {
        a: axis,
        b: scaled
          ? call(context, 'std.mul', { a: swizzle(m, component), b: strength })
          : swizzle(m, component),
      });
    const perturbed = call(context, 'std.add', {
      a: call(context, 'std.add', {
        a: along(t, 'x', true),
        b: along(b, 'y', true),
      }),
      b: along(n, 'z', false),
    });
    return { normal: call(context, 'std.normalize', { x: perturbed }) };
  },
};

/**
 * World-space normal perturbed by a height (bump mapping): the slopes of the
 * height on the screen, from its screen space derivatives, tilt the normal
 * (Mikkelsen 2010, "Bump Mapping Unparametrized Surfaces on the GPU"). No
 * tangents nor uv needed; the height is any value computed per fragment (a
 * texture, a noise), in the units of the scene times `scale`.
 * Fragment stage only.
 */
export const bumpMapping: MacroDefinition = {
  id: 'macro.bumpMapping',
  category: 'macro',
  inputs: () => [
    { name: 'height', type: BuiltinTypes.f32 },
    { name: 'scale', type: BuiltinTypes.f32, default: 1 },
    // The normal to perturb (world space); the vertex normal by default.
    { name: 'normal', type: BuiltinTypes.vec3f, optional: true },
  ],
  outputs: () => [{ name: 'normal', type: BuiltinTypes.vec3f }],
  expand: (context) => {
    const n = macroNormal(context);
    const position = worldPosition(context);
    const dpdx = call(context, 'std.dpdx', { x: position });
    const dpdy = call(context, 'std.dpdy', { x: position });
    const r1 = call(context, 'std.cross', { a: dpdy, b: n });
    const r2 = call(context, 'std.cross', { a: n, b: dpdx });
    const det = call(context, 'std.dot', { a: dpdx, b: r1 });
    const height = call(context, 'std.mul', {
      a: context.input('height'),
      b: context.input('scale'),
    });
    const dhdx = call(context, 'std.dpdx', { x: height });
    const dhdy = call(context, 'std.dpdy', { x: height });
    // The gradient of the height on the surface, oriented by the sign of
    // the determinant (mirrored views).
    const gradient = call(context, 'std.mul', {
      a: call(context, 'std.add', {
        a: call(context, 'std.mul', { a: r1, b: dhdx }),
        b: call(context, 'std.mul', { a: r2, b: dhdy }),
      }),
      b: call(context, 'std.select', {
        ifFalse: 1,
        ifTrue: -1,
        condition: call(context, 'std.less', { a: det, b: 0 }),
      }),
    });
    return {
      normal: call(context, 'std.normalize', {
        x: call(context, 'std.sub', {
          a: call(context, 'std.mul', {
            a: n,
            b: call(context, 'std.abs', { x: det }),
          }),
          b: gradient,
        }),
      }),
    };
  },
};

// The direction from the fragment to the camera in the tangent frame: x
// along u, y up in the image, z along the normal.
function tangentView(
  context: MacroContext,
): { view: ValueSource; uv: ValueSource } | undefined {
  const uv = fragmentUv(context);
  if (!uv) {
    return undefined;
  }
  const n = vertexNormal(context);
  const frame = tangentFrame(context, n);
  if (!frame) {
    return undefined;
  }
  const v = call(context, 'std.normalize', {
    x: call(context, 'std.sub', {
      a: engineValue(context, 'camera.position'),
      b: worldPosition(context),
    }),
  });
  return {
    uv,
    view: call(context, 'std.vec3', {
      x: call(context, 'std.dot', { a: v, b: frame.t }),
      y: call(context, 'std.dot', { a: v, b: frame.b }),
      z: call(context, 'std.dot', { a: v, b: n }),
    }),
  };
}

// The height of a height map at a uv: its first channel.
const sampleHeight = (context: MacroContext, uv: ValueSource) =>
  swizzle(
    call(context, 'std.textureSample', {
      texture: context.input('texture'),
      sampler: context.input('sampler'),
      uv,
    }),
    'x',
  );

// The uv offset of a height seen from a tangent-space view: towards the
// viewer for the high points. The view is up in the image along +y, the
// uv along -v.
const viewShift = (
  context: MacroContext,
  view: ValueSource,
  amount: ValueSource,
): ValueSource =>
  call(context, 'std.mul', {
    a: call(context, 'std.mul', {
      a: call(context, 'std.div', {
        a: swizzle(view, 'xy'),
        b: call(context, 'std.max', { a: swizzle(view, 'z'), b: 0.05 }),
      }),
      b: [1, -1],
    }),
    b: amount,
  });

const heightMapInputs = [
  { name: 'texture', type: BuiltinTypes.texture2d },
  { name: 'sampler', type: BuiltinTypes.sampler },
  // The uv of the surface; the uv of the mesh by default.
  { name: 'uv', type: BuiltinTypes.vec2f, optional: true },
  // The depth of the relief, in uv units: 0.05 is 5% of the texture.
  { name: 'scale', type: BuiltinTypes.f32, default: 0.05 },
] as const;

/**
 * Parallax mapping: the uv shifted along the view by the height read from a
 * height map (first channel, 1 high, 0 deep), so that the relief seems to
 * move with the point of view. One read of the map; read the textures of
 * the surface at the uv it gives. The tangent frame comes from the
 * tangents of the mesh, else from the derivatives of the uv. Without uv,
 * the uv is unchanged. Fragment stage only.
 */
export const parallaxMapping: MacroDefinition = {
  id: 'macro.parallaxMapping',
  category: 'macro',
  inputs: () => heightMapInputs,
  outputs: () => [{ name: 'uv', type: BuiltinTypes.vec2f }],
  expand: (context) => {
    const tangent = tangentView(context);
    if (!tangent) {
      return { uv: context.input('uv') ?? { value: [0, 0] } };
    }
    // (height - 1) × scale: the top of the relief stays in place, the
    // bottom moves away from the viewer.
    const depth = call(context, 'std.mul', {
      a: call(context, 'std.sub', {
        a: sampleHeight(context, tangent.uv),
        b: 1,
      }),
      b: context.input('scale'),
    });
    return {
      uv: call(context, 'std.add', {
        a: tangent.uv,
        b: viewShift(context, tangent.view, depth),
      }),
    };
  },
};

/**
 * Parallax occlusion mapping: the uv where the ray of the view meets the
 * relief of a height map (first channel, 1 high, 0 deep), found by `steps`
 * reads along the ray (unrolled at compilation: 8 to 32), refined between
 * the two last ones. The relief hides itself, unlike parallaxMapping, for a
 * read per step. Fragment stage only.
 */
export const parallaxOcclusionMapping: MacroDefinition = {
  id: 'macro.parallaxOcclusionMapping',
  category: 'macro',
  params: { steps: { kind: 'number', default: 16 } },
  inputs: () => heightMapInputs,
  outputs: () => [{ name: 'uv', type: BuiltinTypes.vec2f }],
  expand: (context) => {
    const steps = context.params['steps'] as number;
    if (!Number.isInteger(steps) || steps < 1 || steps > 64) {
      throw new Error(`steps must be an integer from 1 to 64, got ${steps}`);
    }
    const tangent = tangentView(context);
    if (!tangent) {
      return { uv: context.input('uv') ?? { value: [0, 0] } };
    }
    // From the top of the relief (depth 0) to its bottom (depth 1), the uv
    // moves by `total`.
    const total = viewShift(
      context,
      tangent.view,
      call(context, 'std.mul', { a: context.input('scale'), b: -1 }),
    );
    // Each step: its uv, and how far below the relief the ray is (> 0:
    // under the surface, the ray has met it).
    const layers = [...Array(steps + 1)].map((_, i) => {
      const uv =
        i === 0
          ? tangent.uv
          : call(context, 'std.add', {
              a: tangent.uv,
              b: call(context, 'std.mul', { a: total, b: i / steps }),
            });
      const under = call(context, 'std.sub', {
        a: i / steps,
        b: call(context, 'std.sub', { a: 1, b: sampleHeight(context, uv) }),
      });
      return { uv, under };
    });
    // The first step under the relief, refined between it and the one
    // before: chosen from the last to the first.
    let uv: ValueSource = layers[steps].uv;
    for (let i = steps; i >= 1; i--) {
      const before = layers[i - 1];
      const after = layers[i];
      // The fraction of the step where the ray crosses the relief.
      const t = call(context, 'std.saturate', {
        x: call(context, 'std.div', {
          a: call(context, 'std.mul', { a: before.under, b: -1 }),
          b: call(context, 'std.max', {
            a: call(context, 'std.sub', { a: after.under, b: before.under }),
            b: 1e-5,
          }),
        }),
      });
      uv = call(context, 'std.select', {
        ifFalse: uv,
        ifTrue: call(context, 'std.mix', { a: before.uv, b: after.uv, t }),
        condition: call(context, 'std.greaterEqual', {
          a: after.under,
          b: 0,
        }),
      });
    }
    // At depth 0, the top of the relief is already met.
    uv = call(context, 'std.select', {
      ifFalse: uv,
      ifTrue: tangent.uv,
      condition: call(context, 'std.greaterEqual', {
        a: layers[0].under,
        b: 0,
      }),
    });
    return { uv };
  },
};

/**
 * Displacement mapping: the offset of the vertices along their normal by a
 * height map (first channel), for the positionOffset input of
 * output.surface. Read in the vertex stage (textureSampleLevel, level 0):
 * give the mesh enough vertices (a subdivided plane or sphere). The normals
 * are not changed: perturb them with bumpMapping on the same height, read
 * per fragment.
 */
export const displacement: MacroDefinition = {
  id: 'macro.displacement',
  category: 'macro',
  inputs: () => [
    { name: 'texture', type: BuiltinTypes.texture2d },
    { name: 'sampler', type: BuiltinTypes.sampler },
    // The uv of the vertex; the uv of the mesh by default.
    { name: 'uv', type: BuiltinTypes.vec2f, optional: true },
    // The height of a texel of 1, in the units of the mesh.
    { name: 'scale', type: BuiltinTypes.f32, default: 0.1 },
    // The height of a texel of 0: -0.5 centers the relief on the surface.
    { name: 'bias', type: BuiltinTypes.f32, default: 0 },
  ],
  outputs: () => [{ name: 'offset', type: BuiltinTypes.vec3f }],
  expand: (context) => {
    const uv =
      context.input('uv') ??
      context.add('input.attribute', {
        semantic: 'uv',
        type: BuiltinTypes.vec2f,
      })();
    const height = swizzle(
      call(context, 'std.textureSampleLevel', {
        texture: context.input('texture'),
        sampler: context.input('sampler'),
        uv,
        level: 0,
      }),
      'x',
    );
    return {
      offset: call(context, 'std.mul', {
        a: context.add('input.attribute', {
          semantic: 'normal',
          type: BuiltinTypes.vec3f,
        })(),
        b: call(context, 'std.mul', {
          a: call(context, 'std.add', { a: height, b: context.input('bias') }),
          b: context.input('scale'),
        }),
      }),
    };
  },
};

export const macroDefinitions: readonly MacroDefinition[] = [
  staticSwitch,
  optionalAttribute,
  repeat,
  normalMapping,
  bumpMapping,
  parallaxMapping,
  parallaxOcclusionMapping,
  displacement,
];
