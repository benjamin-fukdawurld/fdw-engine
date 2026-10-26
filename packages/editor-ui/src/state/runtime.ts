import type { EditorHost, EngineConnection } from '../host';
import type { Layout } from '../layout';
import {
  CommandService,
  MenuRegistry,
  type ComponentSpec,
  type KeybindingSpec,
  type StatusBarSpec,
  type ToolbarSpec,
  type ViewSpec,
} from '../plugins/contributions';
import { PluginHost, type PreparedPlugin } from '../plugins/pluginHost';
import { toolbarLayout } from '../toolbarLayout';
import { WorkbenchService } from '../workbenchService';
import {
  createContextKeys,
  type ContextKeys,
  type ContextKeySource,
} from './contextKeys';
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
import { createLevelStore, type LevelStore } from './levelStore';
import { Registry } from './registry';
import { serviceId, ServiceRegistry, type IDisposable } from './services';

export const IEditorHost = serviceId<EditorHost>('editor.host');
export const IEngineConnection =
  serviceId<EngineConnection>('engine.connection');
export const IEngineStore = serviceId<EngineStore>('engine.store');
export const ILevelStore = serviceId<LevelStore>('level.store');
export const IEditorStore = serviceId<EditorStore>('editor.store');
export const IEditorMachine = serviceId<EditorActor>('editor.machine');
export const IContextKeys = serviceId<ContextKeys>('editor.contextKeys');
export const IToolRegistry = serviceId<Registry<ToolSpec>>('editor.tools');
export const IModeRegistry = serviceId<Registry<ModeSpec>>('editor.modes');
export const ICommandService = serviceId<CommandService>('editor.commands');
export const IWorkbench = serviceId<WorkbenchService>('editor.workbench');
export const IPluginHost = serviceId<PluginHost>('editor.plugins');
export const IViewRegistry = serviceId<Registry<ViewSpec>>('editor.views');
export const IToolbarRegistry =
  serviceId<Registry<ToolbarSpec>>('editor.toolbars');

/** The state of the editor kept with the layout. */
export type EditorState = Pick<
  Layout,
  'docks' | 'toolbars' | 'statusBar' | 'machine' | 'plugins'
>;

/**
 * The editor at run time: its services, its stores and its machine
 * (design/editor-state.md), its plugins and the registries they fill
 * (design/editor-ui.md §6). Made by the shell once the layout is read; the
 * stores and the machine are also services, for the code out of React.
 */
export interface EditorRuntime extends IDisposable {
  readonly host: EditorHost;
  readonly services: ServiceRegistry;
  readonly engine: EngineStore;
  /** The projection of the level the engine edits. */
  readonly level: LevelStore;
  readonly editor: EditorStore;
  readonly machine: EditorActor;
  readonly keys: ContextKeys;
  readonly tools: Registry<ToolSpec>;
  readonly modes: Registry<ModeSpec>;
  readonly plugins: PluginHost;
  readonly commands: CommandService;
  readonly views: Registry<ViewSpec>;
  readonly viewComponents: Registry<ComponentSpec>;
  readonly menus: MenuRegistry;
  readonly toolbars: Registry<ToolbarSpec>;
  readonly statusBar: Registry<StatusBarSpec>;
  readonly statusComponents: Registry<ComponentSpec>;
  readonly keybindings: Registry<KeybindingSpec>;
  readonly workbench: WorkbenchService;
  /** The state to keep: the chrome, the machine, the plugins. */
  persist(): EditorState;
}

export interface EditorRuntimeOptions {
  readonly host: EditorHost;
  /** The state of the engine, followed before the layout is read. */
  readonly engine: EngineStore;
  /** The projection of its level, followed as well. */
  readonly level?: LevelStore;
  /** The state kept by `persist`. */
  readonly saved?: Partial<EditorState>;
  /**
   * The plugins, registered in this order; those whose code is loaded are
   * activated before the machine restores (`preparePlugins`).
   */
  readonly plugins?: readonly PreparedPlugin[];
}

// A source of the context keys from something that gives its unsubscription.
const keySource = (source: {
  subscribe(listener: () => void): () => void;
}): ContextKeySource => ({
  subscribe: (listener) => ({ unsubscribe: source.subscribe(listener) }),
});

export function createEditorRuntime({
  host,
  engine,
  level = createLevelStore(),
  saved = {},
  plugins = [],
}: EditorRuntimeOptions): EditorRuntime {
  const services = new ServiceRegistry();
  services.register(IEditorHost, () => host);
  services.register(IEngineConnection, () => host.engine);
  services.register(IEngineStore, () => engine);
  services.register(ILevelStore, () => level);
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
  // While the plugins loaded at the start activate: the machine is made
  // after, to restore their tools.
  let starting = false;
  services.register(
    IEditorMachine,
    (accessor) => {
      if (starting) {
        console.warn(
          '[editor] A plugin reads the machine of the editor (or the context keys) while the plugins activate: the tools kept may not restore. Read it at the call.',
        );
      }
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

  services.register(IViewRegistry, () => new Registry<ViewSpec>('view'));
  services.register(
    IToolbarRegistry,
    () => new Registry<ToolbarSpec>('toolbar'),
  );
  const views = services.get(IViewRegistry);
  const toolbars = services.get(IToolbarRegistry);
  const editor = services.get(IEditorStore);
  services.register(IWorkbench, () => new WorkbenchService(editor, views));
  const workbench = services.get(IWorkbench);
  services.register(IContextKeys, (accessor) => {
    const machine = accessor.get(IEditorMachine);
    const engine = accessor.get(IEngineStore);
    return createContextKeys(
      [
        machine,
        editor,
        engine,
        level,
        keySource(workbench),
        keySource(toolbars),
      ],
      () => {
        const state = machine.getSnapshot();
        const chrome = editor.getSnapshot().context;
        const { selection, docks, statusBar } = chrome;
        const { backend, fallback, rays, scene } = engine.getSnapshot().context;
        const document = level.getSnapshot().context;
        const tools = toolSlots.map((slot) => state.context.tools[slot]);
        return {
          'editor.focusedArea': state.context.focus.area,
          'editor.focusedView': state.context.focus.view,
          'editor.windowFocused': state.matches({ window: 'focused' }),
          'editor.mode': state.context.mode,
          'editor.toolActive': tools.some((tool) => tool !== undefined),
          ...Object.fromEntries(
            toolSlots.map((slot, index) => [`tool.${slot}`, tools[index]]),
          ),
          'scene.hasSelection': selection.length > 0,
          'engine.ready': backend !== '',
          'engine.backend': backend || undefined,
          'engine.fallback': fallback !== undefined,
          'engine.rays': rays,
          'engine.scene': scene || undefined,
          'level.open': document.name !== '',
          'level.dirty': document.dirty,
          'level.canUndo': document.undo !== undefined,
          'level.canRedo': document.redo !== undefined,
          'workbench.dock.left': docks.left,
          'workbench.dock.right': docks.right,
          'workbench.dock.bottom': docks.bottom,
          'workbench.statusBar': statusBar,
          ...Object.fromEntries(
            workbench.openViews().map((id) => [`view.${id}.open`, true]),
          ),
          ...Object.fromEntries(
            toolbars.all().map((toolbar) => {
              const layout = toolbarLayout(chrome, toolbar);
              return [
                `toolbar.${toolbar.id}`,
                layout.visible ? layout.side : 'hidden',
              ];
            }),
          ),
        };
      },
    );
  });
  const tools = services.get(IToolRegistry);
  const modes = services.get(IModeRegistry);

  const keys = () => services.get(IContextKeys);
  services.register(
    ICommandService,
    () =>
      new CommandService({
        activate: (event) => pluginHost.activateByEvent(event),
        matches: (when) => keys().matches(when),
      }),
  );
  const commands = services.get(ICommandService);
  const viewComponents = new Registry<ComponentSpec>('view component');
  const menus = new MenuRegistry();
  const statusBar = new Registry<StatusBarSpec>('status bar item');
  const statusComponents = new Registry<ComponentSpec>('status bar component');
  const keybindings = new Registry<KeybindingSpec>('keybinding');
  services.register(
    IPluginHost,
    () =>
      new PluginHost({
        services,
        commands,
        views,
        viewComponents,
        menus,
        toolbars,
        statusBar,
        statusComponents,
        keybindings,
        tools,
        modes,
        editor,
        machine: () => services.get(IEditorMachine),
        keys,
      }),
  );
  const pluginHost = services.get(IPluginHost);

  // The plugins before the machine: those loaded register their tools at
  // once, and the machine restores them.
  for (const { plugin, builtin, module } of plugins) {
    pluginHost.register(plugin, {
      ...(builtin && { builtin }),
      ...(module && { module }),
    });
  }
  starting = true;
  for (const { plugin, module } of plugins) {
    const { id } = plugin.manifest;
    if (module && typeof id === 'string') void pluginHost.activate(id);
  }
  starting = false;

  const machine = services.get(IEditorMachine);

  // The selection of the level, by ids, in the store of the editor.
  const select = () => {
    const { selection } = level.getSnapshot().context;
    if (selection !== editor.getSnapshot().context.selection) {
      editor.trigger.select({ ids: selection });
    }
  };
  select();
  const selection = level.subscribe(select);

  // A tool or a mode unregistered ends.
  const unsubscribe = [
    () => selection.unsubscribe(),
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
    level,
    editor,
    machine,
    keys: keys(),
    tools,
    modes,
    plugins: pluginHost,
    commands,
    views,
    viewComponents,
    menus,
    toolbars,
    statusBar,
    statusComponents,
    keybindings,
    workbench,
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
    dispose: () => {
      unsubscribe.forEach((stop) => stop());
      services.dispose();
    },
  };
}
