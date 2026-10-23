import { useEditor } from '../editorContext';
import type { PluginManifest } from '../plugins/manifest';
import type { EditorPlugin, PluginContext } from '../plugins/pluginHost';
import type { IDisposable } from '../state/services';
import { IEngineConnection, IEngineStore } from '../state/runtime';

const manifest = {
  id: 'fdw.viewport',
  title: 'Viewport',
  version: '1.0.0',
  engine: '^1.0.0',
  description: 'The view of the engine, and the Scene menu.',
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

function ViewportPanel() {
  const { Viewport } = useEditor().host;
  return (
    <div className="h-full w-full bg-black">
      <Viewport />
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
