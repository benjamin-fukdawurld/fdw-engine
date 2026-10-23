import type { Chrome, ToolbarLayout } from './layout';
import type { ToolbarContribution } from './plugins/manifest';

/** The layout of a toolbar: the one saved, or the one it declares. */
export function toolbarLayout(
  chrome: Chrome,
  toolbar: Pick<ToolbarContribution, 'id' | 'side' | 'visible'>,
): ToolbarLayout {
  return (
    chrome.toolbars[toolbar.id] ?? {
      side: toolbar.side ?? 'top',
      visible: toolbar.visible ?? true,
    }
  );
}
