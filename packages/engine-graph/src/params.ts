import type { Diagnostic } from './Diagnostic';
import type { GraphNode } from './GraphData';

/**
 * A parameter of a node type: its kind, its allowed values, its default.
 * The kinds are those of the kind of graph; `string`, `number`, `boolean`,
 * `numbers` (an array of numbers) and `json` (any value) are checked by
 * {@link basicParamCheck}.
 *
 * @group Node types
 */
export interface ParamSchema<K extends string = string, V = unknown> {
  readonly kind: K;
  /** Allowed values, for string parameters. */
  readonly values?: readonly string[];
  readonly default?: V;
  readonly required?: boolean;
  /** For documentation and editors. */
  readonly description?: string;
}

/**
 * Checks the value of a parameter: an error message, or undefined.
 *
 * @group Node types
 */
export type ParamCheck<S extends ParamSchema = ParamSchema> = (
  name: string,
  schema: S,
  value: unknown,
) => string | undefined;

/**
 * Checks the basic kinds of parameters: `string` (among `values` when
 * given), `number`, `boolean`, `numbers`, `json`. Undefined for the other
 * kinds: a kind of graph checks its own.
 *
 * @group Node types
 */
export function basicParamCheck(
  name: string,
  schema: ParamSchema,
  value: unknown,
): string | undefined {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string') {
        return `parameter "${name}" must be a string`;
      }
      if (schema.values && !schema.values.includes(value)) {
        return `parameter "${name}" must be one of ${schema.values
          .map((allowed) => `"${allowed}"`)
          .join(', ')}, got "${value}"`;
      }
      return undefined;
    case 'number':
      return typeof value === 'number'
        ? undefined
        : `parameter "${name}" must be a number`;
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : `parameter "${name}" must be a boolean`;
    case 'numbers':
      return Array.isArray(value) && value.every((v) => typeof v === 'number')
        ? undefined
        : `parameter "${name}" must be an array of numbers`;
    default:
      return undefined;
  }
}

/**
 * Checks the parameters of a node against the schemas of its type: the
 * required ones, the value of each (`check`), and the unknown ones (a
 * warning). Problems go to `diagnostics`; returns whether the parameters
 * are valid.
 *
 * @group Node types
 */
export function checkParams<S extends ParamSchema>(
  node: GraphNode,
  schemas: Readonly<Record<string, S>>,
  check: ParamCheck<S>,
  diagnostics: Diagnostic[],
): boolean {
  let valid = true;
  for (const [name, schema] of Object.entries(schemas)) {
    const value = node.params[name] ?? schema.default;
    if (value === undefined) {
      if (schema.required) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `missing required parameter "${name}"`,
        });
        valid = false;
      }
      continue;
    }
    const error = check(name, schema, value);
    if (error) {
      diagnostics.push({ severity: 'error', node: node.id, message: error });
      valid = false;
    }
  }
  for (const name of Object.keys(node.params)) {
    if (!(name in schemas)) {
      diagnostics.push({
        severity: 'warning',
        node: node.id,
        message: `unknown parameter "${name}" for node type "${node.type}"`,
      });
    }
  }
  return valid;
}

/**
 * The parameters of a node: the declared defaults, then its own values.
 *
 * @group Node types
 */
export function resolveParams<V>(
  schemas: Readonly<Record<string, ParamSchema<string, V>>> | undefined,
  params: Readonly<Record<string, V>>,
): Readonly<Record<string, V>> {
  const resolved: Record<string, V> = {};
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    if (schema.default !== undefined) {
      resolved[name] = schema.default;
    }
  }
  return { ...resolved, ...params };
}
