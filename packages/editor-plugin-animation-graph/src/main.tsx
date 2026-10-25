import {
  Button,
  cn,
  IEngineConnection,
  IWorkbench,
  NativeSelect,
  NativeSelectOption,
  type PluginContext,
} from '@fdw/editor-ui';
import type {
  AnimationLive,
  GraphCommand,
  GraphView,
  NodeView,
} from '@fdw/engine-graph-editing';
import {
  Field,
  GraphClient,
  GraphPanel,
  type GraphOverlay,
  type GraphPanelContext,
  type NodeOverlay,
  useGraphClient,
} from '@fdw/graph-editor';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { animationGraphView, showAnimationGraphCommand } from './manifest';
import {
  addState,
  type Condition,
  machineParams,
  removeState,
  renameState,
  setTransitions,
  stateBox,
  stateLayout,
  statesOf,
  type Transition,
  transitionsOf,
} from './stateMachine';

interface Parameter {
  readonly name: string;
  readonly type: 'number' | 'boolean' | 'trigger';
}

const parametersOf = (view: GraphView) =>
  (view.fields['parameters'] ?? []) as readonly Parameter[];

/**
 * What the canvas shows of the animator followed: the weight of each node
 * in its pose, the state of each machine.
 */
export function animationOverlay(
  live: AnimationLive | undefined,
): GraphOverlay | undefined {
  if (!live) return undefined;
  const nodes: Record<string, NodeOverlay> = {};
  for (const [id, { weight }] of Object.entries(live.nodes)) {
    nodes[id] = {
      weight,
      ...(weight > 0 && { badge: `${Math.round(weight * 100)}%` }),
      ...(weight === 0 && { className: 'opacity-60' }),
    };
  }
  for (const [id, machine] of Object.entries(live.machines)) {
    nodes[id] = {
      ...nodes[id],
      badge: machine.next
        ? `${machine.state} → ${machine.next}`
        : machine.state,
    };
  }
  return { nodes };
}

// The states as boxes, the transitions as arrows; what plays now in
// color. A drag from the dot of a state to another makes a transition; a
// click selects a state or a transition, Delete removes it.
function StateMachineView({
  context,
  node,
  selected,
  onSelect,
  onClose,
}: {
  readonly context: GraphPanelContext;
  readonly node: NodeView;
  readonly selected?: string;
  readonly onSelect: (item: string | undefined) => void;
  readonly onClose: () => void;
}) {
  const { client, view } = context;
  const { animation } = useGraphClient(client);
  const states = statesOf(node);
  const transitions = transitionsOf(node);
  const places = stateLayout(states);
  const machine = animation?.machines[node.id];
  const initial =
    (node.params['initial'] as string | undefined) ?? states[0]?.name;
  const [wire, setWire] = useState<{ from: string; x: number; y: number }>();
  const run = (commands: readonly GraphCommand[]) =>
    commands.forEach((command) => client.command(command));
  const center = (name: string) => {
    const p = places.get(name) ?? { x: 0, y: 0 };
    return { x: p.x + stateBox.width / 2, y: p.y + stateBox.height / 2 };
  };

  const startWire = (from: string, event: ReactPointerEvent) => {
    event.stopPropagation();
    const box = (
      event.currentTarget.closest('[data-machine]') as HTMLElement
    ).getBoundingClientRect();
    const move = (e: PointerEvent) =>
      setWire({ from, x: e.clientX - box.left, y: e.clientY - box.top });
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWire(undefined);
      const to = (e.target as Element | null)
        ?.closest?.('[data-state]')
        ?.getAttribute('data-state');
      if (to && to !== '*' && to !== from) {
        client.command(
          setTransitions(node, [...transitions, { from, to, duration: 0.2 }]),
        );
        onSelect(`transition:${transitions.length}`);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const remove = () => {
    if (!selected) return;
    if (selected.startsWith('transition:')) {
      const index = Number(selected.slice('transition:'.length));
      client.command(
        setTransitions(
          node,
          transitions.filter((_, i) => i !== index),
        ),
      );
    } else if (selected.startsWith('state:')) {
      run(removeState(view, node, selected.slice('state:'.length)));
    }
    onSelect(undefined);
  };

  return (
    <div
      data-machine
      tabIndex={0}
      role="application"
      aria-label={`${node.title}: state machine`}
      className="relative h-full w-full overflow-auto bg-[#1b1b1f] outline-none select-none"
      onPointerDown={() => onSelect(undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          remove();
        } else if (event.key === 'Escape') {
          onClose();
        }
      }}
    >
      <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
        <Button variant="outline" size="xs" onClick={onClose}>
          <ArrowLeft /> {view.name}
        </Button>
        <span className="text-muted-foreground">
          {node.title}: drag from the dot of a state to another for a
          transition.
        </span>
      </div>
      <svg
        className="absolute top-0 left-0 overflow-visible"
        width={1}
        height={1}
      >
        <defs>
          <marker
            id="fdw-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        {transitions.map((transition, index) => {
          const a = center(transition.from);
          const b = center(transition.to);
          // Both ways: side by side.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy) || 1;
          const nx = (-dy / length) * 8;
          const ny = (dx / length) * 8;
          const shrink = (p: { x: number; y: number }, s: number) => ({
            x: p.x + (dx / length) * s,
            y: p.y + (dy / length) * s,
          });
          const start = shrink({ x: a.x + nx, y: a.y + ny }, 40);
          const end = shrink({ x: b.x + nx, y: b.y + ny }, -40);
          const id = `transition:${index}`;
          const playing =
            machine?.next === transition.to &&
            (transition.from === machine.state || transition.from === '*');
          return (
            <g key={index}>
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="transparent"
                strokeWidth={12}
                className="cursor-pointer"
                data-transition={index}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onSelect(id);
                }}
              />
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke={
                  selected === id ? '#38bdf8' : playing ? '#fbbf24' : '#a1a1aa'
                }
                strokeWidth={playing ? 3 : 2}
                markerEnd="url(#fdw-arrow)"
                pointerEvents="none"
              />
            </g>
          );
        })}
        {wire && (
          <line
            x1={center(wire.from).x}
            y1={center(wire.from).y}
            x2={wire.x}
            y2={wire.y}
            stroke="#38bdf8"
            strokeDasharray="6 4"
            strokeWidth={2}
          />
        )}
      </svg>
      {['*', ...states.map((s) => s.name)].map((name) => {
        const p = places.get(name) ?? { x: 0, y: 0 };
        const current = machine?.state === name;
        const next = machine?.next === name;
        const id = `state:${name}`;
        return (
          <div
            key={name}
            data-state={name}
            role="button"
            aria-label={name === '*' ? 'Any state' : `State ${name}`}
            className={cn(
              'absolute flex flex-col justify-center rounded-md border px-3',
              name === '*'
                ? 'border-dashed border-zinc-600 text-zinc-400'
                : 'border-zinc-600 bg-zinc-800 text-zinc-100',
              current && 'border-emerald-400 bg-emerald-900/60',
              next && 'border-amber-400',
              selected === id && 'ring-2 ring-sky-400',
            )}
            style={{ left: p.x, top: p.y, ...stateBox }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (name !== '*') onSelect(id);
            }}
          >
            <span className="truncate font-medium">
              {name === '*' ? 'Any state' : name}
              {name === initial && (
                <span className="ml-1 text-muted-foreground">(initial)</span>
              )}
            </span>
            {current && machine && (
              <span className="text-[10px] text-emerald-300">
                {machine.time.toFixed(2)} s
              </span>
            )}
            {next && machine && (
              <span
                aria-label={`Fading in ${Math.round(machine.progress * 100)}%`}
                className="mt-0.5 h-0.5 bg-amber-400"
                style={{ width: `${machine.progress * 100}%` }}
              />
            )}
            <span
              aria-label={`Transition from ${name}`}
              title="Drag to another state"
              className="absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-sky-400 bg-zinc-900"
              onPointerDown={(event) => startWire(name, event)}
            />
          </div>
        );
      })}
    </div>
  );
}

// The states and the transitions of the state machine selected.
function MachineTab({
  context,
  node,
  selected,
  onSelect,
}: {
  readonly context: GraphPanelContext;
  readonly node: NodeView | undefined;
  readonly selected?: string;
  readonly onSelect: (item: string | undefined) => void;
}) {
  const { client, view } = context;
  const [name, setName] = useState('');
  if (!node) {
    return (
      <p className="p-3 text-muted-foreground">
        Select a state machine node; a double click opens it.
      </p>
    );
  }
  const states = statesOf(node);
  const transitions = transitionsOf(node);
  const parameters = parametersOf(view);
  const run = (commands: readonly GraphCommand[]) =>
    commands.forEach((command) => client.command(command));
  const change = (index: number, transition: Transition) =>
    client.command(
      setTransitions(
        node,
        transitions.map((t, i) => (i === index ? transition : t)),
      ),
    );
  const stateNames = states.map((s) => s.name);
  const initial =
    (node.params['initial'] as string | undefined) ?? stateNames[0];
  return (
    <div className="flex flex-col gap-2 p-3">
      <span className="font-medium">States</span>
      {states.map((state) => (
        <div key={state.name} className="grid grid-cols-[1fr_1.5rem] gap-1">
          <Field
            label={`State ${state.name}`}
            value={state.name}
            onCommit={(next) => run(renameState(view, node, state.name, next))}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove the state ${state.name}`}
            onClick={() => run(removeState(view, node, state.name))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (name) run(addState(node, name));
          setName('');
        }}
      >
        <input
          aria-label="New state"
          placeholder="New state"
          className="h-6 min-w-0 flex-1 rounded-md border bg-transparent px-1.5"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <Button size="xs" type="submit">
          Add
        </Button>
      </form>
      <label className="grid grid-cols-[4rem_1fr] items-center gap-2">
        <span className="text-muted-foreground">Initial</span>
        <NativeSelect
          size="xs"
          aria-label="Initial state"
          value={initial ?? ''}
          onChange={(event) =>
            client.command({
              op: 'params',
              node: node.id,
              params: { initial: event.target.value },
            })
          }
        >
          {stateNames.map((state) => (
            <NativeSelectOption key={state} value={state}>
              {state}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <span className="mt-2 border-t pt-2 font-medium">Transitions</span>
      {transitions.map((transition, index) => (
        <TransitionForm
          key={index}
          index={index}
          transition={transition}
          states={stateNames}
          parameters={parameters}
          selected={selected === `transition:${index}`}
          onSelect={() => onSelect(`transition:${index}`)}
          onChange={(next) => change(index, next)}
          onRemove={() =>
            client.command(
              setTransitions(
                node,
                transitions.filter((_, i) => i !== index),
              ),
            )
          }
        />
      ))}
      <Button
        variant="outline"
        size="xs"
        disabled={stateNames.length < 2}
        onClick={() =>
          client.command(
            setTransitions(node, [
              ...transitions,
              { from: stateNames[0], to: stateNames[1], duration: 0.2 },
            ]),
          )
        }
      >
        <Plus /> Transition
      </Button>
    </div>
  );
}

const ops = ['==', '!=', '>', '>=', '<', '<='] as const;

function TransitionForm({
  index,
  transition,
  states,
  parameters,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly transition: Transition;
  readonly states: readonly string[];
  readonly parameters: readonly Parameter[];
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onChange: (transition: Transition) => void;
  readonly onRemove: () => void;
}) {
  const label = `Transition ${index + 1}`;
  const conditions = transition.conditions ?? [];
  const setConditions = (next: readonly Condition[]) => {
    const changed: Transition = { ...transition, conditions: next };
    if (next.length === 0)
      delete (changed as { conditions?: unknown }).conditions;
    onChange(changed);
  };
  const triggers = parameters.filter((p) => p.type === 'trigger');
  const values = parameters.filter((p) => p.type !== 'trigger');
  return (
    <div
      className={cn(
        'grid grid-cols-[4rem_1fr] items-center gap-1 rounded-md border p-1.5',
        selected && 'border-sky-400',
      )}
      onPointerDown={onSelect}
    >
      <span className="text-muted-foreground">From</span>
      <div className="flex gap-1">
        <NativeSelect
          size="xs"
          aria-label={`${label} from`}
          value={transition.from}
          onChange={(event) =>
            onChange({ ...transition, from: event.target.value })
          }
        >
          {['*', ...states].map((s) => (
            <NativeSelectOption key={s} value={s}>
              {s === '*' ? 'any' : s}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="self-center">→</span>
        <NativeSelect
          size="xs"
          aria-label={`${label} to`}
          value={transition.to}
          onChange={(event) =>
            onChange({ ...transition, to: event.target.value })
          }
        >
          {states.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {s}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <span className="text-muted-foreground">Fade (s)</span>
      <Field
        type="number"
        label={`${label} duration`}
        value={String(transition.duration ?? 0.2)}
        onCommit={(text) => {
          const duration = Number(text);
          if (Number.isFinite(duration)) onChange({ ...transition, duration });
        }}
      />
      <span className="text-muted-foreground">Exit time</span>
      <Field
        type="number"
        label={`${label} exit time`}
        value={
          transition.exitTime === undefined ? '' : String(transition.exitTime)
        }
        onCommit={(text) => {
          const next: Transition = { ...transition };
          if (text.trim() === '')
            delete (next as { exitTime?: unknown }).exitTime;
          else if (Number.isFinite(Number(text))) {
            (next as { exitTime?: number }).exitTime = Number(text);
          }
          onChange(next);
        }}
      />
      <span className="text-muted-foreground">Trigger</span>
      <NativeSelect
        size="xs"
        aria-label={`${label} trigger`}
        value={transition.trigger ?? ''}
        onChange={(event) => {
          const next: Transition = {
            ...transition,
            trigger: event.target.value,
          };
          if (event.target.value === '')
            delete (next as { trigger?: unknown }).trigger;
          onChange(next);
        }}
      >
        <NativeSelectOption value="">none</NativeSelectOption>
        {triggers.map((p) => (
          <NativeSelectOption key={p.name} value={p.name}>
            {p.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {conditions.map((condition, i) => {
        const parameter = values.find((p) => p.name === condition.parameter);
        return (
          <div
            key={i}
            className="col-span-2 grid grid-cols-[1fr_3rem_4rem_1.5rem] gap-1"
          >
            <NativeSelect
              size="xs"
              aria-label={`${label} condition ${i + 1} parameter`}
              value={condition.parameter}
              onChange={(event) =>
                setConditions(
                  conditions.map((c, j) =>
                    j === i ? { ...c, parameter: event.target.value } : c,
                  ),
                )
              }
            >
              {values.map((p) => (
                <NativeSelectOption key={p.name} value={p.name}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              size="xs"
              aria-label={`${label} condition ${i + 1} operator`}
              value={condition.op ?? '=='}
              onChange={(event) =>
                setConditions(
                  conditions.map((c, j) =>
                    j === i
                      ? { ...c, op: event.target.value as Condition['op'] }
                      : c,
                  ),
                )
              }
            >
              {ops.map((op) => (
                <NativeSelectOption key={op} value={op}>
                  {op}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Field
              label={`${label} condition ${i + 1} value`}
              value={String(condition.value ?? true)}
              onCommit={(text) => {
                const value =
                  parameter?.type === 'boolean'
                    ? text === 'true'
                    : Number(text);
                setConditions(
                  conditions.map((c, j) => (j === i ? { ...c, value } : c)),
                );
              }}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove the condition ${i + 1}`}
              onClick={() =>
                setConditions(conditions.filter((_, j) => j !== i))
              }
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      <Button
        className="col-span-2"
        variant="ghost"
        size="xs"
        disabled={values.length === 0}
        onClick={() =>
          setConditions([
            ...conditions,
            {
              parameter: values[0]?.name ?? '',
              op: values[0]?.type === 'number' ? '>' : '==',
              value: values[0]?.type === 'number' ? 0 : true,
            },
          ])
        }
      >
        <Plus /> Condition
      </Button>
    </div>
  );
}

// What the animator followed plays: its parameters (forced from here),
// its machines.
function PlayTab({ context }: { readonly context: GraphPanelContext }) {
  const { client, view } = context;
  const { animation } = useGraphClient(client);
  if (!view.target) {
    return (
      <p className="p-3 text-muted-foreground">
        A graph of the scene plays: choose one above.
      </p>
    );
  }
  if (!animation) return <p className="p-3 text-muted-foreground">Waiting…</p>;
  const parameters = parametersOf(view);
  const force = (name: string, value: number | boolean) =>
    client.animation({ parameter: { name, value } });
  return (
    <div className="flex flex-col gap-2 p-3">
      <label className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-muted-foreground">Animator</span>
        <NativeSelect
          size="xs"
          aria-label="Animator followed"
          value={animation.animator ?? ''}
          onChange={(event) =>
            client.animation({ animator: event.target.value })
          }
        >
          {animation.animators.map((name) => (
            <NativeSelectOption key={name} value={name}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <span className="mt-1 border-t pt-2 font-medium">Parameters</span>
      <p className="-mt-1 text-muted-foreground">
        The game sets them at each frame: a value forced here holds until it
        does.
      </p>
      {parameters.map((parameter) => {
        const value = animation.parameters[parameter.name];
        return (
          <div
            key={parameter.name}
            className="grid grid-cols-[5rem_1fr] items-center gap-2"
          >
            <span className="truncate text-muted-foreground">
              {parameter.name}
            </span>
            {parameter.type === 'number' ? (
              <Field
                type="number"
                label={`Parameter ${parameter.name}`}
                value={String(Math.round(Number(value ?? 0) * 100) / 100)}
                onCommit={(text) => {
                  const number = Number(text);
                  if (Number.isFinite(number)) force(parameter.name, number);
                }}
              />
            ) : parameter.type === 'boolean' ? (
              <input
                type="checkbox"
                aria-label={`Parameter ${parameter.name}`}
                className="size-3.5"
                checked={value === true}
                onChange={(event) =>
                  force(parameter.name, event.target.checked)
                }
              />
            ) : (
              <Button
                variant="outline"
                size="xs"
                onClick={() => force(parameter.name, true)}
              >
                Fire {value === true && '(waiting)'}
              </Button>
            )}
          </div>
        );
      })}
      <span className="mt-1 border-t pt-2 font-medium">State machines</span>
      {Object.entries(animation.machines).map(([id, machine]) => (
        <p key={id}>
          <span className="text-muted-foreground">
            {view.nodes.find((n) => n.id === id)?.title ?? id}:
          </span>{' '}
          {machine.state}
          {machine.next &&
            ` → ${machine.next} (${Math.round(machine.progress * 100)}%)`}
        </p>
      ))}
    </div>
  );
}

/** Called by the editor at the first activation event of the plugin. */
export function activate(context: PluginContext): void {
  const client = new GraphClient(
    context.services.get(IEngineConnection),
    animationGraphView,
    'animation',
  );
  context.subscriptions.push({ dispose: () => client.dispose() });
  context.commands.register(showAnimationGraphCommand, () =>
    context.services.get(IWorkbench).openView(animationGraphView),
  );
  const remembered = () =>
    (context.state.get() as { target?: string } | undefined)?.target;
  context.views.registerComponent(
    animationGraphView,
    function AnimationPanel() {
      // The state machine opened, its state or transition selected.
      const [opened, setOpened] = useState<string>();
      const [item, setItem] = useState<string>();
      const machineOf = (ctx: GraphPanelContext) => {
        const id =
          opened ??
          (ctx.node?.type === 'anim.stateMachine' ? ctx.node.id : undefined);
        return ctx.view.nodes.find(
          (n) => n.id === id && n.type === 'anim.stateMachine',
        );
      };
      return (
        <GraphPanel
          client={client}
          title="Animation graph"
          extension=".animation.json"
          accepts={(from, to) => from === to}
          tabs={[
            {
              id: 'play',
              title: 'Play',
              render: (ctx) => <PlayTab context={ctx} />,
            },
            {
              id: 'machine',
              title: 'State machine',
              render: (ctx) => (
                <MachineTab
                  context={ctx}
                  node={machineOf(ctx)}
                  {...(item !== undefined && { selected: item })}
                  onSelect={setItem}
                />
              ),
            },
          ]}
          overlay={(ctx) => animationOverlay(ctx.state.animation)}
          override={(ctx) => {
            const machine = opened
              ? ctx.view.nodes.find((n) => n.id === opened)
              : undefined;
            return machine ? (
              <StateMachineView
                context={ctx}
                node={machine}
                {...(item !== undefined && { selected: item })}
                onSelect={setItem}
                onClose={() => {
                  setOpened(undefined);
                  setItem(undefined);
                }}
              />
            ) : undefined;
          }}
          onOpenNode={(node) => {
            if (node.type === 'anim.stateMachine') setOpened(node.id);
          }}
          hiddenParams={(node) =>
            node.type === 'anim.stateMachine' ? machineParams : []
          }
          {...(remembered() !== undefined && { initialTarget: remembered() })}
          onTargetShown={(target) => {
            if (target !== undefined) context.state.set({ target });
          }}
        />
      );
    },
  );
}
