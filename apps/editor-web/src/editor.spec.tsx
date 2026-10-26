import { EditorShell, type HostStorage } from '@fdw/editor-ui';
import './styles.css';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { WebEngine } from './engine';
import { createWebHost } from './host';
import { scenes } from './scenes';
import { indexedDbStorage } from './storage';

// The editor in Chromium, its engine on SwiftShader: the status bar tells
// the backend running and the frames drawn.

const engines: WebEngine[] = [];

function startEditor(backend: string | undefined) {
  const engine = new WebEngine({ backend, scene: 'shadows', scenes });
  engines.push(engine);
  const stored = new Map<string, unknown>();
  const storage: HostStorage = {
    read: async (key) => stored.get(key),
    write: async (key, value) => {
      stored.set(key, value);
    },
  };
  render(<EditorShell host={createWebHost(engine, storage)} />, {
    wrapper: StrictMode,
  });
  return engine;
}

// The status bar once the engine has drawn frames.
async function drawing(backend: string) {
  const status = await screen.findByText(
    (text) => text.startsWith(`${backend} · `) && /[1-9]\d* fps/.test(text),
    undefined,
    { timeout: 20_000 },
  );
  return status.textContent ?? '';
}

describe('the web editor', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(engines.map((engine) => engine.stop()));
    engines.length = 0;
  });

  it.each(['webgpu', 'webgl2'])(
    'shows the first scene on %s, its canvas the size of the viewport',
    async (backend) => {
      const engine = startEditor(backend);
      const status = await drawing(backend);
      expect(screen.queryByText(/^Fallback/)).toBeNull();
      const canvas = engine.element.querySelector('canvas');
      fillsViewport(canvas);
      expect(status).toContain(`${canvas?.width} × ${canvas?.height}`);
    },
    30_000,
  );

  it('runs WebGPU without FDW_BACKEND', async () => {
    startEditor(undefined);
    await drawing('webgpu');
  }, 30_000);

  it('falls back to WebGL2 on an unknown backend', async () => {
    startEditor('vulkan');
    await drawing('webgl2');
    expect(screen.getByText('Fallback: Unknown backend vulkan')).toBeTruthy();
  }, 30_000);
});

// The canvas the size of the area of the viewport, in device pixels.
function fillsViewport(canvas: HTMLCanvasElement | null) {
  const area = screen.getByTestId('viewport').getBoundingClientRect();
  const scale = window.devicePixelRatio;
  expect(canvas?.width).toBe(Math.round(area.width * scale));
  expect(canvas?.height).toBe(Math.round(area.height * scale));
}

describe('the layout of the web editor', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(engines.map((engine) => engine.stop()));
    engines.length = 0;
  });

  it('keeps the canvas through the docks hidden and the tabs changed', async () => {
    const engine = startEditor('webgpu');
    await drawing('webgpu');
    const canvas = engine.element.querySelector('canvas');
    const width = canvas?.width ?? 0;
    fillsViewport(canvas);

    // The docks hidden: the viewport grows.
    fireEvent.click(screen.getByRole('button', { name: 'Left dock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Right dock' }));
    // The bounds reach the canvas through the channel, late on a busy CI.
    await waitFor(() => expect(canvas?.width).toBeGreaterThan(width), {
      timeout: 10_000,
    });
    fillsViewport(canvas);

    // Behind another tab: hidden, still mounted, with its canvas.
    const menu = screen.getByRole('menuitem', { name: 'View' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitemcheckbox', {
        name: 'Welcome',
      }),
    );
    const viewport = screen.getByTestId('viewport');
    await waitFor(() =>
      expect(viewport.checkVisibility({ visibilityProperty: true })).toBe(
        false,
      ),
    );
    expect(engine.element.isConnected).toBe(true);
    expect(engine.element.querySelector('canvas')).toBe(canvas);

    // Back: the same canvas, drawn again, the size of the area.
    const tab = Array.from(document.querySelectorAll('.dv-tab')).find(
      (element) => element.textContent === 'Viewport',
    );
    fireEvent.pointerDown(tab as Element);
    fireEvent.click(tab as Element);
    await waitFor(() =>
      expect(viewport.checkVisibility({ visibilityProperty: true })).toBe(true),
    );
    expect(engine.element.querySelector('canvas')).toBe(canvas);
    fillsViewport(canvas);
    await drawing('webgpu');
  }, 30_000);
});

describe('the plugins of the web editor', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(engines.map((engine) => engine.stop()));
    engines.length = 0;
  });

  it('runs the tool of the sample plugin from the palette, its code loaded then', async () => {
    startEditor('webgl2');
    await drawing('webgl2');
    fireEvent.keyDown(window, {
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
    });
    const palette = await screen.findByRole('dialog');
    fireEvent.click(
      within(palette).getByRole('option', { name: 'Tool: Mark' }),
    );
    expect(await screen.findByText('Object mode · Mark')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Marks' }), {
      key: 'Enter',
    });
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Show the marks',
      }),
    );
    expect(await screen.findByText('Marking: 1 mark.')).toBeTruthy();
    // The viewport still drawn, beside the toolbar of the plugin.
    await drawing('webgl2');
  }, 30_000);
});

describe('the level in the web editor', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(engines.map((engine) => engine.stop()));
    engines.length = 0;
  });

  // A pointer event on the canvas, at a fraction of its size.
  function point(
    canvas: HTMLCanvasElement,
    type: string,
    x: number,
    y: number,
    buttons = 0,
  ) {
    const area = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent(type, {
        clientX: area.left + area.width * x,
        clientY: area.top + area.height * y,
        button: 0,
        buttons,
        pointerId: 1,
        bubbles: true,
      }),
    );
  }

  const selectedRows = () =>
    within(screen.getByRole('tree', { name: 'Level' }))
      .queryAllByRole('treeitem')
      .filter((row) => row.getAttribute('aria-selected') === 'true');

  it('selects in the viewport and in the tree, deletes, undoes', async () => {
    const engine = new WebEngine({ backend: 'webgpu', scene: 'level', scenes });
    engines.push(engine);
    render(
      <EditorShell
        host={createWebHost(engine, {
          read: async () => undefined,
          write: async () => undefined,
        })}
      />,
      { wrapper: StrictMode },
    );
    await drawing('webgpu');
    expect(await screen.findByText('cube 1')).toBeTruthy();

    // A rectangle over the whole view: the tools of the engine pick.
    const canvas = engine.element.querySelector('canvas') as HTMLCanvasElement;
    point(canvas, 'pointermove', 0.02, 0.02);
    point(canvas, 'pointerdown', 0.02, 0.02, 1);
    for (const t of [0.2, 0.5, 0.8, 0.98])
      point(canvas, 'pointermove', t, t, 1);
    await waitFor(() =>
      expect(screen.queryAllByTestId('selection-rectangle')).toHaveLength(4),
    );
    point(canvas, 'pointerup', 0.98, 0.98);
    await waitFor(() => expect(selectedRows().length).toBeGreaterThan(4), {
      timeout: 5000,
    });
    expect(screen.queryAllByTestId('selection-rectangle')).toHaveLength(0);

    // The tree selects one, the inspector shows it.
    fireEvent.click(screen.getByText('cube 2'));
    await waitFor(() =>
      expect(selectedRows().map((row) => row.textContent)).toEqual(['cube 2']),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
        'cube 2',
      ),
    );

    // Deleted from the keyboard, back with Ctrl+Z.
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    await waitFor(() => expect(screen.queryByText('cube 2')).toBeNull());
    expect(screen.getByText(/Delete cube 2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(await screen.findByText('cube 2')).toBeTruthy();
    await drawing('webgpu');
  }, 30_000);
});

describe('indexedDbStorage', () => {
  it('keeps JSON documents by key', async () => {
    const name = `fdw-editor-test-${Math.random()}`;
    const storage = indexedDbStorage(name);
    expect(await storage.read('layout')).toBeUndefined();
    await storage.write('layout', { outlinerOpen: false, gone: undefined });
    // Another connection to the same database.
    expect(await indexedDbStorage(name).read('layout')).toEqual({
      outlinerOpen: false,
    });
    await expect(storage.write('../layout', {})).rejects.toThrow(
      'Invalid storage key',
    );
  });
});
