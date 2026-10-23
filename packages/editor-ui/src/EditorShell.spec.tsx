import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EditorShell } from './EditorShell';
import type { EditorHost, EngineConnection } from './host';
import type { Layout } from './layout';
import type { EngineMessage, PageMessage } from './protocol';

// jsdom has no ResizeObserver, which dockview watches its element with: the
// layout itself is tested in Chromium (apps/editor-web).
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {
      // Never resized.
    }
    unobserve() {
      // Nothing observed.
    }
    disconnect() {
      // Nothing observed.
    }
  };
});

// A host without engine: the messages of the page are kept, those of the
// engine sent by the test. The viewport counts its mounts.
function fakeHost(saved: Record<string, unknown> = {}) {
  const posted: PageMessage[] = [];
  const listeners = new Set<(message: EngineMessage) => void>();
  const engine: EngineConnection = {
    post: (message) => posted.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const stored = new Map<string, unknown>(Object.entries(saved));
  const viewport = { mounts: 0 };
  const host: EditorHost = {
    engine,
    Viewport: function Viewport() {
      useEffect(() => {
        viewport.mounts++;
      }, []);
      return <div data-testid="viewport" />;
    },
    files: {
      open: async () => undefined,
      save: async () => false,
    },
    storage: {
      read: async (key) => stored.get(key),
      write: async (key, value) => {
        stored.set(key, value);
      },
    },
    popoutUrl: 'popout.html',
    about: 'Fake host',
  };
  const send = (message: EngineMessage) =>
    act(() => listeners.forEach((listener) => listener(message)));
  return { host, posted, send, listeners, stored, viewport };
}

const ready: EngineMessage = {
  type: 'ready',
  backend: 'vulkan',
  device: 'GPU',
  scenes: ['a', 'b'],
  scene: 'a',
};

// Opens a menu of the menu bar, by the keyboard (jsdom has no PointerEvent).
function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('menuitem', { name }), { key: 'Enter' });
  return screen.getByRole('menu');
}

// Chooses an item of a menu: a command, a checkbox or a radio item.
function chooseInMenu(menu: string, name: string) {
  const items = within(openMenu(menu));
  const item =
    items.queryByRole('menuitem', { name }) ??
    items.queryByRole('menuitemcheckbox', { name }) ??
    items.getByRole('menuitemradio', { name });
  fireEvent.click(item);
}

// The layout written by the shell, once its changes settle.
async function storedLayout(
  stored: Map<string, unknown>,
  check: (layout: Layout) => boolean,
) {
  await waitFor(() => {
    expect(check(stored.get('layout') as Layout)).toBe(true);
  });
  return stored.get('layout') as Layout;
}

// The title of the tabs of dockview.
const tabs = () =>
  Array.from(document.querySelectorAll('.dv-tab')).map(
    (tab) => tab.textContent,
  );

describe('EditorShell', () => {
  afterEach(cleanup);

  it('shows the viewport of the host and what it tells of itself', async () => {
    const { host } = fakeHost();
    render(<EditorShell host={host} />);
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expect(screen.getByText('Fake host')).toBeTruthy();
    expect(screen.getByText('Starting the engine…')).toBeTruthy();
  });

  it('lays out the panels around the viewport', async () => {
    const { host } = fakeHost();
    render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    await waitFor(() =>
      expect(tabs()).toEqual(
        expect.arrayContaining([
          'Viewport',
          'Outliner',
          'Inspector',
          'Console',
        ]),
      ),
    );
    expect(screen.getByRole('toolbar', { name: 'Docks' })).toBeTruthy();
  });

  it('shows the device and the stats of the engine', () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />);
    send(ready);
    send({ type: 'stats', fps: 60, width: 800, height: 600, info: '' });
    expect(screen.getByText('vulkan · GPU · 60 fps · 800 × 600')).toBeTruthy();
    send({ type: 'error', message: 'Lost' });
    expect(screen.getAllByText('Lost')).toBeTruthy();
  });

  it('shows why the backend is a fallback', () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />);
    send({ ...ready, backend: 'dawn', fallback: 'vulkan: No device' });
    expect(screen.getByText('dawn · GPU')).toBeTruthy();
    expect(screen.getByText('Fallback: vulkan: No device')).toBeTruthy();
  });

  it('writes what the engine does in the console', async () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    send(ready);
    send({ type: 'loading', scene: 'b' });
    expect(await screen.findByText('Engine ready: vulkan · GPU')).toBeTruthy();
    expect(screen.getByText('Loading b')).toBeTruthy();
  });

  it('asks the engine for the scene chosen in the menu', () => {
    const { host, posted, send } = fakeHost();
    render(<EditorShell host={host} />);
    send(ready);
    chooseInMenu('Scene', 'b');
    expect(posted).toContainEqual({ type: 'scene', name: 'b' });
  });

  it('hides a dock, and keeps it hidden in the storage of the host', async () => {
    const { host, stored } = fakeHost();
    render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    chooseInMenu('View', 'Left dock');
    const button = screen.getByRole('button', { name: 'Left dock' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    const layout = await storedLayout(
      stored,
      (saved) => saved?.docks.left === false,
    );
    expect(layout.docks).toEqual({ left: false, right: true, bottom: true });
    expect(layout.grid).toBeTruthy();
    expect(Object.keys(layout.areas).sort()).toEqual([
      'bottom',
      'center',
      'left',
      'right',
    ]);
  });

  it('moves a toolbar to another side, and hides it', async () => {
    const { host } = fakeHost();
    const { container } = render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    const side = () =>
      screen
        .queryByRole('toolbar', { name: 'Docks' })
        ?.parentElement?.getAttribute('data-side');
    expect(side()).toBe('top');
    fireEvent.keyDown(
      within(openMenu('View')).getByRole('menuitem', { name: 'Toolbars' }),
      { key: 'ArrowRight' },
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Right' }));
    expect(side()).toBe('right');
    expect(
      screen
        .getByRole('toolbar', { name: 'Docks' })
        .getAttribute('aria-orientation'),
    ).toBe('vertical');
    fireEvent.keyDown(
      within(openMenu('View')).getByRole('menuitem', { name: 'Toolbars' }),
      { key: 'ArrowRight' },
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Hidden' }));
    expect(side()).toBeUndefined();
    expect(container.querySelector('[data-side]')).toBeNull();
  });

  it('keeps the viewport mounted behind another tab and with the docks hidden', async () => {
    const { host, viewport } = fakeHost();
    render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    chooseInMenu('View', 'Welcome');
    await waitFor(() => expect(tabs()).toContain('Welcome'));
    for (const dock of ['Left dock', 'Right dock', 'Bottom dock']) {
      fireEvent.click(screen.getByRole('button', { name: dock }));
    }
    expect(screen.getByTestId('viewport')).toBeTruthy();
    expect(viewport.mounts).toBe(1);
  });

  it('restores the layout of the host', async () => {
    const first = fakeHost();
    const { unmount } = render(<EditorShell host={first.host} />);
    await screen.findByTestId('viewport');
    chooseInMenu('View', 'Welcome');
    chooseInMenu('View', 'Console');
    chooseInMenu('View', 'Status bar');
    await storedLayout(
      first.stored,
      (saved) =>
        saved?.statusBar === false &&
        !('console' in (saved.areas.bottom?.panels ?? {})),
    );
    unmount();

    const second = fakeHost(Object.fromEntries(first.stored));
    render(<EditorShell host={second.host} />);
    await screen.findByTestId('viewport');
    await waitFor(() => expect(tabs()).toContain('Welcome'));
    expect(tabs()).not.toContain('Console');
    // No status bar.
    expect(screen.queryByText('Starting the engine…')).toBeNull();
  });

  it('starts from the default layout when the saved one is not of this version', async () => {
    const { host } = fakeHost({ layout: { outlinerOpen: false } });
    render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    await waitFor(() => expect(tabs()).toContain('Outliner'));
  });

  it('resets the layout', async () => {
    const { host, stored } = fakeHost();
    render(<EditorShell host={host} />);
    await screen.findByTestId('viewport');
    chooseInMenu('View', 'Outliner');
    chooseInMenu('View', 'Right dock');
    await waitFor(() => expect(tabs()).not.toContain('Outliner'));
    chooseInMenu('View', 'Reset layout');
    await waitFor(() => expect(tabs()).toContain('Outliner'));
    await storedLayout(stored, (saved) => saved?.docks.right === true);
  });

  it('stops listening to the engine once unmounted', () => {
    const { host, listeners } = fakeHost();
    const { unmount } = render(<EditorShell host={host} />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
