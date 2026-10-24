import type { ComponentType } from 'react';
import { useEngine } from '../editorContext';
import { cn } from '../lib/utils';
import type { PluginManifest, ViewContribution } from '../plugins/manifest';
import type { EditorPlugin } from '../plugins/pluginHost';
import { InspectorPanel } from './inspector';
import { OutlinerPanel } from './outliner';

function ConsolePanel() {
  const { log } = useEngine();
  return (
    <div className="h-full overflow-auto px-3 py-1 font-mono text-xs">
      {log.map((entry) => (
        <div
          key={entry.id}
          className={cn(entry.level === 'error' && 'text-destructive')}
        >
          <span className="text-muted-foreground">
            {entry.time.toLocaleTimeString()}
          </span>{' '}
          {entry.text}
        </div>
      ))}
    </div>
  );
}

// A built-in plugin of a single view, open in the default layout.
function panelPlugin(
  plugin: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
  },
  view: Omit<ViewContribution, 'open'>,
  component: ComponentType,
): EditorPlugin {
  const manifest: PluginManifest = {
    ...plugin,
    version: '1.0.0',
    engine: '^1.0.0',
    activationEvents: ['onStartup'],
    contributes: { views: [{ ...view, open: true }] },
  };
  return {
    manifest,
    load: () => ({
      activate: (context) => {
        context.views.registerComponent(view.id, component);
      },
    }),
  };
}

/** The tree of the level: the projection the engine sends. */
export const outlinerPlugin = panelPlugin(
  {
    id: 'fdw.outliner',
    title: 'Outliner',
    description: 'The tree of the level.',
  },
  { id: 'outliner', title: 'Outliner', icon: 'list-tree', location: 'left' },
  OutlinerPanel,
);

/** The properties of the active node of the level. */
export const inspectorPlugin = panelPlugin(
  {
    id: 'fdw.inspector',
    title: 'Inspector',
    description: 'The properties of the selection.',
  },
  { id: 'inspector', title: 'Inspector', icon: 'sliders', location: 'right' },
  InspectorPanel,
);

/** The messages of the engine. */
export const consolePlugin = panelPlugin(
  {
    id: 'fdw.console',
    title: 'Console',
    description: 'The messages of the engine.',
  },
  { id: 'console', title: 'Console', icon: 'terminal', location: 'bottom' },
  ConsolePanel,
);
