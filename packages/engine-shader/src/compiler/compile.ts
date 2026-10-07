import { Diagnostic, GraphError } from '../graph/Diagnostic';
import type {
  GraphNode,
  MaterialGraphData,
  NodeId,
  StaticValue,
} from '../graph/MaterialGraphData';
import { isFunctionDefinition } from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import {
  GraphValidation,
  ResolvedNode,
  validateGraph,
} from '../graph/validateGraph';
import { createStandardRegistry } from '../std';
import { ShaderType, TextureType, typeToString } from '../types/ShaderType';
import { hashString, stableStringify } from './hash';
import type { ShaderModuleIR } from './ir';
import { generateIr } from './generateIr';
import {
  EngineSlots,
  engineUniformBlocks,
  LogicalBinding,
  ProgramLayout,
  slotOrder,
  uniformBlockName,
} from './layout';
import { lowerSurface } from './lowering';
import { expandMacros } from './macros';
import { optimize, structuralParams } from './optimize';
import { planStages } from './stages';
import { WorkingGraph } from './WorkingGraph';

/**
 * Bumped when the compiler output changes, to invalidate cached programs.
 *
 * @group Compilation
 */
export const CompilerVersion = 1;

/**
 * Limits of the target backend that the compiler checks.
 *
 * @group Compilation
 */
export interface CompilerCapabilities {
  /** Maximum number of varyings between the vertex and fragment stages. */
  readonly maxVaryings: number;
}

/**
 * The guaranteed limits of WebGPU.
 *
 * @group Compilation
 */
export const defaultCompilerCapabilities: CompilerCapabilities = {
  /** WebGPU guaranteed limit (maxInterStageShaderVariables). */
  maxVaryings: 16,
};

/**
 * Options of {@link compile}.
 *
 * @group Compilation
 */
export interface CompileOptions {
  /** Node types of the graph. Defaults to the standard library. */
  readonly registry?: NodeRegistry;
  /**
   * Semantics of the attributes provided by the mesh. When given, the
   * compilation fails if the program needs another one.
   */
  readonly vertexAttributes?: readonly string[];
  /**
   * Limits of the target backend. Defaults to
   * {@link defaultCompilerCapabilities}.
   */
  readonly capabilities?: Partial<CompilerCapabilities>;
  /**
   * Static parameters of the material, read by the macros: normalMap: true…
   * They override the defaults declared by the graph parameters.
   */
  readonly features?: Readonly<Record<string, StaticValue>>;
}

/**
 * A vertex attribute read by a program.
 *
 * @group Compilation
 */
export interface VertexInputRequirement {
  /** Semantic of the attribute. */
  readonly semantic: string;
  /** Type read by the shader. */
  readonly type: ShaderType;
  /** Shader location of the input. */
  readonly location: number;
  /** Name of the stage input in the generated code. */
  readonly name: string;
}

/**
 * A backend-independent program, result of {@link compile}.
 *
 * @group Compilation
 */
export interface CompiledProgram {
  /** Name of the graph. */
  readonly name: string;
  /**
   * Structural hash of the program: equal for graphs that compile to the same
   * code, independently of the uniform values.
   */
  readonly programKey: string;
  /**
   * Static parameters read by the macros during the compilation, with the
   * value they had. Parameters that were not read do not create variants.
   */
  readonly variantKey: Readonly<Record<string, StaticValue>>;
  /** The code of the vertex and fragment stages. */
  readonly module: ShaderModuleIR;
  /** The resources of the program, by slot. */
  readonly layout: ProgramLayout;
  /** The vertex attributes the program reads. */
  readonly vertexInputs: readonly VertexInputRequirement[];
  /** Warnings; errors make compile() throw. */
  readonly diagnostics: readonly Diagnostic[];
}

const resourceTypes = new Set([
  'input.uniform',
  'input.texture',
  'input.sampler',
]);
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]*$/;

function isSupportedType(type: ShaderType): boolean {
  switch (type.kind) {
    case 'scalar':
    case 'vector':
    case 'matrix':
      return type.scalar !== 'f16';
    case 'texture':
    case 'sampler':
      return true;
    default:
      return false;
  }
}

// Checks what the current compiler does not support, or reserves.
function checkSupport(
  validation: GraphValidation,
  diagnostics: Diagnostic[]
): void {
  for (const { node, definition, params } of validation.nodes.values()) {
    const error = (message: string) =>
      diagnostics.push({ severity: 'error', node: node.id, message });

    if (node.type === 'input.storage') {
      error('storage buffers are not supported yet');
      continue;
    }
    if (
      isFunctionDefinition(definition) &&
      definition.implementation?.kind !== 'intrinsic'
    ) {
      /** A function node type may also have no implementation at all. */
      error(
        definition.implementation
          ? `${definition.implementation.kind} functions are not supported yet`
          : `node type "${definition.id}" has no implementation`
      );
      continue;
    }

    const types = validation.types.get(node.id);
    for (const [port, type] of Object.entries({
      ...types?.inputs,
      ...types?.outputs,
    })) {
      if (!isSupportedType(type)) {
        error(
          `port "${port}": ${typeToString(type)} values are not supported yet`
        );
      }
    }

    if (node.type === 'input.attribute') {
      const type = params['type'] as ShaderType;
      if (
        (type.kind !== 'scalar' && type.kind !== 'vector') ||
        type.scalar === 'bool'
      ) {
        error(
          `attribute "${
            params['semantic']
          }" must be a numeric scalar or vector, got ${typeToString(type)}`
        );
      }
    }

    if (!resourceTypes.has(node.type)) {
      continue;
    }
    const name = params['name'] as string;
    const slot = params['slot'] as string;
    if (!identifierPattern.test(name)) {
      error(
        `resource name "${name}" must start with a letter and contain only letters, digits and _`
      );
    }
    if (/Uniforms$/.test(name)) {
      error(`resource name "${name}" is reserved for uniform blocks`);
    }
    if ((EngineSlots as readonly string[]).includes(slot)) {
      error(
        `slot "${slot}" is reserved for engine values, use input.engine or another slot`
      );
    }
    if (!identifierPattern.test(slot)) {
      error(
        `slot name "${slot}" must start with a letter and contain only letters, digits and _`
      );
    }
    if (node.type === 'input.uniform') {
      const type = params['type'] as ShaderType;
      if (type.kind === 'scalar' && type.scalar === 'bool') {
        error(
          `uniform "${name}": bool is not allowed in uniform buffers, use u32`
        );
      } else if (
        type.kind !== 'scalar' &&
        type.kind !== 'vector' &&
        type.kind !== 'matrix'
      ) {
        error(
          `uniform "${name}": ${typeToString(
            type
          )} uniforms are not supported yet`
        );
      }
    }
  }
}

// Built from the resolved parameters, so that the declared defaults (slot
// 'material', dimension '2d'…) apply.
function buildLayout(nodes: Iterable<ResolvedNode>): ProgramLayout {
  const resources = [...nodes]
    .filter(({ node }) => resourceTypes.has(node.type))
    .map(({ node, params }) => ({
      type: node.type,
      params,
      name: params['name'] as string,
      slot: params['slot'] as string,
    }));
  const slots = slotOrder(resources.map((resource) => resource.slot));

  return {
    groups: slots.map((slot) => {
      if (slot === 'frame' || slot === 'object') {
        return {
          slot,
          bindings: [
            {
              kind: 'uniform-block',
              name: uniformBlockName(slot),
              members: engineUniformBlocks[slot],
            },
          ],
        };
      }

      // One binding per name, sorted, so that equivalent graphs get the same
      // binding numbers.
      const ofType = (type: string) =>
        [
          ...new Map(
            resources
              .filter(
                (resource) => resource.slot === slot && resource.type === type
              )
              .map((resource) => [resource.name, resource])
          ).values(),
        ].sort((a, b) => a.name.localeCompare(b.name));

      const bindings: LogicalBinding[] = [];
      const uniforms = ofType('input.uniform');
      if (uniforms.length > 0) {
        bindings.push({
          kind: 'uniform-block',
          name: uniformBlockName(slot),
          members: uniforms.map(({ name, params }) => ({
            name,
            type: params['type'] as ShaderType,
          })),
        });
      }
      for (const { name, params } of ofType('input.texture')) {
        bindings.push({
          kind: 'texture',
          name,
          type: {
            kind: 'texture',
            dimension: params['dimension'] as TextureType['dimension'],
            sampleType: params['sampleType'] as TextureType['sampleType'],
          },
        });
      }
      for (const { name, params } of ofType('input.sampler')) {
        bindings.push({
          kind: 'sampler',
          name,
          comparison: params['comparison'] === true,
        });
      }
      return { slot, bindings };
    }),
  };
}

// Merkle hash of the optimized graph: each node is hashed from its content
// and the hashes of its sources. Independent of the node ids and of their
// order, so that equivalent graphs get the same key.
function programKey(graph: WorkingGraph, order: readonly NodeId[]): string {
  const hashes = new Map<NodeId, string>();
  for (const id of order) {
    const node = graph.nodes.get(id) as GraphNode;
    const inputs = graph
      .incoming(id)
      .map((edge) => [
        edge.to.port,
        hashes.get(edge.from.node),
        edge.from.port,
        edge.swizzle ?? '',
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    hashes.set(
      id,
      hashString(
        stableStringify([
          node.type,
          structuralParams(node),
          node.defaults ?? {},
          node.label ?? '',
          inputs,
        ])
      )
    );
  }

  const outputs = [...graph.nodes.values()]
    .filter(
      (node) => node.type === 'output.vertex' || node.type === 'output.fragment'
    )
    .map((node) => hashes.get(node.id) as string)
    .sort();
  return hashString(stableStringify({ version: CompilerVersion, outputs }));
}

/**
 * Compiles a material graph into a backend-independent program: the
 * intermediate representation of its stages, its resource layout and its
 * vertex inputs. A backend then generates the shader code from it.
 *
 * The compiler lowers `output.surface` (standard vertex stage and shading
 * model), expands the macros, removes dead code, folds constants, merges
 * identical nodes, and places each computation in the vertex or fragment
 * stage.
 *
 * @throws {@link GraphError} when the graph has errors.
 *
 * @example
 * ```ts
 * const program = compile(graph, {
 *   vertexAttributes: ['position', 'normal', 'uv'],
 * });
 * program.programKey; // equal for graphs that compile to the same code
 * ```
 *
 * @group Compilation
 */
export function compile(
  graph: MaterialGraphData,
  options: CompileOptions = {}
): CompiledProgram {
  const registry = options.registry ?? createStandardRegistry();
  const capabilities = {
    ...defaultCompilerCapabilities,
    ...options.capabilities,
  };
  const fail = (diagnostics: readonly Diagnostic[]): never => {
    throw new GraphError(
      diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    );
  };

  const validation = validateGraph(graph, registry);
  const warnings = validation.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'warning'
  );
  if (!validation.valid) {
    fail(validation.diagnostics);
  }

  const diagnostics: Diagnostic[] = [];
  checkSupport(validation, diagnostics);
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }

  const working = new WorkingGraph(graph);
  lowerSurface(working, registry, diagnostics);
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }

  // Static parameters: material features, then graph parameter defaults,
  // then the attributes of the mesh. Every read is recorded.
  const variantKey: Record<string, StaticValue> = {};
  const parameters = new Map(
    (graph.parameters ?? []).map((parameter) => [
      parameter.name,
      parameter.default,
    ])
  );
  const feature = (name: string): StaticValue | undefined => {
    let value = options.features?.[name] ?? parameters.get(name);
    if (
      value === undefined &&
      name.startsWith('hasAttribute.') &&
      options.vertexAttributes
    ) {
      value = options.vertexAttributes.includes(
        name.slice('hasAttribute.'.length)
      );
    }
    if (value !== undefined) {
      variantKey[name] = value;
    }
    return value;
  };
  expandMacros({ graph: working, registry, feature, diagnostics });
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }

  // Each transformation is followed by a validation, which recomputes the
  // order and the types of the transformed graph.
  const revalidate = () => {
    const result = validateGraph(working.toData(), registry);
    if (!result.valid) {
      fail(result.diagnostics);
    }
    return result;
  };
  const lowered = revalidate();
  /** The nodes generated by the macros are checked too. */
  checkSupport(lowered, diagnostics);
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }
  optimize(working, registry, lowered.order, lowered.types);
  const optimized = revalidate();

  if (options.vertexAttributes) {
    const available = new Set(options.vertexAttributes);
    for (const node of working.nodes.values()) {
      const semantic = node.params['semantic'] as string;
      if (node.type === 'input.attribute' && !available.has(semantic)) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `the mesh does not provide the "${semantic}" attribute`,
        });
      }
    }
    if (diagnostics.length > 0) {
      fail(diagnostics);
    }
  }

  const plan = planStages({
    graph: working,
    nodes: optimized.nodes,
    order: optimized.order,
    types: optimized.types,
    maxVaryings: capabilities.maxVaryings,
    diagnostics,
  });
  if (!plan) {
    return fail(diagnostics);
  }

  const module = generateIr({
    graph: working,
    nodes: optimized.nodes,
    order: optimized.order,
    types: optimized.types,
    plan,
  });

  return {
    name: graph.name,
    programKey: programKey(working, optimized.order),
    variantKey,
    module,
    layout: buildLayout(optimized.nodes.values()),
    vertexInputs: plan.attributes.map(({ semantic, type, location, name }) => ({
      semantic,
      type,
      location,
      name,
    })),
    diagnostics: warnings,
  };
}
