import { Diagnostic, GraphError } from '../graph/Diagnostic';
import type {
  GraphNode,
  MaterialGraphData,
  NodeId,
  StaticValue,
} from '../graph/MaterialGraphData';
import { registryWithFunctions } from '../graph/functions';
import { isFunctionDefinition } from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import {
  GraphValidation,
  ResolvedNode,
  validateGraph,
} from '../graph/validateGraph';
import { createStandardRegistry } from '../std';
import {
  ArrayType,
  ShaderType,
  TextureType,
  typeToString,
} from '../types/ShaderType';
import { hashString, stableStringify } from './hash';
import type { ShaderModuleIR } from './ir';
import { generateComputeIr, generateIr, lightLoopBodies } from './generateIr';
import {
  EngineSlots,
  engineUniformBlocks,
  engineResources,
  engineValueLocations,
  LogicalBinding,
  ObjectTableName,
  ProgramLayout,
  slotOrder,
  uniformBlockName,
} from './layout';
import { lowerFullscreen, lowerSurface } from './lowering';
import { expandMacros } from './macros';
import { optimize, structuralParams } from './optimize';
import { planStages } from './stages';
import { WorkingGraph } from './WorkingGraph';

/**
 * Bumped when the compiler output changes, to invalidate cached programs.
 *
 * @group Compilation
 */
export const CompilerVersion = 3;

/**
 * Limits of the target backend that the compiler checks.
 *
 * @group Compilation
 */
export interface CompilerCapabilities {
  /** Maximum number of varyings between the vertex and fragment stages. */
  readonly maxVaryings: number;
  /** Storage buffers (not in WebGL2). */
  readonly storageBuffers: boolean;
  /** Compute stages (not in WebGL2). */
  readonly compute: boolean;
  /**
   * The object data in a table indexed per instance (an 'object-table'
   * binding), instead of a uniform block per object. Default false.
   */
  readonly objectTable?: boolean;
}

/**
 * The guaranteed limits of WebGPU.
 *
 * @group Compilation
 */
export const defaultCompilerCapabilities: CompilerCapabilities = {
  /** WebGPU guaranteed limit (maxInterStageShaderVariables). */
  maxVaryings: 16,
  storageBuffers: true,
  compute: true,
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
  'input.storage',
  'input.texture',
  'input.sampler',
]);

// Elements of storage buffers: numeric scalars, vectors and matrices.
const isStorageElement = (type: ShaderType): boolean =>
  (type.kind === 'scalar' ||
    type.kind === 'vector' ||
    type.kind === 'matrix') &&
  type.scalar !== 'bool' &&
  type.scalar !== 'f16';
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
    case 'array':
      return isSupportedType(type.element);
    default:
      return false;
  }
}

const isCompute = (validation: GraphValidation): boolean =>
  [...validation.nodes.values()].some(
    ({ node }) => node.type === 'output.compute'
  );

// What compute graphs cannot do: stage-specific nodes, reading the buffers
// they write (threads run in any order), writing read-only buffers.
function checkCompute(
  graph: WorkingGraph,
  validation: GraphValidation,
  diagnostics: Diagnostic[]
): void {
  const error = (node: NodeId, message: string) =>
    diagnostics.push({ severity: 'error', node, message });
  for (const { node, definition, params } of validation.nodes.values()) {
    const stage = definition.stage?.(params);
    if (stage === 'vertex' || stage === 'fragment') {
      error(
        node.id,
        `${node.type} is only available in the ${stage} stage${
          node.type === 'std.textureSample'
            ? ': use std.textureSampleLevel'
            : ''
        }`
      );
    }
    if (node.type === 'output.compute') {
      const size = params['workgroupSize'];
      if (
        !Array.isArray(size) ||
        size.length !== 3 ||
        !size.every((n) => Number.isInteger(n) && n > 0)
      ) {
        error(node.id, 'workgroupSize must be three positive integers');
      }
    }
    if (node.type === 'write.storage') {
      const source = graph.inputSource(node, 'array');
      const storage =
        source && 'ref' in source
          ? graph.nodes.get(source.ref.node)
          : undefined;
      if (storage?.type !== 'input.storage') {
        error(node.id, 'write.storage writes a storage buffer (input.storage)');
      } else if (storage.params['access'] !== 'read-write') {
        error(
          node.id,
          `storage buffer "${storage.params['name']}" is read-only: declare it with read-write access to write it`
        );
      }
    }
    if (node.type === 'input.storage' && params['access'] === 'read-write') {
      for (const edge of graph.edges) {
        if (edge.from.node !== node.id) {
          continue;
        }
        const consumer = graph.nodes.get(edge.to.node);
        const allowed =
          (consumer?.type === 'write.storage' && edge.to.port === 'array') ||
          consumer?.type === 'std.arrayLength';
        if (!allowed) {
          error(
            node.id,
            `storage buffer "${params['name']}" is written by the graph: it cannot be read (threads run in any order)`
          );
          break;
        }
      }
    }
  }
}

// Checks what the current compiler does not support, or reserves.
function checkSupport(
  validation: GraphValidation,
  diagnostics: Diagnostic[],
  capabilities: CompilerCapabilities
): void {
  for (const { node, definition, params } of validation.nodes.values()) {
    const error = (message: string) =>
      diagnostics.push({ severity: 'error', node: node.id, message });

    if (node.type === 'input.storage') {
      const type = params['type'] as ShaderType;
      if (!capabilities.storageBuffers) {
        error(
          `storage buffer "${params['name']}": the backend has no storage buffers (WebGL2)`
        );
        continue;
      }
      if (
        type.kind !== 'array' ||
        type.length !== undefined ||
        !isStorageElement(type.element)
      ) {
        error(
          `storage buffer "${
            params['name']
          }" must be a runtime-sized array of numeric scalars, vectors or matrices, got ${typeToString(
            type
          )}`
        );
        continue;
      }
      if (params['access'] !== 'read' && !isCompute(validation)) {
        error(
          `storage buffer "${params['name']}": only compute graphs write storage buffers, use read access`
        );
        continue;
      }
    }
    if (
      isFunctionDefinition(definition) &&
      definition.implementation?.kind !== 'intrinsic' &&
      definition.implementation?.kind !== 'graph'
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

// Replaces the input.engine reads of the object values with input.object
// reads of the object table, at the row given by the object-index builtin.
// Returns whether the graph changed.
function useObjectTable(graph: WorkingGraph): boolean {
  const reads = [...graph.nodes.values()].filter(
    (node) =>
      node.type === 'input.engine' &&
      engineValueLocations[node.params['value'] as string]?.slot === 'object'
  );
  if (reads.length === 0) {
    return false;
  }
  const index = graph.addNode(
    'input.builtin',
    { builtin: 'object-index' },
    {},
    'objectIndex'
  );
  for (const read of reads) {
    const location = engineValueLocations[read.params['value'] as string];
    const object = graph.addNode(
      'input.object',
      { member: location.member },
      { index: { ref: { node: index, port: 'value' } } },
      read.label
    );
    graph.redirectPort(
      { node: read.id, port: 'value' },
      { ref: { node: object, port: 'value' } }
    );
    graph.removeNode(read.id);
  }
  return true;
}

// Built from the resolved parameters, so that the declared defaults (slot
// 'material', dimension '2d'…) apply.
function buildLayout(
  nodes: Iterable<ResolvedNode>,
  {
    usedSlotsOnly = false,
    objectTable = false,
  }: { usedSlotsOnly?: boolean; objectTable?: boolean } = {}
): ProgramLayout {
  const all = [...nodes];
  const resources = all
    .filter(({ node }) => resourceTypes.has(node.type))
    .map(({ node, params }) => ({
      type: node.type,
      params,
      name: params['name'] as string,
      slot: params['slot'] as string,
    }));
  // Materials always have the built-in slots, at fixed group indices shared
  // by every program; compute graphs only have the slots they use.
  const engineValues = new Set(
    all
      .filter(({ node }) => node.type === 'input.engine')
      .map(({ params }) => params['value'] as string)
  );
  const engineSlots = new Set(
    [...engineValues].map(
      (value) => engineValueLocations[value]?.slot ?? 'frame'
    )
  );
  const slots = slotOrder(resources.map((resource) => resource.slot)).filter(
    (slot) =>
      !usedSlotsOnly ||
      engineSlots.has(slot as never) ||
      resources.some((resource) => resource.slot === slot)
  );

  return {
    groups: slots.map((slot) => {
      if (slot === 'object' && objectTable) {
        return {
          slot,
          bindings: [
            {
              kind: 'object-table',
              name: ObjectTableName,
              members: engineUniformBlocks.object,
            },
          ],
        };
      }
      if (slot === 'frame' || slot === 'object') {
        return {
          slot,
          bindings: [
            {
              kind: 'uniform-block',
              name: uniformBlockName(slot),
              members: engineUniformBlocks[slot],
            },
            // The engine resources read by the program (frame only).
            ...Object.entries(engineResources)
              .filter(([value]) => slot === 'frame' && engineValues.has(value))
              .map(([, binding]) => binding),
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
      for (const { name, params } of ofType('input.storage')) {
        bindings.push({
          kind: 'storage-buffer',
          name,
          type: params['type'] as ArrayType,
          access: params['access'] === 'read-write' ? 'read-write' : 'read',
        });
      }
      return { slot, bindings };
    }),
  };
}

// Merkle hash of the optimized graph: each node is hashed from its content
// and the hashes of its sources. Independent of the node ids and of their
// order, and of the labels, which only name the values of the generated code:
// equivalent graphs get the same key, and share their program.
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
          inputs,
        ])
      )
    );
  }

  const outputs = [...graph.nodes.values()]
    .filter(
      (node) =>
        node.type === 'output.vertex' ||
        node.type === 'output.fragment' ||
        node.type === 'output.compute' ||
        node.type === 'write.storage'
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
  // With the function graphs embedded in the graph.
  const registry = registryWithFunctions(
    options.registry ?? createStandardRegistry(),
    graph
  );
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
  const compute = isCompute(validation);
  if (compute && !capabilities.compute) {
    fail([
      {
        severity: 'error',
        message: 'the backend has no compute shaders (WebGL2)',
      },
    ]);
  }
  checkSupport(validation, diagnostics, capabilities);
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

  // The surface lowering reads the 'alphaMode' feature.
  const working = new WorkingGraph(graph);
  lowerSurface(working, registry, diagnostics, feature);
  lowerFullscreen(working, diagnostics);
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }

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
  checkSupport(lowered, diagnostics, capabilities);
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }
  if (compute) {
    checkCompute(working, lowered, diagnostics);
    if (diagnostics.length > 0) {
      fail(diagnostics);
    }
  }
  // The object values read from the table: input.engine becomes
  // input.object, at the row of the object drawn.
  const tabled =
    !compute && capabilities.objectTable && useObjectTable(working)
      ? revalidate()
      : lowered;
  optimize(working, registry, tabled.order, tabled.types);
  const optimized = revalidate();

  if (compute) {
    return {
      name: graph.name,
      programKey: programKey(working, optimized.order),
      variantKey,
      module: generateComputeIr({
        graph: working,
        nodes: optimized.nodes,
        order: optimized.order,
        types: optimized.types,
      }),
      layout: buildLayout(optimized.nodes.values(), { usedSlotsOnly: true }),
      vertexInputs: [],
      diagnostics: warnings,
    };
  }

  // Per-light values only exist in the loop of a light.sum.
  for (const id of lightLoopBodies(working)) {
    const node = working.nodes.get(id) as GraphNode;
    if (node.type === 'output.vertex' || node.type === 'output.fragment') {
      diagnostics.push({
        severity: 'error',
        node: id,
        message: 'depends on light.current without going through a light.sum',
      });
    }
  }
  if (diagnostics.length > 0) {
    fail(diagnostics);
  }

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
    layout: buildLayout(optimized.nodes.values(), {
      objectTable: capabilities.objectTable ?? false,
    }),
    vertexInputs: plan.attributes.map(({ semantic, type, location, name }) => ({
      semantic,
      type,
      location,
      name,
    })),
    diagnostics: warnings,
  };
}
