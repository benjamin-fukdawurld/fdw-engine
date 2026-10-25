import type { EditorPlugin } from '@fdw/editor-ui';
import { manifest } from './manifest';

export {
  manifest,
  materialGraphId,
  materialGraphView,
  showMaterialGraphCommand,
} from './manifest';

/**
 * The editor of the material graphs, as a plugin: its manifest, and its
 * code in a chunk of its own, loaded when its panel is shown.
 */
export const materialGraphPlugin: EditorPlugin = {
  manifest,
  load: () => import('./main'),
};
