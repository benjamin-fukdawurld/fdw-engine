import {
  acceptsBehaviorType,
  type BehaviorFunctionData,
  type BehaviorGraphData,
  BehaviorGraphFormat,
  BehaviorGraphVersion,
  type BehaviorNodeType,
  type BehaviorPortType,
  type BehaviorSignaturePort,
  type BehaviorVariable,
  CallPrefix,
  callType,
  createBehaviorRegistry,
  type EventField,
  fieldsOf,
  FunctionInputs,
  FunctionOutputs,
  functionOf,
  functionRegistry,
  parseBehaviorGraph,
  serializeBehaviorGraph,
  validateBehaviorFunction,
  validateBehaviorGraph,
} from '@fdw/engine-behavior';
import {
  type GraphBody,
  type GraphNode,
  isRecord,
  type Registry,
  resolveParams,
} from '@fdw/engine-graph';
import {
  defaultTitle,
  type GraphKind,
  type KindValidation,
  paramViews,
  portView,
  tryPorts,
} from '../GraphKind';
import type { NodeTemplate, ScopeView } from '../protocol';

const isExec = (type: BehaviorPortType) => type === 'exec';
const variableTypes = ['number', 'boolean', 'string', 'vec3', 'entity'];

/** The title of a behavior node: what it reads, sets, handles or calls. */
function behaviorTitle(node: GraphNode): string {
  if (node.label) return node.label;
  const param = (name: string) => String(node.params[name] ?? '');
  switch (node.type) {
    case 'var.get':
      return `Get ${param('name')}`;
    case 'var.set':
      return `Set ${param('name')}`;
    case 'event.on':
      return `On ${param('event')}`;
    case 'event.emit':
      return `Emit ${param('event')}`;
    case 'event.start':
      return 'On start';
    case 'event.update':
      return 'On update';
    case 'math.compare':
      return `compare ${param('op') || '<'}`;
    case 'value.constant':
      return JSON.stringify(node.params['value'] ?? 0);
    case FunctionInputs:
      return 'Inputs';
    case FunctionOutputs:
      return 'Outputs';
  }
  if (node.type.startsWith(CallPrefix)) {
    return node.type.slice(CallPrefix.length);
  }
  return defaultTitle(node);
}

// The events of a document: those its nodes handle and send, with their
// fields.
function eventsOf(document: BehaviorGraphData): Map<string, EventField[]> {
  const events = new Map<string, EventField[]>();
  for (const body of [document, ...(document.functions ?? [])]) {
    for (const node of body.nodes) {
      if (node.type !== 'event.on' && node.type !== 'event.emit') continue;
      const event = node.params['event'];
      if (typeof event !== 'string' || events.has(event)) continue;
      try {
        events.set(event, [...fieldsOf(node.params)]);
      } catch {
        events.set(event, []);
      }
    }
  }
  return events;
}

const signature = (fn: BehaviorFunctionData) => ({
  name: fn.name,
  kind: fn.kind ?? 'function',
  ...(fn.description !== undefined && { description: fn.description }),
  inputs: fn.inputs,
  outputs: fn.outputs,
});

function checkPorts(value: unknown, what: string): BehaviorSignaturePort[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (port) =>
        isRecord(port) &&
        typeof port['name'] === 'string' &&
        typeof port['type'] === 'string',
    )
  ) {
    throw new Error(`The ${what} must be an array of { name, type }`);
  }
  return value as BehaviorSignaturePort[];
}

/**
 * The behavior graphs (`engine-behavior`), with the node types of an
 * application (`registry`: the standard ones and those of the game).
 */
export function behaviorGraphKind(
  registry: Registry<BehaviorNodeType> = createBehaviorRegistry(),
): GraphKind<BehaviorGraphData> {
  const resolveIn = (document: BehaviorGraphData, scope?: string) =>
    functionRegistry(
      document,
      registry,
      scope === undefined ? undefined : functionOf(document, scope),
    );

  const kind: GraphKind<BehaviorGraphData> = {
    id: 'behavior',
    title: 'Behavior graph',
    extension: '.behavior.json',
    idPrefix: 'n',
    create: (name) => ({
      format: BehaviorGraphFormat,
      version: BehaviorGraphVersion,
      name,
      nodes: [
        { id: 'start', type: 'event.start', params: {} },
        { id: 'update', type: 'event.update', params: {} },
      ],
      edges: [],
      layout: {
        nodes: { start: { x: 0, y: 0 }, update: { x: 0, y: 120 } },
      },
    }),
    parse: (source) => parseBehaviorGraph(source),
    serialize: (document) => serializeBehaviorGraph(document),

    scopes: (document): ScopeView[] => [
      { title: document.name },
      ...(document.functions ?? []).map((fn) => ({
        id: fn.name,
        title: fn.name,
        kind: fn.kind ?? 'function',
      })),
    ],
    body: (document, scope): GraphBody => {
      if (scope === undefined) return document;
      const fn = functionOf(document, scope);
      if (!fn) throw new Error(`No function "${scope}"`);
      return fn;
    },
    withBody: (document, scope, body) => {
      const { nodes, edges, layout } = body;
      if (scope === undefined) {
        return {
          ...document,
          nodes: nodes as BehaviorGraphData['nodes'],
          edges,
          ...(layout && { layout }),
        };
      }
      return {
        ...document,
        functions: (document.functions ?? []).map((fn) =>
          fn.name === scope
            ? ({
                ...fn,
                nodes,
                edges,
                ...(layout && { layout }),
              } as BehaviorFunctionData)
            : fn,
        ),
      };
    },

    validate: (document, scope): KindValidation => {
      const validation =
        scope === undefined
          ? validateBehaviorGraph(document, registry)
          : validateBehaviorFunction(document, scope, registry);
      const nodes: KindValidation['nodes'] = new Map(
        [...validation.nodes].map(([id, resolved]) => {
          const definition = resolved.definition as BehaviorNodeType;
          return [
            id,
            {
              title: behaviorTitle(resolved.node),
              category: definition.category ?? definition.kind,
              ...(definition.description && {
                description: definition.description,
              }),
              schema: paramViews(definition.params),
              inputs: resolved.inputs.map((port) =>
                portView(port, 'input', String, isExec),
              ),
              outputs: resolved.outputs.map((port) =>
                portView(port, 'output', String, isExec),
              ),
            },
          ];
        }),
      );
      return {
        nodes,
        diagnostics: validation.diagnostics.filter(
          (d) => (d.scope ?? undefined) === scope,
        ),
      };
    },
    check: (document) => validateBehaviorGraph(document, registry).diagnostics,

    templates: (document, scope): NodeTemplate[] => {
      const types = resolveIn(document, scope);
      const templates: NodeTemplate[] = [];
      const add = (
        id: string,
        title: string,
        definition: BehaviorNodeType,
        params: Record<string, unknown> = {},
        keywords: string[] = [],
      ) => {
        const resolved = resolveParams(definition.params, params);
        templates.push({
          id,
          title,
          type: definition.id,
          ...(Object.keys(params).length > 0 && { params }),
          category: definition.category ?? definition.kind,
          ...(definition.description && {
            description: definition.description,
          }),
          keywords: [definition.id, ...keywords],
          ...tryPorts(
            () => ({
              inputs: definition.inputs(resolved),
              outputs: definition.outputs(resolved),
            }),
            String,
            isExec,
          ),
        });
      };
      const variables = document.variables ?? [];
      const events = eventsOf(document);
      for (const definition of types.definitions) {
        switch (definition.id) {
          case 'var.get':
          case 'var.set':
            for (const variable of variables) {
              add(
                `${definition.id}:${variable.name}`,
                `${definition.id === 'var.get' ? 'Get' : 'Set'} ${variable.name}`,
                definition,
                { name: variable.name, type: variable.type },
                ['variable', variable.type],
              );
            }
            continue;
          case 'event.on':
          case 'event.emit': {
            const verb = definition.id === 'event.on' ? 'On' : 'Emit';
            for (const [event, fields] of events) {
              add(
                `${definition.id}:${event}`,
                `${verb} ${event}`,
                definition,
                { event, fields },
                ['event'],
              );
            }
            if (scope === undefined || definition.id === 'event.emit') {
              add(definition.id, `${verb} event…`, definition, {
                event: 'event',
                fields: [],
              });
            }
            continue;
          }
          case 'event.start':
          case 'event.update':
            if (scope !== undefined) continue;
            break;
          case 'flow.switch':
            add(definition.id, 'switch', definition, { cases: ['a', 'b'] });
            continue;
          case FunctionInputs:
          case FunctionOutputs:
            add(
              definition.id,
              definition.id === FunctionInputs ? 'Inputs' : 'Outputs',
              definition,
            );
            continue;
        }
        if (definition.id.startsWith(CallPrefix)) {
          const name = definition.id.slice(CallPrefix.length);
          // A function does not call itself.
          if (name === scope) continue;
          add(definition.id, name, definition, {}, ['call', 'function']);
          continue;
        }
        add(
          definition.id,
          behaviorTitle({ id: '', type: definition.id, params: {} }),
          definition,
        );
      }
      return templates;
    },
    catalogKey: (document, scope) =>
      JSON.stringify([
        scope ?? '',
        document.variables ?? [],
        [...eventsOf(document)],
        (document.functions ?? []).map(signature),
      ]),

    fields: (document) => ({
      variables: document.variables ?? [],
      events: [...eventsOf(document)].map(([name, fields]) => ({
        name,
        fields,
      })),
      functions: (document.functions ?? []).map(signature),
    }),
    setField: (document, key, value) => {
      switch (key) {
        case 'name':
          if (typeof value !== 'string' || value === '') {
            throw new Error('A graph needs a name');
          }
          return { ...document, name: value };
        case 'variables': {
          if (
            !Array.isArray(value) ||
            !value.every(
              (variable) =>
                isRecord(variable) &&
                typeof variable['name'] === 'string' &&
                variableTypes.includes(variable['type'] as string),
            )
          ) {
            throw new Error('The variables must be an array of { name, type }');
          }
          const variables = value as BehaviorVariable[];
          const next: BehaviorGraphData = { ...document, variables };
          if (variables.length === 0)
            delete (next as { variables?: unknown }).variables;
          return next;
        }
        default:
          throw new Error(`A behavior graph has no field "${key}"`);
      }
    },
    editFunction: (document, name, change) => {
      const functions = [...(document.functions ?? [])];
      const index = functions.findIndex((fn) => fn.name === name);
      if (change === 'create') {
        if (index >= 0) throw new Error(`A function "${name}" exists already`);
        functions.push({
          name,
          inputs: [],
          outputs: [],
          nodes: [
            { id: 'inputs', type: FunctionInputs, params: {} },
            { id: 'outputs', type: FunctionOutputs, params: {} },
          ],
          edges: [
            {
              from: { node: 'inputs', port: 'exec' },
              to: { node: 'outputs', port: 'then' },
            },
          ],
          layout: {
            nodes: { inputs: { x: 0, y: 0 }, outputs: { x: 360, y: 0 } },
          },
        });
        return { ...document, functions };
      }
      if (index < 0) throw new Error(`No function "${name}"`);
      if (change === 'remove') {
        functions.splice(index, 1);
        const next: BehaviorGraphData = { ...document, functions };
        if (functions.length === 0)
          delete (next as { functions?: unknown }).functions;
        return next;
      }
      const fn = functions[index];
      let next: BehaviorFunctionData = { ...fn };
      const kindChange = change['kind'];
      if (kindChange !== undefined && kindChange !== (fn.kind ?? 'function')) {
        if (kindChange !== 'function' && kindChange !== 'macro') {
          throw new Error('A function is a "function" or a "macro"');
        }
        // The entry and the exit of a function become those of the macro,
        // and back: the edges of the body stay valid.
        next =
          kindChange === 'macro'
            ? {
                ...next,
                kind: 'macro',
                inputs: [{ name: 'exec', type: 'exec' }, ...next.inputs],
                outputs: [{ name: 'then', type: 'exec' }, ...next.outputs],
              }
            : (() => {
                const plain: BehaviorFunctionData = {
                  ...next,
                  inputs: next.inputs.filter((port) => port.type !== 'exec'),
                  outputs: next.outputs.filter((port) => port.type !== 'exec'),
                };
                delete (plain as { kind?: unknown }).kind;
                return plain;
              })();
      }
      if (change['inputs'] !== undefined) {
        next = { ...next, inputs: checkPorts(change['inputs'], 'inputs') };
      }
      if (change['outputs'] !== undefined) {
        next = { ...next, outputs: checkPorts(change['outputs'], 'outputs') };
      }
      if (change['description'] !== undefined) {
        next = { ...next, description: String(change['description']) };
      }
      let renamed = document;
      const newName = change['name'];
      if (typeof newName === 'string' && newName !== name) {
        if (functions.some((other) => other.name === newName)) {
          throw new Error(`A function "${newName}" exists already`);
        }
        next = { ...next, name: newName };
        // Its calls follow.
        const rename = (body: GraphBody) => ({
          ...body,
          nodes: body.nodes.map((node) =>
            node.type === callType(name)
              ? { ...node, type: callType(newName) }
              : node,
          ),
        });
        renamed = { ...document, ...rename(document) } as BehaviorGraphData;
        functions.forEach((other, i) => {
          functions[i] = rename(other) as unknown as BehaviorFunctionData;
        });
      }
      functions[index] = {
        ...next,
        nodes: functions[index].nodes,
        edges: functions[index].edges,
      };
      return { ...renamed, functions };
    },
    accepts: (from, to) =>
      acceptsBehaviorType(from as BehaviorPortType, to as BehaviorPortType),
  };
  return kind;
}
