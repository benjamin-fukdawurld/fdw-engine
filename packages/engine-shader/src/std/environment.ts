import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type {
  FunctionDefinition,
  MacroDefinition,
} from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { BuiltinTypes } from '../types/ShaderType';
import { EnvironmentLevels, EnvironmentTiles } from '../compiler/layout';
import * as functions from './functions';
import { Ops } from './ops';

// The environment of the frame (image-based lighting): the mappings of the
// directions to the textures (octahedral, equirectangular), and the
// lookups of the prefiltered atlas (see environmentMembers).

const vec2 = BuiltinTypes.vec2f;
const vec3 = BuiltinTypes.vec3f;
const f32 = BuiltinTypes.f32;

// 1 for the positive components (0 included), -1 for the others.
const signOf = (o: Ops, value: PortHandle) =>
  o.vec2(
    o.select(-1, 1, o.greaterEqual(value.swizzle('x'), 0)),
    o.select(-1, 1, o.greaterEqual(value.swizzle('y'), 0)),
  );

// The octahedral map: the directions on the faces of an octahedron
// (|x| + |y| + |z| = 1), y up, unfolded in the [0, 1] square: the upper
// half in the diamond of the center, the lower one folded over the
// corners.
function octahedral(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('environment.octahedral', registry);
  const o = new Ops(f);
  const direction = f.functionInput('direction', vec3);
  const n = o.div(direction, o.max(o.dot(o.abs(direction), [1, 1, 1]), 1e-20));
  const p = n.swizzle('xz');
  const folded = o.mul(o.sub([1, 1], o.abs(p.swizzle('yx'))), signOf(o, p));
  const q = o.select(folded, p, o.greaterEqual(n.swizzle('y'), 0));
  f.functionOutput('uv', o.add(o.mul(q, 0.5), 0.5));
  return defineFunction(f.build(), {
    id: 'environment.octahedral',
    description:
      'The coordinates of a direction in an octahedral map, in [0, 1] (y up).',
    registry,
  });
}

// The direction of coordinates of an octahedral map. Those of the border
// of a tile, out of [0, 1] by less than a texel, are folded back across
// the edge (the edges of the map meet mirrored): the border holds what the
// bilinear filter would find past the edge.
function octahedralDirection(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('environment.octahedralDirection', registry);
  const o = new Ops(f);
  const uv = f.functionInput('uv', vec2);
  const fold = (value: PortHandle, axis: 'x' | 'y') => {
    const other = axis === 'x' ? 'y' : 'x';
    const c = value.swizzle(axis);
    const mirrored = o.select(
      o.select(c, o.sub(2, c), o.greater(c, 1)),
      o.mul(c, -1),
      o.less(c, 0),
    );
    const out = o.or(o.less(c, 0), o.greater(c, 1));
    const flipped = o.select(
      value.swizzle(other),
      o.sub(1, value.swizzle(other)),
      out,
    );
    return axis === 'x' ? o.vec2(mirrored, flipped) : o.vec2(flipped, mirrored);
  };
  const p = o.sub(o.mul(fold(fold(uv, 'x'), 'y'), 2), 1);
  const y = o.sub(o.sub(1, o.abs(p.swizzle('x'))), o.abs(p.swizzle('y')));
  const folded = o.mul(o.sub([1, 1], o.abs(p.swizzle('yx'))), signOf(o, p));
  const xz = o.select(p, folded, o.less(y, 0));
  f.functionOutput(
    'direction',
    o.normalize(o.vec3(xz.swizzle('x'), y, xz.swizzle('y'))),
  );
  return defineFunction(f.build(), {
    id: 'environment.octahedralDirection',
    description:
      'The direction of coordinates of an octahedral map (y up); those out of [0, 1] by less than a texel are folded across the edge.',
    registry,
  });
}

// The equirectangular map: u the angle around y (0.5 toward -z, growing
// toward +x), v from the zenith (0) to the nadir (1), as the images of
// panoramas.
function equirect(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('environment.equirect', registry);
  const o = new Ops(f);
  const d = o.normalize(f.functionInput('direction', vec3));
  const u = o.add(
    o.div(
      f.call(functions.atan2, {
        y: d.swizzle('x'),
        x: o.mul(d.swizzle('z'), -1),
      }),
      2 * Math.PI,
    ),
    0.5,
  );
  const v = o.div(
    f.call(functions.acos, { x: o.clamp(d.swizzle('y'), -1, 1) }),
    Math.PI,
  );
  f.functionOutput('uv', o.vec2(u, v));
  return defineFunction(f.build(), {
    id: 'environment.equirect',
    description:
      'The coordinates of a direction in an equirectangular panorama: u around y (0.5 toward -z), v from the zenith (0) to the nadir (1).',
    registry,
  });
}

function equirectDirection(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('environment.equirectDirection', registry);
  const o = new Ops(f);
  const uv = f.functionInput('uv', vec2);
  const phi = o.mul(o.sub(uv.swizzle('x'), 0.5), 2 * Math.PI);
  const theta = o.mul(uv.swizzle('y'), Math.PI);
  const sinTheta = o.sin(theta);
  f.functionOutput(
    'direction',
    o.vec3(
      o.mul(sinTheta, o.sin(phi)),
      o.cos(theta),
      o.mul(o.mul(sinTheta, o.cos(phi)), -1),
    ),
  );
  return defineFunction(f.build(), {
    id: 'environment.equirectDirection',
    description:
      'The direction of coordinates of an equirectangular panorama (see environment.equirect).',
    registry,
  });
}

// The uv of a point of a tile of the atlas, from its coordinates in the
// tile ([0, 1], the border around), and a texel of it.
function tileTexel(
  f: GraphBuilder,
  o: Ops,
  uv: PortHandle,
  tile: PortHandle | number,
): PortHandle {
  const environment = f.engine('environment');
  const size = environment.swizzle('x');
  const row = o.floor(o.div(tile, EnvironmentTiles.x));
  const column = o.sub(tile, o.mul(row, EnvironmentTiles.x));
  const texels = o.add(
    o.mul(o.vec2(column, row), o.add(size, 2)),
    o.add(o.mul(uv, size), 1),
  );
  return f.call(functions.textureSampleLevel, {
    texture: f.engine('environmentMap'),
    sampler: f.engine('environmentSampler'),
    uv: o.mul(texels, environment.swizzle('yz')),
  });
}

function radiance(
  registry: NodeRegistry,
  octahedral: FunctionDefinition,
): FunctionDefinition {
  const f = new GraphBuilder('environment.radiance', registry);
  const o = new Ops(f);
  const direction = f.functionInput('direction', vec3);
  const roughness = f.functionInput('roughness', f32, { default: 0 });
  const uv = f.call(octahedral, { direction });
  // Between the two levels around the roughness.
  const level = o.mul(o.saturate(roughness), EnvironmentLevels - 1);
  const below = o.floor(level);
  const above = o.min(o.add(below, 1), EnvironmentLevels - 1);
  const color = o.mix(
    tileTexel(f, o, uv, below).swizzle('rgb'),
    tileTexel(f, o, uv, above).swizzle('rgb'),
    o.sub(level, below),
  );
  f.functionOutput('color', o.mul(color, f.engine('environment').swizzle('w')));
  return defineFunction(f.build(), {
    id: 'environment.radiance',
    description:
      'The light of the environment a surface of a roughness reflects in a direction (prefiltered, GGX).',
    registry,
  });
}

function irradiance(
  registry: NodeRegistry,
  octahedral: FunctionDefinition,
): FunctionDefinition {
  const f = new GraphBuilder('environment.irradiance', registry);
  const o = new Ops(f);
  const normal = f.functionInput('normal', vec3);
  const uv = f.call(octahedral, { direction: normal });
  f.functionOutput(
    'color',
    o.mul(
      tileTexel(f, o, uv, EnvironmentLevels).swizzle('rgb'),
      f.engine('environment').swizzle('w'),
    ),
  );
  return defineFunction(f.build(), {
    id: 'environment.irradiance',
    description:
      'The light of the environment a white lambertian surface of a normal reflects (its irradiance / π).',
    registry,
  });
}

function brdf(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('environment.brdf', registry);
  const o = new Ops(f);
  const nDotV = f.functionInput('nDotV', f32);
  const roughness = f.functionInput('roughness', f32);
  // At the centers of the texels of the edges at most: not past them.
  const size = f.engine('environment').swizzle('x');
  const half = o.div(0.5, size);
  const uv = o.clamp(
    o.vec2(nDotV, roughness),
    o.vec2(half, half),
    o.vec2(o.sub(1, half), o.sub(1, half)),
  );
  f.functionOutput(
    'scaleBias',
    tileTexel(f, o, uv, EnvironmentLevels + 1).swizzle('xy'),
  );
  return defineFunction(f.build(), {
    id: 'environment.brdf',
    description:
      'The scale and bias of F0 of the light of the environment reflected by a surface (the split sum of Karis), for N·V and the roughness.',
    registry,
  });
}

/** The environment functions of the standard library. */
export function createEnvironmentFunctions(
  registry: NodeRegistry,
): FunctionDefinition[] {
  const mapping = octahedral(registry);
  return [
    mapping,
    octahedralDirection(registry),
    equirect(registry),
    equirectDirection(registry),
    radiance(registry, mapping),
    irradiance(registry, mapping),
    brdf(registry),
  ];
}

/**
 * The light of the environment a surface reflects (image-based lighting):
 * its diffuse color × the irradiance of its normal, and the radiance of
 * the reflected direction, prefiltered for its roughness, × (F0 × scale +
 * bias) (the split sum). Used by the pbr shading model.
 *
 * Only with the 'environment' feature (given by the renderer with an
 * environment): without it, black, at no cost.
 *
 * @group Standard library
 */
export const light: MacroDefinition = {
  id: 'environment.light',
  category: 'macro',
  description:
    'The light of the environment a surface reflects (black without the environment feature).',
  inputs: () => [
    { name: 'normal', type: vec3 },
    // Toward the eye.
    { name: 'view', type: vec3 },
    { name: 'diffuseColor', type: vec3 },
    { name: 'f0', type: vec3 },
    { name: 'roughness', type: f32 },
  ],
  outputs: () => [{ name: 'color', type: vec3 }],
  expand: (context) => {
    if (!context.feature('environment')) {
      return { color: { value: [0, 0, 0] } };
    }
    const add = (type: string, inputs: Record<string, unknown>) =>
      context.add(type, {}, inputs as never)();
    const normal = context.input('normal');
    const view = context.input('view');
    const roughness = context.input('roughness');
    const nDotV = add('std.max', {
      a: add('std.dot', { a: normal, b: view }),
      b: 0,
    });
    const reflected = add('std.reflect', {
      incident: add('std.mul', { a: view, b: -1 }),
      normal,
    });
    const scaleBias = add('environment.brdf', { nDotV, roughness });
    const specular = add('std.mul', {
      a: add('environment.radiance', { direction: reflected, roughness }),
      b: add('std.add', {
        a: add('std.mul', {
          a: context.input('f0'),
          b: { ...scaleBias, swizzle: 'x' },
        }),
        b: { ...scaleBias, swizzle: 'y' },
      }),
    });
    const diffuse = add('std.mul', {
      a: add('environment.irradiance', { normal }),
      b: context.input('diffuseColor'),
    });
    return { color: add('std.add', { a: diffuse, b: specular }) };
  },
};

export const environmentDefinitions = [light];
