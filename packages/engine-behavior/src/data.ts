import type {
  GraphBody,
  GraphDocument,
  GraphEdge,
  GraphNode,
} from '@fdw/engine-graph';

/**
 * Value of the `format` field of serialized behavior graphs.
 *
 * @group Behavior graph
 */
export const BehaviorGraphFormat = 'fdw-behavior-graph' as const;

/**
 * Current version of the serialized behavior graph format.
 *
 * @group Behavior graph
 */
export const BehaviorGraphVersion = 1 as const;

/**
 * The types of the values of a behavior graph: a number, a boolean, a
 * string (the name of a state), a vector `{ x, y, z }`, an entity (its
 * number), or `any` (an input taking every type: a log, a comparison).
 *
 * @group Behavior graph
 */
export type BehaviorValueType =
  'number' | 'boolean' | 'string' | 'vec3' | 'entity' | 'any';

/**
 * The types of the ports: the values, and `exec`, the flow of execution
 * (the white wires of a blueprint).
 *
 * @group Behavior graph
 */
export type BehaviorPortType = 'exec' | BehaviorValueType;

/**
 * A vector of a behavior graph.
 *
 * @group Behavior graph
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A value of a behavior graph: what its variables, its ports and the
 * payloads of its events hold. Graphs stay JSON: the constants are numbers,
 * booleans, strings and vectors.
 *
 * @group Behavior graph
 */
export type BehaviorValue = number | boolean | string | Vec3;

/**
 * A variable of a behavior graph: one per instance, kept between two runs
 * (the state of an enemy, its health).
 *
 * @group Behavior graph
 */
export interface BehaviorVariable {
  readonly name: string;
  /** Any type but `any`. */
  readonly type: Exclude<BehaviorValueType, 'any'>;
  /** The value of a new instance; 0, false, '' or the zero vector by default. */
  readonly default?: BehaviorValue;
}

/**
 * A value carried by an event: a port of the nodes that handle it or emit
 * it.
 *
 * @group Behavior graph
 */
export interface EventField {
  readonly name: string;
  readonly type: Exclude<BehaviorValueType, 'any'>;
}

/**
 * A node of a behavior graph.
 *
 * @group Behavior graph
 */
export type BehaviorNode = GraphNode<unknown, BehaviorValue>;

/**
 * A port of the signature of a function or a macro: an input of its call
 * node and an output of its `fn.inputs` node, or an output of its call
 * node and an input of its `fn.outputs` node.
 *
 * @group Behavior graph
 */
export interface BehaviorSignaturePort {
  readonly name: string;
  /** `exec` for the entries and the exits of a macro. */
  readonly type: Exclude<BehaviorPortType, 'any'>;
  /** The value of an input not connected; the zero of its type by default. */
  readonly default?: BehaviorValue;
}

/**
 * A graph called by another: its nodes are laid in the graph where it is
 * called (`call.<name>` nodes) before the graph runs.
 *
 * - a `function` has one entry and one exit of the flow (the `exec` output
 *   of its `fn.inputs` node, the `then` input of its `fn.outputs` node),
 *   and cannot wait (no `flow.delay`);
 * - a `macro` has the entries and the exits of its signature (none: its
 *   values are computed on demand, as a pure node), and may wait.
 *
 * Both read and set the variables of the graph; neither handles events.
 *
 * @group Behavior graph
 */
export interface BehaviorFunctionData extends GraphBody<
  BehaviorNode,
  GraphEdge
> {
  readonly name: string;
  /** `function` by default. */
  readonly kind?: 'function' | 'macro';
  readonly description?: string;
  readonly inputs: readonly BehaviorSignaturePort[];
  readonly outputs: readonly BehaviorSignaturePort[];
}

/**
 * A behavior graph: events starting chains of nodes run one after the
 * other (the flow of execution, through `exec` ports), which read values
 * computed on demand (the data flow) and change variables. A plain object,
 * serializable as JSON ({@link serializeBehaviorGraph},
 * {@link parseBehaviorGraph}), built with a {@link BehaviorGraphBuilder},
 * run by a {@link BehaviorSystem} for each of its entities.
 *
 * @group Behavior graph
 */
export interface BehaviorGraphData extends GraphDocument<
  BehaviorNode,
  GraphEdge
> {
  readonly format: typeof BehaviorGraphFormat;
  readonly version: typeof BehaviorGraphVersion;
  readonly variables?: readonly BehaviorVariable[];
  /** The functions and the macros its `call.<name>` nodes call. */
  readonly functions?: readonly BehaviorFunctionData[];
}

/**
 * The value of a type when none is given: 0, false, '', the zero vector.
 *
 * @group Behavior graph
 */
export function zeroOf(type: BehaviorValueType): BehaviorValue {
  switch (type) {
    case 'boolean':
      return false;
    case 'string':
      return '';
    case 'vec3':
      return { x: 0, y: 0, z: 0 };
    default:
      return 0;
  }
}

/**
 * Whether a value is of a type.
 *
 * @group Behavior graph
 */
export function isOfType(value: unknown, type: BehaviorValueType): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number';
    case 'entity':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'vec3':
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Vec3).x === 'number' &&
        typeof (value as Vec3).y === 'number' &&
        typeof (value as Vec3).z === 'number'
      );
    case 'any':
      return value !== undefined;
  }
}
