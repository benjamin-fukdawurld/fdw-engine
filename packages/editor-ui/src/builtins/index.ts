import type { EditorPlugin } from '../plugins/pluginHost';
import { consolePlugin, inspectorPlugin, outlinerPlugin } from './panels';
import { viewportPlugin } from './viewport';
import { workbenchPlugin } from './workbench';

/**
 * The plugins of the editor, always there: its panels and its chrome are
 * plugins too (design/editor-ui.md §6), in this order in the View menu.
 */
export const builtinPlugins: readonly EditorPlugin[] = [
  viewportPlugin,
  workbenchPlugin,
  outlinerPlugin,
  inspectorPlugin,
  consolePlugin,
];
