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
import { CombinedSampler, combinedSamplers } from './combinedSamplers';

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

// The combined sampler type of a texture: sampler2D, usampler3D…
export function glslSamplerType(type: TextureType): string {
  const dimension = samplerDimensions[type.dimension];
  if (!dimension || type.multisampled) {
    throw new Error(`${typeToString(type)} cannot be sampled in GLSL ES 3.0`);
  }
  return `${samplerPrefixes[type.sampleType]}sampler${dimension}`;
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

function emitBody(
  entryPoint: IrEntryPoint,
  samplers: readonly CombinedSampler[]
): { lines: string[]; expressions: Map<number, string> } {
  const expressions = new Map<number, string>();
  const instructions = new Map<number, IrInstruction>();
  const lines: string[] = [];
  const arg = (instruction: IrInstruction, index: number) =>
    expressions.get(instruction.args[index]) as string;
  const args = (instruction: IrInstruction) =>
    instruction.args.map((_, i) => arg(instruction, i)).join(', ');
  const typeOf = (id: number) => (instructions.get(id) as IrInstruction).type;

  for (const instruction of entryPoint.body) {
    instructions.set(instruction.id, instruction);
    const { op, type } = instruction;
    let expression: string;
    switch (op.kind) {
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
      case 'intrinsic':
        expression =
          op.name === 'saturate'
            ? `clamp(${arg(instruction, 0)}, 0.0, 1.0)`
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
      case 'sample': {
        const texture = arg(instruction, 0);
        const sampler = arg(instruction, 1);
        const combined = samplers.find(
          (candidate) =>
            candidate.texture === texture && candidate.sampler === sampler
        );
        if (!combined) {
          throw new Error(`No combined sampler for ${texture} and ${sampler}`);
        }
        // Depth textures read as a float: the depth is the first component.
        expression = `texture(${combined.name}, ${arg(instruction, 2)})${
          type.kind === 'scalar' ? '.r' : ''
        }`;
        break;
      }
      case 'construct':
      case 'convert':
        expression = `${glslType(type)}(${args(instruction)})`;
        break;
      case 'swizzle':
        expression = `${arg(instruction, 0)}.${op.components}`;
        break;
    }

    if (isHandle(type)) {
      expressions.set(instruction.id, expression);
      continue;
    }
    const name = identifier(
      `v${instruction.id}${instruction.name ? `_${instruction.name}` : ''}`
    );
    const comment = instruction.sourceNode
      ? ` // #${instruction.sourceNode}`
      : '';
    lines.push(`  ${glslType(type)} ${name} = ${expression};${comment}`);
    expressions.set(instruction.id, name);
  }

  return { lines, expressions };
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
export class GlslEsCodegen implements ShaderCodegen {
  readonly language = 'glsl-es-300' as const;

  emit(module: ShaderModuleIR, layout: PhysicalProgramLayout): ShaderSources {
    const vertex = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'vertex'
    );
    const fragment = module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'fragment'
    );
    if (!vertex || !fragment) {
      throw new Error('A program needs a vertex and a fragment entry point');
    }

    const samplers = combinedSamplers(module, layout);
    const samplerTypes = [
      ...new Set(samplers.map((sampler) => glslSamplerType(sampler.type))),
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
                `  ${glslType(member.type)} ${memberIdentifier(member.name)};`
            ),
            `} ${identifier(resource.name)};`,
          ].join('\n')
        );
      }
    }
    if (samplers.length > 0) {
      resources.push(
        samplers
          .map(
            (sampler) =>
              `uniform ${glslSamplerType(sampler.type)} ${sampler.name};`
          )
          .join('\n')
      );
    }

    const vertexBody = emitBody(vertex, samplers);
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

    const fragmentBody = emitBody(fragment, samplers);
    const color = fragment.outputs[0];
    const fragmentSource = [
      header,
      ...resources,
      [
        ...fragment.inputs
          .filter((input) => !input.builtin)
          .map((input) => varying(input, 'in')),
        `layout(location = ${color.location ?? 0}) out ${glslType(
          color.type
        )} o_${identifier(color.name)};`,
      ].join('\n'),
      [
        'void main() {',
        ...fragmentBody.lines,
        `  o_${identifier(color.name)} = ${fragmentBody.expressions.get(
          fragment.results[color.name]
        )};`,
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
