import type {
  FunctionDefinition,
  MacroDefinition,
  NodeDefinition,
  PortSchema,
} from '../graph/NodeDefinition';
import { generic } from '../types/PortType';
import { BuiltinTypes, ShaderType, typeToString } from '../types/ShaderType';

const numeric = generic('T', 'numeric');

/**
 * The state of a fold loop at the start of an iteration: `initial` at the
 * first one, then the `next` of the iteration before. Connected to the
 * `state` input of its {@link end | loop.end}, which ties it to its loop.
 *
 * The nodes depending on it (or on its {@link index | loop.index}) form
 * the body of the loop, computed at each iteration; they can only reach
 * the outputs through their `loop.end`. See {@link GraphBuilder.fold}.
 *
 * @group Standard library
 */
export const state: NodeDefinition = {
  id: 'loop.state',
  category: 'input',
  description: 'The state of a fold loop at the start of an iteration.',
  params: { type: { kind: 'type', required: true } },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
};

/**
 * The index of the iteration of a fold loop: 0, 1… count - 1 (a u32).
 * Connected to the `index` input of its {@link end | loop.end}.
 *
 * @group Standard library
 */
export const index: NodeDefinition = {
  id: 'loop.index',
  category: 'input',
  description: 'The index of the iteration of a fold loop.',
  inputs: () => [],
  outputs: () => [{ name: 'index', type: BuiltinTypes.u32 }],
};

/**
 * The end of a fold loop: the state after `count` iterations, starting from
 * `initial`, each one computing the `next` state from the `state` (a
 * {@link state | loop.state} node) and the `index` (a
 * {@link index | loop.index} node). `count` can change from a draw to the
 * next (a uniform): the loop is not unrolled. The state is a numeric
 * scalar or vector.
 *
 * @group Standard library
 */
export const end: FunctionDefinition = {
  id: 'loop.end',
  category: 'function',
  description: 'The state of a fold loop after its iterations.',
  implementation: { kind: 'intrinsic', op: 'loop-fold' },
  inputs: () => [
    { name: 'initial', type: numeric },
    { name: 'count', type: BuiltinTypes.u32 },
    { name: 'next', type: numeric },
    { name: 'state', type: numeric },
    { name: 'index', type: BuiltinTypes.u32, optional: true },
  ],
  outputs: () => [{ name: 'result', type: numeric }],
};

// The ports of the body function of a fold, checked.
function foldBody(
  body: NodeDefinition | undefined,
  id: string,
): { inputs: readonly PortSchema[]; state: ShaderType } {
  if (!body) {
    throw new Error(`loop.fold: unknown body function "${id}"`);
  }
  const inputs = body.inputs({});
  const stateInput = inputs.find((input) => input.name === 'state');
  const output = body.outputs({})[0];
  if (
    !stateInput ||
    stateInput.type.kind === 'generic' ||
    !output ||
    output.type.kind === 'generic'
  ) {
    throw new Error(
      `loop.fold: the body "${id}" needs a "state" input and an output of concrete types`,
    );
  }
  if (
    typeToString(stateInput.type as ShaderType) !==
    typeToString(output.type as ShaderType)
  ) {
    throw new Error(
      `loop.fold: the body "${id}" returns a ${typeToString(
        output.type as ShaderType,
      )} for a ${typeToString(stateInput.type as ShaderType)} state`,
    );
  }
  return { inputs, state: stateInput.type as ShaderType };
}

/**
 * A fold loop over a function node: state = initial, then `count` times
 * state = body(state, index, …). The body function has a `state` input and
 * returns the next state (its first output, of the same type); an `index`
 * input (u32) receives the iteration number. Its other inputs are inputs
 * of the fold, given once for every iteration. Unlike macro.repeat, the
 * loop is not unrolled: `count` can be a uniform.
 *
 * @group Standard library
 */
export const fold: MacroDefinition = {
  id: 'loop.fold',
  category: 'macro',
  description:
    'state = initial, then count times state = body(state, index, …), in a loop.',
  params: { body: { kind: 'string', required: true } },
  inputs: (params, context) => {
    const id = params['body'] as string;
    const registry = context?.registry;
    if (!registry) {
      return [
        { name: 'initial', type: numeric },
        { name: 'count', type: BuiltinTypes.u32 },
      ];
    }
    const body = foldBody(registry.get(id), id);
    return [
      { name: 'initial', type: body.state },
      { name: 'count', type: BuiltinTypes.u32 },
      ...body.inputs.filter(
        (input) => input.name !== 'state' && input.name !== 'index',
      ),
    ];
  },
  outputs: (params, context) => {
    const id = params['body'] as string;
    const registry = context?.registry;
    return [
      {
        name: 'result',
        type: registry ? foldBody(registry.get(id), id).state : numeric,
      },
    ];
  },
  expand: (context) => {
    const body = context.params['body'] as string;
    const type = context.typeOf('initial') as ShaderType;
    const stateValue = context.add('loop.state', { type })();
    const withIndex = context.hasInput(body, 'index');
    const indexValue = withIndex ? context.add('loop.index')() : undefined;
    const inputs: Record<string, ReturnType<typeof context.input>> = {
      state: stateValue,
      ...(indexValue ? { index: indexValue } : {}),
    };
    for (const port of context.ports) {
      if (port.name !== 'initial' && port.name !== 'count') {
        inputs[port.name] = context.input(port.name);
      }
    }
    const next = context.add(body, {}, inputs)();
    return {
      result: context.add(
        'loop.end',
        {},
        {
          initial: context.input('initial'),
          count: context.input('count'),
          next,
          state: stateValue,
          ...(indexValue ? { index: indexValue } : {}),
        },
      )(),
    };
  },
};

export const loopDefinitions: readonly NodeDefinition[] = [
  state,
  index,
  end,
  fold,
];
