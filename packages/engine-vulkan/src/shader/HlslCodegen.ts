import type {
  PhysicalBinding,
  PhysicalProgramLayout,
  ShaderCodegen,
  ShaderSources,
} from '@fdw/engine-backend';
import {
  ConstantValue,
  IrEntryPoint,
  IrInstruction,
  IrStageVariable,
  LogicalBinding,
  RayAlphaMaskSize,
  RayInstanceFlags,
  RayInstanceVec4s,
  ShaderModuleIR,
  ShaderType,
  typeToString,
} from '@fdw/engine-shader';

// HLSL (Shader Model 6, HLSL 2021), for two targets:
// - Vulkan, compiled to SPIR-V by DXC: `dxc -spirv -HV 2021
//   -fvk-use-gl-layout` (see dxcArguments). The bindings are Vulkan
//   descriptor sets and bindings ([[vk::binding]]), the uniform block
//   members have the offsets of the physical layout ([[vk::offset]]).
// - Direct3D 12, compiled to DXIL: the bindings are registers, the group
//   being the register space. The offsets of the physical layout (std140,
//   std430) are kept: uniform blocks are cbuffers whose members are placed
//   with packoffset, structured buffers have explicit padding.
// Matrices are column-major, as in the rest of the engine: `mul(m, v)` is
// the product of the matrix by a column vector.

/** The API the HLSL is compiled for. */
export type HlslTarget = 'vulkan' | 'd3d12';

/**
 * Direct3D 12: the register space of the constants the backend sets for
 * each draw or dispatch (root constants at b0): the first instance of a
 * draw, the number of workgroups of a dispatch.
 */
export const D3D12ConstantsSpace = 100;

const scalarNames: Record<string, string> = {
  f32: 'float',
  i32: 'int',
  u32: 'uint',
  bool: 'bool',
};

const textureNames: Record<string, string> = {
  '1d': 'Texture1D',
  '2d': 'Texture2D',
  '2d-array': 'Texture2DArray',
  '3d': 'Texture3D',
  cube: 'TextureCube',
  'cube-array': 'TextureCubeArray',
};

const sampledTypes = {
  float: 'float4',
  'unfilterable-float': 'float4',
  sint: 'int4',
  uint: 'uint4',
  // Depth textures read a single depth.
  depth: 'float',
} as const;

export function hlslType(type: ShaderType): string {
  const unsupported = () =>
    new Error(`${typeToString(type)} is not supported by the HLSL generator`);
  switch (type.kind) {
    case 'scalar': {
      const name = scalarNames[type.scalar];
      if (!name) {
        throw unsupported();
      }
      return name;
    }
    case 'vector': {
      const name = scalarNames[type.scalar];
      if (!name) {
        throw unsupported();
      }
      return `${name}${type.size}`;
    }
    case 'matrix':
      if (type.scalar !== 'f32') {
        throw unsupported();
      }
      // HLSL names matrices rows × columns.
      return `float${type.rows}x${type.columns}`;
    case 'texture': {
      const sampled = sampledTypes[type.sampleType];
      if (type.multisampled) {
        return `Texture2DMS<${sampled}>`;
      }
      const name = textureNames[type.dimension];
      if (!name) {
        throw unsupported();
      }
      return `${name}<${sampled}>`;
    }
    case 'sampler':
      return type.comparison ? 'SamplerComparisonState' : 'SamplerState';
    default:
      throw unsupported();
  }
}

// A declaration: arrays put their length after the name.
function declaration(type: ShaderType, name: string): string {
  if (type.kind === 'array') {
    if (type.length === undefined) {
      throw new Error(
        `${typeToString(type)}: runtime-sized arrays are storage buffers`,
      );
    }
    return `${declaration(type.element, name)}[${type.length}]`;
  }
  return `${hlslType(type)} ${name}`;
}

function floatLiteral(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function scalarLiteral(value: number | boolean, scalar: string): string {
  if (typeof value === 'boolean') {
    return String(value);
  }
  switch (scalar) {
    case 'i32':
      return String(value);
    case 'u32':
      return `${value}u`;
    default:
      return floatLiteral(value);
  }
}

function literal(type: ShaderType, value: ConstantValue): string {
  if (type.kind === 'scalar') {
    return scalarLiteral(value as number | boolean, type.scalar);
  }
  const components = value as readonly number[];
  if (type.kind === 'vector') {
    return `${hlslType(type)}(${components
      .map((component) => scalarLiteral(component, type.scalar))
      .join(', ')})`;
  }
  if (type.kind === 'matrix') {
    // The constant is column-major; HLSL constructors take rows.
    const rows: string[] = [];
    for (let row = 0; row < type.rows; row++) {
      for (let column = 0; column < type.columns; column++) {
        rows.push(floatLiteral(components[column * type.rows + row]));
      }
    }
    return `${hlslType(type)}(${rows.join(', ')})`;
  }
  throw new Error(`Cannot write a ${typeToString(type)} literal`);
}

const intrinsicNames: Record<string, string> = {
  fract: 'frac',
  mix: 'lerp',
  dpdx: 'ddx',
  dpdy: 'ddy',
};

// Textures, samplers, arrays and buffers are used inline: HLSL cannot copy
// them into a local (textures, samplers), or would copy them (arrays).
const isInline = (type: ShaderType) =>
  type.kind === 'texture' ||
  type.kind === 'sampler' ||
  type.kind === 'array' ||
  type.kind === 'acceleration-structure';

const identifier = (text: string) =>
  text.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');

const structName = (name: string) =>
  name.charAt(0).toUpperCase() + name.slice(1);

// Names chosen by the user are prefixed, so that they collide with neither
// the HLSL keywords nor its intrinsics; the names generated by the compiler
// are kept.
const memberIdentifier = (name: string) => `u_${name}`;

function resourceIdentifier(resource: LogicalBinding): string {
  switch (resource.kind) {
    case 'uniform-block':
      return resource.name;
    case 'texture':
      return `t_${resource.name}`;
    case 'sampler':
      return `s_${resource.name}`;
    case 'storage-buffer':
      return `b_${resource.name}`;
    case 'object-table':
      return resource.name;
    case 'acceleration-structure':
      return `as_${resource.name}`;
  }
}

// The function tracing rays against a structure (see rayFunctions).
const traceFunction = (
  structure: string,
  mode: 'closest' | 'any',
  alphaTest = false,
) => `fdw_trace_${alphaTest ? 'alpha_' : ''}${mode}_${structure}`;

// Ray queries against a structure: the hit of the ray-query instruction of
// the IR (instance, triangle with bit 31 for the back faces, barycentrics).
function rayFunctions(structure: string): string {
  return (['closest', 'any'] as const)
    .map(
      (mode) => `uint4 ${traceFunction(structure, mode)}(float3 origin, float3 direction, float tMin, float tMax, uint mask) {
  // An empty interval (a ray that is not traced): no hit.
  if (!(tMax >= tMin)) {
    return uint4(0xffffffffu, 0u, 0u, 0u);
  }
  RayDesc ray;
  ray.Origin = origin;
  ray.Direction = direction;
  ray.TMin = tMin;
  ray.TMax = tMax;
  RayQuery<RAY_FLAG_FORCE_OPAQUE${
    mode === 'any' ? ' | RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH' : ''
  }> query;
  query.TraceRayInline(${structure}, RAY_FLAG_NONE, mask & 0xffu, ray);
  while (query.Proceed()) {
  }
  if (query.CommittedStatus() != COMMITTED_TRIANGLE_HIT) {
    return uint4(0xffffffffu, 0u, 0u, 0u);
  }
  const float2 uv = query.CommittedTriangleBarycentrics();
  const uint back = query.CommittedTriangleFrontFace() ? 0u : 0x80000000u;
  return uint4(query.CommittedInstanceIndex(), query.CommittedPrimitiveIndex() | back, asuint(uv.x), asuint(uv.y));
}`,
    )
    .join('\n\n');
}

// The ray queries with alpha test (ray.traceAlpha): the structure is traced
// without forcing the instances opaque; the candidate triangles of those
// that are not (their material is masked) are kept where the alpha mask of
// their material is (RayAlphaMaskSize), read from the buffers of the scene
// at the uv of the candidate point.
function alphaRayFunctions(
  structure: string,
  // The expressions of an element of the buffers of the scene.
  instances: (index: string) => string,
  geometry: (index: string) => string,
  // Only the test (the any-hit shader of a ray tracing pipeline calls it).
  testOnly = false,
): string {
  const kept = keptFunction(structure);
  return [
    `bool ${kept}(uint instance, uint primitive, float2 barycentrics) {
  const uint4 info = asuint(${instances(`instance * ${RayInstanceVec4s}u + 6u`)});
  if ((info.w & ${RayInstanceFlags.alphaTest}u) == 0u) {
    return true;
  }
  const uint3 corners = asuint(${geometry('info.x + primitive')}.xyz);
  const float3 w = float3(1.0 - barycentrics.x - barycentrics.y, barycentrics.x, barycentrics.y);
  const float s = dot(w, float3(${geometry('corners.x')}.w, ${geometry('corners.y')}.w, ${geometry('corners.z')}.w));
  const float t = dot(w, float3(${geometry('corners.x + 1u')}.w, ${geometry('corners.y + 1u')}.w, ${geometry('corners.z + 1u')}.w));
  const uint2 texel = min(uint2(frac(float2(s, t)) * ${RayAlphaMaskSize}.0), uint2(${RayAlphaMaskSize - 1}u, ${RayAlphaMaskSize - 1}u));
  const uint bit = texel.y * ${RayAlphaMaskSize}u + texel.x;
  const uint4 word = asuint(${geometry(`(info.w >> 8u) + bit / 128u`)});
  return ((word[(bit / 32u) % 4u] >> (bit % 32u)) & 1u) != 0u;
}`,
    ...(testOnly ? [] : (['closest', 'any'] as const)).map(
      (mode) => `uint4 ${traceFunction(structure, mode, true)}(float3 origin, float3 direction, float tMin, float tMax, uint mask) {
  // An empty interval (a ray that is not traced): no hit.
  if (!(tMax >= tMin)) {
    return uint4(0xffffffffu, 0u, 0u, 0u);
  }
  RayDesc ray;
  ray.Origin = origin;
  ray.Direction = direction;
  ray.TMin = tMin;
  ray.TMax = tMax;
  RayQuery<${
    mode === 'any' ? 'RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH' : 'RAY_FLAG_NONE'
  }> query;
  query.TraceRayInline(${structure}, RAY_FLAG_NONE, mask & 0xffu, ray);
  while (query.Proceed()) {
    if (query.CandidateType() == CANDIDATE_NON_OPAQUE_TRIANGLE &&
        ${kept}(query.CandidateInstanceIndex(), query.CandidatePrimitiveIndex(), query.CandidateTriangleBarycentrics())) {
      query.CommitNonOpaqueTriangleHit();
    }
  }
  if (query.CommittedStatus() != COMMITTED_TRIANGLE_HIT) {
    return uint4(0xffffffffu, 0u, 0u, 0u);
  }
  const float2 uv = query.CommittedTriangleBarycentrics();
  const uint back = query.CommittedTriangleFrontFace() ? 0u : 0x80000000u;
  return uint4(query.CommittedInstanceIndex(), query.CommittedPrimitiveIndex() | back, asuint(uv.x), asuint(uv.y));
}`,
    ),
  ].join('\n\n');
}

// The test of the alpha masks of a structure (see alphaRayFunctions).
const keptFunction = (structure: string) => `fdw_kept_${structure}`;

// The payload of the rays of a ray tracing pipeline: the hit, as the
// ray-query instruction of the IR gives it.
const payload = `struct FdwPayload {
  uint4 hit;
};`;

// A ray of a ray generation shader: TraceRay, its hit written in the
// payload by the closest-hit shader (the miss shader for none). Opaque but
// with alpha test; the rays of an empty interval hit nothing.
function tracedRayFunction(
  name: string,
  structure: string,
  mode: 'closest' | 'any',
  alphaTest: boolean,
): string {
  const flags = [
    ...(alphaTest ? [] : ['RAY_FLAG_FORCE_OPAQUE']),
    ...(mode === 'any' ? ['RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH'] : []),
  ];
  return `uint4 ${name}(float3 origin, float3 direction, float tMin, float tMax, uint mask) {
  FdwPayload payload;
  payload.hit = uint4(0xffffffffu, 0u, 0u, 0u);
  if (!(tMax > tMin)) {
    return payload.hit;
  }
  RayDesc ray;
  ray.Origin = origin;
  ray.Direction = direction;
  ray.TMin = tMin;
  ray.TMax = tMax;
  TraceRay(${structure}, ${flags.join(' | ') || 'RAY_FLAG_NONE'}, mask & 0xffu, 0, 1, 0, ray, payload);
  return payload.hit;
}`;
}

/**
 * The entry points of a ray tracing pipeline besides its ray generation
 * shader (rg_main): the miss shader (ms_main), the closest-hit shader
 * (ch_main) writing the hit in the payload, and with alpha test, the
 * any-hit shader (ah_main) ignoring the candidates cut by the alpha masks.
 */
export const RayTracingEntryPoints = {
  generation: 'rg_main',
  miss: 'ms_main',
  closestHit: 'ch_main',
  anyHit: 'ah_main',
} as const;

function rayTracingShaders(resources: Resources): string[] {
  const alpha = [...resources.alphaTested];
  if (alpha.length > 1) {
    throw new Error('A ray tracing pipeline tests the alpha of one structure');
  }
  return [
    `[shader("miss")]
void ${RayTracingEntryPoints.miss}(inout FdwPayload payload) {
  payload.hit = uint4(0xffffffffu, 0u, 0u, 0u);
}`,
    `[shader("closesthit")]
void ${RayTracingEntryPoints.closestHit}(inout FdwPayload payload, in BuiltInTriangleIntersectionAttributes attributes) {
  const uint back = HitKind() == HIT_KIND_TRIANGLE_FRONT_FACE ? 0u : 0x80000000u;
  payload.hit = uint4(InstanceIndex(), PrimitiveIndex() | back, asuint(attributes.barycentrics.x), asuint(attributes.barycentrics.y));
}`,
    ...alpha.map(
      (structure) => `[shader("anyhit")]
void ${RayTracingEntryPoints.anyHit}(inout FdwPayload payload, in BuiltInTriangleIntersectionAttributes attributes) {
  if (!${keptFunction(structure)}(InstanceIndex(), PrimitiveIndex(), attributes.barycentrics)) {
    IgnoreHit();
  }
}`,
    ),
  ];
}

// The second buffer of an object table: the row of each instance.
const instancesIdentifier = (table: string) => `${table}Instances`;

// The key of the object table in the identifiers of the resources.
const ObjectTableKey = '#object-table';

// The resources of a program, as the code names them.
interface Resources {
  readonly target: HlslTarget;
  // The identifiers of the resources, by binding name.
  readonly names: Map<string, string>;
  // Direct3D 12: the uniform blocks, cbuffers whose members are globals.
  readonly blocks: Set<string>;
  // Direct3D 12: the structured buffers whose elements are wrapped in a
  // padded structure, read through `.value`.
  readonly wrapped: Set<string>;
  // Direct3D 12: the members of the object rows stored with padded columns
  // (a mat3 as a float4x3), and the cast that reads them.
  readonly rowCasts: Map<string, string>;
  // The functions the code calls besides those of its resources (the ray
  // queries with alpha test), by name: declared before the entry points.
  readonly helpers: Map<string, string>;
  // A ray generation shader (see rayTracingShaders): its rays traced by
  // TraceRay, the shaders of its hits after it.
  readonly rayGeneration: boolean;
  // The structures traced with alpha test, by the any-hit shader.
  readonly alphaTested: Set<string>;
}

// Direct3D 12: a member of a uniform block, a global of its cbuffer.
const blockMember = (block: string, member: string) =>
  `${block}_${memberIdentifier(member)}`;

// The identifier of the object table of the layout.
function objectTable(resources: Resources): string {
  const table = resources.names.get(ObjectTableKey);
  if (!table) {
    throw new Error('The layout has no object table');
  }
  return table;
}

// The builtins read by the stages: parameters of the entry points, with
// their system value semantic.
const builtinParameters = {
  'vertex-index': {
    name: 'vertexIndex',
    declaration: 'uint vertexIndex : SV_VertexID',
  },
  'instance-index': {
    name: 'instanceIndex',
    declaration: 'uint instanceIndex : SV_InstanceID',
  },
  'front-facing': {
    name: 'frontFacing',
    declaration: 'bool frontFacing : SV_IsFrontFace',
  },
  'global-invocation-id': {
    name: 'globalInvocationId',
    declaration: 'uint3 globalInvocationId : SV_DispatchThreadID',
  },
  'local-invocation-id': {
    name: 'localInvocationId',
    declaration: 'uint3 localInvocationId : SV_GroupThreadID',
  },
  'workgroup-id': {
    name: 'workgroupId',
    declaration: 'uint3 workgroupId : SV_GroupID',
  },
} as const;

// HLSL has no system value for the number of workgroups: on Vulkan, the
// SPIR-V builtin is declared directly (NumWorkgroups is BuiltIn 24); on
// Direct3D 12, the backend sets it as root constants.
const numWorkgroups = {
  name: 'gl_NumWorkGroups',
  declaration: {
    vulkan:
      '[[vk::ext_builtin_input(24)]] static const uint3 gl_NumWorkGroups;',
    d3d12: `cbuffer FdwDispatch : register(b0, space${D3D12ConstantsSpace}) {
  uint3 gl_NumWorkGroups;
};`,
  },
};

// Direct3D 12: SV_InstanceID starts at 0 whatever the first instance of the
// draw, which the backend sets as a root constant.
const firstInstance = {
  name: 'fdw_firstInstance',
  declaration: `cbuffer FdwDraw : register(b0, space${D3D12ConstantsSpace}) {
  uint fdw_firstInstance;
};`,
};

// The instance index, the first instance of the draw included (as
// InstanceIndex of Vulkan, instance_index of WGSL).
const instanceIndex = (target: HlslTarget) =>
  target === 'd3d12'
    ? `(${builtinParameters['instance-index'].name} + ${firstInstance.name})`
    : builtinParameters['instance-index'].name;

interface BodyState {
  readonly lines: string[];
  readonly expressions: Map<number, string>;
  readonly types: Map<number, ShaderType>;
  readonly builtins: Set<string>;
}

const valueName = (instruction: IrInstruction) =>
  `v${instruction.id}${
    instruction.name ? `_${identifier(instruction.name)}` : ''
  }`;

function emitBody(entryPoint: IrEntryPoint, resources: Resources): BodyState {
  const state: BodyState = {
    lines: [],
    expressions: new Map(),
    types: new Map(),
    builtins: new Set(),
  };
  const { active } = entryPoint;
  if (active) {
    // The threads out of the guard stop once it is known.
    emitInstructions(entryPoint.body.slice(0, active.after), resources, state, '  ');
    state.lines.push(
      `  if (!(${state.expressions.get(active.value)})) {`,
      '    return;',
      '  }',
    );
    emitInstructions(entryPoint.body.slice(active.after), resources, state, '  ');
  } else {
    emitInstructions(entryPoint.body, resources, state, '  ');
  }
  return state;
}

function emitInstructions(
  body: readonly IrInstruction[],
  resources: Resources,
  state: BodyState,
  indent: string,
): void {
  const { lines, expressions, types, builtins } = state;
  const arg = (instruction: IrInstruction, index: number) =>
    expressions.get(instruction.args[index]) as string;
  const argType = (instruction: IrInstruction, index: number) =>
    types.get(instruction.args[index]);
  const args = (instruction: IrInstruction) =>
    instruction.args.map((_, i) => arg(instruction, i)).join(', ');

  for (const instruction of body) {
    const { op, type } = instruction;
    types.set(instruction.id, type);
    let expression: string;
    switch (op.kind) {
      case 'loop-sum': {
        const sum = valueName(instruction);
        const index = `v${op.index}`;
        const count = arg(instruction, 0);
        lines.push(
          `${indent}${hlslType(type)} ${sum} = (${hlslType(type)})0;`,
          `${indent}for (uint ${index} = 0u; ${index} < ${count}; ${index} = ${index} + 1u) {`,
        );
        expressions.set(op.index, index);
        types.set(op.index, { kind: 'scalar', scalar: 'u32' });
        emitInstructions(op.body, resources, state, `${indent}  `);
        lines.push(
          `${indent}  ${sum} = ${sum} + ${expressions.get(op.result)};`,
          `${indent}}`,
        );
        expressions.set(instruction.id, sum);
        continue;
      }
      case 'loop-fold': {
        // The state lives in a variable, read by the body as it is at the
        // start of the iteration and written at its end.
        const fold = valueName(instruction);
        const index = `v${op.index}`;
        lines.push(
          `${indent}${hlslType(type)} ${fold} = ${arg(instruction, 1)};`,
          `${indent}for (uint ${index} = 0u; ${index} < ${arg(
            instruction,
            0,
          )}; ${index} = ${index} + 1u) {`,
        );
        expressions.set(op.index, index);
        types.set(op.index, { kind: 'scalar', scalar: 'u32' });
        expressions.set(op.state, fold);
        types.set(op.state, type);
        emitInstructions(op.body, resources, state, `${indent}  `);
        lines.push(
          `${indent}  ${fold} = ${expressions.get(op.result)};`,
          `${indent}}`,
        );
        expressions.set(instruction.id, fold);
        continue;
      }
      case 'index':
        expression = `${arg(instruction, 0)}[${arg(instruction, 1)}]${
          resources.wrapped.has(arg(instruction, 0)) ? '.value' : ''
        }`;
        break;
      case 'bitcast': {
        const scalar = type.kind === 'vector' || type.kind === 'scalar'
          ? type.scalar
          : 'f32';
        const cast = { f32: 'asfloat', u32: 'asuint', i32: 'asint' }[
          scalar as 'f32' | 'u32' | 'i32'
        ];
        expression = `${cast}(${arg(instruction, 0)})`;
        break;
      }
      case 'ray-query': {
        const [structure, origin, direction, tMin, tMax, mask, instances, geometry] =
          instruction.args.map((id) => expressions.get(id) as string);
        const alphaTest = op.alphaTest === true;
        if (alphaTest && !resources.helpers.has(structure)) {
          // The elements of the buffers, wrapped or not (Direct3D 12).
          const element = (buffer: string) => (index: string) =>
            `${buffer}[${index}]${resources.wrapped.has(buffer) ? '.value' : ''}`;
          resources.helpers.set(
            structure,
            alphaRayFunctions(
              structure,
              element(instances),
              element(geometry),
              resources.rayGeneration,
            ),
          );
          resources.alphaTested.add(structure);
        }
        const name = `${traceFunction(structure, op.mode, alphaTest)}${
          resources.rayGeneration ? '_rt' : ''
        }`;
        if (resources.rayGeneration && !resources.helpers.has(name)) {
          resources.helpers.set(
            name,
            tracedRayFunction(name, structure, op.mode, alphaTest),
          );
        }
        expression = `${name}(${origin}, ${direction}, ${tMin}, ${tMax}, ${mask})`;
        break;
      }
      case 'array-length': {
        // Structured buffers give their length through out parameters.
        const name = valueName(instruction);
        lines.push(
          `${indent}uint ${name};`,
          `${indent}uint ${name}_stride;`,
          `${indent}${arg(
            instruction,
            0,
          )}.GetDimensions(${name}, ${name}_stride);`,
        );
        expressions.set(instruction.id, name);
        continue;
      }
      case 'constant':
        expression = literal(type, op.value);
        break;
      case 'load-input':
        expression = `input.${op.input}`;
        break;
      case 'load-builtin':
        if (op.builtin === 'frag-coord') {
          // In a pixel shader, SV_Position is the fragment coordinate.
          expression = 'input.clipPosition';
        } else if (op.builtin === 'object-index') {
          // SV_InstanceID is the InstanceIndex of Vulkan: it includes the
          // first instance of the draw (added on Direct3D 12).
          builtins.add('instance-index');
          expression = `${instancesIdentifier(
            objectTable(resources),
          )}[${instanceIndex(resources.target)}]`;
        } else if (op.builtin === 'instance-index') {
          builtins.add(op.builtin);
          expression = instanceIndex(resources.target);
        } else if (op.builtin === 'num-workgroups') {
          builtins.add(op.builtin);
          expression = numWorkgroups.name;
        } else {
          builtins.add(op.builtin);
          expression = builtinParameters[op.builtin].name;
        }
        break;
      case 'load-resource': {
        const binding = resources.names.get(op.binding);
        if (!binding) {
          throw new Error(`Binding "${op.binding}" is not in the layout`);
        }
        expression = !op.member
          ? binding
          : resources.blocks.has(binding)
            ? blockMember(binding, op.member)
            : `${binding}.${memberIdentifier(op.member)}`;
        break;
      }
      case 'binary': {
        // The product with a matrix (but not by a scalar) is a matrix
        // product; the other operators are component-wise, as in WGSL.
        const left = argType(instruction, 0);
        const right = argType(instruction, 1);
        const isMatrix = (t?: ShaderType) => t?.kind === 'matrix';
        const isScalar = (t?: ShaderType) => t?.kind === 'scalar';
        expression =
          op.operator === '*' &&
          (isMatrix(left) || isMatrix(right)) &&
          !isScalar(left) &&
          !isScalar(right)
            ? `mul(${arg(instruction, 0)}, ${arg(instruction, 1)})`
            : `(${arg(instruction, 0)} ${op.operator} ${arg(instruction, 1)})`;
        break;
      }
      case 'compare':
        // Comparisons are component-wise for vectors, as in WGSL.
        expression = `(${arg(instruction, 0)} ${op.operator} ${arg(
          instruction,
          1,
        )})`;
        break;
      case 'intrinsic':
        expression = `${intrinsicNames[op.name] ?? op.name}(${args(
          instruction,
        )})`;
        break;
      case 'select':
        // select(ifFalse, ifTrue, condition) in the IR; HLSL 2021 takes the
        // condition first.
        expression = `select(${arg(instruction, 2)}, ${arg(
          instruction,
          1,
        )}, ${arg(instruction, 0)})`;
        break;
      case 'sample':
        expression = `${arg(instruction, 0)}.Sample(${arg(
          instruction,
          1,
        )}, ${arg(instruction, 2)})`;
        break;
      case 'sample-level':
        expression = `${arg(instruction, 0)}.SampleLevel(${arg(
          instruction,
          1,
        )}, ${arg(instruction, 2)}, ${arg(instruction, 3)})`;
        break;
      case 'sample-compare':
        expression = `${arg(instruction, 0)}.SampleCmpLevelZero(${arg(
          instruction,
          1,
        )}, ${arg(instruction, 2)}, ${arg(instruction, 3)})`;
        break;
      case 'texture-load':
        // Load takes the level as the last coordinate.
        expression = `${arg(instruction, 0)}.Load(int3(${arg(
          instruction,
          1,
        )}, ${arg(instruction, 2)}))`;
        break;
      case 'construct':
        if (
          instruction.args.length === 1 &&
          argType(instruction, 0)?.kind === 'scalar'
        ) {
          // A splat.
          expression = `((${hlslType(type)})${arg(instruction, 0)})`;
        } else if (type.kind === 'matrix') {
          // From columns; HLSL constructors take rows.
          expression = `transpose(float${type.columns}x${type.rows}(${args(
            instruction,
          )}))`;
        } else {
          expression = `${hlslType(type)}(${args(instruction)})`;
        }
        break;
      case 'convert':
        expression = `((${hlslType(type)})${arg(instruction, 0)})`;
        break;
      case 'load-object': {
        const member = `${objectTable(resources)}[${arg(
          instruction,
          0,
        )}].${memberIdentifier(op.member)}`;
        const cast = resources.rowCasts.get(op.member);
        expression = cast ? `((${cast})${member})` : member;
        break;
      }
      case 'swizzle':
        expression = `${arg(instruction, 0)}.${op.components}`;
        break;
    }

    if (isInline(type)) {
      expressions.set(instruction.id, expression);
      continue;
    }
    const name = valueName(instruction);
    const comment = instruction.sourceNode
      ? ` // #${instruction.sourceNode}`
      : '';
    lines.push(
      `${indent}const ${hlslType(type)} ${name} = ${expression};${comment}`,
    );
    expressions.set(instruction.id, name);
  }
}

// Where a resource is bound: before the declaration on Vulkan (a
// descriptor set and a binding), after its name on Direct3D 12 (a register
// of the class of the resource, the group as its space).
interface Location {
  readonly binding: number;
  readonly group: number;
}

function bound(
  target: HlslTarget,
  declaration: string,
  { binding, group }: Location,
  registerClass: 'b' | 't' | 's' | 'u',
): string {
  return target === 'vulkan'
    ? `[[vk::binding(${binding}, ${group})]] ${declaration};`
    : `${declaration} : register(${registerClass}${binding}, space${group});`;
}

// Declares the resources of the layout; returns how the code names them.
function declareResources(
  layout: PhysicalProgramLayout,
  sections: string[],
  target: HlslTarget,
  rayGeneration = false,
): Resources {
  const resources: Resources = {
    target,
    names: new Map(),
    blocks: new Set(),
    wrapped: new Set(),
    rowCasts: new Map(),
    helpers: new Map(),
    rayGeneration,
    alphaTested: new Set(),
  };
  for (const group of layout.groups) {
    for (const physical of group.bindings) {
      const { resource } = physical;
      const location = { binding: physical.binding, group: group.index };
      const name = resourceIdentifier(resource);
      resources.names.set(resource.name, name);
      if (resource.kind === 'object-table') {
        resources.names.set(ObjectTableKey, name);
        sections.push(declareObjectTable(physical, location, name, resources));
        continue;
      }
      sections.push(declareResource(physical, location, name, resources));
    }
  }
  return resources;
}

// Direct3D 12: the place of a member in a cbuffer, from its offset (in
// registers of 16 bytes, then components).
const packOffset = (offset: number) =>
  `packoffset(c${Math.floor(offset / 16)}${
    ['', '.y', '.z', '.w'][(offset % 16) / 4]
  })`;

// Direct3D 12: the size of a type in a structured buffer, where nothing is
// padded (a float3 takes 12 bytes, a column-major float3x3 36).
function tightSize(type: ShaderType): number {
  switch (type.kind) {
    case 'scalar':
      return 4;
    case 'vector':
      return 4 * type.size;
    case 'matrix':
      return 4 * type.rows * type.columns;
    case 'array':
      return tightSize(type.element) * (type.length ?? 0);
    default:
      throw new Error(`${typeToString(type)} cannot be in a structured buffer`);
  }
}

// Direct3D 12: `count` bytes of padding in a structure.
const padding = (count: number, index: number) =>
  count > 0 ? [`  uint _padding${index}[${count / 4}];`] : [];

function declareResource(
  { resource, block, storage }: PhysicalBinding,
  location: Location,
  name: string,
  resources: Resources,
): string {
  const { target } = resources;
  switch (resource.kind) {
    case 'uniform-block': {
      if (!block) {
        throw new Error(`Uniform block "${resource.name}" has no layout`);
      }
      if (target === 'd3d12') {
        // A cbuffer, its members at the offsets of the layout (std140 puts
        // arrays and matrices at the start of a register, as packoffset
        // needs).
        resources.blocks.add(name);
        return [
          `cbuffer cb_${name} : register(b${location.binding}, space${location.group}) {`,
          ...block.members.map(
            (member) =>
              `  ${declaration(
                member.type,
                blockMember(name, member.name),
              )} : ${packOffset(member.offset)};`,
          ),
          '};',
        ].join('\n');
      }
      const struct = structName(resource.name);
      return [
        `struct ${struct} {`,
        ...block.members.map(
          (member) =>
            `  [[vk::offset(${member.offset})]] ${declaration(
              member.type,
              memberIdentifier(member.name),
            )};`,
        ),
        '};',
        bound(target, `ConstantBuffer<${struct}> ${name}`, location, 'b'),
      ].join('\n');
    }
    case 'texture':
      return bound(target, `${hlslType(resource.type)} ${name}`, location, 't');
    case 'sampler':
      return bound(
        target,
        `${
          resource.comparison ? 'SamplerComparisonState' : 'SamplerState'
        } ${name}`,
        location,
        's',
      );
    case 'storage-buffer': {
      const readWrite = resource.access === 'read-write';
      const kind = readWrite ? 'RWStructuredBuffer' : 'StructuredBuffer';
      const element = resource.type.element;
      const sections: string[] = [];
      let elementType = hlslType(element);
      // Direct3D 12: the elements are tightly packed; those taking more in
      // the std430 layout (a vec3 takes 16 bytes) are wrapped in a padded
      // structure.
      const stride = storage?.elementStride ?? 0;
      if (target === 'd3d12' && stride > tightSize(element)) {
        if (element.kind !== 'scalar' && element.kind !== 'vector') {
          throw new Error(
            `${typeToString(element)} elements are not supported in Direct3D 12 storage buffers`,
          );
        }
        elementType = `${structName(name)}Element`;
        resources.wrapped.add(name);
        sections.push(
          [
            `struct ${elementType} {`,
            `  ${hlslType(element)} value;`,
            ...padding(stride - tightSize(element), 0),
            '};',
          ].join('\n'),
        );
      }
      sections.push(
        bound(
          target,
          `${kind}<${elementType}> ${name}`,
          location,
          readWrite ? 'u' : 't',
        ),
      );
      return sections.join('\n');
    }
    case 'object-table':
      throw new Error('An object table is declared by declareObjectTable');
    case 'acceleration-structure':
      if (target === 'd3d12') {
        throw new Error('Direct3D 12 traces no rays yet');
      }
      return [
        bound(target, `RaytracingAccelerationStructure ${name}`, location, 't'),
        // The ray queries; a ray generation shader traces by TraceRay.
        ...(resources.rayGeneration ? [] : [rayFunctions(name)]),
      ].join('\n\n');
  }
}

// The members of a row of an object table. Vulkan keeps the offsets of the
// layout ([[vk::offset]]); Direct3D 12 packs structured buffers tightly, so
// padding goes before the members, a mat3 is stored as a float4x3 (columns
// of 16 bytes, read through a cast) and the row is padded to its size.
function rowMembers(
  row: NonNullable<PhysicalBinding['objectRow']>,
  resources: Resources,
): string[] {
  if (resources.target === 'vulkan') {
    return row.members.map(
      (member) =>
        `  [[vk::offset(${member.offset})]] ${declaration(
          member.type,
          memberIdentifier(member.name),
        )};`,
    );
  }
  const lines: string[] = [];
  let offset = 0;
  for (const member of row.members) {
    lines.push(...padding(member.offset - offset, lines.length));
    const { type } = member;
    const identifier = memberIdentifier(member.name);
    if (type.kind === 'matrix' && type.rows !== 4) {
      lines.push(`  float4x${type.columns} ${identifier};`);
      resources.rowCasts.set(member.name, hlslType(type));
      offset = member.offset + 16 * type.columns;
      continue;
    }
    if (type.kind === 'array' && tightSize(type) !== member.size) {
      throw new Error(
        `${typeToString(type)} members are not supported in Direct3D 12 object tables`,
      );
    }
    lines.push(`  ${declaration(type, identifier)};`);
    offset = member.offset + tightSize(type);
  }
  lines.push(...padding(row.size - offset, lines.length));
  return lines;
}

// An object table: the rows, then the row of each instance at the next
// binding, as structured buffers (storage buffers in SPIR-V).
function declareObjectTable(
  { resource, objectRow }: PhysicalBinding,
  location: Location,
  name: string,
  resources: Resources,
): string {
  if (!objectRow) {
    throw new Error(`Object table "${resource.name}" has no row layout`);
  }
  const struct = `${structName(resource.name)}Row`;
  return [
    `struct ${struct} {`,
    ...rowMembers(objectRow, resources),
    '};',
    bound(
      resources.target,
      `StructuredBuffer<${struct}> ${name}`,
      location,
      't',
    ),
    bound(
      resources.target,
      `StructuredBuffer<uint> ${instancesIdentifier(name)}`,
      { binding: location.binding + 1, group: location.group },
      't',
    ),
  ].join('\n');
}

// A member of the input or output struct of a stage.
function stageVariable(
  variable: IrStageVariable,
  semantic: string,
  target: HlslTarget,
): string {
  if (variable.builtin === 'position') {
    return `  ${hlslType(variable.type)} ${variable.name} : SV_Position;`;
  }
  // Integers are not interpolated (the struct serves both stages).
  const interpolation =
    variable.interpolation === 'flat' ? 'nointerpolation ' : '';
  // Direct3D 12 matches the stages and the vertex attributes by semantic.
  const location =
    target === 'vulkan' ? `[[vk::location(${variable.location})]] ` : '';
  return `  ${location}${interpolation}${hlslType(variable.type)} ${
    variable.name
  } : ${semantic}${variable.location};`;
}

const builtinDeclarations = (builtins: ReadonlySet<string>) =>
  [...builtins]
    .filter((builtin) => builtin !== 'num-workgroups')
    .map(
      (builtin) =>
        builtinParameters[builtin as keyof typeof builtinParameters]
          .declaration,
    );

// A compute stage: the body, then the writes, in order.
function emitCompute(
  compute: IrEntryPoint,
  resources: Resources,
  sections: string[],
): void {
  const body = emitBody(compute, resources);
  const [x, y, z] = compute.workgroupSize ?? [1, 1, 1];
  const writes = (compute.writes ?? []).flatMap((write) => {
    const target = resources.names.get(write.resource);
    if (!target) {
      throw new Error(`Binding "${write.resource}" is not in the layout`);
    }
    const statement = `${target}[${body.expressions.get(write.index)}]${
      resources.wrapped.has(target) ? '.value' : ''
    } = ${body.expressions.get(write.value)};`;
    return write.condition === undefined
      ? [`  ${statement}`]
      : [
          `  if (${body.expressions.get(write.condition)}) {`,
          `    ${statement}`,
          '  }',
        ];
  });
  if (resources.rayGeneration) {
    // A thread per ray: the index of the ray its invocation.
    for (const builtin of body.builtins) {
      if (builtin !== 'global-invocation-id') {
        throw new Error(
          `A ray generation shader reads no ${builtin} (the index of its ray only)`,
        );
      }
    }
    sections.push(payload, ...resources.helpers.values());
    sections.push(
      [
        '[shader("raygeneration")]',
        `void ${RayTracingEntryPoints.generation}() {`,
        ...(body.builtins.size > 0
          ? [
              `  const uint3 ${builtinParameters['global-invocation-id'].name} = DispatchRaysIndex();`,
            ]
          : []),
        ...body.lines,
        ...writes,
        '}',
      ].join('\n'),
      ...rayTracingShaders(resources),
    );
    return;
  }
  if (body.builtins.has('num-workgroups')) {
    sections.push(numWorkgroups.declaration[resources.target]);
  }
  sections.push(...resources.helpers.values());
  sections.push(
    [
      `[numthreads(${x}, ${y}, ${z})]`,
      `void cs_main(${builtinDeclarations(body.builtins).join(', ')}) {`,
      ...body.lines,
      ...writes,
      '}',
    ].join('\n'),
  );
}

/**
 * The DXC arguments compiling a stage of the generated HLSL: to SPIR-V for
 * Vulkan 1.3 (HLSL 2021, layouts of the GLSL family: the offsets are
 * explicit anyway), or to DXIL for Direct3D 12.
 */
export function dxcArguments(
  // 'library': the shaders of a ray tracing pipeline (see HlslEmitOptions).
  stage: 'vertex' | 'fragment' | 'compute' | 'library',
  entryPoint: string,
  target: HlslTarget = 'vulkan',
  // The code: the programs tracing rays need Shader Model 6.5.
  code?: string,
): string[] {
  const model = code?.includes('RayQuery<') ? '6_5' : '6_0';
  const profiles = {
    vertex: `vs_${model}`,
    fragment: `ps_${model}`,
    compute: `cs_${model}`,
    library: 'lib_6_5',
  };
  return [
    ...(target === 'vulkan' ? ['-spirv'] : []),
    '-HV',
    '2021',
    ...(target === 'vulkan'
      ? ['-fspv-target-env=vulkan1.3', '-fvk-use-gl-layout']
      : []),
    '-T',
    profiles[stage],
    // A library has several entry points.
    ...(stage === 'library' ? [] : ['-E', entryPoint]),
  ];
}

export interface HlslCodegenOptions {
  // Vulkan by default.
  readonly target?: HlslTarget;
}

export interface HlslEmitOptions {
  /**
   * A compute stage tracing rays emitted as the shaders of a ray tracing
   * pipeline (Vulkan): its thread a ray generation shader, a thread per
   * ray, its rays traced by TraceRay (see RayTracingEntryPoints).
   */
  readonly rayGeneration?: boolean;
}

// Generates an HLSL module with a vs_main and a ps_main entry point, or a
// cs_main one for a compute stage.
export class HlslCodegen implements ShaderCodegen {
  readonly language = 'hlsl' as const;
  readonly target: HlslTarget;

  constructor({ target = 'vulkan' }: HlslCodegenOptions = {}) {
    this.target = target;
  }

  emit(
    module: ShaderModuleIR,
    layout: PhysicalProgramLayout,
    { rayGeneration = false }: HlslEmitOptions = {},
  ): ShaderSources {
    const target = this.target;
    const sections: string[] = [
      [
        `// Generated from graph "${module.name}". Do not edit.`,
        // The matrices of the engine are column-major.
        '#pragma pack_matrix(column_major)',
      ].join('\n'),
    ];
    const resources = declareResources(layout, sections, target, rayGeneration);

    const compute = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'compute',
    );
    if (compute) {
      emitCompute(compute, resources, sections);
      return {
        kind: 'single-module',
        code: `${sections.join('\n\n')}\n`,
        entryPoints: {
          compute: rayGeneration ? RayTracingEntryPoints.generation : 'cs_main',
        },
      };
    }
    if (rayGeneration) {
      throw new Error('Only the compute stages trace rays in a ray tracing pipeline');
    }

    const vertex = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'vertex',
    );
    const fragment = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'fragment',
    );
    if (!vertex || !fragment) {
      throw new Error(
        'A program needs a vertex and a fragment entry point, or a compute one',
      );
    }
    if (vertex.inputs.length > 0) {
      sections.push(
        [
          'struct VertexInput {',
          ...vertex.inputs.map((input) =>
            stageVariable(input, 'ATTRIBUTE', target),
          ),
          '};',
        ].join('\n'),
      );
    }
    sections.push(
      [
        'struct Varyings {',
        ...vertex.outputs.map((output) =>
          stageVariable(output, 'VARYING', target),
        ),
        '};',
      ].join('\n'),
    );

    const vertexBody = emitBody(vertex, resources);
    const fragmentBody = emitBody(fragment, resources);
    sections.push(...resources.helpers.values());
    if (
      target === 'd3d12' &&
      (vertexBody.builtins.has('instance-index') ||
        fragmentBody.builtins.has('instance-index'))
    ) {
      sections.push(firstInstance.declaration);
    }
    const vertexParameters = [
      ...(vertex.inputs.length > 0 ? ['VertexInput input'] : []),
      ...builtinDeclarations(vertexBody.builtins),
    ];
    sections.push(
      [
        `Varyings vs_main(${vertexParameters.join(', ')}) {`,
        ...vertexBody.lines,
        '  Varyings result;',
        ...vertex.outputs.map(
          (output) =>
            `  result.${output.name} = ${vertexBody.expressions.get(
              vertex.results[output.name],
            )};`,
        ),
        '  return result;',
        '}',
      ].join('\n'),
    );

    const fragmentParameters = [
      'Varyings input',
      ...builtinDeclarations(fragmentBody.builtins),
    ];
    // Depth-only programs have no color; several targets go in a structure.
    const color =
      fragment.outputs.length === 1
        ? (fragment.outputs[0] as IrStageVariable)
        : undefined;
    const targets = fragment.outputs.length > 1 ? fragment.outputs : [];
    if (targets.length > 0) {
      sections.push(
        [
          'struct FragmentOutputs {',
          ...targets.map(
            (target) =>
              `  ${hlslType(target.type)} o_${identifier(
                target.name,
              )} : SV_Target${target.location ?? 0};`,
          ),
          '};',
        ].join('\n'),
      );
    }
    sections.push(
      [
        `${
          color
            ? hlslType(color.type)
            : targets.length > 0
              ? 'FragmentOutputs'
              : 'void'
        } ps_main(${fragmentParameters.join(', ')})${
          color ? ` : SV_Target${color.location ?? 0}` : ''
        } {`,
        ...fragmentBody.lines,
        // After the whole body: every texture sample has run.
        ...(fragment.results['discard'] !== undefined
          ? [
              `  if (${fragmentBody.expressions.get(
                fragment.results['discard'],
              )}) {`,
              '    discard;',
              '  }',
            ]
          : []),
        ...(color
          ? [
              `  return ${fragmentBody.expressions.get(
                fragment.results[color.name],
              )};`,
            ]
          : []),
        ...(targets.length > 0
          ? [
              '  FragmentOutputs targets;',
              ...targets.map(
                (target) =>
                  `  targets.o_${identifier(
                    target.name,
                  )} = ${fragmentBody.expressions.get(
                    fragment.results[target.name],
                  )};`,
              ),
              '  return targets;',
            ]
          : []),
        '}',
      ].join('\n'),
    );

    return {
      kind: 'single-module',
      code: `${sections.join('\n\n')}\n`,
      entryPoints: { vertex: 'vs_main', fragment: 'ps_main' },
    };
  }
}
