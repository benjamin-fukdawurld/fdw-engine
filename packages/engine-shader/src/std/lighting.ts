import { GraphError } from '../graph/Diagnostic';
import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type { MaterialGraphData } from '../graph/MaterialGraphData';
import type { FunctionDefinition } from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { BuiltinTypes, ShaderType, typeEquals } from '../types/ShaderType';
import * as functions from './functions';
import * as lights from './lights';

/**
 * Makes a shading model from a function graph: the node type
 * `lighting.<name>`, inserted by the compiler behind `output.surface` when
 * its `shadingModel` is `name`.
 *
 * The inputs of the function are the inputs of the surface, plus
 * `worldPosition` (vec4, given by the compiler). An input named `normal` is
 * optional on the surface: when unconnected, the compiler gives the
 * interpolated normal of the mesh. The function has one output, `color`
 * (vec4). Lights are read with `light.current` and summed with `light.sum`.
 *
 * @example A toon shading model
 * ```ts
 * const f = new GraphBuilder('toon');
 * const baseColor = f.functionInput('baseColor', BuiltinTypes.vec3f, {
 *   default: [1, 1, 1],
 * });
 * const normal = f.functionInput('normal', BuiltinTypes.vec3f);
 * f.functionInput('worldPosition', BuiltinTypes.vec4f);
 * // … light.current, light.sum …
 * f.functionOutput('color', color);
 * const registry = createStandardRegistry();
 * registry.register(defineShadingModel('toon', f.build()));
 *
 * const g = new GraphBuilder('cartoon', registry);
 * g.surface({ shadingModel: 'toon', baseColor: [1, 0.5, 0] });
 * ```
 *
 * @throws {@link GraphError} when the graph does not follow this contract.
 *
 * @group Functions
 */
export function defineShadingModel(
  name: string,
  graph: MaterialGraphData,
  options: { description?: string; registry?: NodeRegistry } = {}
): FunctionDefinition {
  const definition = defineFunction(graph, {
    id: `lighting.${name}`,
    ...options,
  });
  const fail = (message: string) =>
    new GraphError([
      { severity: 'error', message: `shading model "${name}": ${message}` },
    ]);
  const inputs = definition.inputs({});
  const outputs = definition.outputs({});
  const worldPosition = inputs.find((port) => port.name === 'worldPosition');
  if (
    !worldPosition ||
    !typeEquals(worldPosition.type as ShaderType, BuiltinTypes.vec4f)
  ) {
    throw fail('needs a worldPosition input of type vec4<f32>');
  }
  if (inputs.some((port) => port.name === 'positionOffset')) {
    throw fail('positionOffset is an input of the surface, not of the model');
  }
  if (
    outputs.length !== 1 ||
    outputs[0].name !== 'color' ||
    !typeEquals(outputs[0].type as ShaderType, BuiltinTypes.vec4f)
  ) {
    throw fail('needs a single color output of type vec4<f32>');
  }
  return definition;
}

const vec3 = BuiltinTypes.vec3f;
const f32 = BuiltinTypes.f32;

// The inputs shared by the lit models.
function litInputs(f: GraphBuilder) {
  return {
    baseColor: f.functionInput('baseColor', vec3, { default: [1, 1, 1] }),
    alpha: f.functionInput('alpha', f32, { default: 1 }),
    emissive: f.functionInput('emissive', vec3, { default: [0, 0, 0] }),
    // World-space normal; the interpolated normal of the mesh when the
    // surface leaves it unconnected.
    normal: f.functionInput('normal', vec3),
    worldPosition: f.functionInput('worldPosition', BuiltinTypes.vec4f),
  };
}

// What the lit models compute from the light being summed: the direction to
// the light, its attenuation with the distance, and the spot cone factor.
function lightGeometry(
  f: GraphBuilder,
  position: PortHandle,
  light: Readonly<Record<string, PortHandle>>
) {
  // w = 1 for a point or spot light, 0 for a directional one:
  // normalize(xyz - P × w) is the direction to the light in all cases.
  const lightPosition = light['position'];
  const toLight = f.call(functions.sub, {
    a: lightPosition.swizzle('xyz'),
    b: f.call(functions.mul, { a: position, b: lightPosition.swizzle('w') }),
  });
  const l = f.call(functions.normalize, { x: toLight });

  const factors = light['attenuation'];
  const distance = f.call(functions.length, { x: toLight });
  const attenuation = f.call(functions.div, {
    a: 1,
    b: f.call(functions.add, {
      a: f.call(functions.add, {
        a: factors.swizzle('x'),
        b: f.call(functions.mul, { a: factors.swizzle('y'), b: distance }),
      }),
      b: f.call(functions.mul, {
        a: factors.swizzle('z'),
        b: f.call(functions.mul, { a: distance, b: distance }),
      }),
    }),
  });

  // Spot cone: 1 inside the inner angle, 0 outside the outer one, linear in
  // the cosine between them. Other lights have a cone covering every
  // direction.
  const cone = light['spotCone'];
  const spot = f.call(functions.saturate, {
    x: f.call(functions.div, {
      a: f.call(functions.sub, {
        a: f.call(functions.dot, {
          a: f.call(functions.mul, { a: l, b: -1 }),
          b: light['spotDirection'],
        }),
        b: cone.swizzle('y'),
      }),
      b: f.call(functions.sub, { a: cone.swizzle('x'), b: cone.swizzle('y') }),
    }),
  });

  return { l, attenuation, spot };
}

// Unlit: the base color, with its alpha.
function unlit(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('unlit', registry);
  const baseColor = f.functionInput('baseColor', vec3, { default: [1, 1, 1] });
  const alpha = f.functionInput('alpha', f32, { default: 1 });
  f.functionInput('worldPosition', BuiltinTypes.vec4f);
  f.functionOutput(
    'color',
    f.call(functions.extend, { xyz: baseColor, w: alpha })
  );
  return defineShadingModel('unlit', f.build(), {
    description: 'The base color, without lighting.',
    registry,
  });
}

// Phong lighting, summed over the lights of the frame:
//   Σ (ambient + (diffuse + specular) × attenuation × spot) + emissive
// The values that do not depend on the light (normal, view direction…) are
// computed once, outside the loop.
function phong(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('phong', registry);
  const { baseColor, alpha, emissive, normal, worldPosition } = litInputs(f);
  const specularColor = f.functionInput('specular', vec3, {
    default: [1, 1, 1],
  });
  const shininess = f.functionInput('shininess', f32, { default: 32 });

  const position = f
    .call(functions.perFragment, { value: worldPosition })
    .swizzle('xyz');
  const n = f.call(functions.normalize, { x: normal });
  const v = f.call(functions.normalize, {
    x: f.call(functions.sub, { a: f.engine('camera.position'), b: position }),
  });

  const light = f.node(lights.current);
  const { l, attenuation, spot } = lightGeometry(f, position, light);

  const nDotL = f.call(functions.dot, { a: n, b: l });
  const diffuseFactor = f.call(functions.max, { a: nDotL, b: 0 });
  const reflected = f.call(functions.reflect, {
    incident: f.call(functions.mul, { a: l, b: -1 }),
    normal: n,
  });
  // No highlight on faces turned away from the light; an exponent below 1
  // would light the whole surface.
  const specularFactor = f.call(functions.mul, {
    a: f.call(functions.pow, {
      base: f.call(functions.max, {
        a: f.call(functions.dot, { a: v, b: reflected }),
        b: 0,
      }),
      exponent: f.call(functions.max, { a: shininess, b: 1 }),
    }),
    b: f.call(functions.step, { edge: 0, x: nDotL }),
  });

  const ambient = f.call(functions.mul, { a: light['ambient'], b: baseColor });
  const diffuse = f.call(functions.mul, {
    a: f.call(functions.mul, { a: light['diffuse'], b: baseColor }),
    b: diffuseFactor,
  });
  const specular = f.call(functions.mul, {
    a: f.call(functions.mul, { a: light['specular'], b: specularColor }),
    b: specularFactor,
  });
  const perLight = f.call(functions.add, {
    a: ambient,
    b: f.call(functions.mul, {
      a: f.call(functions.add, { a: diffuse, b: specular }),
      b: f.call(functions.mul, { a: attenuation, b: spot }),
    }),
  });
  const color = f.call(functions.add, {
    a: f.call(lights.sum, { value: perLight }),
    b: emissive,
  });
  f.functionOutput('color', f.call(functions.extend, { xyz: color, w: alpha }));
  return defineShadingModel('phong', f.build(), {
    description: 'Phong lighting, summed over the lights of the frame.',
    registry,
  });
}

// Physically based lighting, metallic/roughness (the model of glTF), summed
// over the lights of the frame: Cook-Torrance with the GGX distribution, the
// Smith-Schlick geometry term and the Schlick Fresnel term.
//
// The diffuse color of a light is its radiance, scaled by π so that a white
// light gives baseColor × N·L on a rough dielectric, as Phong. The ambient
// term is ambient × baseColor × occlusion; image-based lighting will replace
// it.
function pbr(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('pbr', registry);
  const { baseColor, alpha, emissive, normal, worldPosition } = litInputs(f);
  const metallic = f.functionInput('metallic', f32, { default: 0 });
  const roughness = f.functionInput('roughness', f32, { default: 0.5 });
  const occlusion = f.functionInput('occlusion', f32, { default: 1 });
  const { add, sub, mul, div, max, dot, normalize, pow, mix, clamp } =
    functions;
  const pi = f.call('const.pi');

  // Independent of the light: computed once, before the loop.
  const position = f
    .call(functions.perFragment, { value: worldPosition })
    .swizzle('xyz');
  const n = f.call(normalize, { x: normal });
  const v = f.call(normalize, {
    x: f.call(sub, { a: f.engine('camera.position'), b: position }),
  });
  const nDotV = f.call(max, { a: f.call(dot, { a: n, b: v }), b: 1e-4 });
  // Very low roughness gives infinitely thin highlights.
  const r = f.call(clamp, { x: roughness, low: 0.04, high: 1 });
  const a2 = f.call(mul, {
    a: f.call(mul, { a: r, b: r }),
    b: f.call(mul, { a: r, b: r }),
  });
  const k = f.call(div, {
    a: f.call(mul, {
      a: f.call(add, { a: r, b: 1 }),
      b: f.call(add, { a: r, b: 1 }),
    }),
    b: 8,
  });
  // Smith-Schlick: x / (x (1 - k) + k).
  const geometry = (x: PortHandle) =>
    f.call(div, {
      a: x,
      b: f.call(add, {
        a: f.call(mul, { a: x, b: f.call(sub, { a: 1, b: k }) }),
        b: k,
      }),
    });
  const geometryV = geometry(nDotV);
  const f0 = f.call(mix, { a: [0.04, 0.04, 0.04], b: baseColor, t: metallic });
  const diffuseColor = f.call(mul, {
    a: baseColor,
    b: f.call(sub, { a: 1, b: metallic }),
  });

  // Per light.
  const light = f.node(lights.current);
  const { l, attenuation, spot } = lightGeometry(f, position, light);
  const h = f.call(normalize, { x: f.call(add, { a: l, b: v }) });
  const nDotL = f.call(max, { a: f.call(dot, { a: n, b: l }), b: 0 });
  const nDotH = f.call(max, { a: f.call(dot, { a: n, b: h }), b: 0 });
  const vDotH = f.call(max, { a: f.call(dot, { a: v, b: h }), b: 0 });

  // GGX: a² / (π ((N·H)² (a² - 1) + 1)²).
  const denominator = f.call(add, {
    a: f.call(mul, {
      a: f.call(mul, { a: nDotH, b: nDotH }),
      b: f.call(sub, { a: a2, b: 1 }),
    }),
    b: 1,
  });
  const distribution = f.call(div, {
    a: a2,
    b: f.call(mul, {
      a: pi,
      b: f.call(mul, { a: denominator, b: denominator }),
    }),
  });
  // Schlick: F0 + (1 - F0) (1 - V·H)⁵.
  const fresnel = f.call(add, {
    a: f0,
    b: f.call(mul, {
      a: f.call(sub, { a: 1, b: f0 }),
      b: f.call(pow, { base: f.call(sub, { a: 1, b: vDotH }), exponent: 5 }),
    }),
  });
  // D G F / (4 N·L N·V).
  const specular = f.call(div, {
    a: f.call(mul, {
      a: fresnel,
      b: f.call(mul, {
        a: distribution,
        b: f.call(mul, { a: geometry(nDotL), b: geometryV }),
      }),
    }),
    b: f.call(add, {
      a: f.call(mul, { a: 4, b: f.call(mul, { a: nDotL, b: nDotV }) }),
      b: 1e-4,
    }),
  });
  // The light not reflected is diffused: (1 - F) × diffuse color / π.
  const diffuse = f.call(div, {
    a: f.call(mul, { a: f.call(sub, { a: 1, b: fresnel }), b: diffuseColor }),
    b: pi,
  });
  const radiance = f.call(mul, {
    a: light['diffuse'],
    b: f.call(mul, { a: pi, b: f.call(mul, { a: attenuation, b: spot }) }),
  });
  const direct = f.call(mul, {
    a: f.call(mul, {
      a: f.call(add, { a: diffuse, b: specular }),
      b: radiance,
    }),
    b: nDotL,
  });
  const ambient = f.call(mul, {
    a: f.call(mul, { a: light['ambient'], b: baseColor }),
    b: occlusion,
  });
  const color = f.call(add, {
    a: f.call(lights.sum, { value: f.call(add, { a: ambient, b: direct }) }),
    b: emissive,
  });
  f.functionOutput('color', f.call(functions.extend, { xyz: color, w: alpha }));
  return defineShadingModel('pbr', f.build(), {
    description:
      'Physically based lighting (metallic/roughness), summed over the lights of the frame.',
    registry,
  });
}

/**
 * The standard shading models, built with the given registry: the standard
 * node types, without the shading models.
 */
export function createShadingModels(
  registry: NodeRegistry
): FunctionDefinition[] {
  return [unlit(registry), phong(registry), pbr(registry)];
}
