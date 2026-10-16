import type {
  PhysicalProgramLayout,
  ShaderCodegen,
  ShaderSources,
} from '@fdw/engine-backend';
import {
  ConstantValue,
  IrEntryPoint,
  IrInstruction,
  IrStageVariable,
  ShaderModuleIR,
  ShaderType,
  TextureType,
  typeToString,
} from '@fdw/engine-shader';
import {
  CombinedSampler,
  combinedSamplers,
  orientationUniform,
} from './combinedSamplers';

const scalarNames = { f32: 'float', i32: 'int', u32: 'uint', bool: 'bool' };
const vectorPrefixes = { f32: 'vec', i32: 'ivec', u32: 'uvec', bool: 'bvec' };

export function glslType(type: ShaderType): string {
  const unsupported = () =>
    new Error(
      `${typeToString(type)} is not supported by the GLSL ES generator`
    );
  switch (type.kind) {
    case 'scalar':
      if (!(type.scalar in scalarNames)) {
        throw unsupported();
      }
      return scalarNames[type.scalar as keyof typeof scalarNames];
    case 'vector':
      if (!(type.scalar in vectorPrefixes)) {
        throw unsupported();
      }
      return `${vectorPrefixes[type.scalar as keyof typeof vectorPrefixes]}${
        type.size
      }`;
    case 'matrix':
      if (type.scalar !== 'f32') {
        throw unsupported();
      }
      return type.columns === type.rows
        ? `mat${type.columns}`
        : `mat${type.columns}x${type.rows}`;
    default:
      throw unsupported();
  }
}

const samplerDimensions: Record<string, string> = {
  '2d': '2D',
  '2d-array': '2DArray',
  '3d': '3D',
  cube: 'Cube',
};

const samplerPrefixes = {
  float: '',
  'unfilterable-float': '',
  // Depth textures sampled without comparison read the depth as a float.
  depth: '',
  sint: 'i',
  uint: 'u',
} as const;

// The combined sampler type of a texture: sampler2D, usampler3D…, and
// sampler2DShadow… with a comparison sampler.
export function glslSamplerType(type: TextureType, comparison = false): string {
  const dimension = samplerDimensions[type.dimension];
  if (!dimension || type.multisampled || (comparison && dimension === '3D')) {
    throw new Error(
      `${typeToString(type)} cannot be sampled${
        comparison ? ' with comparison' : ''
      } in GLSL ES 3.0`
    );
  }
  return comparison
    ? `sampler${dimension}Shadow`
    : `${samplerPrefixes[type.sampleType]}sampler${dimension}`;
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
  if (type.kind === 'vector' || type.kind === 'matrix') {
    // Matrix constructors take their components column by column, like the
    // IR.
    const components = (value as readonly number[]).map((component) =>
      scalarLiteral(component, type.scalar)
    );
    return `${glslType(type)}(${components.join(', ')})`;
  }
  throw new Error(`Cannot write a ${typeToString(type)} literal`);
}

const isHandle = (type: ShaderType) =>
  type.kind === 'texture' || type.kind === 'sampler';

// Values used inline rather than stored in a variable: handles, and the
// arrays of uniform blocks, indexed in place rather than copied.
const isInline = (type: ShaderType) => isHandle(type) || type.kind === 'array';

// The declaration of a variable or block member: arrays put their length
// after the name in GLSL.
function declaration(type: ShaderType, name: string): string {
  if (type.kind === 'array') {
    if (type.length === undefined) {
      throw new Error('Runtime-sized arrays are not supported by GLSL ES 3.00');
    }
    return `${glslType(type.element)} ${name}[${type.length}]`;
  }
  return `${glslType(type)} ${name}`;
}

// GLSL reserves the identifiers containing two consecutive underscores.
const identifier = (text: string) =>
  text
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .replace(/_{2,}/g, '_');

// Name of the GLSL block of a uniform block binding: materialUniforms →
// MaterialUniforms. The pipeline looks the blocks up by this name.
export const glslBlockName = (name: string) =>
  name.charAt(0).toUpperCase() + name.slice(1);

// As in WGSL, names chosen by the user are prefixed: they cannot collide
// with the GLSL keywords and builtin functions.
const memberIdentifier = (name: string) => identifier(`u_${name}`);

const vectorComponents = 'xyzw';

const vectorComparisons = {
  '<': 'lessThan',
  '<=': 'lessThanEqual',
  '>': 'greaterThan',
  '>=': 'greaterThanEqual',
  '==': 'equal',
  '!=': 'notEqual',
} as const;

interface BodyState {
  // The object table of the layout, if any.
  readonly table?: ObjectTableCode;
  readonly lines: string[];
  readonly expressions: Map<number, string>;
  readonly instructions: Map<number, IrInstruction>;
}

const valueName = (instruction: IrInstruction) =>
  identifier(
    `v${instruction.id}${instruction.name ? `_${instruction.name}` : ''}`
  );

function emitBody(
  entryPoint: IrEntryPoint,
  samplers: readonly CombinedSampler[],
  table?: ObjectTableCode
): BodyState {
  const state: BodyState = {
    lines: [],
    expressions: new Map(),
    instructions: new Map(),
    table,
  };
  emitInstructions(entryPoint.body, samplers, state, '  ');
  return state;
}

function emitInstructions(
  body: readonly IrInstruction[],
  samplers: readonly CombinedSampler[],
  state: BodyState,
  indent: string
): void {
  const { lines, expressions, instructions } = state;
  const arg = (instruction: IrInstruction, index: number) =>
    expressions.get(instruction.args[index]) as string;
  const args = (instruction: IrInstruction) =>
    instruction.args.map((_, i) => arg(instruction, i)).join(', ');
  const typeOf = (id: number) => (instructions.get(id) as IrInstruction).type;

  for (const instruction of body) {
    instructions.set(instruction.id, instruction);
    const { op, type } = instruction;
    let expression: string;
    switch (op.kind) {
      case 'loop-sum': {
        const sum = valueName(instruction);
        const index = `v${op.index}`;
        lines.push(
          `${indent}${glslType(type)} ${sum} = ${glslType(type)}(0.0);`,
          `${indent}for (uint ${index} = 0u; ${index} < ${arg(
            instruction,
            0
          )}; ${index}++) {`
        );
        expressions.set(op.index, index);
        emitInstructions(op.body, samplers, state, `${indent}  `);
        lines.push(
          `${indent}  ${sum} += ${expressions.get(op.result)};`,
          `${indent}}`
        );
        expressions.set(instruction.id, sum);
        continue;
      }
      case 'index':
        expression = `${arg(instruction, 0)}[${arg(instruction, 1)}]`;
        break;
      case 'array-length':
        // The compiler rejects storage buffers for WebGL2 (capability).
        throw new Error('GLSL ES 3.00 has no storage buffers');
      case 'constant':
        expression = literal(type, op.value);
        break;
      case 'load-input':
        expression = op.input;
        break;
      case 'load-builtin':
        switch (op.builtin) {
          case 'vertex-index':
            expression = `${glslType(type)}(gl_VertexID)`;
            break;
          case 'instance-index':
            expression = `${glslType(type)}(gl_InstanceID)`;
            break;
          case 'front-facing':
            expression = 'gl_FrontFacing';
            break;
          case 'frag-coord':
            // Origin at the bottom left, where WGSL has it at the top left.
            expression = 'gl_FragCoord';
            break;
          case 'object-index':
            // No base instance in WebGL2: the backend sets the first
            // instance of each draw in a uniform.
            expression = `${objectTableCode(state).instances}(${
              ObjectTableNames.firstInstance
            } + uint(gl_InstanceID))`;
            break;
          default:
            throw new Error(`GLSL ES 3.00 has no ${op.builtin} (compute)`);
        }
        break;
      case 'load-resource':
        if (isHandle(type)) {
          // Textures and samplers are only used through the combined
          // samplers, by the sample instructions.
          expression = op.binding;
        } else if (op.member) {
          expression = `${identifier(op.binding)}.${memberIdentifier(
            op.member
          )}`;
        } else {
          throw new Error(
            `Binding "${op.binding}" can only be read through its members`
          );
        }
        break;
      case 'binary':
        expression = `${arg(instruction, 0)} ${op.operator} ${arg(
          instruction,
          1
        )}`;
        break;
      case 'compare': {
        const [a, b] = [arg(instruction, 0), arg(instruction, 1)];
        // Vectors are compared by functions in GLSL, scalars by operators.
        expression =
          type.kind === 'vector'
            ? `${vectorComparisons[op.operator]}(${a}, ${b})`
            : `${a} ${op.operator} ${b}`;
        break;
      }
      case 'intrinsic':
        expression =
          op.name === 'saturate'
            ? `clamp(${arg(instruction, 0)}, 0.0, 1.0)`
            : op.name === 'dpdx'
            ? `dFdx(${arg(instruction, 0)})`
            : op.name === 'dpdy'
            ? // The window y points up in OpenGL: down, as in WGSL.
              `(-dFdy(${arg(instruction, 0)}))`
            : `${op.name}(${args(instruction)})`;
        break;
      case 'select': {
        const [ifFalse, ifTrue, condition] = [0, 1, 2].map((i) =>
          arg(instruction, i)
        );
        const conditionType = typeOf(instruction.args[2]);
        if (conditionType.kind !== 'vector') {
          expression = `(${condition} ? ${ifTrue} : ${ifFalse})`;
        } else if (type.kind === 'vector' && type.scalar === 'f32') {
          expression = `mix(${ifFalse}, ${ifTrue}, ${condition})`;
        } else {
          // mix() only selects floats in GLSL ES 3.0: one choice per
          // component.
          const components = vectorComponents
            .slice(0, conditionType.size)
            .split('')
            .map((c) => `${condition}.${c} ? ${ifTrue}.${c} : ${ifFalse}.${c}`);
          expression = `${glslType(type)}(${components.join(', ')})`;
        }
        break;
      }
      case 'sample':
      case 'sample-level':
      case 'sample-compare': {
        const texture = arg(instruction, 0);
        const sampler = arg(instruction, 1);
        const combined = samplers.find(
          (candidate) =>
            candidate.texture === texture && candidate.sampler === sampler
        );
        if (!combined) {
          throw new Error(`No combined sampler for ${texture} and ${sampler}`);
        }
        // 2d textures are mostly stored bottom row first (see WebGl2Texture):
        // v is flipped by their orientation, to point down as in WebGPU.
        const uv = arg(instruction, 2);
        const orientation = orientationUniform(combined);
        const coordinates = orientation
          ? `vec2(${uv}.x, ${orientation}.x + ${orientation}.y * ${uv}.y)`
          : uv;
        if (op.kind === 'sample-compare') {
          // The reference depth is the last coordinate of shadow samplers.
          expression = `textureLod(${combined.name}, vec3(${coordinates}, ${arg(
            instruction,
            3
          )}), 0.0)`;
          break;
        }
        // Depth textures read as a float: the depth is the first component.
        expression = `${
          op.kind === 'sample-level'
            ? `textureLod(${combined.name}, ${coordinates}, ${arg(
                instruction,
                3
              )})`
            : `texture(${combined.name}, ${coordinates})`
        }${type.kind === 'scalar' ? '.r' : ''}`;
        break;
      }
      case 'texture-load': {
        const texture = arg(instruction, 0);
        const combined = samplers.find(
          (candidate) =>
            candidate.texture === texture && candidate.sampler === undefined
        );
        if (!combined) {
          throw new Error(`No combined sampler to load ${texture}`);
        }
        // Rows are mostly stored bottom first (see WebGl2Texture): counted
        // from the top by the orientation, as in WebGPU.
        const coords = arg(instruction, 1);
        const level = arg(instruction, 2);
        const orientation = orientationUniform(combined);
        const row = orientation
          ? `int(${orientation}.x) * (textureSize(${combined.name}, ${level}).y - 1) + int(${orientation}.y) * ${coords}.y`
          : `${coords}.y`;
        expression = `texelFetch(${
          combined.name
        }, ivec2(${coords}.x, ${row}), ${level})${
          type.kind === 'scalar' ? '.r' : ''
        }`;
        break;
      }
      case 'construct':
      case 'convert':
        expression = `${glslType(type)}(${args(instruction)})`;
        break;
      case 'load-object':
        expression = objectTableCode(state).member(
          op.member,
          arg(instruction, 0)
        );
        break;
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
    lines.push(`${indent}${glslType(type)} ${name} = ${expression};${comment}`);
    expressions.set(instruction.id, name);
  }
}

function varying(variable: IrStageVariable, direction: 'in' | 'out'): string {
  const flat = variable.interpolation === 'flat' ? 'flat ' : '';
  return `${flat}${direction} ${glslType(variable.type)} ${variable.name};`;
}

// Generates a vertex and a fragment shader in GLSL ES 3.00, for WebGL2.
//
// - Uniform blocks follow the std140 layout; their binding points, like the
//   texture units of the combined samplers, are assigned by the pipeline
//   after linking (GLSL ES 3.00 has no binding qualifiers).
// - The clip space depth of the engine is [0, 1]; the vertex shader remaps it
//   to the [-1, 1] range of OpenGL.
/**
 * The names of the object table in GLSL ES (WebGL2): two data textures, the
 * rows (RGBA32F, a row on consecutive texels) and the row of each instance
 * (R32UI), ObjectTableWidth texels wide; and the first instance of the draw,
 * a uniform set by the backend, which has no base instance.
 */
export const ObjectTableNames = {
  rows: 'objects',
  instances: 'objectsInstances',
  firstInstance: 'objectsFirstInstance',
} as const;

/** The width of the textures of an object table, in texels. */
export const ObjectTableWidth = 2048;

// The code reading the object table of a program.
interface ObjectTableCode {
  readonly declarations: string;
  // The function giving the row of an instance.
  readonly instances: string;
  // A member of the row `row`.
  member(name: string, row: string): string;
}

function objectTableCode(state: BodyState): ObjectTableCode {
  if (!state.table) {
    throw new Error('The layout has no object table');
  }
  return state.table;
}

function objectTable(
  layout: PhysicalProgramLayout
): ObjectTableCode | undefined {
  const binding = layout.groups
    .flatMap((group) => group.bindings)
    .find((candidate) => candidate.resource.kind === 'object-table');
  const row = binding?.objectRow;
  if (!binding || !row) {
    return undefined;
  }
  const { rows, instances, firstInstance } = ObjectTableNames;
  const texels = row.size / 16;
  const width = `${ObjectTableWidth}u`;
  const declarations = [
    `uniform highp sampler2D ${rows};`,
    `uniform highp usampler2D ${instances};`,
    `uniform uint ${firstInstance};`,
    '',
    `// The texel k of a row: ${texels} texels per row, ${ObjectTableWidth} per line.`,
    `vec4 ${rows}Texel(uint row, uint k) {`,
    `  uint t = row * ${texels}u + k;`,
    `  return texelFetch(${rows}, ivec2(int(t % ${width}), int(t / ${width})), 0);`,
    '}',
    '',
    `uint ${instances}Row(uint instance) {`,
    `  return texelFetch(${instances}, ivec2(int(instance % ${width}), int(instance / ${width})), 0).x;`,
    '}',
  ].join('\n');
  return {
    declarations,
    instances: `${instances}Row`,
    member: (name, row) => {
      const member = binding.objectRow?.members.find(
        (candidate) => candidate.name === name
      );
      if (!member) {
        throw new Error(`The object table has no member "${name}"`);
      }
      const first = member.offset / 16;
      const texel = (k: number) => `${rows}Texel(${row}, ${first + k}u)`;
      const { type } = member;
      if (type.kind === 'matrix' && type.columns === 4 && type.rows === 4) {
        return `mat4(${[0, 1, 2, 3].map(texel).join(', ')})`;
      }
      if (type.kind === 'matrix' && type.columns === 3 && type.rows === 3) {
        return `mat3(${[0, 1, 2].map((k) => `${texel(k)}.xyz`).join(', ')})`;
      }
      if (type.kind === 'vector' && type.size === 4) {
        return texel(0);
      }
      throw new Error(
        `Object table members of type ${glslType(type)} are not supported`
      );
    },
  };
}

export class GlslEsCodegen implements ShaderCodegen {
  readonly language = 'glsl-es-300' as const;

  emit(module: ShaderModuleIR, layout: PhysicalProgramLayout): ShaderSources {
    const vertex = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'vertex'
    );
    const fragment = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'fragment'
    );
    if (module.entryPoints.some((entry) => entry.stage === 'compute')) {
      throw new Error('GLSL ES 3.00 has no compute shaders');
    }
    if (!vertex || !fragment) {
      throw new Error('A program needs a vertex and a fragment entry point');
    }

    const samplers = combinedSamplers(module, layout);
    const samplerTypes = [
      ...new Set(
        samplers.map((sampler) =>
          glslSamplerType(sampler.type, sampler.comparison)
        )
      ),
    ].sort();

    const header = [
      '#version 300 es',
      `// Generated from material graph "${module.name}". Do not edit.`,
      '',
      'precision highp float;',
      'precision highp int;',
      ...samplerTypes.map((type) => `precision highp ${type};`),
    ].join('\n');

    // The same declarations in both stages: GLSL requires the blocks shared
    // by the stages to match.
    const resources: string[] = [];
    for (const group of layout.groups) {
      for (const { resource } of group.bindings) {
        if (resource.kind !== 'uniform-block') {
          continue;
        }
        resources.push(
          [
            `layout(std140) uniform ${glslBlockName(resource.name)} {`,
            ...resource.members.map(
              (member) =>
                `  ${declaration(member.type, memberIdentifier(member.name))};`
            ),
            `} ${identifier(resource.name)};`,
          ].join('\n')
        );
      }
    }
    if (samplers.length > 0) {
      resources.push(
        samplers
          .flatMap((sampler) => {
            const orientation = orientationUniform(sampler);
            return [
              `uniform ${glslSamplerType(sampler.type, sampler.comparison)} ${
                sampler.name
              };`,
              ...(orientation ? [`uniform vec2 ${orientation};`] : []),
            ];
          })
          .join('\n')
      );
    }

    const table = objectTable(layout);
    if (table) {
      resources.push(table.declarations);
    }
    const vertexBody = emitBody(vertex, samplers, table);
    const vertexOutputs = vertex.outputs.filter((output) => !output.builtin);
    const vertexSource = [
      header,
      ...resources,
      [
        ...vertex.inputs.map(
          (input) =>
            `layout(location = ${input.location}) in ${glslType(input.type)} ${
              input.name
            };`
        ),
        ...vertexOutputs.map((output) => varying(output, 'out')),
      ].join('\n'),
      [
        'void main() {',
        ...vertexBody.lines,
        ...vertex.outputs.map((output) => {
          const value = vertexBody.expressions.get(vertex.results[output.name]);
          return output.builtin === 'position'
            ? `  gl_Position = ${value};`
            : `  ${output.name} = ${value};`;
        }),
        '  // Clip space depth: [0, 1] in the engine, [-1, 1] in OpenGL.',
        '  gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;',
        '}',
      ].join('\n'),
    ];

    const fragmentBody = emitBody(fragment, samplers, table);
    // Depth-only programs have no color; one out variable per target.
    const targets = fragment.outputs;
    const fragmentSource = [
      header,
      ...resources,
      [
        ...fragment.inputs
          .filter((input) => !input.builtin)
          .map((input) => varying(input, 'in')),
        ...targets.map(
          (target) =>
            `layout(location = ${target.location ?? 0}) out ${glslType(
              target.type
            )} o_${identifier(target.name)};`
        ),
      ].join('\n'),
      [
        'void main() {',
        ...fragmentBody.lines,
        // After the whole body: every texture sample has run.
        ...(fragment.results['discard'] !== undefined
          ? [
              `  if (${fragmentBody.expressions.get(
                fragment.results['discard']
              )}) {`,
              '    discard;',
              '  }',
            ]
          : []),
        ...targets.map(
          (target) =>
            `  o_${identifier(target.name)} = ${fragmentBody.expressions.get(
              fragment.results[target.name]
            )};`
        ),
        '}',
      ].join('\n'),
    ];

    return {
      kind: 'per-stage',
      vertex: `${vertexSource.filter(Boolean).join('\n\n')}\n`,
      fragment: `${fragmentSource.filter(Boolean).join('\n\n')}\n`,
    };
  }
}
