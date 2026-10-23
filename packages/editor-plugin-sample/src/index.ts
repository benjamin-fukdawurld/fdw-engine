import type { EditorPlugin } from '@fdw/editor-ui';
import { manifest } from './manifest';

export { manifest, markTool, sampleId } from './manifest';
export type { SampleState } from './main';

/**
 * The sample plugin (step 12 of P18): its manifest, and its code in a chunk
 * of its own, loaded at its first activation event.
 */
export const samplePlugin: EditorPlugin = {
  manifest,
  load: () => import('./main'),
};
