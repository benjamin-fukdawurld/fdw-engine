import { type GraphEdge, GraphError } from '@fdw/engine-graph';
import {
  type AnimationGraphData,
  AnimationGraphFormat,
  AnimationGraphVersion,
  type AnimationNode,
  type AnimationParameter,
  type AnimationParameterType,
  type AnimationPortType,
  type StateDescription,
  type TransitionDescription,
} from './data';
import { validateAnimationGraph } from './validate';

/**
 * An output of a node of an {@link AnimationGraphBuilder}: a pose, or a
 * value read from a parameter.
 *
 * @group Animation graph
 */
export class AnimationHandle<T extends AnimationPortType = AnimationPortType> {
  constructor(
    readonly node: string,
    readonly port: string,
    readonly type: T,
  ) {}
}

/** A pose output. @group Animation graph */
export type PoseHandle = AnimationHandle<'pose'>;

/** A number: a parameter, or a constant. @group Animation graph */
export type NumberInput = AnimationHandle<'number'> | number;

/**
 * A state of {@link AnimationGraphBuilder.stateMachine}: its pose, or its
 * pose and its options.
 *
 * @group Animation graph
 */
export type StateInput =
  PoseHandle | ({ readonly pose: PoseHandle } & Omit<StateDescription, 'name'>);

/**
 * Builds an animation graph with handles: each method adds a node and
 * returns its output; `build()` validates the whole.
 *
 * @example
 * ```ts
 * const g = new AnimationGraphBuilder('character');
 * g.parameter('speed', 'number');
 * g.parameter('jump', 'trigger');
 * const locomotion = g.blend1d(
 *   [g.clip('Idle'), g.clip('Walk'), g.clip('Run')],
 *   [0, 1.5, 4],
 *   g.param('speed'),
 * );
 * const body = g.stateMachine({
 *   states: { locomotion, jump: g.clip('Jump', { loop: false }) },
 *   transitions: [
 *     { from: 'locomotion', to: 'jump', trigger: 'jump', duration: 0.1 },
 *     { from: 'jump', to: 'locomotion', exitTime: 1 },
 *   ],
 * });
 * g.output(body);
 * const graph = g.build();
 * ```
 *
 * @group Animation graph
 */
export class AnimationGraphBuilder {
  private readonly _nodes: AnimationNode[] = [];
  private readonly _edges: GraphEdge[] = [];
  private readonly _parameters: AnimationParameter[] = [];
  private _nextId = 1;

  constructor(readonly name: string) {}

  /** Declares a parameter, set on the animator by name. */
  parameter(
    name: string,
    type: AnimationParameterType,
    defaultValue?: number | boolean,
  ): this {
    if (this._parameters.some((parameter) => parameter.name === name)) {
      throw new Error(`Parameter "${name}" is already declared`);
    }
    this._parameters.push({
      name,
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    });
    return this;
  }

  /** Reads a number or boolean parameter. */
  param(name: string): AnimationHandle<'number'>;
  param(name: string, type: 'boolean'): AnimationHandle<'boolean'>;
  param(
    name: string,
    type: 'number' | 'boolean' = 'number',
  ): AnimationHandle<'number' | 'boolean'> {
    const id = this.add('anim.parameter', { name, type }, {}, name);
    return new AnimationHandle(id, 'value', type);
  }

  /**
   * Plays a clip of the animator. `rate` multiplies `speed`: a parameter
   * makes the walk faster with the character.
   */
  clip(
    clip: string,
    options: {
      loop?: boolean;
      speed?: number;
      rate?: NumberInput;
      additive?: boolean;
    } = {},
  ): PoseHandle {
    const { rate, ...params } = options;
    return this.pose(
      'anim.clip',
      { clip, ...params },
      rate !== undefined ? { rate } : {},
      clip,
    );
  }

  /** a(1 − weight) + b weight. */
  blend(
    a: PoseHandle,
    b: PoseHandle,
    weight: NumberInput,
    options: { sync?: boolean } = {},
  ): PoseHandle {
    return this.pose('anim.blend', options, { a, b, weight });
  }

  /**
   * A blend space: a pose at each point (increasing), the two around
   * `value` blended. Synchronized by default: the clips keep the same
   * phase, the feet in step.
   */
  blend1d(
    poses: readonly PoseHandle[],
    points: readonly number[],
    value: NumberInput,
    options: { sync?: boolean } = {},
  ): PoseHandle {
    if (poses.length !== points.length) {
      throw new Error(
        `A blend space needs a point per pose: ${poses.length} poses, ${points.length} points`,
      );
    }
    const inputs: Record<string, AnimationHandle | number> = { value };
    poses.forEach((pose, i) => (inputs[`pose${i}`] = pose));
    return this.pose(
      'anim.blend1d',
      { points: [...points], ...options },
      inputs,
    );
  }

  /**
   * A layer over a base pose, on the joints of a mask of the animator
   * (all of them without): it replaces the base (`override`), or adds to
   * it (`additive`, with an additive clip).
   */
  layer(
    base: PoseHandle,
    layer: PoseHandle,
    options: {
      weight?: NumberInput;
      mask?: string;
      mode?: 'override' | 'additive';
    } = {},
  ): PoseHandle {
    const { weight, ...params } = options;
    return this.pose('anim.layer', params, {
      base,
      layer,
      ...(weight !== undefined ? { weight } : {}),
    });
  }

  /**
   * A state machine: a pose per state, the transitions between them. The
   * first state is the initial one unless `initial` says otherwise;
   * `label` names it for {@link Animator.state}.
   */
  stateMachine(options: {
    states: Readonly<Record<string, StateInput>>;
    transitions?: readonly TransitionDescription[];
    initial?: string;
    label?: string;
  }): PoseHandle {
    const states: StateDescription[] = [];
    const inputs: Record<string, PoseHandle> = {};
    for (const [name, state] of Object.entries(options.states)) {
      if (state instanceof AnimationHandle) {
        states.push({ name });
        inputs[name] = state;
      } else {
        const { pose, ...rest } = state;
        states.push({ name, ...rest });
        inputs[name] = pose;
      }
    }
    return this.pose(
      'anim.stateMachine',
      {
        states,
        transitions: [...(options.transitions ?? [])],
        ...(options.initial !== undefined ? { initial: options.initial } : {}),
      },
      inputs,
      options.label,
    );
  }

  /** The pose of the graph. */
  output(pose: PoseHandle): void {
    this.add('anim.output', {}, { pose });
  }

  /**
   * Validates the graph and returns it.
   *
   * @throws {@link GraphError} when it has errors.
   */
  build(): AnimationGraphData {
    const graph: AnimationGraphData = {
      format: AnimationGraphFormat,
      version: AnimationGraphVersion,
      name: this.name,
      nodes: [...this._nodes],
      edges: [...this._edges],
      ...(this._parameters.length > 0
        ? { parameters: [...this._parameters] }
        : {}),
    };
    const validation = validateAnimationGraph(graph);
    if (!validation.valid) {
      throw new GraphError(validation.diagnostics);
    }
    return graph;
  }

  private pose(
    type: string,
    params: Record<string, unknown>,
    inputs: Readonly<Record<string, AnimationHandle | number | undefined>>,
    label?: string,
  ): PoseHandle {
    return new AnimationHandle(
      this.add(type, params, inputs, label),
      'pose',
      'pose',
    );
  }

  private add(
    type: string,
    params: Record<string, unknown>,
    inputs: Readonly<Record<string, AnimationHandle | number | undefined>>,
    label?: string,
  ): string {
    const id = `n${this._nextId++}`;
    const defaults: Record<string, number> = {};
    for (const [port, value] of Object.entries(inputs)) {
      if (value instanceof AnimationHandle) {
        this._edges.push({
          from: { node: value.node, port: value.port },
          to: { node: id, port },
        });
      } else if (value !== undefined) {
        defaults[port] = value;
      }
    }
    const defined = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined),
    );
    this._nodes.push({
      id,
      type,
      params: defined,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      ...(label !== undefined ? { label } : {}),
    });
    return id;
  }
}
