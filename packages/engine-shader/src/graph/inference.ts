import {
  ConstantValue,
  isConstantCompatible,
  literalType,
} from '../types/ConstantValue';
import {
  GenericPortType,
  PortType,
  portTypeToString,
  satisfiesConstraint,
  scalarKindOf,
} from '../types/PortType';
import {
  ScalarKind,
  ShaderType,
  typeEquals,
  typeToString,
  vec,
} from '../types/ShaderType';
import type { PortSchema } from './NodeDefinition';

/**
 * Concrete types of the ports of a node.
 *
 * @group Validation
 */
export interface NodeTypes {
  readonly inputs: Readonly<Record<string, ShaderType>>;
  readonly outputs: Readonly<Record<string, ShaderType>>;
}

/**
 * A type error on a port of a node.
 *
 * @group Validation
 */
export interface PortTypeError {
  readonly port?: string;
  readonly message: string;
}

/**
 * Result of {@link resolveNodeTypes}.
 *
 * @group Validation
 */
export interface NodeTypeResolution {
  readonly types: NodeTypes;
  readonly errors: readonly PortTypeError[];
}

/**
 * The only implicit conversion: a scalar splats to a vector of the same
 * scalar kind. Any other conversion needs an explicit node.
 *
 * @group Validation
 */
export function isAssignable(from: ShaderType, to: ShaderType): boolean {
  if (typeEquals(from, to)) {
    return true;
  }
  return (
    from.kind === 'scalar' && to.kind === 'vector' && from.scalar === to.scalar
  );
}

type Bindings = Map<string, ShaderType>;

function resolvePortType(
  type: PortType,
  bindings: Bindings
): ShaderType | undefined {
  switch (type.kind) {
    case 'generic':
      return bindings.get(type.name);
    case 'element-of': {
      const bound = bindings.get(type.of);
      const kind = bound && scalarKindOf(bound);
      return kind ? { kind: 'scalar', scalar: kind } : undefined;
    }
    case 'vector-of': {
      const bound = bindings.get(type.of);
      const kind: ScalarKind | undefined = bound && scalarKindOf(bound);
      return kind ? vec(type.size, kind) : undefined;
    }
    default:
      return type;
  }
}

// Unifies the types connected to the ports of a generic. Scalars are
// absorbed by a vector of the same scalar kind: add(f32, vec3<f32>) binds
// T = vec3<f32>.
function unify(
  candidates: readonly { port: string; type: ShaderType }[]
): { type: ShaderType } | PortTypeError {
  let bound = candidates[0].type;
  for (const { port, type } of candidates.slice(1)) {
    if (isAssignable(type, bound)) {
      continue;
    }
    if (isAssignable(bound, type)) {
      bound = type;
      continue;
    }
    return {
      port,
      message: `got ${typeToString(type)}, incompatible with ${typeToString(
        bound
      )} connected to "${candidates[0].port}"`,
    };
  }
  return { type: bound };
}

function collectGenerics(
  ports: readonly PortSchema[]
): Map<string, GenericPortType> {
  const generics = new Map<string, GenericPortType>();
  for (const port of ports) {
    if (port.type.kind === 'generic' && !generics.has(port.type.name)) {
      generics.set(port.type.name, port.type);
    }
  }
  return generics;
}

/**
 * Resolves the concrete type of every port of a node, from the types of the
 * values connected to its inputs and from the literal defaults.
 *
 * @group Validation
 */
export function resolveNodeTypes({
  inputs,
  outputs,
  connected,
  defaults = {},
}: {
  inputs: readonly PortSchema[];
  outputs: readonly PortSchema[];
  /** Types of the values connected to the inputs (after swizzle). */
  connected: Readonly<Record<string, ShaderType>>;
  /** Node-level values of the unconnected inputs. */
  defaults?: Readonly<Record<string, ConstantValue>>;
}): NodeTypeResolution {
  const errors: PortTypeError[] = [];
  const bindings: Bindings = new Map();
  const generics = collectGenerics([...inputs, ...outputs]);

  for (const generic of generics.values()) {
    const ports = inputs.filter(
      (port) => port.type.kind === 'generic' && port.type.name === generic.name
    );
    const candidates = ports
      .filter((port) => connected[port.name] !== undefined)
      .map((port) => ({ port: port.name, type: connected[port.name] }));

    // Literals of the unconnected ports of the generic.
    const literals = ports
      .filter((port) => connected[port.name] === undefined)
      .map((port) => defaults[port.name] ?? port.default)
      .filter((value): value is ConstantValue => value !== undefined);
    const vectorLiteral = literals.find(Array.isArray);

    let bound: ShaderType | undefined;
    if (candidates.length > 0) {
      const result = unify(candidates);
      if ('message' in result) {
        errors.push(result);
        continue;
      }
      bound = result.type;
      /**
       * Vector literals widen a scalar binding, like a connected vector
       * would: mix([0, 0, 0], [1, 1, 1], t: f32) binds T = vec3<f32>.
       */
      if (bound.kind === 'scalar' && vectorLiteral) {
        const literal = literalType(vectorLiteral);
        if (literal?.kind === 'vector') {
          bound = vec(literal.size, bound.scalar);
        }
      }
    } else {
      // Nothing connected: the type of the literals, vectors first.
      const literal = vectorLiteral ?? literals[0];
      bound = literal !== undefined ? literalType(literal) : undefined;
    }

    if (!bound) {
      errors.push({
        message: `cannot infer the type of ${generic.name}: connect one of its inputs`,
      });
      continue;
    }
    if (!satisfiesConstraint(bound, generic.constraint)) {
      errors.push({
        port: candidates[0]?.port,
        message: `${typeToString(bound)} does not satisfy the constraint "${
          generic.constraint
        }" of ${generic.name}`,
      });
      continue;
    }
    bindings.set(generic.name, bound);
  }

  const inputTypes: Record<string, ShaderType> = {};
  for (const port of inputs) {
    const expected = resolvePortType(port.type, bindings);
    if (!expected) {
      // Already reported while binding the generics.
      continue;
    }
    inputTypes[port.name] = expected;

    const actual = connected[port.name];
    if (actual) {
      if (!isAssignable(actual, expected)) {
        errors.push({
          port: port.name,
          message: `expects ${typeToString(expected)}, got ${typeToString(
            actual
          )}`,
        });
      }
      continue;
    }

    const value = defaults[port.name] ?? port.default;
    if (value !== undefined) {
      if (!isConstantCompatible(value, expected)) {
        errors.push({
          port: port.name,
          message: `default value ${JSON.stringify(
            value
          )} is not a valid ${typeToString(expected)}`,
        });
      }
    } else if (!port.optional) {
      errors.push({
        port: port.name,
        message: `input of type ${portTypeToString(
          port.type
        )} must be connected`,
      });
    }
  }

  const outputTypes: Record<string, ShaderType> = {};
  for (const port of outputs) {
    const type = resolvePortType(port.type, bindings);
    if (type) {
      outputTypes[port.name] = type;
    }
  }

  return { types: { inputs: inputTypes, outputs: outputTypes }, errors };
}
