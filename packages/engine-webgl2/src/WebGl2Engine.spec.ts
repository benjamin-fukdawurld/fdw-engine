import { beforeAll, describe, expect, it } from 'vitest';
import { fakeGl, installGl } from './testing/fakeGl';
import { WebGl2Engine } from './WebGl2Engine';

beforeAll(installGl);

// A canvas whose context is lost by its loseContext extension, as in a
// browser.
function fakeCanvas() {
  const canvas = new EventTarget() as EventTarget & {
    getContext: () => WebGL2RenderingContext;
  };
  const lose = () => {
    const event = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(event);
    return event;
  };
  const { gl } = fakeGl({
    extensions: { WEBGL_lose_context: { loseContext: lose } },
  });
  canvas.getContext = () => gl;
  return { canvas: canvas as unknown as HTMLCanvasElement, lose };
}

describe('WebGl2Engine', () => {
  it('reports the loss and the restoration of the context', async () => {
    const { canvas, lose } = fakeCanvas();
    const engine = new WebGl2Engine({ canvas });
    await engine.init();
    const events: string[] = [];
    for (const type of ['lost', 'restored', 'destroyed']) {
      engine.addEventListener(type, () => events.push(type));
    }

    // Prevented, for the browser to restore it.
    expect(lose().defaultPrevented).toBe(true);
    expect(engine.lost).toBe(true);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(events).toEqual(['lost', 'restored']);

    // Lost by destroy(): not reported.
    await engine.destroy();
    expect(events).toEqual(['lost', 'restored', 'destroyed']);
    await engine.init();
    expect(engine.lost).toBe(false);
  });
});
