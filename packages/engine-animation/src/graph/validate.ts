import {
  type Diagnostic,
  type DocumentValidation,
  type GraphEdge,
  isRecord,
  parseDocument,
  type Registry,
  serializeDocument,
  validateDocument,
} from '@fdw/engine-graph';
import {
  type AnimationGraphData,
  AnimationGraphFormat,
  AnimationGraphVersion,
  type AnimationNode,
  type AnimationParameter,
  type AnimationPortType,
} from './data';
import {
  type AnimationNodeType,
  createAnimationRegistry,
  statesOf,
  transitionsOf,
} from './nodes';

/**
 * Result of {@link validateAnimationGraph}.
 *
 * @group Animation graph
 */
export type AnimationGraphValidation = DocumentValidation<
  AnimationPortType,
  AnimationNode,
  GraphEdge
>;

const parameterTypes = new Set(['number', 'boolean', 'trigger']);
const operators = new Set(['>', '>=', '<', '<=', '==', '!=']);

/**
 * Validates an animation graph: its nodes, edges and types (the graph
 * core), one output, the parameters read and compared, the states and the
 * transitions of the state machines, the points of the blend spaces. Does
 * not throw: the problems are in `diagnostics`.
 *
 * @group Animation graph
 */
export function validateAnimationGraph(
  graph: AnimationGraphData,
  registry: Registry<AnimationNodeType> = createAnimationRegistry(),
): AnimationGraphValidation {
  const parameters = new Map<string, AnimationParameter>();
  const declared: Diagnostic[] = [];
  for (const parameter of graph.parameters ?? []) {
    if (parameters.has(parameter.name)) {
      declared.push({
        severity: 'error',
        message: `parameter "${parameter.name}" is declared twice`,
      });
    }
    if (!parameterTypes.has(parameter.type)) {
      declared.push({
        severity: 'error',
        message: `parameter "${parameter.name}" has an unknown type "${String(parameter.type)}"`,
      });
    }
    parameters.set(parameter.name, parameter);
  }

  const validation = validateDocument(graph, {
    registry,
    graph: (nodes, diagnostics) => {
      diagnostics.push(...declared);
      const outputs = [...nodes.values()].filter(
        (resolved) => resolved.node.type === 'anim.output',
      );
      if (outputs.length !== 1) {
        diagnostics.push({
          severity: 'error',
          message: `an animation graph has one anim.output node, not ${outputs.length}`,
        });
      }
      for (const { node, params } of nodes.values()) {
        const error = (message: string) =>
          diagnostics.push({ severity: 'error', node: node.id, message });
        switch (node.type) {
          case 'anim.parameter': {
            const name = params['name'] as string;
            const parameter = parameters.get(name);
            if (!parameter) {
              error(`unknown parameter "${name}"`);
            } else if (
              parameter.type === 'trigger' ||
              parameter.type !== params['type']
            ) {
              error(
                `parameter "${name}" is a ${parameter.type}, read as a ${String(params['type'])}`,
              );
            }
            break;
          }
          case 'anim.blend1d': {
            const points = params['points'] as number[];
            if (points.length < 2) {
              error('a blend space needs two points at least');
            } else if (points.some((p, i) => i > 0 && p <= points[i - 1])) {
              error('the points of a blend space must increase');
            }
            break;
          }
          case 'anim.stateMachine':
            checkStateMachine(params, parameters, error);
            break;
        }
      }
    },
  });
  return validation;
}

function checkStateMachine(
  params: Readonly<Record<string, unknown>>,
  parameters: ReadonlyMap<string, AnimationParameter>,
  error: (message: string) => void,
): void {
  const states = statesOf(params);
  const names = new Set<string>();
  if (states.length === 0) {
    error('a state machine needs a state at least');
  }
  for (const state of states) {
    if (names.has(state.name)) {
      error(`state "${state.name}" is declared twice`);
    }
    names.add(state.name);
  }
  const initial = params['initial'];
  if (typeof initial === 'string' && !names.has(initial)) {
    error(`the initial state "${initial}" is not a state`);
  }
  let transitions;
  try {
    transitions = transitionsOf(params);
  } catch (e) {
    error((e as Error).message);
    return;
  }
  transitions.forEach((transition, i) => {
    const label = `transition ${i} (${String(transition?.from)} → ${String(transition?.to)})`;
    if (!isRecord(transition)) {
      error(`transition ${i} must be an object`);
      return;
    }
    if (transition.from !== '*' && !names.has(transition.from)) {
      error(`${label}: unknown state "${transition.from}"`);
    }
    if (!names.has(transition.to)) {
      error(`${label}: unknown state "${transition.to}"`);
    }
    if (
      transition.duration !== undefined &&
      !(typeof transition.duration === 'number' && transition.duration >= 0)
    ) {
      error(`${label}: the duration must be a number of seconds`);
    }
    if (transition.trigger !== undefined) {
      if (parameters.get(transition.trigger)?.type !== 'trigger') {
        error(`${label}: "${transition.trigger}" is not a trigger parameter`);
      }
    }
    for (const condition of transition.conditions ?? []) {
      const parameter = parameters.get(condition.parameter);
      if (!parameter) {
        error(`${label}: unknown parameter "${condition.parameter}"`);
        continue;
      }
      if (condition.op !== undefined && !operators.has(condition.op)) {
        error(`${label}: unknown comparison "${condition.op}"`);
      }
      const value = condition.value ?? true;
      if (
        (parameter.type === 'number') !== (typeof value === 'number') ||
        parameter.type === 'trigger'
      ) {
        error(
          `${label}: "${condition.parameter}" is a ${parameter.type}, compared with ${JSON.stringify(value)}`,
        );
      }
    }
  });
}

/**
 * Serializes an animation graph as indented JSON.
 *
 * @group Animation graph
 */
export function serializeAnimationGraph(graph: AnimationGraphData): string {
  return serializeDocument(graph);
}

/**
 * Parses an animation graph document and checks its structure; the
 * semantic checks are those of {@link validateAnimationGraph}.
 *
 * @group Animation graph
 */
export function parseAnimationGraph(
  source: string | unknown,
): AnimationGraphData {
  return parseDocument<AnimationGraphData>(source, {
    format: AnimationGraphFormat,
    version: AnimationGraphVersion,
    kind: 'animation graph',
    document: (data) => {
      const parameters = data['parameters'];
      if (
        parameters !== undefined &&
        (!Array.isArray(parameters) ||
          !parameters.every(
            (parameter) =>
              isRecord(parameter) &&
              typeof parameter['name'] === 'string' &&
              typeof parameter['type'] === 'string',
          ))
      ) {
        throw new Error('Malformed "parameters"');
      }
    },
  });
}
