import { createMachine } from 'xstate';
import { useEditor, useSelector } from '../editorContext';
import type { FileFilter } from '../host';
import type { PluginManifest } from '../plugins/manifest';
import type { EditorPlugin, PluginContext } from '../plugins/pluginHost';
import {
  levelScene,
  type EngineMessage,
  type GizmoSettings,
  type LevelFormat,
  type LevelPrimitive,
  type LevelRendering,
  levelRenderings,
  type PageMessage,
  type ViewportTool,
} from '../protocol';
import type { EditorActor } from '../state/editorMachine';
import {
  IEditorHost,
  IEditorMachine,
  IEngineConnection,
  IEngineStore,
  ILevelStore,
} from '../state/runtime';
import type { IDisposable } from '../state/services';

const levelId = 'fdw.level';

/** The tools of the viewport, in the primary slot: the gizmo of each mode. */
const tools = {
  [`${levelId}.move`]: 'translate',
  [`${levelId}.rotate`]: 'rotate',
  [`${levelId}.scale`]: 'scale',
} as const satisfies Record<string, ViewportTool>;

const primitives: readonly (readonly [LevelPrimitive, string, string])[] = [
  ['empty', 'Empty node', 'square'],
  ['cube', 'Cube', 'box'],
  ['sphere', 'Sphere', 'circle'],
  ['light', 'Point light', 'lightbulb'],
];

const addCommand = (primitive: LevelPrimitive) => `${levelId}.add.${primitive}`;

// The keys of the level, while it is in the viewport.
const levelShown = `engine.scene == ${levelScene}`;

/** The renderings of the viewport, by their commands. */
const renderings: Readonly<Record<LevelRendering, readonly [string, string]>> = {
  raster: ['Rasterized', 'image'],
  shadows: ['Ray traced shadows', 'sun'],
  reflections: ['Ray traced reflections', 'sparkles'],
  path: ['Path traced', 'aperture'],
};
const renderingCommand = (rendering: LevelRendering) =>
  `${levelId}.rendering.${rendering}`;

const manifest = {
  id: levelId,
  title: 'Level',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'The level the engine edits: the File and Edit menus, the tools of the viewport (select, move, rotate, scale), undo and redo.',
  activationEvents: ['onStartup'],
  contributes: {
    commands: [
      {
        id: `${levelId}.new`,
        title: 'New level',
        category: 'File',
        icon: 'file-plus',
      },
      {
        id: `${levelId}.open`,
        title: 'Open level…',
        category: 'File',
        icon: 'folder-open',
      },
      {
        id: `${levelId}.save`,
        title: 'Save level',
        category: 'File',
        icon: 'save',
      },
      {
        id: `${levelId}.export`,
        title: 'Export as glTF…',
        category: 'File',
        icon: 'download',
      },
      {
        id: `${levelId}.undo`,
        title: 'Undo',
        category: 'Edit',
        icon: 'undo',
        enablement: 'level.canUndo',
      },
      {
        id: `${levelId}.redo`,
        title: 'Redo',
        category: 'Edit',
        icon: 'redo',
        enablement: 'level.canRedo',
      },
      {
        id: `${levelId}.delete`,
        title: 'Delete',
        category: 'Edit',
        icon: 'trash',
        enablement: 'scene.hasSelection',
      },
      ...primitives.map(([primitive, title, icon]) => ({
        id: addCommand(primitive),
        title,
        category: 'Add',
        icon,
      })),
      {
        id: `${levelId}.frame`,
        title: 'Frame the selection',
        category: 'View',
        icon: 'focus',
        enablement: levelShown,
      },
      {
        id: `${levelId}.select`,
        title: 'Select',
        category: 'Tool',
        icon: 'pointer',
        toggled: '!tool.primary',
      },
      ...levelRenderings.map((rendering) => ({
        id: renderingCommand(rendering),
        title: renderings[rendering][0],
        category: 'Rendering',
        icon: renderings[rendering][1],
        toggled: `level.rendering == ${rendering}`,
        // The rays: on the backends that trace them.
        ...(rendering === 'raster' ? {} : { enablement: 'engine.rays' }),
      })),
      {
        id: `${levelId}.space`,
        title: 'Local axes',
        category: 'Gizmo',
        icon: 'globe',
        toggled: 'level.gizmo.local',
      },
      {
        id: `${levelId}.pivot`,
        title: 'Pivot at the origins',
        category: 'Gizmo',
        icon: 'map-pin',
        toggled: 'level.gizmo.origins',
      },
      {
        id: `${levelId}.snap`,
        title: 'Snap',
        category: 'Gizmo',
        icon: 'magnet',
        toggled: 'level.gizmo.snapping',
      },
    ],
    tools: [
      { id: `${levelId}.move`, title: 'Move', slot: 'primary', icon: 'move' },
      {
        id: `${levelId}.rotate`,
        title: 'Rotate',
        slot: 'primary',
        icon: 'rotate',
      },
      {
        id: `${levelId}.scale`,
        title: 'Scale',
        slot: 'primary',
        icon: 'scale',
      },
    ],
    menus: {
      menubar: [
        { submenu: 'menubar.file', title: 'File', order: 1 },
        { submenu: 'menubar.edit', title: 'Edit', order: 2 },
      ],
      'menubar.file': [
        { command: `${levelId}.new`, group: '1_open' },
        { command: `${levelId}.open`, group: '1_open' },
        { command: `${levelId}.save`, group: '2_save' },
        { command: `${levelId}.export`, group: '2_save' },
      ],
      'menubar.edit': [
        { command: `${levelId}.undo`, group: '1_history' },
        { command: `${levelId}.redo`, group: '1_history' },
        { command: `${levelId}.delete`, group: '2_nodes' },
        { submenu: 'menubar.edit.add', title: 'Add', group: '2_nodes' },
        { command: `${levelId}.frame`, group: '3_view' },
        { command: `${levelId}.select`, group: '4_tools' },
        ...Object.keys(tools).map((command) => ({ command, group: '4_tools' })),
        { command: `${levelId}.space`, group: '5_gizmo' },
        { command: `${levelId}.pivot`, group: '5_gizmo' },
        { command: `${levelId}.snap`, group: '5_gizmo' },
        { submenu: 'menubar.edit.rendering', title: 'Rendering', group: '6_view' },
      ],
      'menubar.edit.rendering': levelRenderings.map((rendering) => ({
        command: renderingCommand(rendering),
      })),
      'menubar.edit.add': primitives.map(([primitive]) => ({
        command: addCommand(primitive),
      })),
    },
    toolbars: [
      {
        id: `${levelId}.tools`,
        title: 'Level',
        side: 'top',
        items: [
          `${levelId}.select`,
          ...Object.keys(tools),
          `${levelId}.space`,
          `${levelId}.pivot`,
          `${levelId}.snap`,
          `${levelId}.undo`,
          `${levelId}.redo`,
          `${levelId}.frame`,
        ],
      },
    ],
    statusBar: [{ id: `${levelId}.status`, alignment: 'left', priority: 90 }],
    keybindings: [
      { command: `${levelId}.open`, key: 'ctrl+o' },
      { command: `${levelId}.save`, key: 'ctrl+s' },
      { command: `${levelId}.undo`, key: 'ctrl+z' },
      { command: `${levelId}.redo`, key: 'ctrl+y' },
      { command: `${levelId}.redo`, key: 'ctrl+shift+z' },
      { command: `${levelId}.delete`, key: 'delete', when: levelShown },
      { command: `${levelId}.frame`, key: 'f', when: levelShown },
      { command: `${levelId}.select`, key: 'q', when: levelShown },
      { command: `${levelId}.move`, key: 'w', when: levelShown },
      { command: `${levelId}.rotate`, key: 'e', when: levelShown },
      { command: `${levelId}.scale`, key: 'r', when: levelShown },
      { command: `${levelId}.space`, key: 'x', when: levelShown },
      { command: `${levelId}.pivot`, key: 'c', when: levelShown },
    ],
  },
} as const satisfies PluginManifest;

/** The files of the levels, in the dialogs. */
export const levelFilters: readonly FileFilter[] = [
  { name: 'Levels', extensions: ['json', 'glb', 'gltf'] },
];

// The rendering of the viewport kept with the layout (with the gizmo).
function readRendering(value: unknown): LevelRendering {
  const rendering = (value as { rendering?: unknown } | undefined)?.rendering;
  return levelRenderings.includes(rendering as LevelRendering)
    ? (rendering as LevelRendering)
    : 'raster';
}

// The settings of the gizmo kept with the layout (the state of the plugin).
function readGizmo(value: unknown): GizmoSettings {
  const state = (value ?? {}) as Partial<GizmoSettings>;
  return {
    space: state.space === 'local' ? 'local' : 'world',
    pivot: state.pivot === 'origin' ? 'origin' : 'center',
    snapping: state.snapping === true,
  };
}

/** The tool of the viewport for the tool of the primary slot. */
export function viewportTool(primary: string | undefined): ViewportTool {
  if (primary === undefined) return 'select';
  return (tools as Record<string, ViewportTool>)[primary] ?? 'none';
}

/** The name of a file of the level in another format. */
export function levelFileName(name: string, format: LevelFormat): string {
  const base = name.replace(/\.(scene\.json|json|glb|gltf)$/i, '') || 'level';
  return format === 'glb' ? `${base}.glb` : `${base}.scene.json`;
}

// The name of the level, whether it changed, the last command.
function LevelStatus() {
  const { level } = useEditor();
  const { name, dirty, undo } = useSelector(
    level,
    (snapshot) => snapshot.context,
  );
  if (!name) return null;
  return (
    <span className="text-muted-foreground">
      {name}
      {dirty && ' •'}
      {undo && ` · ${undo}`}
    </span>
  );
}

function activate(context: PluginContext): void {
  const { services, commands } = context;
  const connection = services.get(IEngineConnection);
  const engine = services.get(IEngineStore);
  const level = services.get(ILevelStore);
  const host = services.get(IEditorHost);
  const post = (message: PageMessage) => connection.post(message);
  const log = (level: 'info' | 'error', text: string) =>
    engine.trigger.message({ message: { type: 'log', level, text } });
  // The machine read at the call: made once the plugins of the start are.
  const machine = (): EditorActor => services.get(IEditorMachine);

  // A level of the user, or the sample one, shown in the viewport.
  const show = () => engine.trigger.chooseScene({ scene: levelScene });
  commands.register(`${levelId}.new`, () => {
    post({ type: 'level.new' });
    show();
  });
  commands.register(`${levelId}.open`, async () => {
    const file = await host.files.open(levelFilters);
    if (!file) return;
    post({ type: 'level.open', name: file.name, data: file.data });
    show();
  });
  // The engine writes the level, the host saves the file.
  const write = async (format: LevelFormat) => {
    const name = levelFileName(level.getSnapshot().context.name, format);
    const file = await new Promise<
      Extract<EngineMessage, { type: 'level.file' }> | undefined
    >((resolve) => {
      const stop = connection.subscribe((message) => {
        if (message.type === 'level.file' && message.name === name) {
          stop();
          resolve(message);
        } else if (message.type === 'error') {
          stop();
          resolve(undefined);
        }
      });
      post({ type: 'level.save', format, name });
    });
    if (!file) return;
    if (!(await host.files.save(name, file.data, levelFilters))) return;
    if (format === 'fdw-scene') post({ type: 'level.saved', name });
    log('info', `${format === 'glb' ? 'Exported' : 'Saved'} ${name}`);
  };
  commands.register(`${levelId}.save`, () => write('fdw-scene'));
  commands.register(`${levelId}.export`, () => write('glb'));

  commands.register(`${levelId}.undo`, () =>
    post({ type: 'level.command', command: 'undo' }),
  );
  commands.register(`${levelId}.redo`, () =>
    post({ type: 'level.command', command: 'redo' }),
  );
  commands.register(`${levelId}.delete`, () =>
    post({ type: 'level.command', command: 'delete' }),
  );
  for (const [primitive] of primitives) {
    commands.register(addCommand(primitive), () =>
      post({ type: 'level.command', command: 'add', primitive }),
    );
  }
  commands.register(`${levelId}.frame`, () =>
    post({ type: 'level.command', command: 'frame' }),
  );
  // Select: no tool in the primary slot.
  commands.register(`${levelId}.select`, () =>
    machine().send({ type: 'TOOL.DEACTIVATE', slot: 'primary' }),
  );
  for (const id of Object.keys(tools)) {
    // A tool of the viewport: the engine does the work, the machine only
    // holds which one is active.
    context.tools.register(id, () => createMachine({ id }));
  }

  // The gizmo and the rendering: kept with the layout, as context keys,
  // sent to the engine.
  let keys: IDisposable[] = [];
  const sendGizmo = () => {
    const state = context.state.get();
    const gizmo = readGizmo(state);
    const rendering = readRendering(state);
    keys.forEach((key) => key.dispose());
    keys = [
      context.keys.set('level.gizmo.local', gizmo.space === 'local'),
      context.keys.set('level.gizmo.origins', gizmo.pivot === 'origin'),
      context.keys.set('level.gizmo.snapping', gizmo.snapping),
      context.keys.set('level.rendering', rendering),
    ];
    post({ type: 'level.gizmo', ...gizmo });
    post({ type: 'level.rendering', rendering });
  };
  const setState = (change: Partial<GizmoSettings> & { rendering?: LevelRendering }) => {
    const state = context.state.get();
    context.state.set({
      ...readGizmo(state),
      rendering: readRendering(state),
      ...change,
    });
    sendGizmo();
  };
  const setGizmo = (
    change: (gizmo: GizmoSettings) => Partial<GizmoSettings>,
  ) => setState(change(readGizmo(context.state.get())));
  for (const rendering of levelRenderings) {
    commands.register(renderingCommand(rendering), () => setState({ rendering }));
  }
  commands.register(`${levelId}.space`, () =>
    setGizmo(({ space }) => ({ space: space === 'world' ? 'local' : 'world' })),
  );
  commands.register(`${levelId}.pivot`, () =>
    setGizmo(({ pivot }) => ({
      pivot: pivot === 'center' ? 'origin' : 'center',
    })),
  );
  commands.register(`${levelId}.snap`, () =>
    setGizmo(({ snapping }) => ({ snapping: !snapping })),
  );
  context.statusBar.registerComponent(`${levelId}.status`, LevelStatus);

  // The tool of the primary slot routes the main button of the viewport:
  // to the tools of the engine, or to none (another tool has it). Sent
  // again to an engine that starts again (a page reloaded, a process).
  let tool: ViewportTool | undefined;
  const sendTool = (force = false) => {
    const next = viewportTool(machine().getSnapshot().context.tools.primary);
    if (next === tool && !force) return;
    tool = next;
    post({ type: 'level.tool', tool: next });
  };
  let active = true;
  context.subscriptions.push(
    { dispose: () => keys.forEach((key) => key.dispose()) },
    {
      dispose: connection.subscribe((message) => {
        if (message.type !== 'ready') return;
        sendTool(true);
        sendGizmo();
      }),
    },
    {
      dispose: () => {
        active = false;
      },
    },
  );
  // After the start: the machine (and the context keys) are made once the
  // plugins have activated, to restore their tools.
  queueMicrotask(() => {
    if (!active) return;
    sendGizmo();
    sendTool(true);
    const subscription = machine().subscribe(() => sendTool());
    context.subscriptions.push({ dispose: () => subscription.unsubscribe() });
  });
}

/** The level: open, save, the tools of the viewport, as a plugin. */
export const levelPlugin: EditorPlugin = {
  manifest,
  load: () => ({ activate }),
};
