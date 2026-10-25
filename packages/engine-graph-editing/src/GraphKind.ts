import type {
  Diagnostic,
  GraphBody,
  GraphDocument,
  GraphNode,
  NodeId,
  ParamSchema,
  PortSpec,
} from '@fdw/engine-graph';
import type {
  GraphKindId,
  NodeTemplate,
  NodeView,
  ParamView,
  PortView,
  ScopeView,
} from './protocol';

/** The nodes of a body with their ports, and the problems found. */
export interface KindValidation {
  /** The nodes resolved, by id: those absent are drawn without ports. */
  readonly nodes: ReadonlyMap<
    NodeId,
    Pick<NodeView, 'inputs' | 'outputs' | 'schema' | 'title'> &
      Partial<Pick<NodeView, 'category' | 'description'>>
  >;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * What the editor knows of a kind of graph: its documents, its scopes (the
 * functions), its validation, its catalog of nodes. One per kind:
 * {@link materialGraphKind}, {@link animationGraphKind},
 * {@link behaviorGraphKind}.
 */
export interface GraphKind<D extends GraphDocument = GraphDocument> {
  readonly id: GraphKindId;
  /** 'Material graph'… */
  readonly title: string;
  /** The end of the names of its files: `.material.json`. */
  readonly extension: string;
  /** A new graph: what it needs to be valid (an output, an event). */
  create(name: string): D;
  /** @throws when the document is malformed. */
  parse(source: string | unknown): D;
  serialize(document: D): string;
  /** The graph, and its functions. */
  scopes(document: D): readonly ScopeView[];
  /** The nodes of a scope. @throws for a scope it does not have. */
  body(document: D, scope?: string): GraphBody;
  withBody(document: D, scope: string | undefined, body: GraphBody): D;
  /** The nodes of a scope resolved, and the problems of the document. */
  validate(document: D, scope?: string): KindValidation;
  /** The problems of every scope of the document. */
  check(document: D): readonly Diagnostic[];
  /** The nodes the search offers in a scope. */
  templates(document: D, scope?: string): readonly NodeTemplate[];
  /** What the templates depend on: they are sent again when it changes. */
  catalogKey(document: D, scope?: string): string;
  /** The fields of the document that are not nodes, for the side panels. */
  fields(document: D): Readonly<Record<string, unknown>>;
  /** @throws for a field it does not have, or a malformed value. */
  setField(document: D, key: string, value: unknown): D;
  /**
   * Adds, changes or removes a function: 'create', 'remove', or the fields
   * of its signature. @throws when the kind has no functions.
   */
  editFunction?(
    document: D,
    name: string,
    change: 'create' | 'remove' | Readonly<Record<string, unknown>>,
  ): D;
  /** The parameters of a node as the editor shows them (the types by name). */
  viewParams?(
    params: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  /**
   * The parameters the editor sends for a node, as the document holds
   * them. @throws for a value it cannot read.
   */
  editorParams?(
    document: D,
    type: string,
    params: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  /** Whether an output of a type may feed an input of another: the editor's hint. */
  accepts(from: string, to: string): boolean;
  /** The prefix of the ids of its new nodes. */
  readonly idPrefix?: string;
}

/** The parameters of a node type, for the inspector. */
export function paramViews(
  params: Readonly<Record<string, ParamSchema>> | undefined,
): ParamView[] {
  return Object.entries(params ?? {}).map(([name, schema]) => ({
    name,
    kind: schema.kind,
    ...(schema.values && { values: schema.values }),
    ...(schema.default !== undefined && { default: schema.default }),
    ...(schema.required && { required: true }),
    ...(schema.description && { description: schema.description }),
  }));
}

/** A port of the graph core, as the editor shows it. */
export function portView<T>(
  port: PortSpec<T>,
  side: 'input' | 'output',
  typeName: (type: T) => string = String,
  exec?: (type: T) => boolean,
): PortView {
  const isExec = exec?.(port.type) ?? false;
  return {
    name: port.name,
    type: typeName(port.type),
    ...(isExec && { exec: true }),
    connections: port.connections ?? (side === 'input' ? 'one' : 'many'),
    ...(port.optional && { optional: true }),
    ...(port.default !== undefined && { default: port.default }),
    ...(port.description && { description: port.description }),
  };
}

/** `std.smoothstep` → `smoothstep`, `anim.stateMachine` → `state machine`. */
export function typeTitle(type: string): string {
  const last = type.slice(type.lastIndexOf('.') + 1);
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toLowerCase())
    .toLowerCase();
}

/** Its label, else a title of its type: the default of the kinds. */
export const defaultTitle = (node: GraphNode): string =>
  node.label ?? typeTitle(node.type);

/**
 * The ports of a node type with some parameters, or none when they cannot
 * be resolved (a required parameter missing): for the templates.
 */
export function tryPorts<T>(
  resolve: () => {
    inputs: readonly PortSpec<T>[];
    outputs: readonly PortSpec<T>[];
  },
  typeName?: (type: T) => string,
  exec?: (type: T) => boolean,
): { inputs: PortView[]; outputs: PortView[] } {
  try {
    const { inputs, outputs } = resolve();
    return {
      inputs: inputs.map((port) => portView(port, 'input', typeName, exec)),
      outputs: outputs.map((port) => portView(port, 'output', typeName, exec)),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}
