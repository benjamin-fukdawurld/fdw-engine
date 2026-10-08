import type { NodeDefinition } from '../graph/NodeDefinition';
import { generic } from '../types/PortType';
import type { ShaderType } from '../types/ShaderType';

/**
 * An input of a function graph: a port of the function node, with a name, a
 * concrete type and an optional default value.
 *
 * @group Standard library
 */
export const input: NodeDefinition = {
  id: 'function.input',
  category: 'input',
  description: 'An input of a function graph.',
  params: {
    name: { kind: 'string', required: true },
    type: { kind: 'type', required: true },
    default: { kind: 'constant' },
  },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
};

/**
 * An output of a function graph: a port of the function node, whose type is
 * the type of the value connected to it.
 *
 * @group Standard library
 */
export const output: NodeDefinition = {
  id: 'function.output',
  category: 'output',
  description: 'An output of a function graph.',
  params: {
    name: { kind: 'string', required: true },
  },
  inputs: () => [{ name: 'value', type: generic('T', 'any') }],
  outputs: () => [],
};

export const subgraphDefinitions: readonly NodeDefinition[] = [input, output];
