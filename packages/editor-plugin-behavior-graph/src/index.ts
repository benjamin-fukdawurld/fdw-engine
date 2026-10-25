import type { EditorPlugin } from '@fdw/editor-ui';
import { manifest } from './manifest';

export * from './manifest';

/**
 * The editor of the behavior graphs, as a plugin: its manifest, and its
 * code in a chunk of its own, loaded when its panel is shown.
 */
export const behaviorGraphPlugin: EditorPlugin = {
  manifest,
  load: () => import('./main'),
};
