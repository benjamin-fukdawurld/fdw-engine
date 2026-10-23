import type { PluginManifest } from '@fdw/editor-ui';

/** The id of the plugin, and the prefix of its contributions. */
export const sampleId = 'fdw.sample';

export const markTool = `${sampleId}.mark`;

const whileMarking = `tool.primary == ${markTool}`;

/**
 * The manifest of the sample: read by the editor at the start, before the
 * code of the plugin (./main.tsx) is loaded.
 */
export const manifest = {
  id: sampleId,
  title: 'Marks (sample)',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'A sample plugin: a tool that places marks, a panel that counts them and keeps notes.',
  contributes: {
    tools: [{ id: markTool, title: 'Mark', slot: 'primary', icon: 'map-pin' }],
    commands: [
      {
        id: `${sampleId}.addMark`,
        title: 'Add a mark',
        category: 'Marks',
        icon: 'plus',
        enablement: whileMarking,
      },
      {
        id: `${sampleId}.finish`,
        title: 'Finish the marks',
        category: 'Marks',
        icon: 'check',
        enablement: whileMarking,
      },
      {
        id: `${sampleId}.showMarks`,
        title: 'Show the marks',
        category: 'Marks',
      },
    ],
    views: [
      {
        id: `${sampleId}.marks`,
        title: 'Marks',
        icon: 'map-pin',
        location: 'right',
      },
    ],
    menus: {
      menubar: [{ submenu: `${sampleId}.menu`, title: 'Marks', order: 30 }],
      [`${sampleId}.menu`]: [
        { command: markTool, group: '1_tool' },
        { command: `${sampleId}.addMark`, group: '2_marks' },
        { command: `${sampleId}.finish`, group: '2_marks' },
        { command: `${sampleId}.showMarks`, group: '3_view' },
      ],
    },
    toolbars: [
      {
        id: `${sampleId}.toolbar`,
        title: 'Marks',
        side: 'left',
        items: [markTool, `${sampleId}.addMark`, `${sampleId}.finish`],
      },
    ],
    statusBar: [{ id: `${sampleId}.status`, alignment: 'right', priority: 60 }],
    keybindings: [
      { command: `${sampleId}.addMark`, key: 'm', when: whileMarking },
      { command: `${sampleId}.finish`, key: 'ctrl+enter', when: whileMarking },
    ],
  },
} as const satisfies PluginManifest;
