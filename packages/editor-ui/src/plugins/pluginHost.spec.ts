import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachine } from 'xstate';
import { createEngineStore } from '../state/engineStore';
import {
  createEditorRuntime,
  IEditorMachine,
  type EditorRuntime,
} from '../state/runtime';
import { serviceId } from '../state/services';
import { fakeHost } from '../testing';
import type { PluginManifest } from './manifest';
import {
  preparePlugins,
  type EditorPlugin,
  type PluginContext,
  type PluginModule,
} from './pluginHost';

const manifest = {
  id: 'acme.tools',
  title: 'Acme tools',
  version: '1.2.0',
  engine: '^1.0.0',
  contributes: {
    commands: [{ id: 'acme.run', title: 'Run' }],
    views: [{ id: 'acme.view', title: 'View', location: 'right' }],
    menus: { 'acme.menu': [{ command: 'acme.run' }] },
    toolbars: [
      { id: 'acme.bar', title: 'Bar', items: ['acme.run', 'acme.tool'] },
    ],
    statusBar: [{ id: 'acme.status' }],
    keybindings: [{ command: 'acme.run', key: 'ctrl+r' }],
    tools: [{ id: 'acme.tool', title: 'Tool', slot: 'primary' }],
    modes: [{ id: 'acme.mode', title: 'Mode' }],
  },
} as const satisfies PluginManifest;

interface Service {
  dispose(): void;
}
const IAcme = serviceId<Service>('acme.service');

// A plugin whose code is a spy: what activate registers, and when.
function acmePlugin(activate?: (context: PluginContext) => void) {
  const service = { dispose: vi.fn() };
  const module: PluginModule = {
    activate: vi.fn((context: PluginContext) => {
      context.commands.register('acme.run', () => 'ran');
      context.views.registerComponent('acme.view', () => null);
      context.statusBar.registerComponent('acme.status', () => null);
      context.tools.register('acme.tool', () =>
        createMachine({ initial: 'on', states: { on: {} } }),
      );
      context.modes.register('acme.mode');
      context.services.register(IAcme, () => service, { lazy: false });
      activate?.(context);
    }),
    deactivate: vi.fn(),
  };
  const load = vi.fn(async () => module);
  const plugin: EditorPlugin = { manifest, load };
  return { plugin, module, load, service };
}

const runtimes: EditorRuntime[] = [];

function startRuntime(
  plugins: Parameters<typeof createEditorRuntime>[0]['plugins'] = [],
  saved?: Parameters<typeof createEditorRuntime>[0]['saved'],
) {
  const runtime = createEditorRuntime({
    host: fakeHost().host,
    engine: createEngineStore(),
    plugins,
    ...(saved && { saved }),
  });
  runtimes.push(runtime);
  return runtime;
}

describe('PluginHost', () => {
  afterEach(() => {
    runtimes.splice(0).forEach((runtime) => runtime.dispose());
  });

  it('declares the contributions of a plugin without loading it', () => {
    const { plugin, load } = acmePlugin();
    const runtime = startRuntime([{ plugin }]);
    expect(load).not.toHaveBeenCalled();
    expect(runtime.plugins.info('acme.tools')).toMatchObject({
      title: 'Acme tools',
      version: '1.2.0',
      status: 'inactive',
      builtin: false,
    });
    expect(runtime.commands.specs.get('acme.run')?.plugin).toBe('acme.tools');
    // The tool and the mode are commands too.
    expect(runtime.commands.specs.get('acme.tool')).toMatchObject({
      title: 'Tool',
      toggled: 'tool.primary == acme.tool',
    });
    expect(runtime.views.get('acme.view')?.location).toBe('right');
    expect(runtime.menus.items('acme.menu')).toEqual([{ command: 'acme.run' }]);
    expect(runtime.toolbars.get('acme.bar')?.items).toHaveLength(2);
    expect(runtime.statusBar.get('acme.status')).toBeTruthy();
    expect(runtime.keybindings.all().map((binding) => binding.key)).toEqual([
      'ctrl+r',
    ]);
    // Not before activated.
    expect(runtime.tools.get('acme.tool')).toBeUndefined();
    expect(runtime.keys.values()['toolbar.acme.bar']).toBe('top');
  });

  it('activates a plugin at its first event, once', async () => {
    const { plugin, module, load } = acmePlugin();
    const runtime = startRuntime([{ plugin }]);
    await runtime.plugins.activateByEvent('onView:other');
    expect(load).not.toHaveBeenCalled();
    await Promise.all([
      runtime.plugins.activateByEvent('onView:acme.view'),
      runtime.plugins.activateByEvent('onCommand:acme.run'),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(module.activate).toHaveBeenCalledTimes(1);
    expect(runtime.plugins.info('acme.tools')?.status).toBe('active');
    expect(runtime.viewComponents.get('acme.view')).toBeTruthy();
    expect(runtime.tools.get('acme.tool')?.slot).toBe('primary');
  });

  it('activates the plugin of a command run, of a tool activated', async () => {
    const { plugin } = acmePlugin();
    const runtime = startRuntime([{ plugin }]);
    expect(await runtime.commands.execute('acme.run')).toBe('ran');

    const other = acmePlugin();
    const second = startRuntime([{ plugin: other.plugin }]);
    await second.commands.execute('acme.tool');
    expect(second.machine.getSnapshot().context.tools.primary).toBe(
      'acme.tool',
    );
    expect(second.keys.matches('tool.primary == acme.tool')).toBe(true);
    // Run again, the tool ends.
    await second.commands.execute('acme.tool');
    expect(second.machine.getSnapshot().context.tools.primary).toBeUndefined();
    await second.commands.execute('acme.mode');
    expect(second.machine.getSnapshot().context.mode).toBe('acme.mode');
  });

  it('gives the plugin its scope of services and its state', async () => {
    let context: PluginContext | undefined;
    const { plugin, service } = acmePlugin((given) => (context = given));
    const runtime = startRuntime([{ plugin }]);
    await runtime.plugins.activate('acme.tools');
    expect(context?.services.get(IAcme)).toBe(service);
    // Not seen from the editor.
    expect(runtime.services.has(IAcme)).toBe(false);
    context?.state.set({ count: 1 });
    expect(runtime.editor.getSnapshot().context.plugins['acme.tools']).toEqual({
      count: 1,
    });
    expect(context?.state.get()).toEqual({ count: 1 });
    expect(runtime.persist().plugins).toEqual({ 'acme.tools': { count: 1 } });
  });

  it('refuses a registration its manifest does not declare', async () => {
    const { plugin } = acmePlugin((context) => {
      context.views.registerComponent('acme.other', () => null);
    });
    const runtime = startRuntime([{ plugin }]);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await runtime.plugins.activate('acme.tools');
    expect(runtime.plugins.info('acme.tools')).toMatchObject({
      status: 'failed',
      error: 'The plugin acme.tools declares no view acme.other',
    });
    // What it registered before is gone.
    expect(runtime.viewComponents.get('acme.view')).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    // Not activated again until enabled.
    await runtime.plugins.activateByEvent('onView:acme.view');
    expect(runtime.plugins.info('acme.tools')?.status).toBe('failed');
  });

  it('disposes what a plugin registered when deactivated, its tool ended', async () => {
    const { plugin, module, service } = acmePlugin();
    const runtime = startRuntime([{ plugin }]);
    await runtime.commands.execute('acme.tool');
    expect(runtime.machine.getSnapshot().context.tools.primary).toBe(
      'acme.tool',
    );
    await runtime.plugins.disable('acme.tools');
    expect(module.deactivate).toHaveBeenCalled();
    expect(service.dispose).toHaveBeenCalled();
    expect(runtime.plugins.info('acme.tools')?.status).toBe('disabled');
    expect(runtime.machine.getSnapshot().context.tools.primary).toBeUndefined();
    expect(runtime.viewComponents.get('acme.view')).toBeUndefined();
    // Still declared, but not activated while disabled.
    expect(runtime.views.get('acme.view')).toBeTruthy();
    await runtime.plugins.activateByEvent('onView:acme.view');
    expect(runtime.viewComponents.get('acme.view')).toBeUndefined();
    runtime.plugins.enable('acme.tools');
    await runtime.plugins.activateByEvent('onView:acme.view');
    expect(runtime.viewComponents.get('acme.view')).toBeTruthy();
    expect(module.activate).toHaveBeenCalledTimes(2);
  });

  it('keeps a built-in plugin enabled', async () => {
    const { plugin } = acmePlugin();
    const runtime = startRuntime([{ plugin, builtin: true }]);
    await expect(runtime.plugins.disable('acme.tools')).rejects.toThrow(
      'The plugin acme.tools is built in',
    );
  });

  it('makes invalid a plugin whose manifest is not one, or whose ids are taken', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const runtime = startRuntime([
      { plugin: acmePlugin().plugin },
      {
        plugin: {
          manifest: { ...manifest, id: 'acme.again' },
          load: () => ({}),
        },
      },
      {
        plugin: {
          manifest: { id: 'acme.old', version: '1.0.0', engine: '^0.1.0' },
          load: () => ({}),
        },
      },
    ]);
    expect(
      runtime.plugins
        .infos()
        .map(({ id, status, error }) => ({ id, status, error })),
    ).toEqual([
      { id: 'acme.tools', status: 'inactive', error: undefined },
      {
        id: 'acme.again',
        status: 'invalid',
        error: 'The command acme.run is already registered',
      },
      {
        id: 'acme.old',
        status: 'invalid',
        error: 'manifest.engine ^0.1.0 does not accept the API 1.0.0',
      },
    ]);
    // The contributions of the invalid one left out.
    expect(runtime.commands.specs.all()).toHaveLength(3);
    error.mockRestore();
  });

  it('restores a tool whose plugin is loaded before the machine', async () => {
    const first = acmePlugin();
    const runtime = startRuntime([{ plugin: first.plugin }]);
    await runtime.commands.execute('acme.tool');
    const saved = runtime.persist();

    const second = acmePlugin();
    const prepared = await preparePlugins(
      [{ plugin: second.plugin }],
      ['onStartup', 'onTool:acme.tool'],
    );
    expect(second.load).toHaveBeenCalledTimes(1);
    const restored = startRuntime(prepared, saved);
    expect(restored.machine.getSnapshot().context.tools.primary).toBe(
      'acme.tool',
    );

    // Without its plugin: idle.
    const without = startRuntime([], saved);
    expect(without.machine.getSnapshot().context.tools.primary).toBeUndefined();
  });

  it('warns when a plugin reads the machine while the plugins of the start activate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { plugin } = acmePlugin((context) => {
      context.services.get(IEditorMachine);
    });
    const prepared = await preparePlugins([{ plugin }], ['onTool:acme.tool']);
    startRuntime(prepared);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the tools kept may not restore'),
    );
    warn.mockRestore();
  });

  it('loads only the plugins of the events', async () => {
    const lazy = acmePlugin();
    const eager = {
      manifest: {
        ...manifest,
        id: 'acme.eager',
        contributes: {},
        activationEvents: ['onStartup'],
      },
      load: vi.fn(() => ({})),
    };
    const prepared = await preparePlugins(
      [{ plugin: lazy.plugin }, { plugin: eager, builtin: true }],
      ['onStartup'],
    );
    expect(lazy.load).not.toHaveBeenCalled();
    expect(eager.load).toHaveBeenCalled();
    expect(prepared[0]?.module).toBeUndefined();
    expect(prepared[1]).toMatchObject({ builtin: true, module: {} });
  });
});
