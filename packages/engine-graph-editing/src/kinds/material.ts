import { type GraphBody, isRecord, type ParamSchema } from '@fdw/engine-graph';
import {
  BuiltinTypes,
  createStandardRegistry,
  type GraphFunctionData,
  type GraphParameterDeclaration,
  type MaterialGraphData,
  MaterialGraphFormat,
  MaterialGraphVersion,
  type NodeDefinition,
  type NodeRegistry,
  parseGraph,
  portTypeToString,
  registryWithFunctions,
  resolveParams,
  serializeGraph,
  type ShaderType,
  type StaticValue,
  typeToString,
  validateGraph,
} from '@fdw/engine-shader';
import {
  defaultTitle,
  type GraphKind,
  type KindValidation,
  paramViews,
  typeTitle,
} from '../GraphKind';
import type { NodeTemplate, NodeView, PortView, ScopeView } from '../protocol';

// The types the inspector offers for the `type` parameters, by name.
const namedTypes = new Map<string, ShaderType>(
  Object.values(BuiltinTypes).map((type) => [typeToString(type), type]),
);
const scalars = new Set(['f32', 'f16', 'i32', 'u32', 'bool']);

/** A type written as the editor shows it (`vec3<f32>`), or undefined. */
export function parseShaderType(text: string): ShaderType | undefined {
  const named = namedTypes.get(text.trim());
  if (named) return named;
  const vector = /^vec([234])<(f32|f16|i32|u32|bool)>$/.exec(text.trim());
  if (vector) {
    return {
      kind: 'vector',
      size: Number(vector[1]) as 2 | 3 | 4,
      scalar: vector[2] as 'f32',
    } as ShaderType;
  }
  return undefined;
}

const isShaderType = (value: unknown): value is ShaderType =>
  isRecord(value) && typeof value['kind'] === 'string';

/**
 * Whether an output of a type may feed an input of another, as the editor
 * guesses it: the same type, a scalar into a vector of its kind, or a
 * generic type (resolved by the validation only).
 */
export function acceptsMaterialType(from: string, to: string): boolean {
  if (from === to) return true;
  const concrete = (type: string) => scalars.has(type) || type.includes('<');
  if (!concrete(from) || !concrete(to)) return true;
  const vector = /^vec[234]<(\w+)>$/.exec(to);
  return vector !== null && vector[1] === from;
}

function materialTitle(node: MaterialGraphData['nodes'][number]): string {
  if (node.label) return node.label;
  const param = (name: string) => node.params[name];
  switch (node.type) {
    case 'input.uniform':
    case 'input.storage':
    case 'input.texture':
    case 'input.sampler':
      return `${typeTitle(node.type)} ${String(param('name'))}`;
    case 'input.attribute':
      return `attribute ${String(param('semantic'))}`;
    case 'input.engine':
      return String(param('value'));
    case 'input.builtin':
      return String(param('builtin'));
    case 'const.value': {
      const value = param('value');
      return Array.isArray(value)
        ? `(${value.join(', ')})`
        : JSON.stringify(value ?? 0);
    }
    case 'output.surface':
      return `surface (${String(param('shadingModel') ?? 'unlit')})`;
    case 'function.input':
      return `input ${String(param('name'))}`;
    case 'function.output':
      return `output ${String(param('name'))}`;
  }
  // The functions of the standard library by their name alone, the others
  // with their family: `smoothstep`, `noise perlin3`, `loop index`.
  const dot = node.type.indexOf('.');
  return dot < 0 || node.type.startsWith('std.')
    ? defaultTitle(node)
    : `${node.type.slice(0, dot)} ${typeTitle(node.type)}`;
}

// The parameters as the editor shows them: the types by name.
function shownParams(
  params: Readonly<Record<string, StaticValue>>,
): Record<string, unknown> {
  const shown: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    shown[name] = isShaderType(value) ? typeToString(value) : value;
  }
  return shown;
}

function schemaOf(definition: NodeDefinition) {
  return paramViews(definition.params).map((param) =>
    param.kind === 'type'
      ? {
          ...param,
          values: [...namedTypes.keys()],
          ...(param.default !== undefined &&
            isShaderType(param.default) && {
              default: typeToString(param.default),
            }),
        }
      : param,
  );
}

// A value for a required parameter, for a template.
function placeholder(name: string, schema: ParamSchema): unknown {
  if (schema.values?.length) return schema.values[0];
  switch (schema.kind) {
    case 'type':
      return BuiltinTypes.f32;
    case 'number':
    case 'constant':
      return 0;
    case 'boolean':
      return false;
    default:
      return name === 'name' ? 'value' : name;
  }
}

const templateTypes: readonly [string, ShaderType][] = [
  ['float', BuiltinTypes.f32],
  ['vec2', BuiltinTypes.vec2f],
  ['vec3', BuiltinTypes.vec3f],
  ['vec4', BuiltinTypes.vec4f],
];

/**
 * The material graphs (`engine-shader`), with the node types of a
 * registry (the standard library by default).
 */
export function materialGraphKind(
  registry: NodeRegistry = createStandardRegistry(),
): GraphKind<MaterialGraphData> {
  const functionsOf = (document: MaterialGraphData) => document.functions ?? [];
  const registryOf = (document: MaterialGraphData) =>
    registryWithFunctions(registry, document);
  const bodyOf = (document: MaterialGraphData, scope?: string) => {
    if (scope === undefined) return document;
    const fn = functionsOf(document).find((f) => f.id === scope);
    if (!fn) throw new Error(`No function "${scope}"`);
    return fn.graph;
  };

  const validate = (
    document: MaterialGraphData,
    scope?: string,
  ): KindValidation => {
    const graph = bodyOf(document, scope);
    let types: NodeRegistry;
    try {
      types = registryOf(document);
    } catch {
      types = registry;
    }
    const validation = validateGraph(graph, types);
    const nodes = new Map<string, Omit<NodeView, 'id' | 'type' | 'params'>>();
    for (const [id, resolved] of validation.nodes) {
      const concrete = validation.types.get(id);
      const port = (
        schema: (typeof resolved.inputs)[number],
        side: 'input' | 'output',
      ): PortView => {
        const known =
          side === 'input'
            ? concrete?.inputs[schema.name]
            : concrete?.outputs[schema.name];
        return {
          name: schema.name,
          type: known ? typeToString(known) : portTypeToString(schema.type),
          connections: side === 'input' ? 'one' : 'many',
          ...(schema.optional && { optional: true }),
          ...(schema.default !== undefined && { default: schema.default }),
        };
      };
      nodes.set(id, {
        title: materialTitle(resolved.node),
        category: resolved.definition.category,
        ...(resolved.definition.description && {
          description: resolved.definition.description,
        }),
        schema: schemaOf(resolved.definition),
        inputs: resolved.inputs.map((p) => port(p, 'input')),
        outputs: resolved.outputs.map((p) => port(p, 'output')),
      });
    }
    return {
      nodes,
      diagnostics: validation.diagnostics.map((diagnostic) =>
        scope === undefined ? diagnostic : { ...diagnostic, scope },
      ),
    };
  };

  return {
    id: 'material',
    title: 'Material graph',
    extension: '.material.json',
    idPrefix: 'n',
    create: (name) => ({
      format: MaterialGraphFormat,
      version: MaterialGraphVersion,
      name,
      nodes: [
        {
          id: 'color',
          type: 'const.value',
          params: { type: BuiltinTypes.vec3f, value: [0.8, 0.5, 0.3] },
        },
        {
          id: 'surface',
          type: 'output.surface',
          params: { shadingModel: 'pbr' },
          defaults: { roughness: 0.5, metallic: 0 },
        },
      ] as MaterialGraphData['nodes'],
      edges: [
        {
          from: { node: 'color', port: 'value' },
          to: { node: 'surface', port: 'baseColor' },
        },
      ],
      layout: {
        nodes: { color: { x: 0, y: 0 }, surface: { x: 260, y: 0 } },
      },
    }),
    parse: (source) => parseGraph(source),
    serialize: (document) => serializeGraph(document),

    scopes: (document): ScopeView[] => [
      { title: document.name },
      ...functionsOf(document).map((fn) => ({
        id: fn.id,
        title: fn.id,
        kind: 'function',
      })),
    ],
    body: (document, scope): GraphBody => bodyOf(document, scope),
    withBody: (document, scope, body) => {
      const { nodes, edges, layout } = body as GraphBody<
        MaterialGraphData['nodes'][number],
        MaterialGraphData['edges'][number]
      >;
      const apply = (graph: MaterialGraphData): MaterialGraphData => ({
        ...graph,
        nodes,
        edges,
        ...(layout && { layout }),
      });
      if (scope === undefined) return apply(document);
      return {
        ...document,
        functions: functionsOf(document).map((fn) =>
          fn.id === scope ? { ...fn, graph: apply(fn.graph) } : fn,
        ),
      };
    },
    validate,
    check: (document) => [
      ...validate(document).diagnostics,
      ...functionsOf(document).flatMap(
        (fn) => validate(document, fn.id).diagnostics,
      ),
    ],

    templates: (document, scope): NodeTemplate[] => {
      let types: NodeRegistry;
      try {
        types = registryOf(document);
      } catch {
        types = registry;
      }
      const templates: NodeTemplate[] = [];
      const add = (
        id: string,
        title: string,
        definition: NodeDefinition,
        params: Record<string, StaticValue> = {},
        keywords: string[] = [],
      ) => {
        let ports: { inputs: PortView[]; outputs: PortView[] };
        try {
          const resolved = resolveParams(definition, params);
          const view = (
            schema: ReturnType<NodeDefinition['inputs']>[number],
            side: 'input' | 'output',
          ): PortView => ({
            name: schema.name,
            type: portTypeToString(schema.type),
            connections: side === 'input' ? 'one' : 'many',
            ...(schema.optional && { optional: true }),
          });
          ports = {
            inputs: definition
              .inputs(resolved, { registry: types })
              .map((p) => view(p, 'input')),
            outputs: definition
              .outputs(resolved, { registry: types })
              .map((p) => view(p, 'output')),
          };
        } catch {
          ports = { inputs: [], outputs: [] };
        }
        templates.push({
          id,
          title,
          type: definition.id,
          ...(Object.keys(params).length > 0 && { params }),
          category: definition.category,
          ...(definition.description && {
            description: definition.description,
          }),
          keywords: [definition.id, ...keywords],
          ...ports,
        });
      };
      for (const definition of types.definitions) {
        const schemas = Object.entries(definition.params ?? {});
        const required = schemas.filter(
          ([, schema]) => schema.required && schema.default === undefined,
        );
        if (
          scope === undefined &&
          (definition.id === 'function.input' ||
            definition.id === 'function.output')
        ) {
          continue;
        }
        // A function does not call itself.
        if (definition.id === scope) continue;
        const enumerated = schemas.find(
          ([, schema]) => schema.values && schema.values.length <= 32,
        );
        const typed = required.find(([, schema]) => schema.kind === 'type');
        const base: Record<string, StaticValue> = {};
        for (const [name, schema] of required) {
          base[name] = placeholder(name, schema) as StaticValue;
        }
        const title = materialTitle({
          id: '',
          type: definition.id,
          params: base,
        });
        if (definition.id === 'const.value') {
          for (const [name, type] of templateTypes) {
            add(
              `const.value:${name}`,
              `${name} constant`,
              definition,
              {
                type,
                value: type.kind === 'vector' ? Array(type.size).fill(0) : 0,
              },
              ['constant', 'value'],
            );
          }
        } else if (typed) {
          for (const [name, type] of templateTypes) {
            add(
              `${definition.id}:${name}`,
              `${typeTitle(definition.id)} ${name}`,
              definition,
              { ...base, [typed[0]]: type },
            );
          }
        } else if (definition.id === 'output.surface') {
          for (const model of ['unlit', 'phong', 'pbr']) {
            add(
              `output.surface:${model}`,
              `surface (${model})`,
              definition,
              {
                shadingModel: model,
              },
              ['output', 'shading'],
            );
          }
        } else if (enumerated && enumerated[1].required) {
          for (const value of enumerated[1].values ?? []) {
            const params = { ...base, [enumerated[0]]: value };
            add(
              `${definition.id}:${value}`,
              materialTitle({ id: '', type: definition.id, params }),
              definition,
              params,
            );
          }
        } else {
          add(definition.id, title, definition, base);
        }
      }
      return templates;
    },
    catalogKey: (document, scope) =>
      JSON.stringify([scope ?? '', functionsOf(document).map((fn) => fn.id)]),

    fields: (document) => ({
      parameters: document.parameters ?? [],
      functions: functionsOf(document).map((fn) => ({
        name: fn.id,
        ...(fn.description !== undefined && { description: fn.description }),
      })),
    }),
    setField: (document, key, value) => {
      switch (key) {
        case 'name':
          if (typeof value !== 'string' || value === '') {
            throw new Error('A graph needs a name');
          }
          return { ...document, name: value };
        case 'parameters': {
          if (
            !Array.isArray(value) ||
            !value.every(
              (parameter) =>
                isRecord(parameter) &&
                typeof parameter['name'] === 'string' &&
                parameter['default'] !== undefined,
            )
          ) {
            throw new Error(
              'The parameters must be an array of { name, default }',
            );
          }
          return {
            ...document,
            parameters: value as GraphParameterDeclaration[],
          };
        }
        default:
          throw new Error(`A material graph has no field "${key}"`);
      }
    },
    editFunction: (document, name, change) => {
      const functions = [...functionsOf(document)];
      const index = functions.findIndex((fn) => fn.id === name);
      if (change === 'create') {
        if (index >= 0 || registry.has(name)) {
          throw new Error(`A node type "${name}" exists already`);
        }
        const fn: GraphFunctionData = {
          id: name,
          graph: {
            format: MaterialGraphFormat,
            version: MaterialGraphVersion,
            name,
            nodes: [
              {
                id: 'x',
                type: 'function.input',
                params: { name: 'x', type: BuiltinTypes.f32 },
              },
              {
                id: 'result',
                type: 'function.output',
                params: { name: 'result' },
              },
            ],
            edges: [
              {
                from: { node: 'x', port: 'value' },
                to: { node: 'result', port: 'value' },
              },
            ],
            layout: {
              nodes: { x: { x: 0, y: 0 }, result: { x: 300, y: 0 } },
            },
          },
        };
        return { ...document, functions: [...functions, fn] };
      }
      if (index < 0) throw new Error(`No function "${name}"`);
      if (change === 'remove') {
        functions.splice(index, 1);
        const next: MaterialGraphData = { ...document, functions };
        if (functions.length === 0) {
          delete (next as { functions?: unknown }).functions;
        }
        return next;
      }
      const fn = functions[index];
      functions[index] = {
        ...fn,
        ...(typeof change['description'] === 'string' && {
          description: change['description'],
        }),
      };
      return { ...document, functions };
    },
    viewParams: (params) => shownParams(params as Record<string, StaticValue>),
    editorParams: (document, type, params) => {
      let types: NodeRegistry;
      try {
        types = registryOf(document);
      } catch {
        types = registry;
      }
      return materialParamsFromEditor(types.get(type), params);
    },
    accepts: acceptsMaterialType,
  };
}

/**
 * The parameters an editor sends for a material node, as the document
 * holds them: the types parsed from their names.
 *
 * @throws for a type name it does not know.
 */
export function materialParamsFromEditor(
  definition: NodeDefinition | undefined,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    if (
      definition?.params?.[name]?.kind === 'type' &&
      typeof value === 'string'
    ) {
      const type = parseShaderType(value);
      if (!type) throw new Error(`Unknown type "${value}"`);
      parsed[name] = type;
    } else {
      parsed[name] = value;
    }
  }
  return parsed;
}
