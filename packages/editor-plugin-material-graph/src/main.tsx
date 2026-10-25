import {
  cn,
  IEngineConnection,
  IWorkbench,
  NativeSelect,
  NativeSelectOption,
  type PluginContext,
} from '@fdw/editor-ui';
import { formatDiagnostic } from '@fdw/engine-graph';
import type { MaterialCode } from '@fdw/engine-graph-editing';
import {
  GraphClient,
  GraphPanel,
  type GraphPanelContext,
  type GraphOverlay,
  useGraphClient,
} from '@fdw/graph-editor';
import { useEffect, useRef, useState } from 'react';
import { materialGraphView, showMaterialGraphCommand } from './manifest';

/**
 * Whether an output of a type may feed an input of another, as the editor
 * guesses it while a wire is dragged: the same type, a scalar into a
 * vector of its kind, or a type still generic. The engine decides.
 */
export function acceptsMaterialType(from: string, to: string): boolean {
  if (from === to) return true;
  const concrete = (type: string) =>
    ['f32', 'f16', 'i32', 'u32', 'bool'].includes(type) || type.includes('<');
  if (!concrete(from) || !concrete(to)) return true;
  const vector = /^vec[234]<(\w+)>$/.exec(to);
  return vector !== null && vector[1] === from;
}

type Shape = 'sphere' | 'cube' | 'plane';

// The material alone, drawn by the engine: its image, its shape, its time.
function PreviewTab({ context }: { readonly context: GraphPanelContext }) {
  const { client } = context;
  const { preview, code } = useGraphClient(client);
  const [shape, setShape] = useState<Shape>('sphere');
  const [animate, setAnimate] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => client.preview(shape, animate), [client, shape, animate]);
  useEffect(() => {
    const target = canvas.current;
    const context2d = target?.getContext('2d');
    if (!target || !context2d || !preview) return;
    target.width = preview.width;
    target.height = preview.height;
    context2d.putImageData(
      new ImageData(
        new Uint8ClampedArray(
          preview.pixels.buffer,
          preview.pixels.byteOffset,
          preview.pixels.byteLength,
        ),
        preview.width,
        preview.height,
      ),
      0,
      0,
    );
  }, [preview]);
  const errors = code?.diagnostics.filter((d) => d.severity === 'error') ?? [];
  return (
    <div className="flex flex-col gap-2 p-3">
      <canvas
        ref={canvas}
        role="img"
        aria-label="Preview of the material"
        className="aspect-square w-full rounded-md bg-zinc-900"
      />
      <div className="flex items-center gap-2">
        <NativeSelect
          size="xs"
          aria-label="Shape of the preview"
          value={shape}
          onChange={(event) => setShape(event.target.value as Shape)}
        >
          <NativeSelectOption value="sphere">Sphere</NativeSelectOption>
          <NativeSelectOption value="cube">Cube</NativeSelectOption>
          <NativeSelectOption value="plane">Plane</NativeSelectOption>
        </NativeSelect>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={animate}
            onChange={(event) => setAnimate(event.target.checked)}
          />
          Animate
        </label>
      </div>
      {code && (
        <p className="text-muted-foreground">
          {errors.length > 0
            ? 'Does not compile: the scene keeps the last material that did.'
            : `Compiled in ${code.time.toFixed(1)} ms.`}
        </p>
      )}
      {errors.map((diagnostic, i) => (
        <p key={i} className="text-destructive">
          {formatDiagnostic(diagnostic)}
        </p>
      ))}
    </div>
  );
}

/** The lines of a source generated for a node, by the source map. */
export function linesOf(
  code: MaterialCode,
  source: number,
  node: string | undefined,
): number[] {
  if (node === undefined) return [];
  return Object.entries(code.lines[source] ?? {})
    .filter(([, id]) => id === node)
    .map(([line]) => Number(line));
}

// The code generated for the backend of the engine: a click on a line
// marked selects its node, the lines of the node selected stand out.
function CodeTab({ context }: { readonly context: GraphPanelContext }) {
  const { code } = useGraphClient(context.client);
  const [source, setSource] = useState(0);
  const lines = useRef<HTMLDivElement>(null);
  const marked = code ? linesOf(code, source, context.node?.id) : [];
  // The first line of the node selected, in view.
  useEffect(() => {
    if (marked.length === 0) return;
    lines.current
      ?.querySelector(`[data-line="${marked[0]}"]`)
      ?.scrollIntoView({ block: 'center' });
    // Scrolled when the node selected changes.
  }, [context.node?.id, source]);
  if (!code || code.sources.length === 0) {
    return (
      <p className="p-3 text-muted-foreground">
        {code?.diagnostics.length
          ? 'The material does not compile.'
          : 'No code yet.'}
      </p>
    );
  }
  const shown = code.sources[Math.min(source, code.sources.length - 1)];
  const map = code.lines[source] ?? {};
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <span className="text-muted-foreground">{code.language}</span>
        {code.sources.length > 1 && (
          <NativeSelect
            size="xs"
            aria-label="Stage"
            value={source}
            onChange={(event) => setSource(Number(event.target.value))}
          >
            {code.sources.map((s, i) => (
              <NativeSelectOption key={s.stage} value={i}>
                {s.stage}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      <div
        ref={lines}
        role="list"
        aria-label="Generated code"
        className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[10px] leading-4"
      >
        {shown.code.split('\n').map((text, i) => {
          const line = i + 1;
          const node = map[line];
          return (
            <div
              key={line}
              role="listitem"
              data-line={line}
              data-node={node}
              className={cn(
                'flex gap-2 pr-2 whitespace-pre',
                node && 'cursor-pointer hover:bg-accent',
                marked.includes(line) && 'bg-sky-500/25',
              )}
              onClick={() => node && context.reveal(node)}
            >
              <span className="w-8 shrink-0 text-right text-muted-foreground select-none">
                {line}
              </span>
              {text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The nodes the compilation finds wrong, outlined.
function compileOverlay(context: GraphPanelContext): GraphOverlay | undefined {
  const diagnostics = context.state.code?.diagnostics ?? [];
  const nodes: Record<string, { className: string; badge: string }> = {};
  for (const diagnostic of diagnostics) {
    if (diagnostic.node && diagnostic.severity === 'error') {
      nodes[diagnostic.node] = {
        className: 'border-red-500',
        badge: 'error',
      };
    }
  }
  return { nodes };
}

/** Called by the editor at the first activation event of the plugin. */
export function activate(context: PluginContext): void {
  const client = new GraphClient(
    context.services.get(IEngineConnection),
    materialGraphView,
    'material',
  );
  context.subscriptions.push({ dispose: () => client.dispose() });
  const remembered = () =>
    (context.state.get() as { target?: string } | undefined)?.target;
  context.views.registerComponent(materialGraphView, () => (
    <GraphPanel
      client={client}
      title="Material graph"
      extension=".material.json"
      accepts={acceptsMaterialType}
      tabs={[
        {
          id: 'preview',
          title: 'Preview',
          render: (ctx) => <PreviewTab context={ctx} />,
        },
        {
          id: 'code',
          title: 'Code',
          render: (ctx) => <CodeTab context={ctx} />,
        },
      ]}
      overlay={compileOverlay}
      {...(remembered() !== undefined && { initialTarget: remembered() })}
      onTargetShown={(target) => {
        if (target !== undefined) context.state.set({ target });
      }}
    />
  ));
  context.commands.register(showMaterialGraphCommand, () =>
    context.services.get(IWorkbench).openView(materialGraphView),
  );
}
