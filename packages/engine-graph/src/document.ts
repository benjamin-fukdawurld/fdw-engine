import type { GraphDocument } from './GraphData';

/**
 * What a kind of graph checks when parsing its documents.
 *
 * @group Serialization
 */
export interface DocumentFormat {
  /** The value of the `format` field: 'fdw-animation-graph'… */
  readonly format: string;
  readonly version: number;
  /** The kind of graph, in the messages: 'material graph'… */
  readonly kind: string;
  /** Checks the fields an edge adds; true when they are well formed. */
  readonly edge?: (edge: Record<string, unknown>) => boolean;
  /** Checks the fields a document adds; throws when malformed. */
  readonly document?: (document: Record<string, unknown>) => void;
  /**
   * Brings the documents of older versions to the current one:
   * `migrations[n]` makes a document of version n one of version n + 1.
   */
  readonly migrations?: Readonly<Record<number, DocumentMigration>>;
}

/**
 * Makes a document of a version one of the next version.
 *
 * @group Serialization
 */
export type DocumentMigration = (
  document: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Whether a value is a plain object.
 *
 * @group Serialization
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPortRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['node'] === 'string' &&
    typeof value['port'] === 'string'
  );
}

/**
 * Serializes a graph as indented JSON.
 *
 * @group Serialization
 */
export function serializeDocument(graph: GraphDocument): string {
  return JSON.stringify(graph, null, 2);
}

/**
 * Parses a graph document (JSON text or an object) and checks its
 * structure: format, version, name, nodes and edges. The semantic checks
 * (node types, ports, types, cycles) belong to the validation of its kind.
 *
 * @throws when the document is malformed.
 * @group Serialization
 */
export function parseDocument<G extends GraphDocument>(
  source: string | unknown,
  format: DocumentFormat,
): G {
  const parsed: unknown =
    typeof source === 'string' ? JSON.parse(source) : source;
  const kind = format.kind;
  const article = /^[aeiou]/.test(kind) ? 'An' : 'A';

  if (!isRecord(parsed)) {
    throw new Error(`${article} ${kind} must be a JSON object`);
  }
  let data = parsed;
  if (data['format'] !== format.format) {
    throw new Error(
      `Unsupported document format "${String(
        data['format'],
      )}", expected "${format.format}"`,
    );
  }
  for (
    let version = data['version'];
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 1 &&
    version < format.version;
    version++
  ) {
    const migrate = format.migrations?.[version];
    if (!migrate) {
      throw new Error(`No migration of ${kind} from version ${version}`);
    }
    data = { ...migrate(data), version: version + 1 };
  }
  if (data['version'] !== format.version) {
    throw new Error(
      `Unsupported ${kind} version ${String(data['version'])}, expected ${
        format.version
      }`,
    );
  }
  if (typeof data['name'] !== 'string') {
    throw new Error(`${article} ${kind} must have a name`);
  }

  const nodes = data['nodes'];
  if (!Array.isArray(nodes)) {
    throw new Error('"nodes" must be an array');
  }
  nodes.forEach((node, i) => {
    if (
      !isRecord(node) ||
      typeof node['id'] !== 'string' ||
      typeof node['type'] !== 'string' ||
      !isRecord(node['params']) ||
      (node['defaults'] !== undefined && !isRecord(node['defaults'])) ||
      (node['label'] !== undefined && typeof node['label'] !== 'string')
    ) {
      throw new Error(`Malformed node at index ${i}`);
    }
  });

  const edges = data['edges'];
  if (!Array.isArray(edges)) {
    throw new Error('"edges" must be an array');
  }
  edges.forEach((edge, i) => {
    if (
      !isRecord(edge) ||
      !isPortRef(edge['from']) ||
      !isPortRef(edge['to']) ||
      (format.edge !== undefined && !format.edge(edge))
    ) {
      throw new Error(`Malformed edge at index ${i}`);
    }
  });

  format.document?.(data);
  return data as unknown as G;
}
