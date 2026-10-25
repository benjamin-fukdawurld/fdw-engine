import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type {
  FunctionDefinition,
  NodeDefinition,
} from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { RayInstanceVec4s } from '../compiler/layout';
import { BuiltinTypes } from '../types/ShaderType';
import * as functions from './functions';

/**
 * Traces a ray in the scene (`input.engine` 'scene'), from `origin` along
 * `direction`, between `tMin` and `tMax` (in units of the length of the
 * direction), seeing the instances whose mask shares a bit with `mask`.
 * With `mode` 'closest' (default), the nearest hit; with 'any', the first
 * one found: enough to know whether something is in the way (a shadow).
 *
 * The hit is a vec4<u32>, read with the ray.hit* functions: x the instance
 * (0xffffffff when nothing is hit), y the triangle in its mesh (bit 31: seen
 * from the back), z and w the bits of the barycentric coordinates.
 *
 * Needs the rayQuery capability of the backend: rays traced by the GPU
 * (Vulkan) or by the code of the backend (WebGPU).
 *
 * @group Standard library
 */
export const trace: FunctionDefinition = {
  id: 'ray.trace',
  category: 'function',
  description: 'Traces a ray in the scene: the hit (see ray.hit*).',
  implementation: { kind: 'intrinsic', op: 'ray-query' },
  params: {
    mode: { kind: 'string', values: ['closest', 'any'], default: 'closest' },
  },
  inputs: () => [
    { name: 'scene', type: BuiltinTypes.accelerationStructure },
    { name: 'origin', type: BuiltinTypes.vec3f },
    { name: 'direction', type: BuiltinTypes.vec3f },
    { name: 'tMin', type: BuiltinTypes.f32, default: 0 },
    { name: 'tMax', type: BuiltinTypes.f32, default: 1e30 },
    { name: 'mask', type: BuiltinTypes.u32, default: 0xff },
  ],
  outputs: () => [{ name: 'result', type: BuiltinTypes.vec4u }],
};

/** The value of the x of a hit when the ray hits nothing. */
export const RayMiss = 0xffffffff;

export const rayDefinitions: readonly NodeDefinition[] = [trace];

const vec4u = BuiltinTypes.vec4u;
const { add, mul, sub, index, bitAnd, bitcast, notEqual, equal } = functions;

// The graph functions of the hits: what the materials and the passes read
// of the point hit by a ray, from the storage buffers of the traced scene
// (see RayInstanceVec4s).
export function createRayFunctions(
  registry: NodeRegistry,
): FunctionDefinition[] {
  const defined: FunctionDefinition[] = [];
  const define = (
    id: string,
    description: string,
    build: (f: GraphBuilder, hit: PortHandle) => PortHandle,
    output: string,
  ): FunctionDefinition => {
    const f = new GraphBuilder(id, registry);
    const hit = f.functionInput('hit', vec4u);
    f.functionOutput(output, build(f, hit));
    const definition = defineFunction(f.build(), { id, description, registry });
    registry.register(definition);
    defined.push(definition);
    return definition;
  };
  const u32 = (f: GraphBuilder, value: number) =>
    f.constant(BuiltinTypes.u32, value);
  // The instance hit; the first one for a miss, so that what is read of
  // a miss stays in the buffers (the backends without robust buffer
  // accesses would read anywhere).
  const instanceOf = (f: GraphBuilder, hit: PortHandle) =>
    f.call(functions.select, {
      ifFalse: hit.swizzle('x'),
      ifTrue: u32(f, 0),
      condition: f.call(equal, { a: hit.swizzle('x'), b: u32(f, RayMiss) }),
    });
  // The vec4 k of the record of the instance hit.
  const instanceVec = (f: GraphBuilder, hit: PortHandle, k: number) =>
    f.call(index, {
      array: f.call('input.engine', {}, { params: { value: 'rayInstances' } }),
      index: f.call(add, {
        a: f.call(mul, { a: instanceOf(f, hit), b: u32(f, RayInstanceVec4s) }),
        b: u32(f, k),
      }),
    });
  // The bits of the 7th vec4: first index, material, object, flags.
  const instanceWord = (f: GraphBuilder, hit: PortHandle, component: string) =>
    f.call(
      bitcast,
      { value: instanceVec(f, hit, 6).swizzle(component) },
      { params: { to: BuiltinTypes.u32 } },
    );

  const hitTest = define(
    'ray.hit',
    'Whether the ray hit something.',
    (f, hit) => f.call(notEqual, { a: hit.swizzle('x'), b: u32(f, RayMiss) }),
    'hit',
  );
  void hitTest;
  define(
    'ray.hitFrontFacing',
    'Whether the triangle hit was seen from its front.',
    (f, hit) =>
      f.call(equal, {
        a: f.call(bitAnd, { a: hit.swizzle('y'), b: u32(f, 0x80000000) }),
        b: u32(f, 0),
      }),
    'frontFacing',
  );
  const barycentrics = define(
    'ray.hitBarycentrics',
    'The weights of the three vertices of the triangle at the point hit.',
    (f, hit) => {
      const uv = f.call(
        bitcast,
        { value: hit.swizzle('zw') },
        { params: { to: BuiltinTypes.vec2f } },
      );
      return f.call(functions.vec3, {
        x: f.call(sub, {
          a: f.call(sub, { a: 1, b: uv.swizzle('x') }),
          b: uv.swizzle('y'),
        }),
        y: uv.swizzle('x'),
        z: uv.swizzle('y'),
      });
    },
    'weights',
  );
  const geometry = (f: GraphBuilder) =>
    f.call('input.engine', {}, { params: { value: 'rayGeometry' } });
  const vertices = define(
    'ray.hitVertices',
    'The vertices of the triangle hit: the vec4 of their records in the rayGeometry buffer.',
    (f, hit) => {
      const triangle = f.call(bitAnd, {
        a: hit.swizzle('y'),
        b: u32(f, 0x7fffffff),
      });
      const record = f.call(index, {
        array: geometry(f),
        index: f.call(add, { a: instanceWord(f, hit, 'x'), b: triangle }),
      });
      return f.call(
        bitcast,
        { value: record.swizzle('xyz') },
        { params: { to: BuiltinTypes.vec3u } },
      );
    },
    'indices',
  );
  // The interpolation of a vec4 of the vertices of the triangle hit.
  const interpolate = (f: GraphBuilder, hit: PortHandle, k: number) => {
    const weights = f.call(barycentrics, { hit });
    const corners = f.call(vertices, { hit });
    const data = geometry(f);
    const vertex = (component: string) =>
      f.call(index, {
        array: data,
        index: f.call(add, { a: corners.swizzle(component), b: u32(f, k) }),
      });
    return f.call(add, {
      a: f.call(add, {
        a: f.call(mul, { a: vertex('x'), b: weights.swizzle('x') }),
        b: f.call(mul, { a: vertex('y'), b: weights.swizzle('y') }),
      }),
      b: f.call(mul, { a: vertex('z'), b: weights.swizzle('z') }),
    });
  };
  const localPosition = define(
    'ray.hitLocalPosition',
    'The point hit, in the space of the object.',
    (f, hit) => interpolate(f, hit, 0).swizzle('xyz'),
    'position',
  );
  const localNormal = define(
    'ray.hitLocalNormal',
    'The normal of the vertices at the point hit (interpolated, in the space of the object).',
    (f, hit) => interpolate(f, hit, 1).swizzle('xyz'),
    'normal',
  );
  define(
    'ray.hitUv',
    'The uv of the vertices at the point hit (interpolated).',
    (f, hit) =>
      f.call(functions.vec2, {
        x: interpolate(f, hit, 0).swizzle('w'),
        y: interpolate(f, hit, 1).swizzle('w'),
      }),
    'uv',
  );
  define(
    'ray.hitLocalTangent',
    'The tangent of the vertices at the point hit (interpolated, in the space of the object; w the handedness).',
    (f, hit) => interpolate(f, hit, 2),
    'tangent',
  );
  const world = define(
    'ray.hitWorld',
    'The object to world matrix of the instance hit.',
    (f, hit) => {
      const rows = [0, 1, 2].map((k) => instanceVec(f, hit, k));
      const column = (c: string, w: number) =>
        f.call(functions.vec4, {
          x: rows[0].swizzle(c),
          y: rows[1].swizzle(c),
          z: rows[2].swizzle(c),
          w,
        });
      return f.call(functions.mat4, {
        c0: column('x', 0),
        c1: column('y', 0),
        c2: column('z', 0),
        c3: column('w', 1),
      });
    },
    'world',
  );
  void world;
  const normalMatrix = define(
    'ray.hitNormalMatrix',
    'The normal matrix of the instance hit.',
    (f, hit) =>
      f.call(functions.mat3, {
        c0: instanceVec(f, hit, 3).swizzle('xyz'),
        c1: instanceVec(f, hit, 4).swizzle('xyz'),
        c2: instanceVec(f, hit, 5).swizzle('xyz'),
      }),
    'normalMatrix',
  );
  define(
    'ray.hitPosition',
    'The point hit, in the world.',
    (f, hit) => {
      const point = f.call(functions.extend, {
        xyz: f.call(localPosition, { hit }),
        w: 1,
      });
      const row = (k: number) =>
        f.call(functions.dot, { a: instanceVec(f, hit, k), b: point });
      return f.call(functions.vec3, { x: row(0), y: row(1), z: row(2) });
    },
    'position',
  );
  define(
    'ray.hitNormal',
    'The normal of the vertices at the point hit, in the world (normalized).',
    (f, hit) =>
      f.call(functions.normalize, {
        x: f.call(functions.transform3, {
          matrix: f.call(normalMatrix, { hit }),
          vector: f.call(localNormal, { hit }),
        }),
      }),
    'normal',
  );
  define(
    'ray.hitGeometricNormal',
    'The normal of the triangle hit, in the world (normalized, on its front side).',
    (f, hit) => {
      const corners = f.call(vertices, { hit });
      const data = geometry(f);
      const position = (component: string) =>
        f.call(index, { array: data, index: corners.swizzle(component) })
          .swizzle('xyz');
      const p0 = position('x');
      const local = f.call(functions.cross, {
        a: f.call(sub, { a: position('y'), b: p0 }),
        b: f.call(sub, { a: position('z'), b: p0 }),
      });
      return f.call(functions.normalize, {
        x: f.call(functions.transform3, {
          matrix: f.call(normalMatrix, { hit }),
          vector: local,
        }),
      });
    },
    'normal',
  );
  define(
    'ray.hitMaterial',
    'The material of the instance hit: its index in the traced scene.',
    (f, hit) => instanceWord(f, hit, 'y'),
    'material',
  );
  define(
    'ray.hitObject',
    'The identifier of the object hit (0: none).',
    (f, hit) => instanceWord(f, hit, 'z'),
    'object',
  );
  define(
    'ray.hitFlags',
    'The flags of the instance hit (RayInstanceFlags).',
    (f, hit) => instanceWord(f, hit, 'w'),
    'flags',
  );
  define(
    'ray.hitData',
    'The vec4 of the application of the instance hit.',
    (f, hit) => instanceVec(f, hit, 7),
    'data',
  );
  return defined;
}
