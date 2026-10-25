import {
  Button,
  type IDisposable,
  IEngineConnection,
  IWorkbench,
  NativeSelect,
  NativeSelectOption,
  type PluginContext,
} from '@fdw/editor-ui';
import type { BehaviorDebugState, GraphView } from '@fdw/engine-graph-editing';
import {
  edgeKey,
  Field,
  GraphClient,
  GraphPanel,
  type GraphOverlay,
  type GraphPanelContext,
  type NodeOverlay,
  useGraphClient,
} from '@fdw/graph-editor';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  behaviorGraphView,
  breakpointCommand,
  continueCommand,
  debuggingKey,
  pausedKey,
  showBehaviorGraphCommand,
  stepCommand,
  stopDebuggingCommand,
} from './manifest';

/** The types of the values of the graphs, for the variables and the signatures. */
const valueTypes = ['number', 'boolean', 'string', 'vec3', 'entity'] as const;

/** Whether an output may feed an input: the same type, or any value into `any`. */
export const acceptsBehaviorType = (from: string, to: string): boolean =>
  from === to || (to === 'any' && from !== 'exec');

// A value of the debugger, short.
export function shortValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && value !== null) {
    return `(${Object.values(value as Record<string, unknown>)
      .map(shortValue)
      .join(', ')})`;
  }
  return String(value);
}

/**
 * What the canvas shows of the debugger: the breakpoints, the node the
 * graph stopped before, how many times each node ran and its last values,
 * the wires of the flow that ran during the last run.
 */
export function debugOverlay(
  view: GraphView,
  debug: BehaviorDebugState | undefined,
): GraphOverlay | undefined {
  if (!debug?.attached) return undefined;
  const nodes: Record<string, NodeOverlay> = {};
  const breakpoints = new Set(debug.breakpoints);
  for (const node of view.nodes) {
    const state = debug.nodes[node.id];
    const paused = debug.paused?.node === node.id;
    const values: Record<string, string> = {};
    for (const [port, value] of Object.entries(state?.outputs ?? {})) {
      values[port] = shortValue(value);
    }
    nodes[node.id] = {
      ...(paused
        ? { marker: 'paused' as const }
        : breakpoints.has(node.id) && { marker: 'breakpoint' as const }),
      ...(state && state.runs > 0 && { badge: `${state.runs}×` }),
      ...(state?.active && { className: 'shadow-[0_0_0_1px_#fde047]' }),
      values,
    };
  }
  const active = new Set(
    Object.entries(debug.nodes)
      .filter(([, state]) => state.active)
      .map(([id]) => id),
  );
  const edges = new Set(
    view.edges
      .filter((edge) => active.has(edge.from.node) && active.has(edge.to.node))
      .map(edgeKey),
  );
  return { nodes, edges };
}

// The debugger: attached to the system of the scene, the instance
// followed, continue and step, where it stopped, the variables.
function DebuggerTab({ context }: { readonly context: GraphPanelContext }) {
  const { client, view, node } = context;
  const { debug } = useGraphClient(client);
  if (!view.target) {
    return (
      <p className="p-3 text-muted-foreground">
        Only the graphs of the scene are debugged: choose one above.
      </p>
    );
  }
  if (!debug?.attached) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-muted-foreground">
          The debugger interprets the graph while it is open: breakpoints (F9),
          steps (F10), the states of the nodes.
        </p>
        <Button size="xs" onClick={() => client.debug({ action: 'attach' })}>
          Debug
        </Button>
      </div>
    );
  }
  const paused = debug.paused;
  const pausedNode = view.nodes.find((n) => n.id === paused?.node);
  const state = node ? debug.nodes[node.id] : undefined;
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-1">
        <Button size="xs" onClick={() => client.debug({ action: 'continue' })}>
          Continue
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => client.debug({ action: 'step' })}
        >
          Step
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => client.debug({ action: 'detach' })}
        >
          Stop
        </Button>
      </div>
      <label className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-muted-foreground">Instance</span>
        <NativeSelect
          size="xs"
          aria-label="Instance followed"
          value={debug.entity ?? ''}
          onChange={(event) =>
            client.debug({
              action: 'follow',
              entity: Number(event.target.value),
            })
          }
        >
          {debug.instances.map((instance) => (
            <NativeSelectOption key={instance.entity} value={instance.entity}>
              {instance.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <p
        role="status"
        className={paused ? 'text-amber-400' : 'text-muted-foreground'}
      >
        {paused
          ? `Stopped before ${pausedNode?.title ?? paused.node} (${paused.reason}): the scene waits.`
          : `Running, ${debug.time.toFixed(1)} s.`}
      </p>
      {debug.call && (
        <p className="text-muted-foreground">Shown: the call #{debug.call}.</p>
      )}
      <span className="mt-1 border-t pt-2 font-medium">Variables</span>
      <table className="w-full">
        <tbody>
          {Object.entries(debug.variables).map(([name, value]) => (
            <tr key={name}>
              <td className="text-muted-foreground">{name}</td>
              <td className="text-right font-mono">{shortValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {node && (
        <>
          <span className="mt-1 border-t pt-2 font-medium">{node.title}</span>
          {state ? (
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="text-muted-foreground">Runs</td>
                  <td className="text-right">{state.runs}</td>
                </tr>
                {Object.entries(state.outputs).map(([port, value]) => (
                  <tr key={port}>
                    <td className="text-muted-foreground">{port}</td>
                    <td className="text-right font-mono">
                      {shortValue(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-muted-foreground">Not run yet.</p>
          )}
        </>
      )}
    </div>
  );
}

interface Variable {
  readonly name: string;
  readonly type: (typeof valueTypes)[number];
  readonly default?: unknown;
}

// The variables of the graph: each change a command of its history.
function VariablesTab({ context }: { readonly context: GraphPanelContext }) {
  const { client, view } = context;
  const variables = (view.fields['variables'] ?? []) as readonly Variable[];
  const set = (next: readonly Variable[]) =>
    client.command({ op: 'field', key: 'variables', value: next });
  const change = (index: number, variable: Variable) =>
    set(variables.map((v, i) => (i === index ? variable : v)));
  return (
    <div className="flex flex-col gap-1.5 p-3">
      {variables.map((variable, index) => (
        <div
          key={index}
          className="grid grid-cols-[1fr_5rem_4rem_1.5rem] gap-1"
        >
          <Field
            label={`Variable ${index + 1} name`}
            value={variable.name}
            onCommit={(name) => change(index, { ...variable, name })}
          />
          <NativeSelect
            size="xs"
            aria-label={`Variable ${variable.name} type`}
            value={variable.type}
            onChange={(event) => {
              const next: Variable = {
                name: variable.name,
                type: event.target.value as Variable['type'],
              };
              change(index, next);
            }}
          >
            {valueTypes.map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Field
            label={`Variable ${variable.name} default`}
            value={
              variable.default === undefined
                ? ''
                : JSON.stringify(variable.default)
            }
            onCommit={(text) => {
              const next: Variable = {
                name: variable.name,
                type: variable.type,
              };
              if (text.trim() === '') return change(index, next);
              try {
                change(index, { ...next, default: JSON.parse(text) });
              } catch {
                client.tell(`Not JSON: ${text}`);
              }
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${variable.name}`}
            onClick={() => set(variables.filter((_, i) => i !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          let i = variables.length + 1;
          while (variables.some((v) => v.name === `value${i}`)) i++;
          set([...variables, { name: `value${i}`, type: 'number' }]);
        }}
      >
        <Plus /> Variable
      </Button>
      <p className="mt-2 text-muted-foreground">
        Get and Set nodes of each variable are in the search (Space).
      </p>
    </div>
  );
}

interface Signature {
  readonly name: string;
  readonly kind: 'function' | 'macro';
  readonly inputs: readonly { readonly name: string; readonly type: string }[];
  readonly outputs: readonly { readonly name: string; readonly type: string }[];
}

// The ports of a signature: a name and a type each.
function PortsEditor({
  label,
  ports,
  types,
  onChange,
}: {
  readonly label: string;
  readonly ports: Signature['inputs'];
  readonly types: readonly string[];
  readonly onChange: (ports: Signature['inputs']) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      {ports.map((port, index) => (
        <div key={index} className="grid grid-cols-[1fr_5rem_1.5rem] gap-1">
          <Field
            label={`${label} ${index + 1} name`}
            value={port.name}
            onCommit={(name) =>
              onChange(ports.map((p, i) => (i === index ? { ...p, name } : p)))
            }
          />
          <NativeSelect
            size="xs"
            aria-label={`${label} ${port.name} type`}
            value={port.type}
            onChange={(event) =>
              onChange(
                ports.map((p, i) =>
                  i === index ? { ...p, type: event.target.value } : p,
                ),
              )
            }
          >
            {types.map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${port.name}`}
            onClick={() => onChange(ports.filter((_, i) => i !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          let i = ports.length + 1;
          while (ports.some((p) => p.name === `p${i}`)) i++;
          onChange([...ports, { name: `p${i}`, type: 'number' }]);
        }}
      >
        <Plus /> {label === 'Inputs' ? 'Input' : 'Output'}
      </Button>
    </div>
  );
}

// The functions and the macros of the graph: made, shown, their signature.
function FunctionsTab({ context }: { readonly context: GraphPanelContext }) {
  const { client, view } = context;
  const functions = (view.fields['functions'] ?? []) as readonly Signature[];
  const [name, setName] = useState('');
  const shown = functions.find((fn) => fn.name === view.scope);
  const edit = (change: Record<string, unknown>) =>
    shown && client.command({ op: 'function', name: shown.name, change });
  const types = shown?.kind === 'macro' ? ['exec', ...valueTypes] : valueTypes;
  return (
    <div className="flex flex-col gap-2 p-3">
      <ul className="flex flex-col gap-0.5">
        {functions.map((fn) => (
          <li key={fn.name} className="flex items-center gap-1">
            <button
              className="flex-1 truncate rounded px-1 text-left hover:bg-accent"
              onClick={() => client.command({ op: 'scope', scope: fn.name })}
            >
              <span className="text-muted-foreground">{fn.kind}</span> {fn.name}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${fn.name}`}
              onClick={() =>
                client.command({
                  op: 'function',
                  name: fn.name,
                  change: 'remove',
                })
              }
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name) return;
          client.command({ op: 'function', name, change: 'create' });
          client.command({ op: 'scope', scope: name });
          setName('');
        }}
      >
        <input
          aria-label="New function"
          placeholder="New function"
          className="h-6 min-w-0 flex-1 rounded-md border bg-transparent px-1.5"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <Button size="xs" type="submit">
          Create
        </Button>
      </form>
      {shown ? (
        <div className="mt-1 flex flex-col gap-2 border-t pt-2">
          <span className="font-medium">{shown.name}</span>
          <label className="grid grid-cols-[4rem_1fr] items-center gap-2">
            <span className="text-muted-foreground">Name</span>
            <Field
              label="Function name"
              value={shown.name}
              onCommit={(next) => edit({ name: next })}
            />
          </label>
          <label className="grid grid-cols-[4rem_1fr] items-center gap-2">
            <span className="text-muted-foreground">Kind</span>
            <NativeSelect
              size="xs"
              aria-label="Function kind"
              value={shown.kind}
              onChange={(event) => edit({ kind: event.target.value })}
            >
              <NativeSelectOption value="function">function</NativeSelectOption>
              <NativeSelectOption value="macro">macro</NativeSelectOption>
            </NativeSelect>
          </label>
          <PortsEditor
            label="Inputs"
            ports={shown.inputs}
            types={types}
            onChange={(inputs) => edit({ inputs })}
          />
          <PortsEditor
            label="Outputs"
            ports={shown.outputs}
            types={types}
            onChange={(outputs) => edit({ outputs })}
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={() => client.command({ op: 'scope' })}
          >
            Back to the graph
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          A function runs at once (one entry, one exit); a macro may wait, and
          has the entries and exits of its signature. Both are laid in the graph
          where they are called.
        </p>
      )}
    </div>
  );
}

/** Called by the editor at the first activation event of the plugin. */
export function activate(context: PluginContext): void {
  const client = new GraphClient(
    context.services.get(IEngineConnection),
    behaviorGraphView,
    'behavior',
  );
  context.subscriptions.push({ dispose: () => client.dispose() });
  // The node selected in the panel, for the breakpoint command.
  let shown: GraphPanelContext | undefined;
  const debug = () => client.getSnapshot().debug;

  // The context keys of the debugger.
  let keys: IDisposable[] = [];
  let told = '';
  const tell = () => {
    const state = debug();
    const next = `${state?.attached === true}|${state?.paused !== undefined}`;
    if (next === told) return;
    told = next;
    keys.forEach((key) => key.dispose());
    keys = [];
    if (state?.attached) keys.push(context.keys.set(debuggingKey, true));
    if (state?.paused) keys.push(context.keys.set(pausedKey, true));
  };
  context.subscriptions.push(
    { dispose: client.subscribe(tell) },
    { dispose: () => keys.forEach((key) => key.dispose()) },
  );

  const attach = () => {
    if (!debug()?.attached) client.debug({ action: 'attach' });
  };
  context.commands.register(continueCommand, () => {
    attach();
    client.debug({ action: 'continue' });
  });
  context.commands.register(stepCommand, () => {
    attach();
    client.debug({ action: 'step' });
  });
  context.commands.register(stopDebuggingCommand, () =>
    client.debug({ action: 'detach' }),
  );
  context.commands.register(breakpointCommand, () => {
    const node = shown?.node;
    if (!node) return client.tell('Select a node of the flow first.');
    const on = !(debug()?.breakpoints ?? []).includes(node.id);
    client.debug({
      action: 'breakpoint',
      node: node.id,
      on,
      ...(shown?.view.scope !== undefined && { scope: shown.view.scope }),
    });
  });
  context.commands.register(showBehaviorGraphCommand, () =>
    context.services.get(IWorkbench).openView(behaviorGraphView),
  );

  const remembered = () =>
    (context.state.get() as { target?: string } | undefined)?.target;
  context.views.registerComponent(behaviorGraphView, () => (
    <GraphPanel
      client={client}
      title="Behavior graph"
      extension=".behavior.json"
      accepts={acceptsBehaviorType}
      tabs={[
        {
          id: 'debugger',
          title: 'Debugger',
          render: (ctx) => <DebuggerTab context={ctx} />,
        },
        {
          id: 'variables',
          title: 'Variables',
          render: (ctx) => <VariablesTab context={ctx} />,
        },
        {
          id: 'functions',
          title: 'Functions',
          render: (ctx) => <FunctionsTab context={ctx} />,
        },
      ]}
      onOpenNode={(node) => {
        // A call: the body of its function.
        if (node.type.startsWith('call.')) {
          client.command({
            op: 'scope',
            scope: node.type.slice('call.'.length),
          });
        }
      }}
      overlay={(ctx) => {
        shown = ctx;
        return debugOverlay(ctx.view, ctx.state.debug);
      }}
      {...(remembered() !== undefined && { initialTarget: remembered() })}
      onTargetShown={(target) => {
        if (target !== undefined) context.state.set({ target });
      }}
    />
  ));
}
