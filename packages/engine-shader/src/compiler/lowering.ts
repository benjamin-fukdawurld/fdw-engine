import type { Diagnostic } from '../graph/Diagnostic';
import type { GraphNode, StaticValue } from '../graph/MaterialGraphData';
import type { NodeRegistry } from '../graph/NodeRegistry';
import {
  FunctionDefinition,
  isFunctionDefinition,
  resolveParams,
} from '../graph/NodeDefinition';
import type { ConstantValue } from '../types/ConstantValue';
import { BuiltinTypes, ShaderType } from '../types/ShaderType';
import { composeSwizzles } from '../graph/swizzle';
import { InputSource, WorkingGraph } from './WorkingGraph';

/**
 * A color target written by the surface besides its color (or instead of
 * it): see the `outputs` of {@link CompileOptions}.
 *
 * @group Compilation
 */
export interface SurfaceOutput {
  /** The name of the target, unique in the pass. */
  readonly name: string;
  /** Its location in the pass: 0 is the color when the pass has one. */
  readonly location: number;
  /**
   * What is written:
   * - a value of the surface or of the engine, by name: `view-normal`,
   *   `world-normal`, `view-depth`, `world-position`, `object-id`, `uv`,
   *   or an input of the surface (`base-color`, `alpha`, `roughness`…, its
   *   default when the shading model has none); converted to the format;
   * - a function graph whose inputs are named after these values
   *   (`viewNormal`, `baseColor`…), the same for every material;
   * - `'material'`: the `output.value` of that name of the material
   *   (`g.output`), else `default`.
   * The functions and the materials give the type of the format.
   */
  readonly value: string | FunctionDefinition;
  /** The components of the format (1 for r32float, 4 for rgba8unorm). */
  readonly channels: 1 | 2 | 3 | 4;
  /** The scalar of the format: u32 for uint formats, i32 for sint ones. */
  readonly scalar: 'f32' | 'u32' | 'i32';
  /** For `'material'`: the value of the materials without output.value. */
  readonly default?: ConstantValue;
}

/** The type a target of `channels` components of `scalar` takes. */
export function surfaceOutputType(
  output: Pick<SurfaceOutput, 'channels' | 'scalar'>
): ShaderType {
  return output.channels === 1
    ? { kind: 'scalar', scalar: output.scalar }
    : { kind: 'vector', scalar: output.scalar, size: output.channels };
}

// The values of the surface without a port in the shading model.
const surfaceDefaults: Record<
  string,
  { value: ConstantValue; type: ShaderType }
> = {
  baseColor: { value: [1, 1, 1], type: BuiltinTypes.vec3f },
  alpha: { value: 1, type: BuiltinTypes.f32 },
  emissive: { value: [0, 0, 0], type: BuiltinTypes.vec3f },
  roughness: { value: 0.5, type: BuiltinTypes.f32 },
  metallic: { value: 0, type: BuiltinTypes.f32 },
  occlusion: { value: 1, type: BuiltinTypes.f32 },
  specular: { value: [1, 1, 1], type: BuiltinTypes.vec3f },
  shininess: { value: 32, type: BuiltinTypes.f32 },
};

// A swizzle of a source, composed with the one it has.
const swizzled = (source: InputSource, swizzle: string): InputSource =>
  'value' in source
    ? source
    : {
        ...source,
        swizzle: source.swizzle
          ? composeSwizzles(source.swizzle, swizzle) ?? swizzle
          : swizzle,
      };

const camelCase = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

const isZero = (source: InputSource): boolean =>
  'value' in source &&
  (Array.isArray(source.value)
    ? source.value.every((component) => component === 0)
    : source.value === 0);

/**
 * Replaces 'output.fullscreen' by a vertex stage drawing a triangle that
 * covers the target, without mesh, and the fragment output. The 'screen-uv'
 * builtins read the coordinates computed for the vertices, interpolated:
 * origin at the top left on every backend, whatever its framebuffer origin.
 */
export function lowerFullscreen(
  graph: WorkingGraph,
  diagnostics: Diagnostic[]
): void {
  const nodes = [...graph.nodes.values()];
  const output = nodes.find((node) => node.type === 'output.fullscreen');
  const screenUvs = nodes.filter(
    (node) =>
      node.type === 'input.builtin' && node.params['builtin'] === 'screen-uv'
  );
  if (!output) {
    for (const node of screenUvs) {
      diagnostics.push({
        severity: 'error',
        node: node.id,
        message:
          'screen-uv is only available in graphs ending with output.fullscreen',
      });
    }
    return;
  }
  const out = (node: string, port = 'result'): InputSource => ({
    ref: { node, port },
  });

  // Vertices 0, 1 and 2 at (-1, -1), (3, -1) and (-1, 3) in clip space.
  const index = graph.addNode('input.builtin', { builtin: 'vertex-index' });
  const coordinate = (vertex: number) =>
    graph.addNode(
      'std.select',
      {},
      {
        ifFalse: { value: -1 },
        ifTrue: { value: 3 },
        condition: out(
          graph.addNode(
            'std.equal',
            {},
            { a: out(index, 'value'), b: { value: vertex } }
          )
        ),
      }
    );
  const x = coordinate(1);
  const y = coordinate(2);
  const clip = graph.addNode(
    'std.vec4',
    {},
    { x: out(x), y: out(y), z: { value: 0 }, w: { value: 1 } }
  );
  graph.addNode('output.vertex', {}, { clipPosition: out(clip) });

  // uv = ((x + 1) / 2, 1 - (y + 1) / 2): v points down, as in images.
  const half = (value: string) =>
    graph.addNode(
      'std.mul',
      {},
      {
        a: out(
          graph.addNode('std.add', {}, { a: out(value), b: { value: 1 } })
        ),
        b: { value: 0.5 },
      }
    );
  const uv = graph.addNode(
    'std.vec2',
    {},
    {
      x: out(half(x)),
      y: out(
        graph.addNode('std.sub', {}, { a: { value: 1 }, b: out(half(y)) })
      ),
    }
  );
  // Interpolated, then read per fragment: the uv is linear over the
  // triangle, but what depends on it rarely is (a vignette, a distortion),
  // and the vertices are far outside of the target.
  const fragmentUv = graph.addNode('std.perFragment', {}, { value: out(uv) });
  for (const node of screenUvs) {
    graph.redirectPort(
      { node: node.id, port: 'value' },
      { ref: { node: fragmentUv, port: 'result' } }
    );
    graph.removeNode(node.id);
  }

  graph.addNode(
    'output.fragment',
    {},
    { color: graph.inputSource(output, 'color') ?? { value: [0, 0, 0, 1] } }
  );
  graph.removeNode(output.id);
}

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
 *
 * With the 'depthOnly' feature, the fragment stage writes no color: the
 * shading model is left out, only the mask discards remain (shadow maps,
 * depth prepasses).
 *
 * The `outputs` add color targets (output.target), from the values of the
 * surface and of the engine. Without `color`, the shading model is left out
 * too: the surface only writes its outputs (a G-buffer). The output.value
 * nodes of the material are removed, used by the outputs of their name.
 */
export function lowerSurface(
  graph: WorkingGraph,
  registry: NodeRegistry,
  diagnostics: Diagnostic[],
  feature: (name: string) => StaticValue | undefined = () => undefined,
  outputs: readonly SurfaceOutput[] = [],
  withColor = true
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

  if (feature('depthOnly')) {
    lowerDepthOnly(graph, surface, source, feature);
    removeOutputValues(graph);
    return;
  }

  // Fragment stage: the shading model turns the surface into a color.
  const surfaceInputs: Record<string, InputSource | undefined> = {};
  for (const port of ports) {
    if (port.name !== 'positionOffset') {
      surfaceInputs[port.name] = source(port.name);
    }
  }
  // Without a normal on the surface, the model gets the interpolated normal
  // of the mesh, in world space (normalized by the model, per fragment).
  let meshNormal: InputSource | undefined;
  const interpolatedNormal = (): InputSource => {
    if (!meshNormal) {
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
      meshNormal = out(
        graph.addNode('std.perFragment', {}, { value: out(worldNormal) })
      );
    }
    return meshNormal;
  };
  if (
    ports.some((port) => port.name === 'normal') &&
    !surfaceInputs['normal']
  ) {
    surfaceInputs['normal'] = interpolatedNormal();
  }

  const discard = maskDiscard(graph, source, feature);
  const targets = lowerOutputs(graph, registry, diagnostics, surface, {
    outputs,
    ports: ports.map((port) => ({
      name: port.name,
      type: port.type as ShaderType,
    })),
    surfaceInputs,
    interpolatedNormal,
    worldPosition: out(worldPosition),
  });
  removeOutputValues(graph);
  if (!targets) {
    return;
  }
  if (!withColor) {
    // A G-buffer: the outputs only, without the shading model.
    graph.addNode('output.fragment', {}, discard ? { discard } : {});
    graph.removeNode(surface.id);
    return;
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

  graph.addNode(
    'output.fragment',
    {},
    discard ? { color: output, discard } : { color: output }
  );

  graph.removeNode(surface.id);
}

// The output.value nodes of a material: used (or not) by the outputs.
function removeOutputValues(graph: WorkingGraph): void {
  for (const node of [...graph.nodes.values()]) {
    if (node.type === 'output.value') {
      graph.removeNode(node.id);
    }
  }
}

// Adds an output.target per surface output; false on error.
function lowerOutputs(
  graph: WorkingGraph,
  registry: NodeRegistry,
  diagnostics: Diagnostic[],
  surface: GraphNode,
  context: {
    readonly outputs: readonly SurfaceOutput[];
    readonly ports: readonly { name: string; type: ShaderType }[];
    readonly surfaceInputs: Readonly<Record<string, InputSource | undefined>>;
    readonly interpolatedNormal: () => InputSource;
    readonly worldPosition: InputSource;
  }
): boolean {
  const out = (node: string, port = 'result'): InputSource => ({
    ref: { node, port },
  });
  const error = (message: string) => {
    diagnostics.push({ severity: 'error', node: surface.id, message });
    return false;
  };
  const values = new Map<string, { source: InputSource; type: ShaderType }>();
  const cached = (
    name: string,
    build: () => { source: InputSource; type: ShaderType }
  ) => {
    let value = values.get(name);
    if (!value) {
      value = build();
      values.set(name, value);
    }
    return value;
  };
  const view = () =>
    cached('camera.view', () => ({
      source: out(
        graph.addNode('input.engine', { value: 'camera.view' }),
        'value'
      ),
      type: BuiltinTypes.mat4f,
    }));
  const worldNormal = () =>
    cached('worldNormal', () => ({
      source: out(
        graph.addNode(
          'std.normalize',
          {},
          {
            x: context.surfaceInputs['normal'] ?? context.interpolatedNormal(),
          }
        )
      ),
      type: BuiltinTypes.vec3f,
    }));
  // The values the outputs and their functions can use, by name.
  const builders: Record<
    string,
    () => { source: InputSource; type: ShaderType }
  > = {
    normal: worldNormal,
    worldNormal,
    viewNormal: () =>
      cached('viewNormal', () => {
        const direction = graph.addNode(
          'std.transform',
          {},
          {
            matrix: view().source,
            vector: out(
              graph.addNode(
                'std.extend',
                {},
                { xyz: worldNormal().source, w: { value: 0 } }
              )
            ),
          }
        );
        return {
          source: out(
            graph.addNode(
              'std.normalize',
              {},
              { x: swizzled(out(direction), 'xyz') }
            )
          ),
          type: BuiltinTypes.vec3f,
        };
      }),
    worldPosition: () => ({
      source: swizzled(context.worldPosition, 'xyz'),
      type: BuiltinTypes.vec3f,
    }),
    viewDepth: () =>
      cached('viewDepth', () => {
        const position = graph.addNode(
          'std.transform',
          {},
          { matrix: view().source, vector: context.worldPosition }
        );
        // The camera looks at -z.
        return {
          source: out(
            graph.addNode(
              'std.mul',
              {},
              { a: swizzled(out(position), 'z'), b: { value: -1 } }
            )
          ),
          type: BuiltinTypes.f32,
        };
      }),
    objectId: () =>
      cached('objectId', () => ({
        source: out(
          graph.addNode('input.engine', { value: 'object.id' }),
          'value'
        ),
        type: BuiltinTypes.u32,
      })),
    uv: () =>
      cached('uv', () => ({
        source: out(
          graph.addNode('input.attribute', {
            semantic: 'uv',
            type: BuiltinTypes.vec2f,
          }),
          'value'
        ),
        type: BuiltinTypes.vec2f,
      })),
  };
  // The inputs of the surface, or their defaults.
  const surfaceValue = (name: string) => {
    const port = context.ports.find((candidate) => candidate.name === name);
    const connected = context.surfaceInputs[name];
    if (port && connected) {
      // Constants as nodes, which can be swizzled and converted.
      return {
        source:
          'value' in connected
            ? {
                ref: {
                  node: graph.addNode('const.value', {
                    type: port.type,
                    value: connected.value,
                  }),
                  port: 'value',
                },
              }
            : connected,
        type: port.type,
      };
    }
    const fallback = surfaceDefaults[name];
    return fallback
      ? {
          // A node, which can be swizzled and converted.
          source: {
            ref: {
              node: graph.addNode('const.value', {
                type: fallback.type,
                value: fallback.value,
              }),
              port: 'value',
            },
          },
          type: fallback.type,
        }
      : undefined;
  };
  const named = (name: string) => builders[name]?.() ?? surfaceValue(name);
  const known = () =>
    [
      ...Object.keys(builders),
      ...new Set([
        ...context.ports.map((port) => port.name),
        ...Object.keys(surfaceDefaults),
      ]),
    ]
      .filter((name) => name !== 'positionOffset')
      .join(', ');

  const materialValues = new Map(
    [...graph.nodes.values()]
      .filter((node) => node.type === 'output.value')
      .map((node) => [node.params['name'] as string, node] as const)
  );
  for (const output of context.outputs) {
    const expected = surfaceOutputType(output);
    let value: InputSource | undefined;
    if (output.value === 'material') {
      const node = materialValues.get(output.name);
      value = node
        ? graph.inputSource(node, 'value')
        : {
            ref: {
              node: graph.addNode('const.value', {
                type: expected,
                value: output.default ?? 0,
              }),
              port: 'value',
            },
          };
    } else if (typeof output.value !== 'string') {
      const fn = output.value;
      if (!registry.has(fn.id)) {
        return error(`unknown output function "${fn.id}"`);
      }
      const inputs: Record<string, InputSource> = {};
      for (const port of fn.inputs({})) {
        const found = named(port.name);
        if (found) {
          inputs[port.name] = found.source;
        } else if (port.default === undefined) {
          return error(
            `the input "${port.name}" of the output function "${
              fn.id
            }" is not a value of the surface: ${known()}`
          );
        }
      }
      const result = fn.outputs({})[0];
      if (!result || !isFunctionDefinition(fn)) {
        return error(`the output function "${fn.id}" has no output`);
      }
      value = out(graph.addNode(fn.id, {}, inputs), result.name);
    } else {
      const found = named(camelCase(output.value));
      if (!found) {
        return error(
          `unknown output value "${output.value}": ${known()}, or 'material'`
        );
      }
      const shaped = shape(graph, found, expected);
      if (!shaped) {
        return error(
          `the output "${output.name}" cannot hold "${output.value}" in a format of ${output.channels} ${output.scalar} components`
        );
      }
      value = shaped;
    }
    graph.addNode(
      'output.target',
      { name: output.name, location: output.location },
      { value }
    );
  }
  return true;
}

// A value of the engine converted to the type of a target: its scalars,
// then its components (dropped, or added: 0, and 1 for the 4th).
function shape(
  graph: WorkingGraph,
  { source, type }: { source: InputSource; type: ShaderType },
  expected: ShaderType
): InputSource | undefined {
  const size = (t: ShaderType) =>
    t.kind === 'vector' ? t.size : t.kind === 'scalar' ? 1 : 0;
  const scalar = (t: ShaderType) =>
    t.kind === 'vector' || t.kind === 'scalar' ? t.scalar : undefined;
  const from = size(type);
  const to = size(expected);
  const toScalar = scalar(expected);
  if (from === 0 || to === 0 || !toScalar) {
    return undefined;
  }
  let value = source;
  if (scalar(type) !== toScalar) {
    const converted: ShaderType =
      from === 1
        ? { kind: 'scalar', scalar: toScalar }
        : { kind: 'vector', scalar: toScalar, size: from as 2 | 3 | 4 };
    value = {
      ref: {
        node: graph.addNode('std.convert', { to: converted }, { value }),
        port: 'result',
      },
    };
  }
  if (from > to) {
    return swizzled(value, 'xyzw'.slice(0, to));
  }
  if (from < to) {
    // Padding only for floats: the constructors of the library take f32.
    if (toScalar !== 'f32') {
      return undefined;
    }
    const constructors = ['', '', 'std.vec2', 'std.vec3', 'std.vec4'];
    const inputs: Record<string, InputSource> = {};
    'xyzw'
      .slice(0, to)
      .split('')
      .forEach((component, i) => {
        inputs[component] =
          i < from
            ? from === 1
              ? value
              : swizzled(value, component)
            : { value: i === 3 ? 1 : 0 };
      });
    return {
      ref: {
        node: graph.addNode(constructors[to], {}, inputs),
        port: 'result',
      },
    };
  }
  return value;
}

// The discard of masked materials: alpha below the 'alphaCutoff' uniform.
function maskDiscard(
  graph: WorkingGraph,
  source: (port: string) => InputSource | undefined,
  feature: (name: string) => StaticValue | undefined
): InputSource | undefined {
  if (feature('alphaMode') !== 'mask') {
    return undefined;
  }
  const cutoff = graph.addNode('input.uniform', {
    name: 'alphaCutoff',
    type: BuiltinTypes.f32,
    slot: 'material',
    default: 0.5,
  });
  return {
    ref: {
      node: graph.addNode(
        'std.less',
        {},
        {
          a: source('alpha') ?? { value: 1 },
          b: { ref: { node: cutoff, port: 'value' } },
        }
      ),
      port: 'result',
    },
  };
}

// The fragment stage of the depth-only variant: no color, the discard of
// masked materials. The surface inputs no longer used are dead code.
function lowerDepthOnly(
  graph: WorkingGraph,
  surface: GraphNode,
  source: (port: string) => InputSource | undefined,
  feature: (name: string) => StaticValue | undefined
): void {
  const discard = maskDiscard(graph, source, feature);
  graph.addNode('output.fragment', {}, discard ? { discard } : {});
  graph.removeNode(surface.id);
}
