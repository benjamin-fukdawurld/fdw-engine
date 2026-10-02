import type { Diagnostic } from '../graph/Diagnostic';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { resolveParams } from '../graph/NodeDefinition';
import { T } from '../types/ShaderType';
import { InputSource, WorkingGraph } from './WorkingGraph';

const isZero = (source: InputSource): boolean =>
  'value' in source &&
  (Array.isArray(source.value)
    ? source.value.every((component) => component === 0)
    : source.value === 0);

// Replaces 'output.surface' by the standard vertex stage and the shading
// model, ending with 'output.vertex' and 'output.fragment'. Graphs that
// already use the raw outputs are left unchanged.
export function lowerSurface(
  graph: WorkingGraph,
  registry: NodeRegistry,
  diagnostics: Diagnostic[]
): void {
  const surface = [...graph.nodes.values()].find(
    (node) => node.type === 'output.surface'
  );
  if (!surface) {
    return;
  }

  const definition = registry.require('output.surface');
  const params = resolveParams(definition, surface.params);
  const shadingModel = params['shadingModel'] as string;
  if (shadingModel !== 'unlit') {
    diagnostics.push({
      severity: 'error',
      node: surface.id,
      message: `the "${shadingModel}" shading model is not supported yet, only "unlit" is`,
    });
    return;
  }

  // The source of each surface input: its edge, its node default, or the
  // port default.
  const ports = definition.inputs(params);
  const source = (port: string): InputSource => {
    const connected = graph.inputSource(surface, port);
    if (connected) {
      return connected;
    }
    const schema = ports.find((candidate) => candidate.name === port);
    return { value: schema?.default ?? 0 };
  };
  const out = (node: string, port = 'result'): InputSource => ({
    ref: { node, port },
  });

  // Vertex stage: object → world → clip space.
  const position = graph.addNode('input.attribute', {
    semantic: 'position',
    type: T.vec3f,
  });
  const offset = source('positionOffset');
  const displaced = isZero(offset)
    ? out(position, 'value')
    : out(
        graph.addNode('std.add', {}, { a: out(position, 'value'), b: offset })
      );
  const local = graph.addNode(
    'std.extend',
    {},
    { xyz: displaced, w: { value: 1 } }
  );
  const world = graph.addNode('input.engine', { value: 'object.world' });
  const worldPosition = graph.addNode(
    'std.transform',
    {},
    { matrix: out(world, 'value'), vector: out(local) }
  );
  const viewProjection = graph.addNode('input.engine', {
    value: 'camera.viewProjection',
  });
  const clipPosition = graph.addNode(
    'std.transform',
    {},
    { matrix: out(viewProjection, 'value'), vector: out(worldPosition) }
  );
  graph.addNode('output.vertex', {}, { clipPosition: out(clipPosition) });

  // Unlit shading model: the base color, as is.
  const color = graph.addNode(
    'std.extend',
    {},
    { xyz: source('baseColor'), w: source('alpha') }
  );
  graph.addNode('output.fragment', {}, { color: out(color) });

  graph.removeNode(surface.id);
}
