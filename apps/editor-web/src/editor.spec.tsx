import { EditorShell, type HostStorage } from '@fdw/editor-ui';
import '@fdw/editor-ui/styles.css';
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
    await waitFor(() => expect(canvas?.width).toBeGreaterThan(width));
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
