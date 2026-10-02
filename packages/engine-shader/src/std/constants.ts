import { ConstantValue, isConstantCompatible } from '../types/ConstantValue';
import { ShaderType, T, typeToString } from '../types/ShaderType';
import type { NodeDefinition } from '../graph/NodeDefinition';

// A constant is part of the generated code: changing it recompiles the shader.
// Use an 'input.uniform' for values that change at runtime.
export const value: NodeDefinition = {
  id: 'const.value',
  category: 'constant',
  params: {
    type: { kind: 'type', required: true },
    value: { kind: 'constant', required: true },
  },
  inputs: () => [],
  outputs: (params) => {
    const type = params['type'] as ShaderType;
    const constant = params['value'] as ConstantValue;
    if (!isConstantCompatible(constant, type)) {
      throw new Error(
        `${JSON.stringify(constant)} is not a valid ${typeToString(type)}`
      );
    }
    return [{ name: 'value', type }];
  },
};

export const pi: NodeDefinition = {
  id: 'const.pi',
  category: 'constant',
  inputs: () => [],
  outputs: () => [{ name: 'value', type: T.f32 }],
};
