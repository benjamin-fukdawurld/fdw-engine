import type { PluginManifest } from '@fdw/editor-ui';

/** The id of the plugin, and the prefix of its contributions. */
export const animationGraphId = 'fdw.animationGraph';

/** The panel of the editor, and the session of its graph in the engine. */
export const animationGraphView = `${animationGraphId}.editor`;
export const showAnimationGraphCommand = `${animationGraphId}.show`;

/**
 * The manifest of the editor of the animation graphs: its panel, beside
 * the viewport (in the View menu), and the command that shows it.
 */
export const manifest = {
  id: animationGraphId,
  title: 'Animation graphs',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'Edits the animation graphs of the scene and of files, their state machines, and shows what they play: the states, the weights, the parameters.',
  contributes: {
    commands: [
      {
        id: showAnimationGraphCommand,
        title: 'Edit the animations',
        category: 'Graphs',
        icon: 'person-standing',
      },
    ],
    views: [
      {
        id: animationGraphView,
        title: 'Animation graph',
        icon: 'person-standing',
        location: 'center',
        split: 'right',
      },
    ],
  },
} as const satisfies PluginManifest;
