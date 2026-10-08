import type { ValueSource } from '../graph/MaterialGraphData';
import type { MacroDefinition } from '../graph/NodeDefinition';
import { BuiltinTypes } from '../types/ShaderType';
import { call, engineValue, swizzle, vertexNormal } from './macros';
import { ShadingModel, surface } from './outputs';

// A shading model is a macro 'lighting.<model>' taking the surface inputs and
// the world position of the fragment, and producing its final color. The
// compiler inserts it behind 'output.surface'.
function lightingModel(
  model: ShadingModel,
  expand: MacroDefinition['expand']
): MacroDefinition {
  return {
    id: `lighting.${model}`,
    category: 'macro',
    inputs: () => [
      ...surface
        .inputs({ shadingModel: model })
        .filter((port) => port.name !== 'positionOffset'),
      { name: 'worldPosition', type: BuiltinTypes.vec4f },
    ],
    outputs: () => [{ name: 'color', type: BuiltinTypes.vec4f }],
    expand,
  };
}

export const unlit = lightingModel('unlit', (context) => ({
  color: call(context, 'std.extend', {
    xyz: context.input('baseColor'),
    w: context.input('alpha'),
  }),
}));

/**
 * Phong lighting, summed over the lights of the frame:
 *   Σ (ambient + (diffuse + specular) × attenuation × spot) + emissive
 * The values that do not depend on the light (normal, view direction…) are
 * computed once, outside the loop.
 */
export const phong = lightingModel('phong', (context) => {
  const c = context;
  const position = swizzle(
    call(c, 'std.perFragment', { value: c.input('worldPosition') }),
    'xyz'
  );
  const normal: ValueSource = c.input('normal')
    ? call(c, 'std.normalize', { x: c.input('normal') })
    : vertexNormal(c);
  const v = call(c, 'std.normalize', {
    x: call(c, 'std.sub', {
      a: engineValue(c, 'camera.position'),
      b: position,
    }),
  });

  const light = c.add('light.current');
  // w = 1 for a point or spot light, 0 for a directional one:
  // normalize(xyz - P × w) is the direction to the light in all cases.
  const lightPosition = light('position');
  const toLight = call(c, 'std.sub', {
    a: swizzle(lightPosition, 'xyz'),
    b: call(c, 'std.mul', { a: position, b: swizzle(lightPosition, 'w') }),
  });
  const l = call(c, 'std.normalize', { x: toLight });

  const attenuationFactors = light('attenuation');
  const distance = call(c, 'std.length', { x: toLight });
  const attenuation = call(c, 'std.div', {
    a: 1,
    b: call(c, 'std.add', {
      a: call(c, 'std.add', {
        a: swizzle(attenuationFactors, 'x'),
        b: call(c, 'std.mul', {
          a: swizzle(attenuationFactors, 'y'),
          b: distance,
        }),
      }),
      b: call(c, 'std.mul', {
        a: swizzle(attenuationFactors, 'z'),
        b: call(c, 'std.mul', { a: distance, b: distance }),
      }),
    }),
  });

  // Spot cone: 1 inside the inner angle, 0 outside the outer one, linear in
  // the cosine between them. Other lights have a cone covering every
  // direction.
  const cone = light('spotCone');
  const spot = call(c, 'std.saturate', {
    x: call(c, 'std.div', {
      a: call(c, 'std.sub', {
        a: call(c, 'std.dot', {
          a: call(c, 'std.mul', { a: l, b: -1 }),
          b: light('spotDirection'),
        }),
        b: swizzle(cone, 'y'),
      }),
      b: call(c, 'std.sub', {
        a: swizzle(cone, 'x'),
        b: swizzle(cone, 'y'),
      }),
    }),
  });

  const nDotL = call(c, 'std.dot', { a: normal, b: l });
  const diffuseFactor = call(c, 'std.max', { a: nDotL, b: 0 });
  const reflected = call(c, 'std.reflect', {
    incident: call(c, 'std.mul', { a: l, b: -1 }),
    normal,
  });
  // No highlight on faces turned away from the light; an exponent below 1
  // would light the whole surface.
  const specularFactor = call(c, 'std.mul', {
    a: call(c, 'std.pow', {
      base: call(c, 'std.max', {
        a: call(c, 'std.dot', { a: v, b: reflected }),
        b: 0,
      }),
      exponent: call(c, 'std.max', { a: c.input('shininess'), b: 1 }),
    }),
    b: call(c, 'std.step', { edge: 0, x: nDotL }),
  });

  const baseColor = c.input('baseColor');
  const ambient = call(c, 'std.mul', { a: light('ambient'), b: baseColor });
  const diffuse = call(c, 'std.mul', {
    a: call(c, 'std.mul', { a: light('diffuse'), b: baseColor }),
    b: diffuseFactor,
  });
  const specular = call(c, 'std.mul', {
    a: call(c, 'std.mul', { a: light('specular'), b: c.input('specular') }),
    b: specularFactor,
  });

  const perLight = call(c, 'std.add', {
    a: ambient,
    b: call(c, 'std.mul', {
      a: call(c, 'std.add', { a: diffuse, b: specular }),
      b: call(c, 'std.mul', { a: attenuation, b: spot }),
    }),
  });
  const color = call(c, 'std.add', {
    a: call(c, 'light.sum', { value: perLight }),
    b: c.input('emissive'),
  });
  return { color: call(c, 'std.extend', { xyz: color, w: c.input('alpha') }) };
});

export const lightingDefinitions: readonly MacroDefinition[] = [unlit, phong];
