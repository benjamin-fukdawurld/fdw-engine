import type {
  GraphCommand,
  GraphView,
  NodeView,
} from '@fdw/engine-graph-editing';

// The state machines of the animation graphs, as the editor changes them:
// their states and transitions are parameters of their node, their states
// inputs of it (a pose each).

/** A state of a state machine. */
export interface State {
  readonly name: string;
  readonly resetOnEnter?: boolean;
}

/** A condition of a transition. */
export interface Condition {
  readonly parameter: string;
  readonly op?: '>' | '>=' | '<' | '<=' | '==' | '!=';
  readonly value?: number | boolean;
}

/** A transition of a state machine. */
export interface Transition {
  readonly from: string;
  readonly to: string;
  readonly duration?: number;
  readonly conditions?: readonly Condition[];
  readonly trigger?: string;
  readonly exitTime?: number;
}

export const statesOf = (node: NodeView): readonly State[] =>
  Array.isArray(node.params['states'])
    ? (node.params['states'] as State[])
    : [];

export const transitionsOf = (node: NodeView): readonly Transition[] =>
  Array.isArray(node.params['transitions'])
    ? (node.params['transitions'] as Transition[])
    : [];

/** The parameters of a state machine its own editor changes. */
export const machineParams = ['states', 'transitions', 'initial'];

/** The commands that set the transitions of a machine. */
export const setTransitions = (
  node: NodeView,
  transitions: readonly Transition[],
): GraphCommand => ({ op: 'params', node: node.id, params: { transitions } });

/** A state added, its input not connected yet. */
export function addState(node: NodeView, name: string): GraphCommand[] {
  const states = statesOf(node);
  if (states.some((state) => state.name === name)) return [];
  return [
    { op: 'params', node: node.id, params: { states: [...states, { name }] } },
  ];
}

/**
 * A state renamed: its input (the edge feeding it moved to the new one),
 * its transitions, the initial state.
 */
export function renameState(
  view: GraphView,
  node: NodeView,
  from: string,
  to: string,
): GraphCommand[] {
  const states = statesOf(node);
  if (to === '' || to === from || states.some((s) => s.name === to)) return [];
  const rename = (name: string) => (name === from ? to : name);
  const edge = view.edges.find(
    (e) => e.to.node === node.id && e.to.port === from,
  );
  const initial = node.params['initial'];
  return [
    ...(edge ? [{ op: 'disconnect', edges: [edge] } as const] : []),
    {
      op: 'params',
      node: node.id,
      params: {
        states: states.map((s) => (s.name === from ? { ...s, name: to } : s)),
        transitions: transitionsOf(node).map((t) => ({
          ...t,
          from: rename(t.from),
          to: rename(t.to),
        })),
        ...(initial === from && { initial: to }),
      },
    },
    ...(edge
      ? [
          {
            op: 'connect',
            from: edge.from,
            to: { node: node.id, port: to },
          } as const,
        ]
      : []),
  ];
}

/** A state removed, with its input and its transitions. */
export function removeState(
  view: GraphView,
  node: NodeView,
  name: string,
): GraphCommand[] {
  const edges = view.edges.filter(
    (e) => e.to.node === node.id && e.to.port === name,
  );
  return [
    ...(edges.length > 0 ? [{ op: 'disconnect', edges } as const] : []),
    {
      op: 'params',
      node: node.id,
      params: {
        states: statesOf(node).filter((s) => s.name !== name),
        transitions: transitionsOf(node).filter(
          (t) => t.from !== name && t.to !== name,
        ),
        ...(node.params['initial'] === name && { initial: undefined }),
      },
    },
  ];
}

/** Where the states are drawn: on a grid, the any-state box first. */
export function stateLayout(
  states: readonly State[],
): Map<string, { x: number; y: number }> {
  const columns = Math.max(2, Math.ceil(Math.sqrt(states.length + 1)));
  const places = new Map<string, { x: number; y: number }>();
  ['*', ...states.map((s) => s.name)].forEach((name, i) => {
    places.set(name, {
      x: 40 + (i % columns) * 220,
      y: 40 + Math.floor(i / columns) * 140,
    });
  });
  return places;
}

/** The size of the box of a state. */
export const stateBox = { width: 140, height: 48 } as const;
