import {
  Button,
  IEditorMachine,
  IWorkbench,
  toolActor,
  useEditorMachine,
  usePluginState,
  useToolSnapshot,
  type PluginContext,
} from '@fdw/editor-ui';
import { assign, createMachine } from 'xstate';
import { markTool, sampleId } from './manifest';

/** The state of the plugin, kept with the layout (`ctx.state`). */
export interface SampleState {
  /** The marks of the tools finished. */
  readonly placed: number;
  readonly notes: string;
}

function readState(value: unknown): SampleState {
  const state = (value ?? {}) as Partial<SampleState>;
  return {
    placed: typeof state.placed === 'number' ? state.placed : 0,
    notes: typeof state.notes === 'string' ? state.notes : '',
  };
}

type MarkEvent = { type: 'MARK.ADD' } | { type: 'MARK.FINISH' };

/**
 * The machine of the tool: it counts the marks added until finished, its
 * context kept with the layout; finished, its marks are added to the state
 * of the plugin, and its slot goes back to idle.
 */
function markMachine(finished: (marks: number) => void) {
  return createMachine({
    id: markTool,
    types: {} as { context: { marks: number }; events: MarkEvent },
    context: { marks: 0 },
    initial: 'placing',
    states: {
      placing: {
        on: {
          'MARK.ADD': {
            actions: assign({ marks: ({ context }) => context.marks + 1 }),
          },
          'MARK.FINISH': 'finished',
        },
      },
      finished: {
        type: 'final',
        entry: ({ context }) => finished(context.marks),
      },
    },
  });
}

function MarksPanel({ context }: { readonly context: PluginContext }) {
  const state = readState(usePluginState(sampleId));
  const marking = useEditorMachine(
    (snapshot) => snapshot.context.tools.primary === markTool,
  );
  const tool = useToolSnapshot('primary') as
    { context?: { marks?: number } } | undefined;
  const marks = marking ? (tool?.context?.marks ?? 0) : undefined;
  const run = (command: string) => void context.commands.execute(command);
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
      <p>
        {marks === undefined
          ? 'The Mark tool is not active.'
          : `Marking: ${marks} mark${marks === 1 ? '' : 's'}.`}
      </p>
      <div className="flex gap-1">
        <Button variant="outline" size="xs" onClick={() => run(markTool)}>
          {marking ? 'Stop marking' : 'Mark'}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!marking}
          onClick={() => run(`${sampleId}.addMark`)}
        >
          Add a mark
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!marking}
          onClick={() => run(`${sampleId}.finish`)}
        >
          Finish
        </Button>
      </div>
      <p className="text-muted-foreground">Marks placed: {state.placed}</p>
      <label className="flex flex-1 flex-col gap-1">
        Notes
        <textarea
          className="min-h-16 flex-1 rounded-md border bg-transparent p-1.5"
          value={state.notes}
          onChange={(event) =>
            context.state.set({ ...state, notes: event.target.value })
          }
        />
      </label>
    </div>
  );
}

// The marks of the tool while it is active, then those placed.
function MarksStatus() {
  const { placed } = readState(usePluginState(sampleId));
  const marking = useEditorMachine(
    (snapshot) => snapshot.context.tools.primary === markTool,
  );
  const tool = useToolSnapshot('primary') as
    { context?: { marks?: number } } | undefined;
  if (marking) {
    const marks = tool?.context?.marks ?? 0;
    return (
      <span className="text-amber-500">
        Marking: {marks} mark{marks === 1 ? '' : 's'} (M adds, Ctrl+Enter
        finishes)
      </span>
    );
  }
  return <span className="text-muted-foreground">{placed} marks placed</span>;
}

/** Called by the editor at the first activation event of the plugin. */
export function activate(context: PluginContext): void {
  // The services of the editor read at the call: the machine is made once
  // the plugins of the start have registered their tools.
  const { services } = context;
  const send = (event: MarkEvent) =>
    toolActor(services.get(IEditorMachine), 'primary')?.send(event);

  context.tools.register(markTool, () =>
    markMachine((marks) => {
      const state = readState(context.state.get());
      context.state.set({ ...state, placed: state.placed + marks });
    }),
  );
  context.commands.register(`${sampleId}.addMark`, () =>
    send({ type: 'MARK.ADD' }),
  );
  context.commands.register(`${sampleId}.finish`, () =>
    send({ type: 'MARK.FINISH' }),
  );
  context.commands.register(`${sampleId}.showMarks`, () =>
    services.get(IWorkbench).openView(`${sampleId}.marks`),
  );
  context.views.registerComponent(`${sampleId}.marks`, () => (
    <MarksPanel context={context} />
  ));
  context.statusBar.registerComponent(`${sampleId}.status`, MarksStatus);
}
