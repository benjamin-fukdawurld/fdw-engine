import { type NodeType, type PortSpec, Registry } from '@fdw/engine-graph';
import type {
  AnimationPortType,
  StateDescription,
  TransitionDescription,
} from './data';

/**
 * A node type of the animation graphs.
 *
 * @group Animation graph
 */
export type AnimationNodeType = NodeType<AnimationPortType>;

const pose = (name: string): PortSpec<AnimationPortType> => ({
  name,
  type: 'pose',
});
const poseOutput = () => [pose('pose')];

/**
 * Plays a clip, by its name among the clips of the animator.
 *
 * @group Animation graph
 */
export const clipNode: AnimationNodeType = {
  id: 'anim.clip',
  category: 'source',
  description: 'Plays a clip: loops it or holds its last pose.',
  params: {
    clip: { kind: 'string', required: true },
    loop: { kind: 'boolean', default: true },
    speed: { kind: 'number', default: 1 },
    // Plays the difference with the first pose, for an additive layer.
    additive: { kind: 'boolean', default: false },
  },
  inputs: () => [
    {
      name: 'rate',
      type: 'number',
      default: 1,
      description: 'Multiplies the speed.',
    },
  ],
  outputs: poseOutput,
};

/**
 * Reads a parameter of the graph.
 *
 * @group Animation graph
 */
export const parameterNode: AnimationNodeType = {
  id: 'anim.parameter',
  category: 'source',
  description: 'The value of a parameter of the graph.',
  params: {
    name: { kind: 'string', required: true },
    type: { kind: 'string', values: ['number', 'boolean'], default: 'number' },
  },
  inputs: () => [],
  outputs: (params) => [
    { name: 'value', type: params['type'] as AnimationPortType },
  ],
};

/**
 * a(1 − weight) + b weight.
 *
 * @group Animation graph
 */
export const blendNode: AnimationNodeType = {
  id: 'anim.blend',
  category: 'blend',
  description: 'Blends two poses.',
  params: {
    // Plays both at the same phase (two walk cycles).
    sync: { kind: 'boolean', default: false },
  },
  inputs: () => [
    pose('a'),
    pose('b'),
    { name: 'weight', type: 'number', default: 0.5 },
  ],
  outputs: poseOutput,
};

/**
 * Blends the two poses whose points surround a value: idle, walk, run along
 * the speed.
 *
 * @group Animation graph
 */
export const blend1dNode: AnimationNodeType = {
  id: 'anim.blend1d',
  category: 'blend',
  description:
    'A blend space in one dimension: a pose at each point, the two around the value blended.',
  params: {
    points: { kind: 'numbers', required: true },
    sync: { kind: 'boolean', default: true },
  },
  inputs: (params) => [
    ...(params['points'] as number[]).map((_, i) => pose(`pose${i}`)),
    { name: 'value', type: 'number', default: 0 },
  ],
  outputs: poseOutput,
};

/**
 * A layer over a base pose, on the joints of a mask: an override (a
 * blend), or an addition.
 *
 * @group Animation graph
 */
export const layerNode: AnimationNodeType = {
  id: 'anim.layer',
  category: 'blend',
  description: 'A layer over a base pose, on the joints of a mask.',
  params: {
    // A mask of the animator, by name; all the joints without.
    mask: { kind: 'string' },
    mode: {
      kind: 'string',
      values: ['override', 'additive'],
      default: 'override',
    },
  },
  inputs: () => [
    pose('base'),
    pose('layer'),
    { name: 'weight', type: 'number', default: 1 },
  ],
  outputs: poseOutput,
};

/**
 * The states of a state machine, from its parameters.
 *
 * @group Animation graph
 */
export function statesOf(
  params: Readonly<Record<string, unknown>>,
): readonly StateDescription[] {
  const states = params['states'];
  if (
    !Array.isArray(states) ||
    !states.every(
      (state) =>
        typeof state === 'object' &&
        state !== null &&
        typeof (state as StateDescription).name === 'string',
    )
  ) {
    throw new Error('"states" must be an array of { name }');
  }
  return states as StateDescription[];
}

/**
 * The transitions of a state machine, from its parameters.
 *
 * @group Animation graph
 */
export function transitionsOf(
  params: Readonly<Record<string, unknown>>,
): readonly TransitionDescription[] {
  const transitions = params['transitions'] ?? [];
  if (!Array.isArray(transitions)) {
    throw new Error('"transitions" must be an array');
  }
  return transitions as TransitionDescription[];
}

/**
 * States, a pose input each, and the transitions between them.
 *
 * @group Animation graph
 */
export const stateMachineNode: AnimationNodeType = {
  id: 'anim.stateMachine',
  category: 'state',
  description:
    'States and the transitions between them, with cross-fades: idle, walk, jump.',
  params: {
    states: { kind: 'json', required: true },
    transitions: { kind: 'json', default: [] },
    // The first state by default.
    initial: { kind: 'string' },
  },
  inputs: (params) => statesOf(params).map((state) => pose(state.name)),
  outputs: poseOutput,
};

/**
 * The pose of the graph.
 *
 * @group Animation graph
 */
export const outputNode: AnimationNodeType = {
  id: 'anim.output',
  category: 'output',
  description: 'The pose of the graph.',
  inputs: () => [pose('pose')],
  outputs: () => [],
};

/**
 * The node types of the animation graphs.
 *
 * @group Animation graph
 */
export const animationNodeTypes: readonly AnimationNodeType[] = [
  clipNode,
  parameterNode,
  blendNode,
  blend1dNode,
  layerNode,
  stateMachineNode,
  outputNode,
];

/**
 * A registry of the standard node types of the animation graphs.
 *
 * @group Animation graph
 */
export const createAnimationRegistry = (): Registry<AnimationNodeType> =>
  new Registry(animationNodeTypes);
