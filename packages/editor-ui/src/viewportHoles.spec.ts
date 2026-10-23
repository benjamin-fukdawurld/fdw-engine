import { afterEach, describe, expect, it } from 'vitest';
import { viewportHoles } from './viewportHoles';

// An element of the page at the given rectangle (jsdom has no layout).
function place(
  element: Element,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  element.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    }) as DOMRect;
  return element;
}

function add(html: string, left: number, top: number, w: number, h: number) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const element = template.content.firstElementChild as Element;
  document.body.append(element);
  return place(element, left, top, w, h);
}

describe('viewportHoles', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.devicePixelRatio = 1;
  });

  it('gives the parts of the menus and floating groups over the viewport', () => {
    window.devicePixelRatio = 2;
    const viewport = add('<div></div>', 100, 50, 400, 300);
    // A menu across the top edge, a floating group inside.
    add('<div data-radix-popper-content-wrapper></div>', 120, 20, 100, 80);
    add('<div class="dv-resize-container"></div>', 300, 200, 100, 100);
    // Out of the viewport.
    add('<div data-radix-popper-content-wrapper></div>', 0, 0, 50, 50);
    // Not over the page.
    add('<div class="dv-tab"></div>', 120, 60, 50, 20);
    expect(viewportHoles(viewport)).toEqual([
      { x: 240, y: 100, width: 200, height: 100 },
      { x: 600, y: 400, width: 200, height: 200 },
    ]);
  });

  it('leaves out the floating group that holds the viewport', () => {
    const float = add(
      '<div class="dv-resize-container"></div>',
      0,
      0,
      500,
      400,
    );
    const viewport = place(document.createElement('div'), 10, 30, 480, 360);
    float.append(viewport);
    // Another one, which holds it through the overlay of dockview: it
    // covers it whole.
    add('<div class="dv-resize-container"></div>', 0, 0, 500, 400);
    add('<div data-over-viewport></div>', 20, 40, 10, 10);
    expect(viewportHoles(viewport)).toEqual([
      { x: 20, y: 40, width: 10, height: 10 },
    ]);
  });

  it('gives none while the viewport has no area', () => {
    const viewport = add('<div></div>', 0, 0, 0, 0);
    add('<div data-over-viewport></div>', 0, 0, 10, 10);
    expect(viewportHoles(viewport)).toEqual([]);
  });
});
