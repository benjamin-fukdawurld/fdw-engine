import {
  type AnimationGraphData,
  AnimationGraphFormat,
  AnimationGraphVersion,
  type AnimationNodeType,
  type AnimationParameter,
  createAnimationRegistry,
  parseAnimationGraph,
  serializeAnimationGraph,
  validateAnimationGraph,
} from '@fdw/engine-animation';
import {
  type GraphBody,
  type GraphNode,
  isRecord,
  type Registry,
  resolveParams,
} from '@fdw/engine-graph';
import {
  defaultTitle,
  type GraphKind,
  type KindValidation,
  paramViews,
  portView,
  tryPorts,
} from '../GraphKind';
import type { NodeTemplate } from '../protocol';

const parameterTypes = ['number', 'boolean', 'trigger'];

function animationTitle(node: GraphNode): string {
  if (node.label) return node.label;
  const param = (name: string) => String(node.params[name] ?? '');
  switch (node.type) {
    case 'anim.clip':
      return `Clip ${param('clip')}`;
    case 'anim.parameter':
      return param('name');
    case 'anim.blend1d':
      return 'Blend space';
    case 'anim.stateMachine':
      return 'State machine';
    case 'anim.output':
      return 'Output';
  }
  const title = defaultTitle(node);
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The animation graphs (`engine-animation`). */
export function animationGraphKind(
  registry: Registry<AnimationNodeType> = createAnimationRegistry(),
): GraphKind<AnimationGraphData> {
  return {
    id: 'animation',
    title: 'Animation graph',
    extension: '.animation.json',
    idPrefix: 'n',
    create: (name) => ({
      format: AnimationGraphFormat,
      version: AnimationGraphVersion,
      name,
      nodes: [
        { id: 'idle', type: 'anim.clip', params: { clip: 'Idle' } },
        { id: 'output', type: 'anim.output', params: {} },
      ],
      edges: [
        {
          from: { node: 'idle', port: 'pose' },
          to: { node: 'output', port: 'pose' },
        },
      ],
      layout: {
        nodes: { idle: { x: 0, y: 0 }, output: { x: 260, y: 0 } },
      },
    }),
    parse: (source) => parseAnimationGraph(source),
    serialize: (document) => serializeAnimationGraph(document),
    scopes: (document) => [{ title: document.name }],
    body: (document, scope): GraphBody => {
      if (scope !== undefined) throw new Error(`No function "${scope}"`);
      return document;
    },
    withBody: (document, scope, { nodes, edges, layout }) => {
      if (scope !== undefined) throw new Error(`No function "${scope}"`);
      return {
        ...document,
        nodes: nodes as AnimationGraphData['nodes'],
        edges,
        ...(layout && { layout }),
      };
    },
    validate: (document): KindValidation => {
      const validation = validateAnimationGraph(document, registry);
      return {
        nodes: new Map(
          [...validation.nodes].map(([id, resolved]) => [
            id,
            {
              title: animationTitle(resolved.node),
              ...(resolved.definition.category && {
                category: resolved.definition.category,
              }),
              ...(resolved.definition.description && {
                description: resolved.definition.description,
              }),
              schema: paramViews(resolved.definition.params),
              inputs: resolved.inputs.map((port) => portView(port, 'input')),
              outputs: resolved.outputs.map((port) => portView(port, 'output')),
            },
          ]),
        ),
        diagnostics: validation.diagnostics,
      };
    },
    check: (document) => validateAnimationGraph(document, registry).diagnostics,
    templates: (document): NodeTemplate[] => {
      const templates: NodeTemplate[] = [];
      const add = (
        id: string,
        title: string,
        definition: AnimationNodeType,
        params: Record<string, unknown> = {},
      ) => {
        const resolved = resolveParams(definition.params, params);
        templates.push({
          id,
          title,
          type: definition.id,
          ...(Object.keys(params).length > 0 && { params }),
          category: definition.category ?? 'node',
          ...(definition.description && {
            description: definition.description,
          }),
          keywords: [definition.id],
          ...tryPorts(() => ({
            inputs: definition.inputs(resolved),
            outputs: definition.outputs(resolved),
          })),
        });
      };
      for (const definition of registry.definitions) {
        switch (definition.id) {
          case 'anim.clip':
            add(definition.id, 'Clip', definition, { clip: 'Idle' });
            continue;
          case 'anim.parameter':
            for (const parameter of document.parameters ?? []) {
              add(
                `anim.parameter:${parameter.name}`,
                parameter.name,
                definition,
                {
                  name: parameter.name,
                  type: parameter.type === 'number' ? 'number' : 'boolean',
                },
              );
            }
            continue;
          case 'anim.blend1d':
            add(definition.id, 'Blend space', definition, { points: [0, 1] });
            continue;
          case 'anim.stateMachine':
            add(definition.id, 'State machine', definition, {
              states: [{ name: 'idle' }, { name: 'move' }],
              transitions: [],
            });
            continue;
          default:
            add(
              definition.id,
              animationTitle({ id: '', type: definition.id, params: {} }),
              definition,
            );
        }
      }
      return templates;
    },
    catalogKey: (document) => JSON.stringify(document.parameters ?? []),
    fields: (document) => ({ parameters: document.parameters ?? [] }),
    setField: (document, key, value) => {
      switch (key) {
        case 'name':
          if (typeof value !== 'string' || value === '') {
            throw new Error('A graph needs a name');
          }
          return { ...document, name: value };
        case 'parameters':
          if (
            !Array.isArray(value) ||
            !value.every(
              (parameter) =>
                isRecord(parameter) &&
                typeof parameter['name'] === 'string' &&
                parameterTypes.includes(parameter['type'] as string),
            )
          ) {
            throw new Error(
              'The parameters must be an array of { name, type }',
            );
          }
          return { ...document, parameters: value as AnimationParameter[] };
        default:
          throw new Error(`An animation graph has no field "${key}"`);
      }
    },
    accepts: (from, to) => from === to,
  };
}
