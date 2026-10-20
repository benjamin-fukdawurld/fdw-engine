import {
  type Diagnostic,
  type DocumentMigration,
  type DocumentValidation,
  type GraphEdge,
  isRecord,
  parseDocument,
  type Registry,
  serializeDocument,
  validateDocument,
} from '@fdw/engine-graph';
import {
  type BehaviorGraphData,
  BehaviorGraphFormat,
  BehaviorGraphVersion,
  type BehaviorNode,
  type BehaviorPortType,
  type BehaviorVariable,
  isOfType,
} from './data';
import {
  type BehaviorNodeType,
  casesOf,
  createBehaviorRegistry,
  ExecInput,
  fieldsOf,
  ThenOutput,
} from './nodes';

/**
 * Result of {@link validateBehaviorGraph}.
 *
 * @group Behavior graph
 */
export type BehaviorGraphValidation = DocumentValidation<
  BehaviorPortType,
  BehaviorNode,
  GraphEdge
>;

const variableTypes = new Set([
  'number',
  'boolean',
  'string',
  'vec3',
  'entity',
]);

/**
 * The events the system sends itself: `event.on` and `event.emit` cannot
 * take their names.
 *
 * @group Behavior graph
 */
export const ReservedEvents: readonly string[] = ['start', 'update'];

/**
 * Whether an output of type `from` can feed an input of type `to`: the
 * same type, or any value into `any`.
 *
 * @group Behavior graph
 */
export const acceptsBehaviorType = (
  from: BehaviorPortType,
  to: BehaviorPortType,
): boolean => from === to || (to === 'any' && from !== 'exec');

/**
 * Validates a behavior graph: its nodes, edges and types (the graph core;
 * the flow of execution may loop, the values may not), the variables read
 * and set, the events handled and sent, the cases of the switches, the
 * nodes that never run. Does not throw: the problems are in `diagnostics`.
 *
 * `registry` holds the node types of the application with the standard
 * ones ({@link createBehaviorRegistry}).
 *
 * @group Behavior graph
 */
export function validateBehaviorGraph(
  graph: BehaviorGraphData,
  registry: Registry<BehaviorNodeType> = createBehaviorRegistry(),
): BehaviorGraphValidation {
  const variables = new Map<string, BehaviorVariable>();
  const declared: Diagnostic[] = [];
  for (const variable of graph.variables ?? []) {
    if (variables.has(variable.name)) {
      declared.push({
        severity: 'error',
        message: `variable "${variable.name}" is declared twice`,
      });
    }
    if (!variableTypes.has(variable.type)) {
      declared.push({
        severity: 'error',
        message: `variable "${variable.name}" has an unknown type "${String(variable.type)}"`,
      });
    } else if (
      variable.default !== undefined &&
      !isOfType(variable.default, variable.type)
    ) {
      declared.push({
        severity: 'error',
        message: `variable "${variable.name}" is a ${variable.type}, its default is ${JSON.stringify(variable.default)}`,
      });
    }
    variables.set(variable.name, variable);
  }

  return validateDocument(graph, {
    registry,
    accepts: acceptsBehaviorType,
    flow: (type) => type === 'exec',
    graph: (nodes, diagnostics) => {
      diagnostics.push(...declared);
      // The exec inputs reached by an edge.
      const reached = new Set<string>();
      const handled = new Set<string>();
      for (const edge of graph.edges) {
        reached.add(`${edge.to.node}:${edge.to.port}`);
      }
      for (const { definition, params } of nodes.values()) {
        const type = definition as BehaviorNodeType;
        if (type.kind === 'event' && type.event) {
          handled.add(type.event(params));
        }
      }
      for (const resolved of nodes.values()) {
        const { node, params } = resolved;
        const definition = resolved.definition as BehaviorNodeType;
        const error = (message: string) =>
          diagnostics.push({ severity: 'error', node: node.id, message });
        switch (node.type) {
          case 'var.get':
          case 'var.set': {
            const name = params['name'] as string;
            const variable = variables.get(name);
            if (!variable) {
              error(`unknown variable "${name}"`);
            } else if (variable.type !== params['type']) {
              error(
                `variable "${name}" is a ${variable.type}, used as a ${String(params['type'])}`,
              );
            }
            break;
          }
          case 'event.on':
          case 'event.emit': {
            const event = params['event'] as string;
            if (event === '' || ReservedEvents.includes(event)) {
              error(`"${event}" cannot name an event of the graph`);
            }
            checkFields(params, error);
            if (node.type === 'event.emit' && !handled.has(event)) {
              diagnostics.push({
                severity: 'warning',
                node: node.id,
                message: `no event.on node handles "${event}"`,
              });
            }
            break;
          }
          case 'flow.sequence': {
            const count = params['count'] as number;
            if (!Number.isInteger(count) || count < 1) {
              error('a sequence needs a whole number of outputs, 1 at least');
            }
            break;
          }
          case 'flow.switch': {
            const cases = casesOf(params);
            const seen = new Set<string>();
            for (const name of cases) {
              if (name === 'default' || name === ExecInput) {
                error(`"${name}" cannot name a case`);
              } else if (seen.has(name)) {
                error(`case "${name}" is given twice`);
              }
              seen.add(name);
            }
            break;
          }
        }
        if (
          (definition.kind === 'action' || definition.kind === 'flow') &&
          !reached.has(`${node.id}:${ExecInput}`)
        ) {
          diagnostics.push({
            severity: 'warning',
            node: node.id,
            message: 'never runs: its exec input is not connected',
          });
        }
        if (definition.kind === 'action' && !definition.run) {
          error(`node type "${node.type}" is an action without run()`);
        }
        if (definition.kind === 'pure' && !definition.evaluate) {
          error(`node type "${node.type}" is pure without evaluate()`);
        }
      }
    },
  });
}

function checkFields(
  params: Readonly<Record<string, unknown>>,
  error: (message: string) => void,
): void {
  let fields;
  try {
    fields = fieldsOf(params);
  } catch (e) {
    error((e as Error).message);
    return;
  }
  const names = new Set<string>();
  for (const field of fields) {
    if (!variableTypes.has(field.type)) {
      error(`field "${field.name}" has an unknown type "${field.type}"`);
    }
    if (
      names.has(field.name) ||
      field.name === ThenOutput ||
      field.name === ExecInput ||
      field.name === 'target'
    ) {
      error(`field "${field.name}" cannot be used here`);
    }
    names.add(field.name);
  }
}

/**
 * Serializes a behavior graph as indented JSON.
 *
 * @group Behavior graph
 */
export function serializeBehaviorGraph(graph: BehaviorGraphData): string {
  return serializeDocument(graph);
}

/**
 * The migrations of the behavior graph documents: `[n]` makes a document
 * of version n one of version n + 1. Empty while there is one version.
 *
 * @group Behavior graph
 */
export const behaviorGraphMigrations: Record<number, DocumentMigration> = {};

/**
 * Parses a behavior graph document and checks its structure; the semantic
 * checks are those of {@link validateBehaviorGraph}.
 *
 * @group Behavior graph
 */
export function parseBehaviorGraph(
  source: string | unknown,
): BehaviorGraphData {
  return parseDocument<BehaviorGraphData>(source, {
    format: BehaviorGraphFormat,
    version: BehaviorGraphVersion,
    kind: 'behavior graph',
    migrations: behaviorGraphMigrations,
    document: (data) => {
      const variables = data['variables'];
      if (
        variables !== undefined &&
        (!Array.isArray(variables) ||
          !variables.every(
            (variable) =>
              isRecord(variable) &&
              typeof variable['name'] === 'string' &&
              typeof variable['type'] === 'string',
          ))
      ) {
        throw new Error('Malformed "variables"');
      }
    },
  });
}
