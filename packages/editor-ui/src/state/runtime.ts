import type { EditorHost, EngineConnection } from '../host';
import type { Layout } from '../layout';
import { createContextKeys, type ContextKeys } from './contextKeys';
import {
  persistEditor,
  startEditor,
  toolSlots,
  type EditorActor,
  type ModeSpec,
  type ToolSpec,
} from './editorMachine';
import { createEditorStore, type EditorStore } from './editorStore';
import type { EngineStore } from './engineStore';
import { Registry } from './registry';
import { serviceId, ServiceRegistry, type IDisposable } from './services';

export const IEditorHost = serviceId<EditorHost>('editor.host');
export const IEngineConnection =
  serviceId<EngineConnection>('engine.connection');
export const IEngineStore = serviceId<EngineStore>('engine.store');
export const IEditorStore = serviceId<EditorStore>('editor.store');
export const IEditorMachine = serviceId<EditorActor>('editor.machine');
export const IContextKeys = serviceId<ContextKeys>('editor.contextKeys');
export const IToolRegistry = serviceId<Registry<ToolSpec>>('editor.tools');
export const IModeRegistry = serviceId<Registry<ModeSpec>>('editor.modes');

/** The state of the editor kept with the layout. */
export type EditorState = Pick<
  Layout,
  'docks' | 'toolbars' | 'statusBar' | 'machine' | 'plugins'
>;

/**
 * The editor at run time: its services, its stores and its machine
 * (design/editor-state.md). Made by the shell once the layout is read; the
 * stores and the machine are also services, for the code out of React.
 */
export interface EditorRuntime extends IDisposable {
  readonly host: EditorHost;
  readonly services: ServiceRegistry;
  readonly engine: EngineStore;
  readonly editor: EditorStore;
  readonly machine: EditorActor;
  readonly keys: ContextKeys;
  readonly tools: Registry<ToolSpec>;
  readonly modes: Registry<ModeSpec>;
  /** The state to keep: the chrome, the machine, the plugins. */
  persist(): EditorState;
  /** Shows the scene in the viewport. */
  showScene(name: string): void;
}

export interface EditorRuntimeOptions {
  readonly host: EditorHost;
  /** The state of the engine, followed before the layout is read. */
  readonly engine: EngineStore;
  /** The state kept by `persist`. */
  readonly saved?: Partial<EditorState>;
}

export function createEditorRuntime({
  host,
  engine,
  saved = {},
}: EditorRuntimeOptions): EditorRuntime {
  const services = new ServiceRegistry();
  services.register(IEditorHost, () => host);
  services.register(IEngineConnection, () => host.engine);
  services.register(IEngineStore, () => engine);
  services.register(IToolRegistry, () => new Registry<ToolSpec>('tool'));
  services.register(IModeRegistry, () => new Registry<ModeSpec>('mode'));
  services.register(IEditorStore, () =>
    createEditorStore({
      ...(saved.docks && { docks: saved.docks }),
      ...(saved.toolbars && { toolbars: saved.toolbars }),
      ...(saved.statusBar !== undefined && { statusBar: saved.statusBar }),
      ...(saved.plugins && { plugins: saved.plugins }),
    }),
  );
  services.register(
    IEditorMachine,
    (accessor) => {
      const tools = accessor.get(IToolRegistry);
      const modes = accessor.get(IModeRegistry);
      // Derived from the machine: read at the call, once both are made.
      const keys = () => accessor.get(IContextKeys);
      return startEditor(
        {
          tool: (id) => tools.get(id),
          mode: (id) => modes.get(id),
          matches: (when) => keys().matches(when),
          keys: () => keys().values(),
        },
        saved.machine,
      );
    },
    { dispose: (actor) => actor.stop() },
  );
  services.register(IContextKeys, (accessor) => {
    const machine = accessor.get(IEditorMachine);
    const editor = accessor.get(IEditorStore);
    const engine = accessor.get(IEngineStore);
    return createContextKeys([machine, editor, engine], () => {
      const state = machine.getSnapshot();
      const { selection } = editor.getSnapshot().context;
      const { backend, fallback } = engine.getSnapshot().context;
      return {
        'editor.focusedArea': state.context.focus.area,
        'editor.focusedView': state.context.focus.view,
        'editor.windowFocused': state.matches({ window: 'focused' }),
        'editor.mode': state.context.mode,
        ...Object.fromEntries(
          toolSlots.map((slot) => [`tool.${slot}`, state.context.tools[slot]]),
        ),
        'scene.hasSelection': selection.length > 0,
        'engine.ready': backend !== '',
        'engine.backend': backend || undefined,
        'engine.fallback': fallback !== undefined,
      };
    });
  });
  const tools = services.get(IToolRegistry);
  const modes = services.get(IModeRegistry);
  const editor = services.get(IEditorStore);
  const machine = services.get(IEditorMachine);
  const keys = services.get(IContextKeys);

  // A tool or a mode unregistered ends.
  const unsubscribe = [
    tools.subscribe(({ kind, item }) => {
      if (kind === 'remove')
        machine.send({ type: 'TOOL.REMOVED', tool: item.id });
    }),
    modes.subscribe(({ kind, item }) => {
      if (kind === 'remove')
        machine.send({ type: 'MODE.REMOVED', mode: item.id });
    }),
  ];

  return {
    host,
    services,
    engine,
    editor,
    machine,
    keys,
    tools,
    modes,
    persist: () => {
      const { docks, toolbars, statusBar, plugins } =
        editor.getSnapshot().context;
      return {
        docks,
        toolbars,
        statusBar,
        plugins,
        machine: persistEditor(machine),
      };
    },
    showScene: (name) => {
      engine.trigger.chooseScene({ scene: name });
      host.engine.post({ type: 'scene', name });
    },
    dispose: () => {
      unsubscribe.forEach((stop) => stop());
      services.dispose();
    },
  };
}
