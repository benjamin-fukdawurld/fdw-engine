import type { Diagnostic } from '../graph/Diagnostic';
import type { StaticValue } from '../graph/MaterialGraphData';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { resolveParams } from '../graph/NodeDefinition';
import { BuiltinTypes } from '../types/ShaderType';
import { InputSource, WorkingGraph } from './WorkingGraph';

const isZero = (source: InputSource): boolean =>
  'value' in source &&
  (Array.isArray(source.value)
    ? source.value.every((component) => component === 0)
    : source.value === 0);

/**
 * Replaces 'output.surface' by the standard vertex stage and the shading
 * model, ending with 'output.vertex' and 'output.fragment'. Graphs that
 * already use the raw outputs are left unchanged.
 *
 * With the 'alphaMode' feature set to 'mask' (given by the renderer from the
 * render state), fragments whose alpha is below the 'alphaCutoff' uniform are
 * discarded.
 *
 * The color of the shading model is linear. With the 'toneMapping' feature
 * (other than 'none'), it is multiplied by the exposure of the frame and tone
 * mapped; with the 'outputEncoding' feature set to 'srgb', it is encoded for
 * display. Without these features, the color is written as is.
 */
export function lowerSurface(
  graph: WorkingGraph,
  registry: NodeRegistry,
  diagnostics: Diagnostic[],
  feature: (name: string) => StaticValue | undefined = () => undefined
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
  // The shading model is a macro, which may be registered by the user.
  const lighting = `lighting.${shadingModel}`;
  if (!registry.has(lighting)) {
    diagnostics.push({
      severity: 'error',
      node: surface.id,
      message: `the "${shadingModel}" shading model is not supported yet (no ${lighting} macro)`,
    });
    return;
  }

  // The source of each surface input: its edge, its node default, or the
  // port default; undefined for unconnected optional inputs.
  const ports = definition.inputs(params, { registry });
  const source = (port: string): InputSource | undefined => {
    const connected = graph.inputSource(surface, port);
    if (connected) {
      return connected;
    }
    const value = ports.find((candidate) => candidate.name === port)?.default;
    return value === undefined ? undefined : { value };
  };
  const out = (node: string, port = 'result'): InputSource => ({
    ref: { node, port },
  });

  // Vertex stage: object → world → clip space.
  const position = graph.addNode('input.attribute', {
    semantic: 'position',
    type: BuiltinTypes.vec3f,
  });
  const offset = source('positionOffset') ?? { value: 0 };
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

  // Fragment stage: the shading model turns the surface into a color.
  const surfaceInputs: Record<string, InputSource | undefined> = {};
  for (const port of ports) {
    if (port.name !== 'positionOffset') {
      surfaceInputs[port.name] = source(port.name);
    }
  }
  // Without a normal on the surface, the model gets the interpolated normal
  // of the mesh, in world space (normalized by the model, per fragment).
  if (
    ports.some((port) => port.name === 'normal') &&
    !surfaceInputs['normal']
  ) {
    const normal = graph.addNode('input.attribute', {
      semantic: 'normal',
      type: BuiltinTypes.vec3f,
    });
    const normalMatrix = graph.addNode('input.engine', {
      value: 'object.normalMatrix',
    });
    const worldNormal = graph.addNode(
      'std.transform3',
      {},
      { matrix: out(normalMatrix, 'value'), vector: out(normal, 'value') }
    );
    surfaceInputs['normal'] = out(
      graph.addNode('std.perFragment', {}, { value: out(worldNormal) })
    );
  }
  const color = graph.addNode(
    lighting,
    {},
    {
      ...surfaceInputs,
      worldPosition: out(worldPosition),
    }
  );
  let output = out(color, 'color');
  const toneMapping = feature('toneMapping') ?? 'none';
  const encoding = feature('outputEncoding') ?? 'linear';
  if (toneMapping !== 'none' || encoding === 'srgb') {
    let rgb: InputSource = { ...output, swizzle: 'xyz' };
    if (toneMapping !== 'none') {
      const operators: Record<string, string> = {
        reinhard: 'color.toneMapReinhard',
        aces: 'color.toneMapAces',
        neutral: 'color.toneMapNeutral',
      };
      const operator = operators[toneMapping as string];
      if (!operator) {
        diagnostics.push({
          severity: 'error',
          node: surface.id,
          message: `unknown tone mapping "${String(toneMapping)}"`,
        });
        return;
      }
      const exposure = graph.addNode('input.engine', { value: 'exposure' });
      const exposed = graph.addNode(
        'std.mul',
        {},
        { a: rgb, b: out(exposure, 'value') }
      );
      rgb = out(graph.addNode(operator, {}, { color: out(exposed) }));
    }
    if (encoding === 'srgb') {
      rgb = out(graph.addNode('color.linearToSrgb', {}, { color: rgb }));
    }
    output = out(
      graph.addNode(
        'std.extend',
        {},
        { xyz: rgb, w: { ...out(color, 'color'), swizzle: 'w' } }
      )
    );
  }

  let discard: InputSource | undefined;
  if (feature('alphaMode') === 'mask') {
    const cutoff = graph.addNode('input.uniform', {
      name: 'alphaCutoff',
      type: BuiltinTypes.f32,
      slot: 'material',
      default: 0.5,
    });
    discard = out(
      graph.addNode(
        'std.less',
        {},
        { a: source('alpha') ?? { value: 1 }, b: out(cutoff, 'value') }
      )
    );
  }
  graph.addNode(
    'output.fragment',
    {},
    discard ? { color: output, discard } : { color: output }
  );

  graph.removeNode(surface.id);
}
