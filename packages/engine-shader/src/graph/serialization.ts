import {
  MaterialGraphData,
  MaterialGraphFormat,
  MaterialGraphVersion,
} from './MaterialGraphData';

/**
 * Serializes a graph as indented JSON.
 *
 * @group Graph model
 */
export function serializeGraph(graph: MaterialGraphData): string {
  return JSON.stringify(graph, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
 * Parses a graph document and checks its structure. The semantic checks
 * (node types, ports, types, cycles) are done by validateGraph.
 *
 * @group Graph model
 */
export function parseGraph(source: string | unknown): MaterialGraphData {
  const data: unknown =
    typeof source === 'string' ? JSON.parse(source) : source;

  if (!isRecord(data)) {
    throw new Error('A material graph must be a JSON object');
  }
  if (data['format'] !== MaterialGraphFormat) {
    throw new Error(
      `Unsupported document format "${String(
        data['format'],
      )}", expected "${MaterialGraphFormat}"`,
    );
  }
  if (data['version'] !== MaterialGraphVersion) {
    throw new Error(
      `Unsupported material graph version ${String(
        data['version'],
      )}, expected ${MaterialGraphVersion}`,
    );
  }
  if (typeof data['name'] !== 'string') {
    throw new Error('A material graph must have a name');
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
      (edge['swizzle'] !== undefined && typeof edge['swizzle'] !== 'string')
    ) {
      throw new Error(`Malformed edge at index ${i}`);
    }
  });

  const parameters = data['parameters'];
  if (
    parameters !== undefined &&
    (!Array.isArray(parameters) ||
      !parameters.every(
        (parameter) =>
          isRecord(parameter) &&
          typeof parameter['name'] === 'string' &&
          parameter['default'] !== undefined,
      ))
  ) {
    throw new Error('Malformed "parameters"');
  }

  const functions = data['functions'];
  if (functions !== undefined) {
    if (!Array.isArray(functions)) {
      throw new Error('"functions" must be an array');
    }
    functions.forEach((entry, i) => {
      if (
        !isRecord(entry) ||
        typeof entry['id'] !== 'string' ||
        (entry['description'] !== undefined &&
          typeof entry['description'] !== 'string')
      ) {
        throw new Error(`Malformed function at index ${i}`);
      }
      // Function graphs follow the same format.
      parseGraph(entry['graph']);
    });
  }

  return data as unknown as MaterialGraphData;
}
