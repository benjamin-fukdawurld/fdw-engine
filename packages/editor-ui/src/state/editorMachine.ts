import {
  assign,
  createActor,
  enqueueActions,
  assertEvent,
  setup,
  stopChild,
  type Actor,
  type AnyActorLogic,
  type AnyActorRef,
  type Snapshot,
} from 'xstate';
import type { AreaId } from '../layout';
import type { ContextKeyValues } from './when';

/** A slot of tools: one tool at a time in each, independent of the others. */
export type SlotId = 'primary' | 'secondary';

/** The slots, by priority: the inputs go to their tools in this order. */
export const toolSlots: readonly SlotId[] = ['primary', 'secondary'];

/** The mode of the core, without a machine. */
export const objectMode = 'object';

/** What a tool is given (design/editor-state.md §3): never the root machine. */
export interface ToolContext {
  readonly slot: SlotId;
  /** The context keys of the editor, read at the call. */
  keys(): ContextKeyValues;
  /** Ends the tool, its work done: its slot goes back to idle. */
  done(): void;
  /** Ends the tool, its work abandoned. */
  cancel(): void;
}

/**
 * A tool: a machine of a plugin, made when activated in its slot. Its
 * context stays JSON (persisted with the layout); its services come from
 * the closure of `create`.
 */
export interface ToolSpec {
  readonly id: string;
  readonly title: string;
  readonly slot: SlotId;
  /** The clause on the context keys under which it may be activated. */
  readonly when?: string;
  create(context: ToolContext): AnyActorLogic;
}

export interface ModeContext {
  keys(): ContextKeyValues;
  /** Goes back to the object mode. */
  exit(): void;
}

/** A mode of editing; a machine of a plugin while it is the mode, if any. */
export interface ModeSpec {
  readonly id: string;
  readonly title: string;
  readonly when?: string;
  create?(context: ModeContext): AnyActorLogic;
}

/** The view that has the focus, and its area. */
export interface EditorFocus {
  readonly area?: AreaId;
  readonly view?: string;
}

export interface EditorMachineContext {
  readonly focus: EditorFocus;
  readonly mode: string;
  /** The tool of each active slot. */
  readonly tools: Readonly<Partial<Record<SlotId, string>>>;
}

/** The events of the core. */
export type EditorEvent =
  | { type: 'FOCUS.VIEW'; area: AreaId; view?: string }
  | { type: 'FOCUS.WINDOW'; focused: boolean }
  | { type: 'MODE.SET'; mode: string }
  | { type: 'MODE.REMOVED'; mode: string }
  | { type: 'TOOL.ACTIVATE'; tool: string }
  | { type: 'TOOL.DEACTIVATE'; slot: SlotId }
  | { type: 'TOOL.REMOVED'; tool: string }
  /** Escape: ends the tools of every slot. */
  | { type: 'EDITOR.CANCEL' }
  | { type: 'EDITOR.TOOL_DONE'; slot: SlotId }
  | { type: 'EDITOR.TOOL_CANCEL'; slot: SlotId };

/**
 * The reserved events the core forwards to the tools and the mode, once
 * it has handled them.
 */
export type ToolEvent =
  | { type: 'EDITOR.BLUR' }
  | { type: 'EDITOR.VIEW'; area: AreaId; view?: string };

const toolChild = (slot: SlotId) => `tool.${slot}`;
const modeChild = 'mode';

const editorSetup = setup({
  types: {
    context: {} as EditorMachineContext,
    events: {} as EditorEvent,
  },
  // None: the tools and the modes come from the registries. Typed as any
  // logic, else xstate refuses an id to the logic of a child.
  actors: {} as Record<string, AnyActorLogic>,
  // Implemented by startEditor, from the registries: typed here.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  guards: {
    toolAllowed: (_, _params: { slot: SlotId }) => false,
    modeAllowed: () => false,
  },
  actions: {
    startTool: (_, _params: { slot: SlotId }) => undefined,
    startMode: () => undefined,
  },
  /* eslint-enable @typescript-eslint/no-unused-vars */
});

// Sends the reserved events to the tools and the mode, once handled.
const forward = editorSetup.enqueueActions(({ event, enqueue, self }) => {
  const forwarded: ToolEvent | undefined =
    event.type === 'FOCUS.WINDOW'
      ? { type: 'EDITOR.BLUR' }
      : event.type === 'FOCUS.VIEW'
        ? { type: 'EDITOR.VIEW', area: event.area, view: event.view }
        : undefined;
  if (!forwarded) return;
  // A mode may have no machine, and sendTo throws without the child.
  const { children } = self.getSnapshot();
  for (const id of [...toolSlots.map(toolChild), modeChild]) {
    if (id in children) enqueue.sendTo(id, forwarded);
  }
});

// The region of a slot: idle, or a tool of a plugin as a child actor.
// The transitions are on its states: one from the region, reentering it,
// would leave every region (the domain of a transition skips the parallel
// states).
function slotRegion(slot: SlotId) {
  const ofSlot = ({ event }: { event: EditorEvent }) =>
    'slot' in event && event.slot === slot;
  // Another tool of the slot ends the one active.
  const activate = {
    guard: { type: 'toolAllowed', params: { slot } },
    target: 'active',
    reenter: true,
    actions: editorSetup.assign(({ context, event }) => {
      assertEvent(event, 'TOOL.ACTIVATE');
      return { tools: { ...context.tools, [slot]: event.tool } };
    }),
  } as const;
  return editorSetup.createStateConfig({
    initial: 'idle',
    states: {
      idle: {
        entry: editorSetup.assign(({ context }) => ({
          tools: { ...context.tools, [slot]: undefined },
        })),
        on: { 'TOOL.ACTIVATE': activate },
      },
      active: {
        entry: { type: 'startTool', params: { slot } },
        exit: editorSetup.stopChild(toolChild(slot)),
        on: {
          'TOOL.ACTIVATE': activate,
          'EDITOR.TOOL_DONE': { guard: ofSlot, target: 'idle' },
          'EDITOR.TOOL_CANCEL': { guard: ofSlot, target: 'idle' },
          'TOOL.DEACTIVATE': { guard: ofSlot, target: 'idle' },
          'TOOL.REMOVED': {
            guard: ({ context, event }) => context.tools[slot] === event.tool,
            target: 'idle',
          },
          'EDITOR.CANCEL': 'idle',
          [`xstate.done.actor.${toolChild(slot)}`]: 'idle',
        },
      },
    },
  });
}

// The modes, on the states of the region (see slotRegion).
const setMode = editorSetup.createStateConfig({
  on: {
    'MODE.SET': [
      {
        guard: ({ event }) => event.mode === objectMode,
        target: 'object',
      },
      {
        guard: 'modeAllowed',
        target: 'plugin',
        reenter: true,
        actions: assign(({ event }) => ({ mode: event.mode })),
      },
    ],
  },
}).on;

/**
 * The machine of the editor (design/editor-state.md §3), fixed and minimal:
 * the focus, the mode, the slots of tools, in parallel. The tools and the
 * modes of the plugins are child actors; the core names the guards and
 * the actions that the runtime implements (`startEditor`): it never
 * changes for a plugin.
 */
export const editorMachine = editorSetup.createMachine({
  id: 'editor',
  type: 'parallel',
  context: { focus: {}, mode: objectMode, tools: {} },
  on: {
    'FOCUS.VIEW': {
      actions: [
        assign(({ event }) => ({
          focus: { area: event.area, view: event.view },
        })),
        forward,
      ],
    },
  },
  states: {
    window: {
      initial: 'focused',
      states: {
        focused: {
          on: {
            'FOCUS.WINDOW': {
              guard: ({ event }) => !event.focused,
              target: 'blurred',
              actions: forward,
            },
          },
        },
        blurred: {
          on: {
            'FOCUS.WINDOW': {
              guard: ({ event }) => event.focused,
              target: 'focused',
            },
          },
        },
      },
    },
    mode: {
      initial: 'object',
      states: {
        object: { entry: assign({ mode: objectMode }), on: setMode },
        plugin: {
          entry: 'startMode',
          exit: stopChild(modeChild),
          on: {
            ...setMode,
            'MODE.REMOVED': {
              guard: ({ context, event }) => context.mode === event.mode,
              target: 'object',
            },
            [`xstate.done.actor.${modeChild}`]: 'object',
          },
        },
      },
    },
    slots: {
      type: 'parallel',
      states: {
        primary: slotRegion('primary'),
        secondary: slotRegion('secondary'),
      },
    },
  },
});

export type EditorActor = Actor<typeof editorMachine>;

/** The actor of the tool active in the slot; undefined if it is idle. */
export function toolActor(
  actor: EditorActor,
  slot: SlotId,
): AnyActorRef | undefined {
  const children: Record<string, AnyActorRef | undefined> =
    actor.getSnapshot().children;
  return children[toolChild(slot)];
}

/** What the core asks of the registries. */
export interface EditorResolver {
  tool(id: string): ToolSpec | undefined;
  mode(id: string): ModeSpec | undefined;
  /** Whether the context keys satisfy the clause; true without one. */
  matches(when: string | undefined): boolean;
  keys(): ContextKeyValues;
}

function toolLogic(
  resolver: EditorResolver,
  spec: ToolSpec,
  slot: SlotId,
  send: (event: EditorEvent) => void,
): AnyActorLogic {
  return spec.create({
    slot,
    keys: () => resolver.keys(),
    done: () => send({ type: 'EDITOR.TOOL_DONE', slot }),
    cancel: () => send({ type: 'EDITOR.TOOL_CANCEL', slot }),
  });
}

// Only modes with a machine are in the plugin state.
function modeLogic(
  resolver: EditorResolver,
  spec: ModeSpec,
  send: (event: EditorEvent) => void,
): AnyActorLogic | undefined {
  return spec.create?.({
    keys: () => resolver.keys(),
    exit: () => send({ type: 'MODE.SET', mode: objectMode }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The value as JSON, or undefined if it does not go through JSON.
function toJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/**
 * The state of the editor to keep (design/editor-state.md §6), as JSON:
 * the persisted snapshot of XState, its children persisted one by one with
 * the id of their tool or mode as their source (XState does not persist an
 * inline child). A child that does not go through JSON is left out: it
 * restores as idle.
 */
export function persistEditor(actor: EditorActor): unknown {
  const snapshot = actor.getSnapshot();
  const { context } = snapshot;
  const sources: Record<string, string | undefined> = {
    [modeChild]: context.mode,
    ...Object.fromEntries(
      toolSlots.map((slot) => [toolChild(slot), context.tools[slot]]),
    ),
  };
  const children: Record<string, unknown> = {};
  for (const [id, child] of Object.entries(snapshot.children)) {
    const source = sources[id];
    if (!child || !source) continue;
    let persisted: unknown;
    try {
      persisted = child.getPersistedSnapshot();
    } catch {
      continue;
    }
    const json = toJson({ snapshot: persisted, src: source });
    if (json) children[id] = json;
  }
  const root = actor.logic.getPersistedSnapshot({
    ...snapshot,
    children: {},
  }) as Record<string, unknown>;
  return toJson({ ...root, children });
}

/**
 * The events of the plugins that a state kept by `persistEditor` needs:
 * those of its tools and of its mode (`onTool:id`, `onMode:id`), for their
 * plugins to register them before the machine restores.
 */
export function savedEditorEvents(saved: unknown): string[] {
  if (!isRecord(saved) || !isRecord(saved['context'])) return [];
  const { tools, mode } = saved['context'];
  return [
    ...(isRecord(tools)
      ? Object.values(tools).flatMap((id) =>
          typeof id === 'string' ? [`onTool:${id}`] : [],
        )
      : []),
    ...(typeof mode === 'string' && mode !== objectMode
      ? [`onMode:${mode}`]
      : []),
  ];
}

// The persisted snapshot, with the logic of its children back from the
// registries; a tool or a mode no more registered goes back to idle.
function restoreEditor(
  saved: unknown,
  resolver: EditorResolver,
  send: (event: EditorEvent) => void,
): Snapshot<unknown> | undefined {
  if (!isRecord(saved)) return undefined;
  const { value, context, children } = saved;
  if (!isRecord(value) || !isRecord(context) || !isRecord(children)) {
    return undefined;
  }
  const restored: Record<string, unknown> = {};
  const slotsValue: Record<string, unknown> = {
    ...(isRecord(value['slots']) ? value['slots'] : {}),
  };
  const savedTools = isRecord(context['tools']) ? context['tools'] : {};
  const tools: Partial<Record<SlotId, string>> = {};
  for (const slot of toolSlots) {
    const id = savedTools[slot];
    const spec = typeof id === 'string' ? resolver.tool(id) : undefined;
    const child = children[toolChild(slot)];
    if (
      spec?.slot === slot &&
      slotsValue[slot] === 'active' &&
      isRecord(child)
    ) {
      tools[slot] = spec.id;
      restored[toolChild(slot)] = {
        ...child,
        src: toolLogic(resolver, spec, slot, send),
      };
    } else {
      slotsValue[slot] = 'idle';
    }
  }
  const savedMode = context['mode'];
  const modeSpec =
    typeof savedMode === 'string' ? resolver.mode(savedMode) : undefined;
  const modeChildSaved = children[modeChild];
  let mode = objectMode;
  if (modeSpec && value['mode'] === 'plugin') {
    // A mode with a machine needs its child.
    if (!modeSpec.create) mode = modeSpec.id;
    else if (isRecord(modeChildSaved)) {
      const logic = modeLogic(resolver, modeSpec, send);
      restored[modeChild] = { ...modeChildSaved, src: logic };
      mode = modeSpec.id;
    }
  }
  const focus = isRecord(context['focus']) ? context['focus'] : {};
  return {
    ...saved,
    value: {
      ...value,
      mode: mode === objectMode ? 'object' : 'plugin',
      slots: slotsValue,
    },
    context: {
      focus: {
        ...(typeof focus['area'] === 'string' && { area: focus['area'] }),
        ...(typeof focus['view'] === 'string' && { view: focus['view'] }),
      },
      mode,
      tools,
    },
    children: restored,
  } as unknown as Snapshot<unknown>;
}

/**
 * Starts the machine of the editor on the registries, from the state kept
 * by `persistEditor` if given: the default state if it does not restore.
 */
export function startEditor(
  resolver: EditorResolver,
  saved?: unknown,
): EditorActor {
  let actor: EditorActor | undefined;
  const send = (event: EditorEvent) => actor?.send(event);
  const machine = editorMachine.provide({
    guards: {
      toolAllowed: ({ event }, { slot }) => {
        if (event.type !== 'TOOL.ACTIVATE') return false;
        const spec = resolver.tool(event.tool);
        return spec?.slot === slot && resolver.matches(spec.when);
      },
      modeAllowed: ({ event }) => {
        if (event.type !== 'MODE.SET') return false;
        const spec = resolver.mode(event.mode);
        return spec !== undefined && resolver.matches(spec.when);
      },
    },
    actions: {
      startTool: enqueueActions(({ context, enqueue }, { slot }) => {
        const id = context.tools[slot];
        const spec = id ? resolver.tool(id) : undefined;
        if (!spec) return;
        enqueue.spawnChild(toolLogic(resolver, spec, slot, send), {
          id: toolChild(slot),
          input: { slot },
        });
      }),
      startMode: enqueueActions(({ context, enqueue }) => {
        const spec = resolver.mode(context.mode);
        const logic = spec && modeLogic(resolver, spec, send);
        if (logic) enqueue.spawnChild(logic, { id: modeChild });
      }),
    },
  });
  const snapshot =
    saved === undefined ? undefined : restoreEditor(saved, resolver, send);
  if (snapshot) {
    try {
      actor = createActor(machine, { snapshot });
      actor.start();
      return actor;
    } catch (error) {
      console.warn('[editor] The state of the editor does not restore:', error);
    }
  }
  actor = createActor(machine);
  actor.start();
  return actor;
}
