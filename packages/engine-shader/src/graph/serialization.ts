import { isRecord, parseDocument, serializeDocument } from '@fdw/engine-graph';
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
  return serializeDocument(graph);
}

/**
 * Parses a graph document and checks its structure. The semantic checks
 * (node types, ports, types, cycles) are done by validateGraph.
 *
 * @group Graph model
 */
export function parseGraph(source: string | unknown): MaterialGraphData {
  return parseDocument<MaterialGraphData>(source, {
    format: MaterialGraphFormat,
    version: MaterialGraphVersion,
    kind: 'material graph',
    edge: (edge) =>
      edge['swizzle'] === undefined || typeof edge['swizzle'] === 'string',
    document: (data) => {
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
    },
  });
}
