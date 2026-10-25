import type { PluginManifest } from '@fdw/editor-ui';

/** The id of the plugin, and the prefix of its contributions. */
export const materialGraphId = 'fdw.materialGraph';

/** The panel of the editor, and the session of its graph in the engine. */
export const materialGraphView = `${materialGraphId}.editor`;
export const showMaterialGraphCommand = `${materialGraphId}.show`;

/**
 * The manifest of the editor of the material graphs: its panel, beside the
 * viewport (in the View menu), and the command that shows it (in the
 * palette).
 */
export const manifest = {
  id: materialGraphId,
  title: 'Material graphs',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'Edits the material graphs of the scene and of files: a live preview, the code generated and its lines by node, the errors on the nodes.',
  contributes: {
    commands: [
      {
        id: showMaterialGraphCommand,
        title: 'Edit the materials',
        category: 'Graphs',
        icon: 'palette',
      },
    ],
    views: [
      {
        id: materialGraphView,
        title: 'Material graph',
        icon: 'palette',
        location: 'center',
        split: 'right',
      },
    ],
  },
} as const satisfies PluginManifest;
