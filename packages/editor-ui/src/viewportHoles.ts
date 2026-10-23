import type { ViewportBounds } from './protocol';
import { devicePixels } from './useViewportBounds';

/**
 * What the page draws over the viewport: the popups of Radix (menus,
 * tooltips), the floating groups, menus and drop targets of dockview, and
 * the elements marked `data-over-viewport`.
 */
export const overViewportSelector = [
  '[data-radix-popper-content-wrapper]',
  '.dv-resize-container',
  '.dv-context-menu',
  '.dv-tabs-overflow-dropdown-root',
  '.dv-drop-target-anchor',
  '.dv-drop-target-selection',
  '[data-over-viewport]',
].join(', ');

/**
 * The parts of the page over the viewport element, in device pixels in the
 * window: a window over the page (the native viewport of Electron) leaves
 * them out, so that the page shows there. A floating group that holds the
 * viewport, or covers it whole, is not one.
 */
export function viewportHoles(element: Element): ViewportBounds[] {
  const area = element.getBoundingClientRect();
  if (area.width <= 0 || area.height <= 0) return [];
  const holes: ViewportBounds[] = [];
  const overs = element.ownerDocument.querySelectorAll(overViewportSelector);
  for (const over of Array.from(overs)) {
    if (
      over.contains(element) ||
      over.checkVisibility?.({
        visibilityProperty: true,
        opacityProperty: true,
      }) === false
    ) {
      continue;
    }
    const rect = over.getBoundingClientRect();
    const left = Math.max(rect.left, area.left);
    const top = Math.max(rect.top, area.top);
    const right = Math.min(rect.right, area.right);
    const bottom = Math.min(rect.bottom, area.bottom);
    if (right <= left || bottom <= top) continue;
    const whole =
      left === area.left &&
      top === area.top &&
      right === area.right &&
      bottom === area.bottom;
    if (whole && over.matches('.dv-resize-container')) continue;
    holes.push(devicePixels({ left, top, right, bottom }));
  }
  return holes;
}
