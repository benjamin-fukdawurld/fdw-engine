import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';

export type NodeId = string;

// A compile-time value. Shader types are plain objects, so a graph made of
// static values stays serializable as JSON.
export type StaticValue =
  | string
  | number
  | boolean
  | readonly number[]
  | ShaderType;

export interface GraphNode {
  readonly id: NodeId;
  // Id of the NodeDefinition: 'std.mul', 'input.uniform'…
  readonly type: string;
  readonly params: Readonly<Record<string, StaticValue>>;
  // Values of unconnected inputs, overriding the port defaults.
  readonly defaults?: Readonly<Record<string, ConstantValue>>;
  // Used to name the generated variables.
  readonly label?: string;
}

export interface PortRef {
  readonly node: NodeId;
  readonly port: string;
}

export interface GraphEdge {
  // An output port.
  readonly from: PortRef;
  // An input port.
  readonly to: PortRef;
  // Applied to the output value: 'xyz', 'x', 'rg'…
  readonly swizzle?: string;
}

// A static parameter exposed by the graph (a "feature"), resolved when the
// material is created: normalMap, alphaMode…
export interface GraphParameterDeclaration {
  readonly name: string;
  readonly default: StaticValue;
  readonly description?: string;
}

export const MaterialGraphFormat = 'fdw-material-graph' as const;
export const MaterialGraphVersion = 1 as const;

export interface MaterialGraphData {
  readonly format: typeof MaterialGraphFormat;
  readonly version: typeof MaterialGraphVersion;
  readonly name: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly parameters?: readonly GraphParameterDeclaration[];
}

export const portKey = (ref: PortRef): string => `${ref.node}:${ref.port}`;

// A value feeding an input: an output port (possibly swizzled) or a literal.
export type ValueSource =
  | { readonly ref: PortRef; readonly swizzle?: string }
  | { readonly value: ConstantValue };
