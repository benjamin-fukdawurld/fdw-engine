import {
  Button,
  cn,
  NativeSelect,
  NativeSelectOption,
  useEditor,
  type FileFilter,
} from '@fdw/editor-ui';
import { formatDiagnostic } from '@fdw/engine-graph';
import type { GraphView, NodeView } from '@fdw/engine-graph-editing';
import {
  AlertTriangle,
  CircleX,
  FilePlus,
  FolderOpen,
  LayoutGrid,
  Maximize,
  PanelRight,
  Redo2,
  Save,
  Undo2,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { GraphClient, GraphClientState } from './client';
import { useGraphClient } from './client';
import { GraphCanvas, type GraphOverlay } from './GraphCanvas';
import { NodeInspector } from './NodeInspector';

/** What the tabs of a panel are given. */
export interface GraphPanelContext {
  readonly client: GraphClient;
  readonly state: GraphClientState;
  readonly view: GraphView;
  readonly selection: readonly string[];
  setSelection(selection: readonly string[]): void;
  /** The node selected last, if any. */
  readonly node?: NodeView;
  /** Frames and selects a node. */
  reveal(node: string): void;
}

/** A tab of the column of a panel. */
export interface GraphPanelTab {
  readonly id: string;
  readonly title: string;
  render(context: GraphPanelContext): ReactNode;
}

export interface GraphPanelProps {
  readonly client: GraphClient;
  /** 'Material graph'. */
  readonly title: string;
  /** The end of the names of its files: `.material.json`. */
  readonly extension: string;
  readonly accepts: (from: string, to: string) => boolean;
  /** The tabs of the plugin, before Node and Problems. */
  readonly tabs?: readonly GraphPanelTab[];
  /** The live state over the canvas. */
  readonly overlay?: (context: GraphPanelContext) => GraphOverlay | undefined;
  /** Shown instead of the canvas (the editor of a state machine). */
  readonly override?: (context: GraphPanelContext) => ReactNode;
  readonly onOpenNode?: (node: NodeView, context: GraphPanelContext) => void;
  readonly onKey?: (
    event: KeyboardEvent,
    context: GraphPanelContext,
  ) => boolean;
  /** The parameters of a node another tab edits. */
  readonly hiddenParams?: (node: NodeView) => readonly string[];
  /** Buttons of the plugin, in the bar. */
  readonly toolbar?: (context: GraphPanelContext) => ReactNode;
  /** The graph of the scene to open first, when none is: the one shown last. */
  readonly initialTarget?: string;
  /** Tells the plugin the graph of the scene shown, to open it again later. */
  readonly onTargetShown?: (target: string | undefined) => void;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The panel of an editor of graphs, for a plugin: the bar (the graph
 * shown, chosen among those of the scene; new, open and save a file;
 * undo, redo; arrange, frame; the function shown; the problems), the
 * canvas, and a column of tabs: those of the plugin, the node selected,
 * the problems.
 */
export function GraphPanel(props: GraphPanelProps) {
  const { client, title, extension } = props;
  const { host } = useEditor();
  const state = useGraphClient(client);
  const { view, targets } = state;
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [frameRequest, setFrameRequest] = useState(0);
  const [reveal, setReveal] = useState<{ node: string; request: number }>();
  const [tab, setTab] = useState<string>();
  const [sidebar, setSidebar] = useState(true);
  const mine = useMemo(
    () => targets.filter((target) => target.kind === client.kind),
    [targets, client.kind],
  );
  const source = client.source;

  // The graph of the scene shown last, else the first one, when none is
  // shown.
  useEffect(() => {
    if (source || mine.length === 0) return;
    const target = mine.find((t) => t.id === props.initialTarget) ?? mine[0];
    client.open({ target: target.id });
  }, [client, source, mine, props.initialTarget]);
  useEffect(() => {
    props.onTargetShown?.(view?.target);
    // Told when the target shown changes only.
  }, [view?.target]);
  // Another graph: nothing selected.
  useEffect(
    () => setSelection([]),
    [view?.session, view?.scope, view?.target, view?.file],
  );

  const filters: readonly FileFilter[] = [
    { name: title, extensions: ['json'] },
  ];
  const openFile = async () => {
    const file = await host.files.open(filters);
    if (file) {
      client.open({
        file: { name: file.name, text: decoder.decode(file.data) },
      });
    }
  };
  const saveFile = async () => {
    const file = await client.save();
    const data = encoder.encode(file.text) as Uint8Array<ArrayBuffer>;
    if (await host.files.save(file.name, data, filters))
      client.saved(file.name);
  };

  // The message of a command refused, for a few seconds.
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (!state.message) return;
    setMessage(state.message.text);
    const timer = setTimeout(() => setMessage(undefined), 4000);
    return () => clearTimeout(timer);
  }, [state.message]);

  const nodeId = [...selection]
    .reverse()
    .find((id) => view?.nodes.some((node) => node.id === id));
  const node = view?.nodes.find((n) => n.id === nodeId);
  const context: GraphPanelContext | undefined = view && {
    client,
    state,
    view,
    selection,
    setSelection,
    ...(node && { node }),
    reveal: (id) =>
      setReveal({ node: id, request: (reveal?.request ?? 0) + 1 }),
  };

  const tabs: GraphPanelTab[] = [
    ...(props.tabs ?? []),
    {
      id: 'node',
      title: 'Node',
      render: (ctx) =>
        ctx.node ? (
          <NodeInspector
            key={ctx.node.id}
            view={ctx.view}
            node={ctx.node}
            dispatch={(command) => client.command(command)}
            onError={(text) => client.tell(text)}
            hiddenParams={props.hiddenParams?.(ctx.node) ?? []}
          />
        ) : (
          <p className="p-3 text-muted-foreground">Select a node.</p>
        ),
    },
    {
      id: 'problems',
      title: view ? `Problems (${view.errors + view.warnings})` : 'Problems',
      render: (ctx) => <Problems view={ctx.view} reveal={ctx.reveal} />,
    },
  ];
  const shownTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const override = context && props.override?.(context);
  const sourceValue = view?.target
    ? `target:${view.target}`
    : view
      ? 'current'
      : '';

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-1.5">
        <NativeSelect
          size="xs"
          aria-label={`${title} shown`}
          className="w-44"
          value={sourceValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value.startsWith('target:')) {
              client.open({ target: value.slice('target:'.length) });
            }
          }}
        >
          {!view && <NativeSelectOption value="">No graph</NativeSelectOption>}
          {view && !view.target && (
            <NativeSelectOption value="current">
              {view.file ?? view.name}
            </NativeSelectOption>
          )}
          {mine.map((target) => (
            <NativeSelectOption key={target.id} value={`target:${target.id}`}>
              {target.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Bar
          title={`New ${title.toLowerCase()}`}
          onClick={() => client.open({ create: `new ${client.kind}` })}
        >
          <FilePlus />
        </Bar>
        <Bar
          title={`Open a ${title.toLowerCase()}…`}
          onClick={() => void openFile()}
        >
          <FolderOpen />
        </Bar>
        <Bar
          title={`Save as ${extension}`}
          disabled={!view}
          onClick={() => void saveFile()}
        >
          <Save />
        </Bar>
        <span className="mx-1 h-4 border-l" />
        <Bar
          title={view?.undo ? `Undo ${view.undo}` : 'Undo'}
          disabled={!view?.undo}
          onClick={() => client.command({ op: 'undo' })}
        >
          <Undo2 />
        </Bar>
        <Bar
          title={view?.redo ? `Redo ${view.redo}` : 'Redo'}
          disabled={!view?.redo}
          onClick={() => client.command({ op: 'redo' })}
        >
          <Redo2 />
        </Bar>
        <Bar
          title="Arrange the nodes"
          disabled={!view}
          onClick={() => client.command({ op: 'layout' })}
        >
          <LayoutGrid />
        </Bar>
        <Bar
          title="Frame (F)"
          disabled={!view}
          onClick={() => setFrameRequest((n) => n + 1)}
        >
          <Maximize />
        </Bar>
        {view && view.scopes.length > 1 && (
          <NativeSelect
            size="xs"
            aria-label="Function shown"
            className="w-36"
            value={view.scope ?? ''}
            onChange={(event) =>
              client.command({
                op: 'scope',
                ...(event.target.value !== '' && { scope: event.target.value }),
              })
            }
          >
            {view.scopes.map((scope) => (
              <NativeSelectOption key={scope.id ?? ''} value={scope.id ?? ''}>
                {scope.kind ? `${scope.kind} ${scope.title}` : scope.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {context && props.toolbar?.(context)}
        <span className="ml-auto flex items-center gap-2 pr-1">
          {view && (
            <>
              {view.target && (
                <span
                  className="rounded bg-emerald-600/30 px-1.5 text-emerald-300"
                  title="Each valid change runs in the scene"
                >
                  live
                </span>
              )}
              <span
                className={cn(
                  'flex items-center gap-0.5',
                  view.errors > 0
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
                aria-label={`${view.errors} errors`}
              >
                <CircleX className="size-3.5" />
                {view.errors}
              </span>
              <span
                className={cn(
                  'flex items-center gap-0.5',
                  view.warnings > 0
                    ? 'text-amber-500'
                    : 'text-muted-foreground',
                )}
                aria-label={`${view.warnings} warnings`}
              >
                <AlertTriangle className="size-3.5" />
                {view.warnings}
              </span>
              {view.dirty && (
                <span title="Changed since opened or saved">•</span>
              )}
            </>
          )}
          <Bar
            title={sidebar ? 'Hide the column' : 'Show the column'}
            onClick={() => setSidebar((shown) => !shown)}
          >
            <PanelRight />
          </Bar>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {view && context ? (
            (override ?? (
              <GraphCanvas
                view={view}
                templates={state.templates}
                accepts={props.accepts}
                dispatch={(command) => client.command(command)}
                selection={selection}
                onSelectionChange={setSelection}
                overlay={props.overlay?.(context)}
                onOpenNode={(n) => props.onOpenNode?.(n, context)}
                onKey={(event) => props.onKey?.(event, context) ?? false}
                frameRequest={frameRequest}
                {...(reveal && { reveal })}
              />
            ))
          ) : (
            <p className="p-3 text-muted-foreground">
              {mine.length === 0
                ? `The scene shows no ${title.toLowerCase()}: open a file, or make a new one.`
                : 'Opening…'}
            </p>
          )}
          {view?.applyError && (
            <div className="absolute top-2 left-2 max-w-[80%] rounded bg-red-900/80 px-2 py-1 text-red-100">
              Not running: {view.applyError}
            </div>
          )}
          {message && (
            <div
              role="status"
              className="absolute bottom-2 left-2 max-w-[80%] rounded bg-zinc-800/90 px-2 py-1 text-zinc-100 shadow"
            >
              {message}
            </div>
          )}
        </div>
        {sidebar && context && (
          <div className="flex w-[45%] max-w-72 min-w-40 shrink-0 flex-col border-l">
            <div role="tablist" className="flex shrink-0 flex-wrap border-b">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === shownTab.id}
                  className={cn(
                    'px-2 py-1',
                    t.id === shownTab.id
                      ? 'border-b-2 border-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setTab(t.id)}
                >
                  {t.title}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
              {shownTab.render(context)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// A button of the bar.
function Bar({
  title,
  disabled,
  onClick,
  children,
}: {
  readonly title: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// The problems of the graph shown: a click frames their node.
function Problems({
  view,
  reveal,
}: {
  readonly view: GraphView;
  readonly reveal: (node: string) => void;
}) {
  if (view.diagnostics.length === 0) {
    return <p className="p-3 text-muted-foreground">No problem.</p>;
  }
  return (
    <ul className="space-y-0.5 p-1">
      {view.diagnostics.map((diagnostic, i) => (
        <li key={i}>
          <button
            className={cn(
              'w-full rounded px-2 py-1 text-left hover:bg-accent',
              diagnostic.severity === 'error'
                ? 'text-destructive'
                : 'text-amber-500',
            )}
            disabled={!diagnostic.node}
            onClick={() => diagnostic.node && reveal(diagnostic.node)}
          >
            {formatDiagnostic(diagnostic)}
          </button>
        </li>
      ))}
    </ul>
  );
}
