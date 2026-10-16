import type { GraphDocument, GraphEdge, GraphNode } from '@fdw/engine-graph';

/**
 * Value of the `format` field of serialized animation graphs.
 *
 * @group Animation graph
 */
export const AnimationGraphFormat = 'fdw-animation-graph' as const;

/**
 * Current version of the serialized animation graph format.
 *
 * @group Animation graph
 */
export const AnimationGraphVersion = 1 as const;

/**
 * The types of the ports of an animation graph: a pose of the skeleton, a
 * number (a weight, a speed), a boolean.
 *
 * @group Animation graph
 */
export type AnimationPortType = 'pose' | 'number' | 'boolean';

/**
 * The type of a parameter: a number, a boolean, or a trigger (a boolean
 * that the transition it fires sets back to false).
 *
 * @group Animation graph
 */
export type AnimationParameterType = 'number' | 'boolean' | 'trigger';

/**
 * A value an application sets on an animator, by name: the speed of the
 * character, whether it is on the ground, a jump asked.
 *
 * @group Animation graph
 */
export interface AnimationParameter {
  readonly name: string;
  readonly type: AnimationParameterType;
  /** 0 or false by default. */
  readonly default?: number | boolean;
}

/**
 * A state of a state machine: a pose input of the `anim.stateMachine` node,
 * named after it.
 *
 * @group Animation graph
 */
export interface StateDescription {
  readonly name: string;
  /** Restarts the clips of the state when it is entered (true). */
  readonly resetOnEnter?: boolean;
}

/**
 * A comparison of a parameter, for a transition.
 *
 * @group Animation graph
 */
export interface TransitionCondition {
  readonly parameter: string;
  /** `==` by default. */
  readonly op?: '>' | '>=' | '<' | '<=' | '==' | '!=';
  /** True by default. */
  readonly value?: number | boolean;
}

/**
 * A transition of a state machine: from a state (or any, `*`) to another,
 * when its conditions hold, its trigger is set and its exit time is
 * reached, with a cross-fade of `duration` seconds.
 *
 * @group Animation graph
 */
export interface TransitionDescription {
  /** A state, or `*` for any other state than `to`. */
  readonly from: string;
  readonly to: string;
  /** The cross-fade, in seconds (0.2). */
  readonly duration?: number;
  /** All must hold. */
  readonly conditions?: readonly TransitionCondition[];
  /** A trigger parameter, consumed when the transition starts. */
  readonly trigger?: string;
  /**
   * The time spent in the state, in cycles of the state (0.9: near the end
   * of its first cycle), before the transition can start.
   */
  readonly exitTime?: number;
}

/**
 * A node of an animation graph.
 *
 * @group Animation graph
 */
export type AnimationNode = GraphNode<unknown, number | boolean>;

/**
 * An animation graph: clips, blends, layers and state machines producing a
 * pose, driven by parameters. A plain object, serializable as JSON
 * ({@link serializeAnimationGraph}, {@link parseAnimationGraph}), built
 * with an {@link AnimationGraphBuilder}, run by an {@link Animator}.
 *
 * @group Animation graph
 */
export interface AnimationGraphData extends GraphDocument<
  AnimationNode,
  GraphEdge
> {
  readonly format: typeof AnimationGraphFormat;
  readonly version: typeof AnimationGraphVersion;
  readonly parameters?: readonly AnimationParameter[];
}
