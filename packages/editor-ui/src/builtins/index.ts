import type { EditorPlugin } from '../plugins/pluginHost';
import { levelPlugin } from './level';
import { consolePlugin, inspectorPlugin, outlinerPlugin } from './panels';
import { viewportPlugin } from './viewport';
import { workbenchPlugin } from './workbench';

export { levelFileName, levelFilters, viewportTool } from './level';

/**
 * The plugins of the editor, always there: its panels and its chrome are
 * plugins too (design/editor-ui.md §6), in this order in the View menu.
 */
export const builtinPlugins: readonly EditorPlugin[] = [
  viewportPlugin,
  workbenchPlugin,
  levelPlugin,
  outlinerPlugin,
  inspectorPlugin,
  consolePlugin,
];
