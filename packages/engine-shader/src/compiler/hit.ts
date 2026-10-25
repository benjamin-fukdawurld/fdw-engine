import type { Diagnostic } from '../graph/Diagnostic';
import type { StaticValue } from '../graph/MaterialGraphData';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { resolveParams } from '../graph/NodeDefinition';
import type { ConstantValue } from '../types/ConstantValue';
import { arrayType, BuiltinTypes, ShaderType } from '../types/ShaderType';
import { RayMiss } from '../std/rays';
import type { InputSource, WorkingGraph } from './WorkingGraph';

// The "hit" target of the compiler (compile with target 'hit'): the surface
// of a material evaluated at the points hit by rays, in a compute program,
// for the passes that shade what rays hit (the reflections, the path
// tracer). One thread per ray: the hit of the ray, from the rayHits buffer;
// the threads whose hit is of another material, or none, do nothing. The
// surface is written to raySurfaces, RaySurfaceVec4s vec4 per ray (see
// RaySurfaceVec4s).

/**
 * The resources of the 'rays' slot of the hit programs: the hits (a
 * vec4<u32> per ray, from ray.trace), the surfaces written, the number of
 * rays, and the index of the material of the program in the traced scene.
 *
 * @group Compilation
 */
export const HitResources = {
  slot: 'rays',
  hits: 'rayHits',
  surfaces: 'raySurfaces',
  count: 'rayCount',
  material: 'rayMaterial',
} as const;

/**
 * The vec4 a hit program writes per ray, at ray × RaySurfaceVec4s:
 * 0. the base color (linear), and the alpha;
 * 1. the normal (world, turned towards the ray), and the roughness;
 * 2. the emission, and the metalness;
 * 3. the ambient occlusion, 1 for unlit materials (their color is all
 *    emission), the alpha cutoff (masked materials; -1 for the blended
 *    ones, whose alpha is a probability to go through; 0 for the opaque
 *    ones), 0;
 * 4. the point hit (world), and 1: the passes that light it need not read
 *    the geometry of the scene.
 *
 * @group Compilation
 */
export const RaySurfaceVec4s = 5;

const out = (node: string, port = 'result'): InputSource => ({
  ref: { node, port },
});

/**
 * Replaces 'output.surface' by the writes of the surface of the ray of the
 * thread, and 'output.compute' with its guard. Returns the node of the hit,
 * read by the attributes (lowerHitInputs).
 */
export function lowerHitSurface(
  graph: WorkingGraph,
  registry: NodeRegistry,
  diagnostics: Diagnostic[],
  feature: (name: string) => StaticValue | undefined,
): string | undefined {
  const surface = [...graph.nodes.values()].find(
    (node) => node.type === 'output.surface',
  );
  if (!surface) {
    diagnostics.push({
      severity: 'error',
      message: 'the hit target compiles the surface of a material (output.surface)',
    });
    return undefined;
  }
  const definition = registry.require('output.surface');
  const params = resolveParams(definition, surface.params);
  const model = params['shadingModel'] as string;
  const ports = definition.inputs(params, { registry });
  const source = (port: string): InputSource | undefined => {
    if (!ports.some((candidate) => candidate.name === port)) {
      return undefined;
    }
    return (
      graph.inputSource(surface, port) ??
      (() => {
        const value = ports.find((candidate) => candidate.name === port)
          ?.default;
        return value === undefined ? undefined : { value };
      })()
    );
  };
  const add = (
    type: string,
    inputs: Record<string, InputSource | undefined> = {},
    params: Readonly<Record<string, StaticValue>> = {},
  ) => graph.addNode(type, params, inputs);
  const constant = (value: ConstantValue): InputSource => ({ value });
  const { slot } = HitResources;

  // The ray of the thread, and its hit (read in the buffer, the index kept
  // in it).
  const index: InputSource = {
    ref: {
      node: add('input.builtin', {}, { builtin: 'global-invocation-id' }),
      port: 'value',
    },
    swizzle: 'x',
  };
  const hits = add('input.storage', {}, {
    name: HitResources.hits,
    type: arrayType(BuiltinTypes.vec4u),
    access: 'read',
    slot,
  });
  const surfaces = add('input.storage', {}, {
    name: HitResources.surfaces,
    type: arrayType(BuiltinTypes.vec4f),
    access: 'read-write',
    slot,
  });
  const count = add('input.uniform', {}, {
    name: HitResources.count,
    type: BuiltinTypes.u32,
    slot,
  });
  const material = add('input.uniform', {}, {
    name: HitResources.material,
    type: BuiltinTypes.u32,
    slot,
  });
  const last = add('std.sub', {
    a: out(add('std.arrayLength', { array: out(hits, 'value') })),
    b: constant(1),
  });
  const hit = add('std.index', {
    array: out(hits, 'value'),
    index: out(add('std.min', { a: index, b: out(last) })),
  });

  // The values of the surface, by model.
  const zero3 = constant([0, 0, 0]);
  let baseColor = source('baseColor') ?? constant([1, 1, 1]);
  let emissive = source('emissive') ?? zero3;
  const alpha = source('alpha') ?? constant(1);
  let roughness = source('roughness') ?? constant(0.5);
  const metallic = source('metallic') ?? constant(0);
  const occlusion = source('occlusion') ?? constant(1);
  let unlit = 0;
  if (model === 'unlit') {
    emissive = baseColor;
    baseColor = zero3;
    unlit = 1;
  } else if (model === 'phong') {
    // The roughness of a Blinn-Phong lobe of the same width.
    const shininess = source('shininess') ?? constant(32);
    roughness = out(
      add('std.sqrt', {
        x: out(
          add('std.div', {
            a: constant(2),
            b: out(add('std.add', { a: shininess, b: constant(2) })),
          }),
        ),
      }),
    );
  }
  // The normal: that of the surface, or of the vertices; turned towards
  // the ray (the back faces seen from inside, the leaves).
  const normal =
    source('normal') ??
    out(
      add('std.transform3', {
        matrix: out(
          add('input.engine', {}, { value: 'object.normalMatrix' }),
          'value',
        ),
        vector: out(
          add(
            'input.attribute',
            {},
            { semantic: 'normal', type: BuiltinTypes.vec3f },
          ),
          'value',
        ),
      }),
    );
  const facing = add('input.builtin', {}, { builtin: 'front-facing' });
  const unit = out(add('std.normalize', { x: normal }));
  const turned = out(
    add('std.select', {
      ifFalse: out(add('std.mul', { a: unit, b: constant(-1) })),
      ifTrue: unit,
      condition: out(facing, 'value'),
    }),
  );
  const alphaMode = feature('alphaMode') ?? 'opaque';
  const cutoff: InputSource =
    alphaMode === 'mask'
      ? out(
          add('input.uniform', {}, {
            name: 'alphaCutoff',
            type: BuiltinTypes.f32,
            default: 0.5,
          }),
          'value',
        )
      : constant(alphaMode === 'blend' ? -1 : 0);

  const vec4 = (xyz: InputSource, w: InputSource) =>
    out(add('std.extend', { xyz, w }));
  const values = [
    vec4(baseColor, alphaMode === 'opaque' ? constant(1) : alpha),
    vec4(turned, roughness),
    vec4(emissive, metallic),
    out(
      add('std.vec4', {
        x: occlusion,
        y: constant(unlit),
        z: cutoff,
        w: constant(0),
      }),
    ),
    vec4(out(add('ray.hitPosition', { hit: out(hit) }), 'position'), constant(1)),
  ];
  const base = out(add('std.mul', { a: index, b: constant(RaySurfaceVec4s) }));
  values.forEach((value, k) =>
    add('write.storage', {
      array: out(surfaces, 'value'),
      index: out(add('std.add', { a: base, b: constant(k) })),
      value,
    }),
  );

  // The guard: a ray of the dispatch, which hit this material.
  const inRange = out(
    add('std.less', { a: index, b: out(count, 'value') }),
  );
  const hitSomething = out(
    add('std.notEqual', {
      a: { ref: { node: hit, port: 'result' }, swizzle: 'x' },
      b: constant(RayMiss),
    }),
  );
  const ofMaterial = out(
    add('std.equal', {
      a: out(add('ray.hitMaterial', { hit: out(hit) }), 'material'),
      b: out(material, 'value'),
    }),
  );
  const and = (a: InputSource, b: InputSource) =>
    out(add('std.select', { ifFalse: constant(false), ifTrue: b, condition: a }));
  graph.addNode(
    'output.compute',
    { workgroupSize: [64, 1, 1] },
    { active: and(inRange, and(hitSomething, ofMaterial)) },
  );

  graph.removeNode(surface.id);
  for (const node of [...graph.nodes.values()]) {
    if (node.type === 'output.value') {
      graph.removeNode(node.id);
    }
  }
  return hit;
}

// What the hit functions give for the vertex attributes.
const hitAttributes: Record<string, { fn: string; port: string; size: number }> =
  {
    position: { fn: 'ray.hitLocalPosition', port: 'position', size: 3 },
    normal: { fn: 'ray.hitLocalNormal', port: 'normal', size: 3 },
    uv: { fn: 'ray.hitUv', port: 'uv', size: 2 },
    tangent: { fn: 'ray.hitLocalTangent', port: 'tangent', size: 4 },
  };

/** The attributes the hit programs have: those of the traced vertices. */
export const HitAttributes = Object.keys(hitAttributes);

const sizeOf = (type: ShaderType) =>
  type.kind === 'vector' ? type.size : type.kind === 'scalar' ? 1 : 0;

/**
 * Replaces what a surface reads of its vertex, its object and its pixel by
 * what the hit of the ray gives: the attributes interpolated at the point
 * hit, the matrices and the identifier of the instance, the face hit. The
 * textures are sampled at their first level, the derivatives are 0.
 */
export function lowerHitInputs(
  graph: WorkingGraph,
  hit: string,
  diagnostics: Diagnostic[],
): void {
  const hitSource = out(hit);
  const call = (fn: string, port: string): InputSource =>
    out(graph.addNode(fn, {}, { hit: hitSource }), port);
  const replace = (id: string, port: string, source: InputSource) => {
    if ('value' in source) {
      const constant = graph.addNode('const.value', {
        type: typeOfConstant(source.value),
        value: source.value,
      });
      graph.redirectPort({ node: id, port }, { ref: { node: constant, port: 'value' } });
    } else {
      graph.redirectPort(
        { node: id, port },
        source.swizzle ? { ref: source.ref, swizzle: source.swizzle } : { ref: source.ref },
      );
    }
    graph.removeNode(id);
  };

  for (const node of [...graph.nodes.values()]) {
    const { params } = node;
    switch (node.type) {
      case 'input.attribute': {
        const type = params['type'] as ShaderType;
        const size = sizeOf(type);
        const semantic = params['semantic'] as string;
        const known = hitAttributes[semantic];
        if (!known || type.kind === 'scalar' || size === 0) {
          // Absent from the traced vertices: zero.
          const zero = type.kind === 'scalar' ? 0 : new Array(size).fill(0);
          const constant = graph.addNode('const.value', { type, value: zero });
          replace(node.id, 'value', out(constant, 'value'));
          break;
        }
        let value = call(known.fn, known.port);
        if (size < known.size) {
          value = { ...(value as { ref: never }), swizzle: 'xyzw'.slice(0, size) };
        } else if (size === 4 && known.size === 3) {
          // A position or a normal read as a vec4: w = 1 for the position.
          value = out(
            graph.addNode('std.extend', {}, {
              xyz: value,
              w: { value: semantic === 'position' ? 1 : 0 },
            }),
          );
        } else if (size > known.size) {
          diagnostics.push({
            severity: 'error',
            node: node.id,
            message: `the ${semantic} of the points hit has ${known.size} components, not ${size}`,
          });
          break;
        }
        replace(node.id, 'value', value);
        break;
      }
      case 'input.engine': {
        const value = params['value'];
        if (value === 'object.world') {
          replace(node.id, 'value', call('ray.hitWorld', 'world'));
        } else if (value === 'object.normalMatrix') {
          replace(node.id, 'value', call('ray.hitNormalMatrix', 'normalMatrix'));
        } else if (value === 'object.id') {
          replace(node.id, 'value', call('ray.hitObject', 'object'));
        }
        break;
      }
      case 'input.builtin': {
        const builtin = params['builtin'];
        if (builtin === 'front-facing') {
          replace(node.id, 'value', call('ray.hitFrontFacing', 'frontFacing'));
        } else if (builtin === 'frag-coord') {
          replace(node.id, 'value', { value: [0, 0, 0, 1] });
        } else if (builtin === 'screen-uv') {
          replace(node.id, 'value', { value: [0, 0] });
        } else if (
          builtin === 'vertex-index' ||
          builtin === 'instance-index' ||
          builtin === 'object-index'
        ) {
          diagnostics.push({
            severity: 'error',
            node: node.id,
            message: `${String(builtin)} has no value at the points hit by rays`,
          });
        }
        break;
      }
      case 'std.textureSample':
      case 'std.textureSampleCube': {
        // The first level: no derivatives in a compute stage.
        const level = graph.addNode(
          node.type === 'std.textureSample'
            ? 'std.textureSampleLevel'
            : 'std.textureSampleCubeLevel',
          {},
          {
            texture: graph.inputSource(node, 'texture'),
            sampler: graph.inputSource(node, 'sampler'),
            ...(node.type === 'std.textureSample'
              ? { uv: graph.inputSource(node, 'uv') }
              : { direction: graph.inputSource(node, 'direction') }),
            level: { value: 0 },
          },
        );
        replace(node.id, 'result', out(level));
        break;
      }
      case 'std.dpdx':
      case 'std.dpdy':
      case 'std.fwidth': {
        const zero = graph.addNode('std.mul', {}, {
          a: graph.inputSource(node, 'x'),
          b: { value: 0 },
        });
        replace(node.id, 'result', out(zero));
        break;
      }
      case 'std.perFragment': {
        const value = graph.inputSource(node, 'value');
        if (value) {
          replace(node.id, 'result', value);
        }
        break;
      }
      case 'output.attribute':
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message:
            'the attributes computed in the vertex stage (output.attribute) have no value at the points hit by rays',
        });
        break;
    }
  }
}

// The type of a constant of a replaced port.
function typeOfConstant(value: ConstantValue): ShaderType {
  if (typeof value === 'boolean') {
    return BuiltinTypes.bool;
  }
  if (typeof value === 'number') {
    return BuiltinTypes.f32;
  }
  const size = (value as readonly number[]).length;
  return size === 2
    ? BuiltinTypes.vec2f
    : size === 3
      ? BuiltinTypes.vec3f
      : BuiltinTypes.vec4f;
}
