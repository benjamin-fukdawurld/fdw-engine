import type { EditorPlugin } from '@fdw/editor-ui';
import { manifest } from './manifest';

export {
  manifest,
  animationGraphId,
  animationGraphView,
  showAnimationGraphCommand,
} from './manifest';

/**
 * The editor of the animation graphs, as a plugin: its manifest, and its
 * code in a chunk of its own, loaded when its panel is shown.
 */
export const animationGraphPlugin: EditorPlugin = {
  manifest,
  load: () => import('./main'),
};
