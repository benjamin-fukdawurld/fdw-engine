import { arrayType, BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type {
  ConstantValue,
  MaterialGraphData,
  PortHandle,
  ShaderType,
} from '@fdw/engine-shader';

type Value = PortHandle | ConstantValue;

/**
 * Where the skinning runs:
 * - `compute`: a compute pass writes the skinned vertices into a buffer,
 *   read by the vertex stage of every pass (the camera, the shadows, the
 *   ray tracing to come). WebGPU and Vulkan.
 * - `vertex`: the vertex stage of each pass skins its vertex, from the
 *   joint matrices in a texture. Every backend, WebGL2 included.
 */
export type SkinningMode = 'compute' | 'vertex';

/**
 * The names of the values the skinning sets on its materials and kernel.
 */
export const SkinValues = {
  // Vertex: the joint matrices, a row of 4 texels (the columns) per joint
  // (rgba32float).
  jointTexture: 'skinJointTexture',
  // Compute: the same matrices, 4 vec4 per joint.
  jointMatrices: 'skinJointMatrices',
  // Compute: the vertices of the mesh, `stride` vec4 per vertex: the
  // position (w = 1), the normal, the tangent (w: its sign).
  rest: 'skinRest',
  // Compute: the joints (vec4u) and the weights (vec4f) of each vertex.
  joints: 'skinJoints',
  weights: 'skinWeights',
  // Compute: the vertices skinned, as `rest`.
  vertices: 'skinnedVertices',
} as const;

/** The attributes the skinning deforms, besides the position. */
export interface SkinnedAttributes {
  readonly normal: boolean;
  readonly tangent: boolean;
}

/** The vec4 per vertex of the buffers of the compute skinning. */
export const skinStride = (attributes: SkinnedAttributes): number =>
  1 + (attributes.normal ? 1 : 0) + (attributes.tangent ? 1 : 0);

const components = ['x', 'y', 'z', 'w'] as const;

function helpers(g: GraphBuilder) {
  const call = (fn: Parameters<GraphBuilder['call']>[0], inputs: object) =>
    g.call(fn, inputs as Record<string, Value>);
  const convert = (value: Value, to: ShaderType) =>
    g.call(std.convert, { value }, { params: { to } });
  const add = (a: Value, b: Value) => call(std.add, { a, b });
  const mul = (a: Value, b: Value) => call(std.mul, { a, b });
  // m × v, the matrix given by its columns: c0 x + c1 y + c2 z (+ c3 w).
  const transform = (
    columns: readonly PortHandle[],
    v: PortHandle,
    w: 0 | 1,
  ) => {
    let sum = add(
      add(mul(columns[0], v.swizzle('x')), mul(columns[1], v.swizzle('y'))),
      mul(columns[2], v.swizzle('z')),
    );
    if (w === 1) {
      sum = add(sum, columns[3]);
    }
    return sum.swizzle('xyz');
  };
  // The columns of Σ weight_i × matrix(joint_i): the matrices blended once,
  // then applied to the position, the normal and the tangent.
  const blend = (
    joints: PortHandle,
    weights: PortHandle,
    column: (joint: PortHandle, k: number) => PortHandle,
  ) =>
    [0, 1, 2, 3].map((k) =>
      components
        .map((c) => mul(column(joints.swizzle(c), k), weights.swizzle(c)))
        .reduce((a, b) => add(a, b)),
    );
  return { call, convert, add, mul, transform, blend };
}

/**
 * Skins a vertex in the vertex stage, from the joint matrices in a
 * texture: the position, the normal and the tangent of the mesh
 * (`g.meshAttribute`) become those of the graph (`g.vertexAttribute`),
 * read by the surface, the macros and the shadows.
 */
export function skinInVertexStage(
  g: GraphBuilder,
  attributes: SkinnedAttributes,
): void {
  const { convert, call, transform, blend } = helpers(g);
  const texture = g.texture(SkinValues.jointTexture, {
    sampleType: 'unfilterable-float',
  });
  const f32 = (value: Value) => convert(value, BuiltinTypes.f32);
  const columns = blend(
    g.meshAttribute('joints', BuiltinTypes.vec4u),
    g.meshAttribute('weights', BuiltinTypes.vec4f),
    (joint, k) =>
      g.call(std.textureLoad, {
        texture,
        coords: convert(
          call(std.vec2, { x: k, y: f32(joint) }),
          BuiltinTypes.vec2i,
        ),
      }),
  );
  setSkinned(g, attributes, {
    position: transform(
      columns,
      g.meshAttribute('position', BuiltinTypes.vec3f),
      1,
    ),
    ...(attributes.normal
      ? {
          normal: transform(
            columns,
            g.meshAttribute('normal', BuiltinTypes.vec3f),
            0,
          ),
        }
      : {}),
    ...(attributes.tangent
      ? { tangent: g.meshAttribute('tangent', BuiltinTypes.vec4f) }
      : {}),
    columns,
  });
}

/**
 * Reads the vertex skinned by the compute pass, by its index, from the
 * buffer of the skinned vertices.
 */
export function readSkinnedVertex(
  g: GraphBuilder,
  attributes: SkinnedAttributes,
): void {
  const { add, mul } = helpers(g);
  const vertices = g.storage(
    SkinValues.vertices,
    arrayType(BuiltinTypes.vec4f),
  );
  const first = mul(
    g.builtin('vertex-index'),
    g.constant(BuiltinTypes.u32, skinStride(attributes)),
  );
  const at = (k: number) =>
    g.call(std.index, {
      array: vertices,
      index: k === 0 ? first : add(first, g.constant(BuiltinTypes.u32, k)),
    });
  g.vertexAttribute('position', at(0).swizzle('xyz'));
  if (attributes.normal) {
    g.vertexAttribute('normal', at(1).swizzle('xyz'));
  }
  if (attributes.tangent) {
    g.vertexAttribute('tangent', at(attributes.normal ? 2 : 1));
  }
}

// The skinned attributes of the graph: the normal and the tangent
// normalized, the sign of the tangent kept.
function setSkinned(
  g: GraphBuilder,
  attributes: SkinnedAttributes,
  values: {
    position: PortHandle;
    normal?: PortHandle;
    tangent?: PortHandle;
    columns: readonly PortHandle[];
  },
): void {
  const { call, transform } = helpers(g);
  g.vertexAttribute('position', values.position);
  if (attributes.normal && values.normal) {
    g.vertexAttribute('normal', call(std.normalize, { x: values.normal }));
  }
  if (attributes.tangent && values.tangent) {
    g.vertexAttribute(
      'tangent',
      call(std.extend, {
        xyz: call(std.normalize, {
          x: transform(values.columns, values.tangent.swizzle('xyz'), 0),
        }),
        w: values.tangent.swizzle('w'),
      }),
    );
  }
}

/**
 * The material graph of a skinned mesh: the graph of its material, its
 * position, normal and tangent skinned, in the vertex stage or read from
 * the compute pass.
 */
export function skinGraph(
  graph: MaterialGraphData,
  mode: SkinningMode,
  attributes: SkinnedAttributes,
): MaterialGraphData {
  const g = GraphBuilder.extend(graph, { name: `${graph.name} (skinned)` });
  if (mode === 'vertex') {
    skinInVertexStage(g, attributes);
  } else {
    readSkinnedVertex(g, attributes);
  }
  return g.build();
}

/**
 * The kernel of the compute skinning: a thread per vertex, the rest vertex
 * transformed by the blended matrices of its joints, written to the
 * buffer of the skinned vertices. One kernel per set of attributes.
 */
export function skinningKernel(
  attributes: SkinnedAttributes,
): MaterialGraphData {
  const name = `skinning${attributes.normal ? ' normal' : ''}${
    attributes.tangent ? ' tangent' : ''
  }`;
  const g = new GraphBuilder(name);
  const { call, add, mul, transform, blend } = helpers(g);
  const u32 = (value: number) => g.constant(BuiltinTypes.u32, value);
  const vertex = g.builtin('global-invocation-id').swizzle('x');
  const stride = skinStride(attributes);
  const vec4Array = arrayType(BuiltinTypes.vec4f);
  const rest = g.storage(SkinValues.rest, vec4Array);
  const matrices = g.storage(SkinValues.jointMatrices, vec4Array);
  const weights = g.storage(SkinValues.weights, vec4Array);
  const joints = g.storage(SkinValues.joints, arrayType(BuiltinTypes.vec4u));
  const out = g.storage(SkinValues.vertices, vec4Array, {
    access: 'read-write',
  });
  const index = (array: PortHandle, i: Value) =>
    g.call(std.index, { array, index: i });
  const columns = blend(
    index(joints, vertex),
    index(weights, vertex),
    (joint, k) => index(matrices, add(mul(joint, u32(4)), u32(k))),
  );
  const first = mul(vertex, u32(stride));
  const at = (k: number) => (k === 0 ? first : add(first, u32(k)));
  const when = call(std.less, {
    a: vertex,
    b: call(std.arrayLength, { array: weights }),
  });
  const write = (k: number, value: PortHandle) =>
    g.write(out, { index: at(k), value, when });
  write(
    0,
    call(std.extend, {
      xyz: transform(columns, index(rest, at(0)), 1),
      w: 1,
    }),
  );
  let k = 1;
  if (attributes.normal) {
    write(
      k,
      call(std.extend, {
        xyz: call(std.normalize, {
          x: transform(columns, index(rest, at(k)), 0),
        }),
        w: 0,
      }),
    );
    k++;
  }
  if (attributes.tangent) {
    const tangent = index(rest, at(k));
    write(
      k,
      call(std.extend, {
        xyz: call(std.normalize, { x: transform(columns, tangent, 0) }),
        w: tangent.swizzle('w'),
      }),
    );
  }
  g.compute({ workgroupSize: [64, 1, 1] });
  return g.build();
}
