import { useEditor, useSelector } from '../editorContext';
import type { PluginManifest } from '../plugins/manifest';
import type { EditorPlugin, PluginContext } from '../plugins/pluginHost';
import type { IDisposable } from '../state/services';
import { IEngineConnection, IEngineStore } from '../state/runtime';

const manifest = {
  id: 'fdw.viewport',
  title: 'Viewport',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'The view of the engine, and the Scene menu: the level, the demo scenes.',
  activationEvents: ['onStartup'],
  contributes: {
    commands: [
      { id: 'fdw.viewport.showScene', title: 'Show a scene', palette: false },
    ],
    views: [
      {
        id: 'viewport',
        title: 'Viewport',
        icon: 'box',
        location: 'center',
        open: true,
      },
    ],
    menus: {
      // The scenes of the engine, once it is ready.
      menubar: [{ submenu: 'menubar.scene', title: 'Scene', order: 20 }],
    },
  },
} as const satisfies PluginManifest;

// The rectangle of a selection dragged in the level: four lines over the
// view, each a hole of a native viewport (Electron), through which the page
// shows.
function SelectionRectangle() {
  const { level } = useEditor();
  const rectangle = useSelector(
    level,
    (snapshot) => snapshot.context.rectangle,
  );
  if (!rectangle) return null;
  // From the device pixels of the viewport to the pixels of the page.
  const scale = 1 / window.devicePixelRatio;
  const left = rectangle.x * scale;
  const top = rectangle.y * scale;
  const width = Math.max(1, rectangle.width * scale);
  const height = Math.max(1, rectangle.height * scale);
  const lines = [
    { left, top, width, height: 1 },
    { left, top: top + height - 1, width, height: 1 },
    { left, top, width: 1, height },
    { left: left + width - 1, top, width: 1, height },
  ];
  return lines.map((style, index) => (
    <div
      key={index}
      data-over-viewport
      data-testid="selection-rectangle"
      className="pointer-events-none absolute bg-sky-400"
      style={style}
    />
  ));
}

function ViewportPanel() {
  const { Viewport } = useEditor().host;
  return (
    <div className="relative h-full w-full bg-black">
      <Viewport />
      <SelectionRectangle />
    </div>
  );
}

// A value in a `when` clause, quoted.
const quoted = (value: string) =>
  value.includes("'") ? `"${value}"` : `'${value}'`;

function activate(context: PluginContext): void {
  const engine = context.services.get(IEngineStore);
  const connection = context.services.get(IEngineConnection);
  context.views.registerComponent('viewport', ViewportPanel);
  context.commands.register('fdw.viewport.showScene', (name) => {
    if (typeof name !== 'string') return;
    engine.trigger.chooseScene({ scene: name });
    connection.post({ type: 'scene', name });
  });

  // The Scene menu, made again when the engine tells its scenes.
  let scenes: readonly string[] | undefined;
  let items: IDisposable[] = [];
  const update = () => {
    const next = engine.getSnapshot().context.scenes;
    if (next === scenes) return;
    scenes = next;
    items.forEach((item) => item.dispose());
    items = next.map((name) =>
      context.menus.append('menubar.scene', {
        command: 'fdw.viewport.showScene',
        args: [name],
        title: name,
        toggled: `engine.scene == ${quoted(name)}`,
        radio: true,
      }),
    );
  };
  update();
  const subscription = engine.subscribe(update);
  context.subscriptions.push({ dispose: () => subscription.unsubscribe() });
}

/** The viewport: the view of the engine, as a plugin. */
export const viewportPlugin: EditorPlugin = {
  manifest,
  load: () => ({ activate }),
};
