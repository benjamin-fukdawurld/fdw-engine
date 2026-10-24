import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
// StrictMode, as in the applications: a remount at the first mount.
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMachine } from 'xstate';
import { EditorShell } from './EditorShell';
import type { EditorHost } from './host';
import type { Layout } from './layout';
import type { PluginManifest } from './plugins/manifest';
import type { EditorPlugin, PluginContext } from './plugins/pluginHost';
import type { EngineMessage } from './protocol';
import type { EditorRuntime } from './state/runtime';
import { fakeHost as makeFakeHost, readyMessage, stubLayout } from './testing';

beforeAll(stubLayout);

// The fake host, the messages of the engine sent in act.
function fakeHost(...args: Parameters<typeof makeFakeHost>) {
  const fake = makeFakeHost(...args);
  return {
    ...fake,
    send: (message: EngineMessage) => act(() => fake.send(message)),
  };
}

const ready = readyMessage;

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

// Places a toolbar from View, Toolbars: on a side, or hidden.
function placeToolbar(toolbar: string, side: string) {
  fireEvent.keyDown(
    within(openMenu('View')).getByRole('menuitem', { name: 'Toolbars' }),
    { key: 'ArrowRight' },
  );
  const menus = () => screen.getAllByRole('menu');
  fireEvent.keyDown(
    within(menus().at(-1) as HTMLElement).getByRole('menuitem', {
      name: toolbar,
    }),
    { key: 'ArrowRight' },
  );
  fireEvent.click(
    within(menus().at(-1) as HTMLElement).getByRole('menuitemradio', {
      name: side,
    }),
  );
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

// Renders the shell; the runtime once made.
async function renderShell(host: EditorHost) {
  let runtime: EditorRuntime | undefined;
  const view = render(
    <EditorShell host={host} onRuntime={(made) => (runtime = made)} />,
    { wrapper: StrictMode },
  );
  await screen.findByTestId('viewport');
  if (!runtime) throw new Error('No runtime');
  return { ...view, runtime };
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
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expect(screen.getByText('Fake host')).toBeTruthy();
    expect(screen.getByText('Starting the engine…')).toBeTruthy();
  });

  it('lays out the panels around the viewport', async () => {
    const { host } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
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

  it('shows the device and the stats of the engine, sent before the layout is read', async () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    send(ready);
    send({
      type: 'stats',
      fps: 60,
      cpu: 1.24,
      gpu: 0.5,
      width: 800,
      height: 600,
      info: '',
    });
    expect(
      await screen.findByText(
        'vulkan · GPU · 60 fps (CPU 1.2 ms, GPU 0.5 ms) · 800 × 600',
      ),
    ).toBeTruthy();
    send({ type: 'stats', fps: 60, cpu: 2, width: 800, height: 600, info: '' });
    expect(
      await screen.findByText('vulkan · GPU · 60 fps (CPU 2.0 ms) · 800 × 600'),
    ).toBeTruthy();
    send({ type: 'error', message: 'Lost' });
    expect(screen.getAllByText('Lost')).toBeTruthy();
  });

  it('shows why the backend is a fallback', async () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    send({ ...ready, backend: 'dawn', fallback: 'vulkan: No device' });
    expect(await screen.findByText('dawn · GPU')).toBeTruthy();
    expect(screen.getByText('Fallback: vulkan: No device')).toBeTruthy();
  });

  it('writes what the engine does in the console', async () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    await screen.findByTestId('viewport');
    send(ready);
    send({ type: 'loading', scene: 'b' });
    expect(await screen.findByText('Engine ready: vulkan · GPU')).toBeTruthy();
    expect(screen.getByText('Loading b')).toBeTruthy();
  });

  it('asks the engine for the scene chosen in the menu', async () => {
    const { host, posted, send } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    await screen.findByTestId('viewport');
    send(ready);
    chooseInMenu('Scene', 'b');
    expect(posted).toContainEqual({ type: 'scene', name: 'b' });
  });

  it('hides a dock, and keeps it hidden in the storage of the host', async () => {
    const { host, stored } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
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
    const { container } = render(<EditorShell host={host} />, {
      wrapper: StrictMode,
    });
    await screen.findByTestId('viewport');
    const side = () =>
      screen
        .queryByRole('toolbar', { name: 'Docks' })
        ?.parentElement?.getAttribute('data-side');
    expect(side()).toBe('top');
    placeToolbar('Docks', 'Right');
    expect(side()).toBe('right');
    expect(
      screen
        .getByRole('toolbar', { name: 'Docks' })
        .getAttribute('aria-orientation'),
    ).toBe('vertical');
    placeToolbar('Docks', 'Hidden');
    expect(side()).toBeUndefined();
    expect(screen.queryByRole('toolbar', { name: 'Docks' })).toBeNull();
    expect(container.querySelector('[data-side=right]')).toBeNull();
  });

  it('keeps the viewport mounted behind another tab and with the docks hidden', async () => {
    const { host, viewport } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    await screen.findByTestId('viewport');
    const mounts = viewport.mounts;
    chooseInMenu('View', 'Welcome');
    await waitFor(() => expect(tabs()).toContain('Welcome'));
    for (const dock of ['Left dock', 'Right dock', 'Bottom dock']) {
      fireEvent.click(screen.getByRole('button', { name: dock }));
    }
    expect(screen.getByTestId('viewport')).toBeTruthy();
    expect(viewport.mounts).toBe(mounts);
  });

  it('restores the layout of the host', async () => {
    const first = fakeHost();
    const { unmount } = render(<EditorShell host={first.host} />, {
      wrapper: StrictMode,
    });
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
    render(<EditorShell host={second.host} />, { wrapper: StrictMode });
    await screen.findByTestId('viewport');
    await waitFor(() => expect(tabs()).toContain('Welcome'));
    expect(tabs()).not.toContain('Console');
    // No status bar.
    expect(screen.queryByText('Starting the engine…')).toBeNull();
  });

  it('starts from the default layout when the saved one is not of this version', async () => {
    const { host } = fakeHost({ layout: { outlinerOpen: false } });
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    await screen.findByTestId('viewport');
    await waitFor(() => expect(tabs()).toContain('Outliner'));
  });

  it('resets the layout', async () => {
    const { host, stored } = fakeHost();
    render(<EditorShell host={host} />, { wrapper: StrictMode });
    await screen.findByTestId('viewport');
    chooseInMenu('View', 'Outliner');
    chooseInMenu('View', 'Right dock');
    await waitFor(() => expect(tabs()).not.toContain('Outliner'));
    chooseInMenu('View', 'Reset layout');
    await waitFor(() => expect(tabs()).toContain('Outliner'));
    await storedLayout(stored, (saved) => saved?.docks.right === true);
  });

  it('follows the focus of the areas', async () => {
    const { runtime } = await renderShell(fakeHost().host);
    const focus = () => runtime.machine.getSnapshot().context.focus;
    fireEvent.pointerDown(screen.getByText('Nothing selected.'));
    expect(focus()).toEqual({ area: 'right', view: 'inspector' });
    fireEvent.focus(screen.getByTestId('viewport'));
    expect(focus()).toEqual({ area: 'center', view: 'viewport' });
    // Opened, a panel gets the focus.
    chooseInMenu('View', 'Welcome');
    expect(focus()).toEqual({ area: 'center', view: 'welcome' });
  });

  it('derives the context keys from the engine and the editor', async () => {
    const { host, send } = fakeHost();
    const { runtime } = await renderShell(host);
    expect(runtime.keys.matches('engine.ready')).toBe(false);
    send(ready);
    expect(runtime.keys.values()).toMatchObject({
      'engine.ready': true,
      'engine.backend': 'vulkan',
      'editor.mode': 'object',
      'scene.hasSelection': false,
    });
    expect(
      runtime.keys.matches('engine.backend == vulkan && !scene.hasSelection'),
    ).toBe(true);
    act(() => runtime.editor.trigger.select({ ids: ['cube'] }));
    expect(runtime.keys.matches('scene.hasSelection')).toBe(true);
  });

  it('shows the mode and the tools, and keeps them with the layout', async () => {
    const { host, stored } = fakeHost();
    const { runtime, unmount } = await renderShell(host);
    expect(screen.getByText('Object mode')).toBeTruthy();
    act(() => {
      runtime.tools.register({
        id: 'acme.move',
        title: 'Move',
        slot: 'primary',
        create: () => createMachine({}),
      });
      runtime.machine.send({ type: 'TOOL.ACTIVATE', tool: 'acme.move' });
    });
    expect(screen.getByText('Object mode · Move')).toBeTruthy();
    const layout = await storedLayout(stored, (saved) =>
      JSON.stringify(saved?.machine).includes('acme.move'),
    );
    unmount();

    // Restored without the tool: idle.
    const second = fakeHost({ layout });
    await renderShell(second.host);
    expect(screen.getByText('Object mode')).toBeTruthy();
  });

  it('disposes its runtime once unmounted', async () => {
    const { runtime, unmount } = await renderShell(fakeHost().host);
    unmount();
    expect(runtime.machine.getSnapshot().status).toBe('stopped');
  });

  it('stops listening to the engine once unmounted', () => {
    const { host, listeners } = fakeHost();
    const { unmount } = render(<EditorShell host={host} />, {
      wrapper: StrictMode,
    });
    // The state of the engine, and the projection of its level.
    expect(listeners.size).toBe(2);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

// A plugin loaded at its first event: a panel, a command in a menu and a
// toolbar, a tool.
function lazyPlugin() {
  const manifest = {
    id: 'acme.notes',
    title: 'Notes',
    version: '1.0.0',
    engine: '^1.0.0',
    contributes: {
      commands: [
        { id: 'acme.notes.clear', title: 'Clear the notes', category: 'Notes' },
      ],
      views: [{ id: 'acme.notes', title: 'Notes', location: 'right' }],
      menus: {
        menubar: [{ submenu: 'acme.menu', title: 'Notes', order: 30 }],
        'acme.menu': [{ command: 'acme.notes.clear' }, { command: 'acme.pen' }],
      },
      toolbars: [{ id: 'acme.bar', title: 'Notes bar', items: ['acme.pen'] }],
      tools: [
        { id: 'acme.pen', title: 'Pen', slot: 'primary', icon: 'pencil' },
      ],
      keybindings: [{ command: 'acme.notes.clear', key: 'ctrl+alt+n' }],
    },
  } as const satisfies PluginManifest;
  const cleared = vi.fn();
  const load = vi.fn(async () => ({
    activate: (context: PluginContext) => {
      context.views.registerComponent('acme.notes', () => <p>Some notes</p>);
      context.commands.register('acme.notes.clear', cleared);
      context.tools.register('acme.pen', () => createMachine({}));
    },
  }));
  return { plugin: { manifest, load } satisfies EditorPlugin, load, cleared };
}

describe('EditorShell, with plugins', () => {
  afterEach(cleanup);

  it('lists the panels of the plugins, and loads one when it is shown', async () => {
    const { plugin, load } = lazyPlugin();
    await renderShell(fakeHost({}, [plugin]).host);
    expect(load).not.toHaveBeenCalled();
    chooseInMenu('View', 'Notes');
    expect(await screen.findByText('Some notes')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('runs a command of a plugin from its menu, and from its key', async () => {
    const { plugin, cleared } = lazyPlugin();
    await renderShell(fakeHost({}, [plugin]).host);
    chooseInMenu('Notes', 'Clear the notes');
    await waitFor(() => expect(cleared).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, {
      key: 'n',
      code: 'KeyN',
      ctrlKey: true,
      altKey: true,
    });
    await waitFor(() => expect(cleared).toHaveBeenCalledTimes(2));
  });

  it('activates a tool from a toolbar, pressed while active; Escape ends it', async () => {
    const { plugin } = lazyPlugin();
    const { runtime } = await renderShell(fakeHost({}, [plugin]).host);
    const pen = within(
      screen.getByRole('toolbar', { name: 'Notes bar' }),
    ).getByRole('button', { name: 'Pen' });
    expect(pen.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pen);
    await waitFor(() => expect(pen.getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByText('Object mode · Pen')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(runtime.machine.getSnapshot().context.tools.primary).toBeUndefined();
    expect(pen.getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the command palette and runs the command chosen', async () => {
    const { plugin, cleared } = lazyPlugin();
    const { runtime } = await renderShell(fakeHost({}, [plugin]).host);
    fireEvent.keyDown(window, {
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
    });
    const palette = await screen.findByRole('dialog');
    const option = (name: string) =>
      within(palette).queryByRole('option', { name });
    expect(option('View: Left dock')).toBeTruthy();
    expect(option('Notes: Clear the notes')).toBeTruthy();
    expect(option('Tool: Pen')).toBeTruthy();
    // Not enabled without a tool.
    expect(option('Editor: Cancel the tools')).toBeNull();
    // Nor those that need arguments.
    expect(option('Show or hide a panel')).toBeNull();
    fireEvent.click(within(palette).getByRole('option', { name: /Left dock/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(runtime.editor.getSnapshot().context.docks.left).toBe(false);
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('option', {
        name: /Clear the notes/,
      }),
    );
    await waitFor(() => expect(cleared).toHaveBeenCalled());
  });

  it('keeps the panel of a missing plugin in the layout', async () => {
    const { plugin } = lazyPlugin();
    const first = fakeHost({}, [plugin]);
    const { unmount } = await renderShell(first.host);
    chooseInMenu('View', 'Notes');
    await screen.findByText('Some notes');
    await storedLayout(
      first.stored,
      (saved) => 'acme.notes' in (saved?.areas.right?.panels ?? {}),
    );
    unmount();

    // Without the plugin: its tab stays, the view tells it is missing.
    await renderShell(fakeHost(Object.fromEntries(first.stored)).host);
    await waitFor(() => expect(tabs()).toContain('Notes'));
    expect(
      screen.getByText(
        'No plugin gives the view acme.notes: its plugin is missing.',
      ),
    ).toBeTruthy();
    // Not in the View menu.
    expect(
      within(openMenu('View')).queryByRole('menuitemcheckbox', {
        name: 'Notes',
      }),
    ).toBeNull();
  });

  it('lists the plugins, and disables one', async () => {
    const { plugin } = lazyPlugin();
    const { runtime } = await renderShell(fakeHost({}, [plugin]).host);
    chooseInMenu('View', 'Notes');
    await screen.findByText('Some notes');
    chooseInMenu('View', 'Plugins');
    const item = (await screen.findByText('acme.notes · Active')).closest('li');
    expect(screen.getByText('fdw.workbench · Active · built in')).toBeTruthy();
    fireEvent.click(
      within(item as HTMLElement).getByRole('button', { name: 'Disable' }),
    );
    expect(
      await screen.findByText('The plugin acme.notes is disabled.'),
    ).toBeTruthy();
    expect(runtime.plugins.info('acme.notes')?.status).toBe('disabled');
    fireEvent.click(
      within(item as HTMLElement).getByRole('button', { name: 'Enable' }),
    );
    // Its panel open, activated again.
    expect(await screen.findByText('Some notes')).toBeTruthy();
  });
});
