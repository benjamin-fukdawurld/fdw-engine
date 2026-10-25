import type { PluginManifest } from '@fdw/editor-ui';

/** The id of the plugin, and the prefix of its contributions. */
export const behaviorGraphId = 'fdw.behaviorGraph';

/** The panel of the editor, and the session of its graph in the engine. */
export const behaviorGraphView = `${behaviorGraphId}.editor`;
export const showBehaviorGraphCommand = `${behaviorGraphId}.show`;
export const continueCommand = `${behaviorGraphId}.continue`;
export const stepCommand = `${behaviorGraphId}.step`;
export const breakpointCommand = `${behaviorGraphId}.breakpoint`;
export const stopDebuggingCommand = `${behaviorGraphId}.stop`;

/** The context keys of the plugin: the debugger open, the graph stopped. */
export const debuggingKey = 'behavior.debugging';
export const pausedKey = 'behavior.paused';

// The keys of the debugger, while its panel has the focus.
const focused = `editor.focusedView == ${behaviorGraphView}`;

/**
 * The manifest of the editor of the behavior graphs: its panel, beside the
 * viewport, and the Debug menu (continue, step, breakpoints), with the keys
 * of the debuggers (F5, F10, F9).
 */
export const manifest = {
  id: behaviorGraphId,
  title: 'Behavior graphs',
  version: '1.0.0',
  engine: '^1.0.0',
  description:
    'Edits the behavior graphs of the scene and of files, their functions and macros, and debugs them: breakpoints, steps, the states of the nodes.',
  contributes: {
    commands: [
      {
        id: showBehaviorGraphCommand,
        title: 'Edit the behaviors',
        category: 'Graphs',
        icon: 'bug',
      },
      {
        id: continueCommand,
        title: 'Continue',
        category: 'Debug',
        icon: 'play',
      },
      {
        id: stepCommand,
        title: 'Step to the next node',
        category: 'Debug',
        icon: 'step-forward',
      },
      {
        id: breakpointCommand,
        title: 'Toggle a breakpoint on the node',
        category: 'Debug',
        icon: 'circle-dot',
      },
      {
        id: stopDebuggingCommand,
        title: 'Stop debugging',
        category: 'Debug',
        icon: 'x',
        enablement: debuggingKey,
      },
    ],
    views: [
      {
        id: behaviorGraphView,
        title: 'Behavior graph',
        icon: 'bug',
        location: 'center',
        split: 'right',
      },
    ],
    menus: {
      menubar: [{ submenu: 'menubar.debug', title: 'Debug', order: 30 }],
      'menubar.debug': [
        { command: continueCommand, group: '1_run' },
        { command: stepCommand, group: '1_run' },
        { command: stopDebuggingCommand, group: '1_run' },
        { command: breakpointCommand, group: '2_breakpoints' },
      ],
    },
    keybindings: [
      { command: continueCommand, key: 'f5', when: focused },
      { command: stepCommand, key: 'f10', when: focused },
      { command: breakpointCommand, key: 'f9', when: focused },
      { command: stopDebuggingCommand, key: 'shift+f5', when: focused },
    ],
  },
} as const satisfies PluginManifest;
