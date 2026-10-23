import { Button } from '../components/ui/button';
import {
  useEditor,
  useEditorMachine,
  useEngine,
  useItems,
} from '../editorContext';
import { docks, toolbarSides, type DockId, type ToolbarSide } from '../layout';
import type { MenuItem, PluginManifest } from '../plugins/manifest';
import type { EditorPlugin, PluginContext } from '../plugins/pluginHost';
import { objectMode, toolSlots } from '../state/editorMachine';
import {
  IEditorMachine,
  IEditorStore,
  IToolbarRegistry,
  IViewRegistry,
  IWorkbench,
} from '../state/runtime';
import type { IDisposable } from '../state/services';
import { toolbarLayout } from '../toolbarLayout';

const dockTitles: Readonly<Record<DockId, string>> = {
  left: 'Left dock',
  right: 'Right dock',
  bottom: 'Bottom dock',
};

const sideTitles: Readonly<Record<ToolbarSide, string>> = {
  top: 'Top',
  left: 'Left',
  right: 'Right',
  bottom: 'Bottom',
};

const dockCommand = (dock: DockId) => `workbench.dock.${dock}.toggle`;

const manifest = {
  id: 'fdw.workbench',
  title: 'Workbench',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'The View menu, the docks, the status bar, the command palette; the welcome page and the list of the plugins.',
  activationEvents: ['onStartup'],
  contributes: {
    commands: [
      {
        id: 'workbench.commandPalette',
        title: 'Command palette',
        category: 'View',
        icon: 'command',
      },
      ...docks.map((dock) => ({
        id: dockCommand(dock),
        title: dockTitles[dock],
        category: 'View',
        icon: `panel-${dock}`,
        toggled: `workbench.dock.${dock}`,
      })),
      {
        id: 'workbench.statusBar.toggle',
        title: 'Status bar',
        category: 'View',
        toggled: 'workbench.statusBar',
      },
      {
        id: 'workbench.resetLayout',
        title: 'Reset layout',
        category: 'View',
        icon: 'reset',
      },
      {
        id: 'workbench.view.toggle',
        title: 'Show or hide a panel',
        palette: false,
      },
      {
        id: 'workbench.toolbar.place',
        title: 'Place a toolbar',
        palette: false,
      },
      {
        id: 'editor.cancel',
        title: 'Cancel the tools',
        category: 'Editor',
        icon: 'x',
        enablement: 'editor.toolActive',
      },
    ],
    views: [
      { id: 'welcome', title: 'Welcome', icon: 'home', location: 'center' },
      { id: 'plugins', title: 'Plugins', icon: 'puzzle', location: 'left' },
    ],
    menus: {
      menubar: [{ submenu: 'menubar.view', title: 'View', order: 10 }],
      // The panels, in 3_panels, and the toolbars come from the registries.
      'menubar.view': [
        { command: 'workbench.commandPalette', group: '1_palette' },
        ...docks.map((dock) => ({
          command: dockCommand(dock),
          group: '2_docks',
        })),
        {
          submenu: 'menubar.view.toolbars',
          title: 'Toolbars',
          group: '4_chrome',
        },
        { command: 'workbench.statusBar.toggle', group: '4_chrome' },
        { command: 'workbench.resetLayout', group: '5_reset' },
      ],
    },
    toolbars: [
      {
        id: 'workbench.docks',
        title: 'Docks',
        side: 'top',
        items: docks.map(dockCommand),
      },
    ],
    statusBar: [
      { id: 'workbench.engine', alignment: 'left', priority: 100 },
      { id: 'workbench.editing', alignment: 'right', priority: 50 },
      { id: 'workbench.about', alignment: 'right', priority: 100 },
    ],
    keybindings: [
      { command: 'workbench.commandPalette', key: 'ctrl+shift+p' },
      { command: 'workbench.commandPalette', key: 'f1' },
      { command: 'editor.cancel', key: 'escape', when: 'editor.toolActive' },
    ],
  },
} as const satisfies PluginManifest;

function WelcomePanel() {
  const { host } = useEditor();
  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-2 text-base font-semibold">FDW Editor</h1>
      <p className="text-muted-foreground">
        Drag the tabs to split the central area or a dock; the View menu shows
        and hides the docks, the panels and the toolbars. Ctrl+Shift+P opens the
        command palette.
      </p>
      <p className="mt-4 text-xs text-muted-foreground">{host.about}</p>
    </div>
  );
}

const statusTitles = {
  inactive: 'Inactive',
  activating: 'Activating…',
  active: 'Active',
  failed: 'Failed',
  disabled: 'Disabled',
  invalid: 'Invalid',
} as const;

// The plugins, their state; those not built in disabled and enabled.
function PluginsPanel() {
  const { plugins } = useEditor();
  const infos = useItems(plugins);
  return (
    <ul className="h-full overflow-auto p-2 text-xs">
      {infos.map((info, index) => (
        <li
          key={`${info.id}#${index}`}
          className="flex items-start gap-2 border-b py-1.5 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {info.title}{' '}
              <span className="text-muted-foreground">{info.version}</span>
            </div>
            <div className="text-muted-foreground">
              {info.id} · {statusTitles[info.status]}
              {info.builtin && ' · built in'}
            </div>
            {info.error && <div className="text-destructive">{info.error}</div>}
          </div>
          {!info.builtin && info.status !== 'invalid' && (
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                info.status === 'disabled' || info.status === 'failed'
                  ? plugins.enable(info.id)
                  : void plugins.disable(info.id)
              }
            >
              {info.status === 'disabled' || info.status === 'failed'
                ? 'Enable'
                : 'Disable'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

// The backend, the device, the frames.
function EngineStatus() {
  const { device, backend, fallback, loading, stats, error } = useEngine();
  return (
    <>
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : (
        <span>
          {device ? `${backend} · ${device}` : 'Starting the engine…'}
          {stats &&
            ` · ${stats.fps} fps · ${stats.width} × ${stats.height}${
              stats.info ? ` · ${stats.info}` : ''
            }`}
        </span>
      )}
      {loading && <span className="text-muted-foreground">Loading…</span>}
      {fallback && (
        <span className="text-amber-500" title={fallback}>
          Fallback: {fallback}
        </span>
      )}
    </>
  );
}

// The mode and the tools active, by their titles.
function EditingStatus() {
  const { tools, modes } = useEditor();
  const mode = useEditorMachine((snapshot) => snapshot.context.mode);
  const active = useEditorMachine((snapshot) => snapshot.context.tools);
  const toolTitles = toolSlots.flatMap((slot) => {
    const id = active[slot];
    return id ? [tools.get(id)?.title ?? id] : [];
  });
  return (
    <span className="text-muted-foreground">
      {mode === objectMode ? 'Object' : (modes.get(mode)?.title ?? mode)} mode
      {toolTitles.length > 0 && ` · ${toolTitles.join(', ')}`}
    </span>
  );
}

function AboutStatus() {
  const { host } = useEditor();
  return <span className="text-muted-foreground">{host.about}</span>;
}

// Items made again at each change of a registry: disposes the previous ones.
function rebuilt(
  context: PluginContext,
  make: () => readonly (readonly [string, MenuItem])[],
): () => void {
  let items: IDisposable[] = [];
  return () => {
    items.forEach((item) => item.dispose());
    items = make().map(([menu, item]) => context.menus.append(menu, item));
  };
}

function activate(context: PluginContext): void {
  const { services, commands } = context;
  const editor = services.get(IEditorStore);
  const workbench = services.get(IWorkbench);
  const views = services.get(IViewRegistry);
  const toolbars = services.get(IToolbarRegistry);

  context.views.registerComponent('welcome', WelcomePanel);
  context.views.registerComponent('plugins', PluginsPanel);
  context.statusBar.registerComponent('workbench.engine', EngineStatus);
  context.statusBar.registerComponent('workbench.editing', EditingStatus);
  context.statusBar.registerComponent('workbench.about', AboutStatus);

  commands.register('workbench.commandPalette', () =>
    workbench.setPalette(!workbench.paletteOpen()),
  );
  for (const dock of docks) {
    commands.register(dockCommand(dock), () =>
      editor.trigger.setDock({
        dock,
        shown: !editor.getSnapshot().context.docks[dock],
      }),
    );
  }
  commands.register('workbench.statusBar.toggle', () =>
    editor.trigger.setStatusBar({
      shown: !editor.getSnapshot().context.statusBar,
    }),
  );
  commands.register('workbench.resetLayout', () => workbench.resetLayout());
  commands.register('workbench.view.toggle', (id) => {
    if (typeof id === 'string') workbench.toggleView(id);
  });
  commands.register('workbench.toolbar.place', (id, side) => {
    const toolbar = typeof id === 'string' ? toolbars.get(id) : undefined;
    if (!toolbar) return;
    const layout = toolbarLayout(editor.getSnapshot().context, toolbar);
    editor.trigger.setToolbar({
      id: toolbar.id,
      layout: toolbarSides.includes(side as ToolbarSide)
        ? { side: side as ToolbarSide, visible: true }
        : { ...layout, visible: false },
    });
  });
  commands.register('editor.cancel', () =>
    services.get(IEditorMachine).send({ type: 'EDITOR.CANCEL' }),
  );

  // The panels in the View menu, and the toolbars with their sides.
  const viewItems = rebuilt(context, () =>
    views.all().map((view) => [
      'menubar.view',
      {
        command: 'workbench.view.toggle',
        args: [view.id],
        title: view.title,
        toggled: `view.${view.id}.open`,
        group: '3_panels',
        ...(view.when && { when: view.when }),
      },
    ]),
  );
  const toolbarItems = rebuilt(context, () =>
    toolbars.all().flatMap((toolbar) => {
      const submenu = `menubar.view.toolbar.${toolbar.id}`;
      return [
        ['menubar.view.toolbars', { submenu, title: toolbar.title }] as const,
        ...[...toolbarSides, 'hidden' as const].map(
          (side) =>
            [
              submenu,
              {
                command: 'workbench.toolbar.place',
                args: [toolbar.id, side],
                title: side === 'hidden' ? 'Hidden' : sideTitles[side],
                toggled: `toolbar.${toolbar.id} == ${side}`,
                radio: true,
                ...(side === 'hidden' && { group: 'hidden' }),
              },
            ] as const,
        ),
      ];
    }),
  );
  viewItems();
  toolbarItems();
  context.subscriptions.push(
    { dispose: views.subscribe(viewItems) },
    { dispose: toolbars.subscribe(toolbarItems) },
  );
}

/** The workbench: the chrome of the editor, as a plugin. */
export const workbenchPlugin: EditorPlugin = {
  manifest,
  load: () => ({ activate }),
};
