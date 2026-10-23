import type { ComponentType } from 'react';
import type { AnyActorLogic } from 'xstate';
import type { ContextKeys } from '../state/contextKeys';
import type {
  EditorActor,
  ModeContext,
  ModeSpec,
  ToolContext,
  ToolSpec,
} from '../state/editorMachine';
import type { EditorStore } from '../state/editorStore';
import type { Registry } from '../state/registry';
import type { IDisposable, ServiceRegistry } from '../state/services';
import type {
  CommandHandler,
  CommandService,
  ComponentSpec,
  KeybindingSpec,
  MenuRegistry,
  StatusBarSpec,
  ToolbarSpec,
  ViewSpec,
} from './contributions';
import {
  activationEvents,
  readManifest,
  type MenuItem,
  type PluginManifest,
} from './manifest';

/** What `activate` is given (design/editor-ui.md §6). */
export interface PluginContext {
  readonly id: string;
  readonly manifest: PluginManifest;
  /**
   * The services of the plugin, in its own scope: those of the editor
   * (`IEditorStore`, `IEngineConnection`…), and those it registers, disposed
   * when it is deactivated.
   */
  readonly services: ServiceRegistry;
  /**
   * Disposed when the plugin is deactivated, the last first. The
   * registrations below are added to it.
   */
  readonly subscriptions: IDisposable[];
  readonly commands: {
    /** The handler of a command of its manifest. */
    register(id: string, handler: CommandHandler): IDisposable;
    execute(id: string, ...args: readonly unknown[]): Promise<unknown>;
  };
  readonly views: {
    /** The component of a view of its manifest. */
    registerComponent(id: string, component: ComponentType): IDisposable;
  };
  readonly statusBar: {
    /** The component of an item of the status bar of its manifest. */
    registerComponent(id: string, component: ComponentType): IDisposable;
  };
  readonly menus: {
    /** An item made by its code: one per panel, per scene. */
    append(menu: string, item: MenuItem): IDisposable;
  };
  readonly tools: {
    /** The machine of a tool of its manifest. */
    register(id: string, create: ToolSpec['create']): IDisposable;
  };
  readonly modes: {
    /** A mode of its manifest, with its machine if it has one. */
    register(id: string, create?: ModeSpec['create']): IDisposable;
  };
  readonly keys: {
    /** Sets a context key, until disposed. */
    set(key: string, value: unknown): IDisposable;
  };
  /**
   * The state of the plugin, as JSON, kept with the layout; kept as well
   * when the plugin is gone.
   */
  readonly state: {
    get(): unknown;
    set(value: unknown): void;
  };
}

/** The code of a plugin, loaded at its first activation event. */
export interface PluginModule {
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** A plugin, as a host gives it: its manifest, and how to load its code. */
export interface EditorPlugin {
  /** Checked when registered (`readManifest`). */
  readonly manifest: PluginManifest | Readonly<Record<string, unknown>>;
  load(): PluginModule | Promise<PluginModule>;
}

/**
 * Where a plugin is: registered but not yet loaded (`inactive`), being
 * activated, `active`, `failed` (its code throws), `disabled` by the user,
 * or `invalid` (its manifest).
 */
export type PluginStatus =
  'inactive' | 'activating' | 'active' | 'failed' | 'disabled' | 'invalid';

export interface PluginInfo {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly builtin: boolean;
  readonly status: PluginStatus;
  /** Why it is invalid or failed. */
  readonly error?: string;
}

/** The registries the plugins fill. */
export interface PluginRegistries {
  readonly services: ServiceRegistry;
  readonly commands: CommandService;
  readonly views: Registry<ViewSpec>;
  readonly viewComponents: Registry<ComponentSpec>;
  readonly menus: MenuRegistry;
  readonly toolbars: Registry<ToolbarSpec>;
  readonly statusBar: Registry<StatusBarSpec>;
  readonly statusComponents: Registry<ComponentSpec>;
  readonly keybindings: Registry<KeybindingSpec>;
  readonly tools: Registry<ToolSpec>;
  readonly modes: Registry<ModeSpec>;
  readonly editor: EditorStore;
  /** Read at the call: the machine is made once the plugins are registered. */
  readonly machine: () => EditorActor;
  readonly keys: () => ContextKeys;
}

export interface RegisterOptions {
  /** A plugin of the editor: always there, never disabled. */
  readonly builtin?: boolean;
  /** Its code, loaded already. */
  readonly module?: PluginModule;
}

interface Entry {
  readonly plugin: EditorPlugin;
  readonly manifest: PluginManifest;
  readonly builtin: boolean;
  readonly events: ReadonlySet<string>;
  readonly declarations: IDisposable[];
  module?: PluginModule;
  status: PluginStatus;
  error?: string;
  activation?: Promise<void>;
  context?: { scope: ServiceRegistry; subscriptions: IDisposable[] };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function disposeAll(disposables: IDisposable[]): void {
  for (const disposable of disposables.splice(0).reverse()) {
    try {
      disposable.dispose();
    } catch (error) {
      console.error('[editor]', error);
    }
  }
}

/**
 * The plugins of the editor (design/editor-ui.md §6): their manifests read
 * when registered, their contributions declared at once; their code loaded
 * and activated at the first event that names them (a view shown, a command
 * run, a tool activated, `onStartup`), and deactivated by disposing what it
 * registered.
 */
export class PluginHost implements IDisposable {
  readonly #registries: PluginRegistries;
  readonly #entries = new Map<string, Entry>();
  readonly #invalid: PluginInfo[] = [];
  readonly #listeners = new Set<() => void>();
  #infos: readonly PluginInfo[] = [];

  constructor(registries: PluginRegistries) {
    this.#registries = registries;
  }

  /**
   * Registers a plugin: its manifest checked, its contributions declared.
   * An invalid manifest, or a contribution of an id already taken, makes it
   * `invalid`, without contributions.
   */
  register(plugin: EditorPlugin, options: RegisterOptions = {}): PluginInfo {
    const read = readManifest(plugin.manifest);
    const rawId = (plugin.manifest as { id?: unknown }).id;
    const id = read.manifest?.id ?? (typeof rawId === 'string' ? rawId : '?');
    const invalid = (error: string): PluginInfo => {
      const info: PluginInfo = {
        id,
        title: id,
        version: '',
        builtin: options.builtin ?? false,
        status: 'invalid',
        error,
      };
      console.error(`[editor] The plugin ${id} is invalid: ${error}`);
      this.#invalid.push(info);
      this.#changed();
      return info;
    };
    if (!read.manifest) return invalid(read.errors.join('; '));
    if (this.#entries.has(id)) return invalid('registered twice');
    const entry: Entry = {
      plugin,
      manifest: read.manifest,
      builtin: options.builtin ?? false,
      events: activationEvents(read.manifest),
      declarations: [],
      module: options.module,
      status: 'inactive',
    };
    try {
      this.#declare(entry);
    } catch (error) {
      disposeAll(entry.declarations);
      return invalid(message(error));
    }
    this.#entries.set(id, entry);
    this.#changed();
    return this.#info(entry);
  }

  /** The plugins, invalid ones included; the same array until a change. */
  infos(): readonly PluginInfo[] {
    return this.#infos;
  }

  /** The same as `infos`, as a registry (`useItems`). */
  all(): readonly PluginInfo[] {
    return this.#infos;
  }

  info(id: string): PluginInfo | undefined {
    return this.#infos.find((info) => info.id === id);
  }

  /** Listens to the changes; returns the unsubscription. Bound, for React. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Activates the plugins of the event, at most once each; the disabled,
   * invalid and failed ones are left.
   */
  async activateByEvent(event: string): Promise<void> {
    const ids = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.events.has(event) ||
          (event === 'onStartup' && entry.events.has('*')),
      )
      .map((entry) => entry.manifest.id);
    await Promise.all(ids.map((id) => this.activate(id)));
  }

  /**
   * Loads the code of the plugin and calls its `activate`. With its code
   * loaded, `activate` is called before this returns: what it registers at
   * once is there.
   */
  activate(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry || entry.status === 'disabled' || entry.status === 'failed') {
      return Promise.resolve();
    }
    entry.activation ??= this.#activate(entry);
    return entry.activation;
  }

  /** Deactivates the plugin: its `deactivate`, then what it registered. */
  async deactivate(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    await entry.activation?.catch(() => undefined);
    await this.#deactivate(entry);
    if (entry.status !== 'disabled') entry.status = 'inactive';
    this.#changed();
  }

  /** Deactivates the plugin, and keeps it so until enabled. */
  async disable(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (entry.builtin) throw new Error(`The plugin ${id} is built in`);
    entry.status = 'disabled';
    this.#changed();
    await this.deactivate(id);
  }

  /** Enables a disabled plugin, or one that failed: activated at its next event. */
  enable(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry || (entry.status !== 'disabled' && entry.status !== 'failed')) {
      return;
    }
    entry.status = 'inactive';
    delete entry.error;
    this.#changed();
  }

  /** Deactivates the plugins and removes their contributions. */
  dispose(): void {
    for (const entry of [...this.#entries.values()].reverse()) {
      void this.#deactivate(entry);
      disposeAll(entry.declarations);
    }
    this.#entries.clear();
    this.#listeners.clear();
  }

  async #activate(entry: Entry): Promise<void> {
    const { id } = entry.manifest;
    entry.status = 'activating';
    this.#changed();
    try {
      // Without await when loaded: activate is called at once.
      const module = entry.module ?? (await entry.plugin.load());
      entry.module = module;
      if (entry.status !== 'activating') return;
      const context = this.#context(entry);
      await module.activate?.(context);
      if (entry.status === 'activating') entry.status = 'active';
    } catch (error) {
      console.error(`[editor] The plugin ${id} does not activate:`, error);
      await this.#deactivate(entry);
      entry.status = 'failed';
      entry.error = message(error);
    }
    this.#changed();
  }

  async #deactivate(entry: Entry): Promise<void> {
    const context = entry.context;
    delete entry.activation;
    if (!context) return;
    delete entry.context;
    try {
      await entry.module?.deactivate?.();
    } catch (error) {
      console.error(
        `[editor] The plugin ${entry.manifest.id} does not deactivate:`,
        error,
      );
    }
    disposeAll(context.subscriptions);
    context.scope.dispose();
  }

  // The contributions of the manifest; the tools and the modes are commands
  // too, which activate the plugin first.
  #declare(entry: Entry): void {
    const registries = this.#registries;
    const { manifest, declarations } = entry;
    const plugin = manifest.id;
    const contributes = manifest.contributes ?? {};
    const add = (disposable: IDisposable) => declarations.push(disposable);
    for (const command of contributes.commands ?? []) {
      add(registries.commands.specs.register({ ...command, plugin }));
    }
    for (const tool of contributes.tools ?? []) {
      add(
        registries.commands.specs.register({
          id: tool.id,
          title: tool.title,
          category: 'Tool',
          ...(tool.icon && { icon: tool.icon }),
          ...(tool.when && { enablement: tool.when }),
          toggled: `tool.${tool.slot} == ${tool.id}`,
          plugin,
        }),
      );
      add(
        registries.commands.registerHandler(tool.id, async () => {
          await this.activateByEvent(`onTool:${tool.id}`);
          const machine = registries.machine();
          if (machine.getSnapshot().context.tools[tool.slot] === tool.id) {
            machine.send({ type: 'TOOL.DEACTIVATE', slot: tool.slot });
          } else machine.send({ type: 'TOOL.ACTIVATE', tool: tool.id });
        }),
      );
    }
    for (const mode of contributes.modes ?? []) {
      add(
        registries.commands.specs.register({
          id: mode.id,
          title: mode.title,
          category: 'Mode',
          ...(mode.icon && { icon: mode.icon }),
          ...(mode.when && { enablement: mode.when }),
          toggled: `editor.mode == ${mode.id}`,
          plugin,
        }),
      );
      add(
        registries.commands.registerHandler(mode.id, async () => {
          await this.activateByEvent(`onMode:${mode.id}`);
          const machine = registries.machine();
          const active = machine.getSnapshot().context.mode === mode.id;
          machine.send({ type: 'MODE.SET', mode: active ? 'object' : mode.id });
        }),
      );
    }
    for (const view of contributes.views ?? []) {
      add(registries.views.register({ ...view, plugin }));
    }
    for (const [menu, items] of Object.entries(contributes.menus ?? {})) {
      for (const item of items) add(registries.menus.append(menu, item));
    }
    for (const toolbar of contributes.toolbars ?? []) {
      add(registries.toolbars.register({ ...toolbar, plugin }));
    }
    for (const item of contributes.statusBar ?? []) {
      add(registries.statusBar.register({ ...item, plugin }));
    }
    (contributes.keybindings ?? []).forEach((binding, index) => {
      add(
        registries.keybindings.register({
          ...binding,
          id: `${plugin}#${index}`,
          plugin,
        }),
      );
    });
  }

  #context(entry: Entry): PluginContext {
    const registries = this.#registries;
    const { manifest } = entry;
    const { id } = manifest;
    const contributes = manifest.contributes ?? {};
    const scope = registries.services.createScope(id);
    const subscriptions: IDisposable[] = [];
    entry.context = { scope, subscriptions };
    const keep = (disposable: IDisposable) => {
      subscriptions.push(disposable);
      return disposable;
    };
    // A registration names a contribution of the manifest.
    const declared =
      <T extends { readonly id: string }>(
        kind: string,
        ids: readonly T[] = [],
      ) =>
      (item: string): T => {
        const found = ids.find((declaration) => declaration.id === item);
        if (!found) {
          throw new Error(`The plugin ${id} declares no ${kind} ${item}`);
        }
        return found;
      };
    const command = declared('command', contributes.commands);
    const view = declared('view', contributes.views);
    const status = declared('status bar item', contributes.statusBar);
    const tool = declared('tool', contributes.tools);
    const mode = declared('mode', contributes.modes);
    return {
      id,
      manifest,
      services: scope,
      subscriptions,
      commands: {
        register: (item, handler) => {
          command(item);
          return keep(registries.commands.registerHandler(item, handler));
        },
        execute: (item, ...args) => registries.commands.execute(item, ...args),
      },
      views: {
        registerComponent: (item, component) => {
          view(item);
          return keep(
            registries.viewComponents.register({ id: item, component }),
          );
        },
      },
      statusBar: {
        registerComponent: (item, component) => {
          status(item);
          return keep(
            registries.statusComponents.register({ id: item, component }),
          );
        },
      },
      menus: {
        append: (menu, item) => keep(registries.menus.append(menu, item)),
      },
      tools: {
        register: (item, create: (context: ToolContext) => AnyActorLogic) => {
          const declaration = tool(item);
          return keep(registries.tools.register({ ...declaration, create }));
        },
      },
      modes: {
        register: (item, create?: (context: ModeContext) => AnyActorLogic) => {
          const declaration = mode(item);
          return keep(
            registries.modes.register({
              ...declaration,
              ...(create && { create }),
            }),
          );
        },
      },
      keys: {
        set: (key, value) => keep(registries.keys().set(key, value)),
      },
      state: {
        get: () => registries.editor.getSnapshot().context.plugins[id],
        set: (value) =>
          registries.editor.trigger.setPluginState({
            plugin: id,
            state: value,
          }),
      },
    };
  }

  #info(entry: Entry): PluginInfo {
    const { manifest } = entry;
    return {
      id: manifest.id,
      title: manifest.title ?? manifest.id,
      version: manifest.version,
      ...(manifest.description && { description: manifest.description }),
      builtin: entry.builtin,
      status: entry.status,
      ...(entry.error && { error: entry.error }),
    };
  }

  #changed(): void {
    this.#infos = [
      ...[...this.#entries.values()].map((entry) => this.#info(entry)),
      ...this.#invalid,
    ];
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A plugin to register, with its code if loaded already. */
export interface PreparedPlugin {
  readonly plugin: EditorPlugin;
  readonly builtin?: boolean;
  readonly module?: PluginModule;
}

/**
 * Loads the code of the plugins activated by one of the events (`onStartup`,
 * the tools and the mode of a state kept): activated with the runtime, they
 * register their tools before the machine restores. A plugin whose code
 * does not load is given without it: it fails when activated.
 */
export async function preparePlugins(
  plugins: readonly {
    readonly plugin: EditorPlugin;
    readonly builtin?: boolean;
  }[],
  events: readonly string[],
): Promise<PreparedPlugin[]> {
  return Promise.all(
    plugins.map(async (prepared) => {
      const { manifest } = readManifest(prepared.plugin.manifest);
      if (!manifest) return prepared;
      const listened = activationEvents(manifest);
      const wanted = events.some(
        (event) =>
          listened.has(event) || (event === 'onStartup' && listened.has('*')),
      );
      if (!wanted) return prepared;
      try {
        return { ...prepared, module: await prepared.plugin.load() };
      } catch (error) {
        console.error(
          `[editor] The plugin ${manifest.id} does not load:`,
          error,
        );
        return prepared;
      }
    }),
  );
}
