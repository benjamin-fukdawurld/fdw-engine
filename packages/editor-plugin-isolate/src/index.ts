import type { EditorPlugin } from '@fdw/editor-ui';
import { manifest } from './manifest';

export {
  isolateCommand,
  isolatedKey,
  isolateId,
  manifest,
  showAllCommand,
  statisticsView,
} from './manifest';

/**
 * The plugin of the tutorial "Writing a plugin" of the documentation: its
 * manifest, and its code in a chunk of its own, loaded at its first
 * activation event.
 */
export const isolatePlugin: EditorPlugin = {
  manifest,
  load: () => import('./main'),
};
