import type { PluginManifest } from '@fdw/editor-ui';

/** The id of the plugin, and the prefix of its contributions. */
export const isolateId = 'fdw.isolate';

export const isolateCommand = `${isolateId}.isolate`;
export const showAllCommand = `${isolateId}.showAll`;
export const statisticsView = `${isolateId}.statistics`;

/** The context key the plugin sets while the selection is isolated. */
export const isolatedKey = 'isolate.active';

// The keys work over the level, as those of the level plugin.
const levelShown = 'engine.scene == level';

/**
 * The manifest of the plugin of the tutorial "Writing a plugin": read by
 * the editor at the start, before the code (./main.tsx) is loaded. Its
 * commands, its panel and its item of the status bar are shown at once;
 * the code comes at the first of them used: its panel, open in the
 * default layout.
 */
export const manifest = {
  id: isolateId,
  title: 'Isolate',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'Hides everything but the selection, and shows the statistics of the level.',
  contributes: {
    commands: [
      {
        id: isolateCommand,
        title: 'Isolate the selection',
        category: 'Isolate',
        icon: 'focus',
        enablement: `scene.hasSelection && !${isolatedKey}`,
      },
      {
        id: showAllCommand,
        title: 'Show everything',
        category: 'Isolate',
        icon: 'eye',
        enablement: isolatedKey,
      },
    ],
    views: [
      {
        id: statisticsView,
        title: 'Statistics',
        icon: 'list-tree',
        location: 'right',
        // In the default layout.
        open: true,
      },
    ],
    menus: {
      // The Edit menu of the level plugin, in a group of its own.
      'menubar.edit': [
        { command: isolateCommand, group: '3_view' },
        { command: showAllCommand, group: '3_view' },
      ],
    },
    statusBar: [{ id: `${isolateId}.status`, alignment: 'left', priority: 40 }],
    keybindings: [
      { command: isolateCommand, key: 'i', when: levelShown },
      { command: showAllCommand, key: 'shift+i', when: levelShown },
    ],
  },
} as const satisfies PluginManifest;
