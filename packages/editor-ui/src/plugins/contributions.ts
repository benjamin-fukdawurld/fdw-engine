import type { ComponentType } from 'react';
import { Registry } from '../state/registry';
import type { IDisposable } from '../state/services';
import type {
  CommandContribution,
  KeybindingContribution,
  MenuItem,
  StatusBarContribution,
  ToolbarContribution,
  ViewContribution,
} from './manifest';

/** What a plugin contributed, with the id of the plugin. */
export type Contributed<T> = T & { readonly plugin: string };

export type CommandSpec = Contributed<CommandContribution>;
export type ViewSpec = Contributed<ViewContribution>;
export type ToolbarSpec = Contributed<ToolbarContribution>;
export type StatusBarSpec = Contributed<StatusBarContribution>;
export type KeybindingSpec = Contributed<KeybindingContribution> & {
  readonly id: string;
};

/** The component of a view or of an item of the status bar. */
export interface ComponentSpec {
  readonly id: string;
  readonly component: ComponentType;
}

export type CommandHandler = (...args: readonly unknown[]) => unknown;

export interface CommandServiceOptions {
  /** Activates the plugins of the event (`onCommand:id`). */
  readonly activate: (event: string) => Promise<void>;
  /** Whether the context keys satisfy the clause. */
  readonly matches: (when: string | undefined) => boolean;
}

/**
 * The commands (design/editor-ui.md §6): declared by the manifests, run by
 * the handlers of the plugins, registered once active. Menus, toolbars,
 * keybindings and the palette only name them.
 */
export class CommandService {
  readonly specs = new Registry<CommandSpec>('command');
  readonly #handlers = new Map<string, CommandHandler>();
  readonly #options: CommandServiceOptions;

  constructor(options: CommandServiceOptions) {
    this.#options = options;
  }

  /** Registers the handler of a declared command. */
  registerHandler(id: string, handler: CommandHandler): IDisposable {
    if (!this.specs.get(id)) throw new Error(`No command ${id} declared`);
    if (this.#handlers.has(id)) {
      throw new Error(`The command ${id} has a handler already`);
    }
    this.#handlers.set(id, handler);
    return {
      dispose: () => {
        if (this.#handlers.get(id) === handler) this.#handlers.delete(id);
      },
    };
  }

  /** Whether the command is declared and its enablement satisfied. */
  enabled(id: string): boolean {
    const spec = this.specs.get(id);
    return spec !== undefined && this.#options.matches(spec.enablement);
  }

  /**
   * Runs the command, its plugin activated first; what its handler gives,
   * undefined if it is not enabled or has no handler (with a warning).
   */
  async execute(id: string, ...args: readonly unknown[]): Promise<unknown> {
    if (!this.enabled(id)) {
      if (!this.specs.get(id)) console.warn(`[editor] No command ${id}`);
      return undefined;
    }
    if (!this.#handlers.has(id))
      await this.#options.activate(`onCommand:${id}`);
    const handler = this.#handlers.get(id);
    if (!handler) {
      console.warn(`[editor] The command ${id} has no handler`);
      return undefined;
    }
    return handler(...args);
  }
}

interface MenuEntry {
  readonly menu: string;
  readonly item: MenuItem;
}

const byGroup = (a: MenuItem, b: MenuItem) =>
  (a.group ?? '').localeCompare(b.group ?? '') ||
  (a.order ?? 0) - (b.order ?? 0);

/**
 * The items of the menus, by menu id: `menubar` for the menu bar, whose
 * items are submenus. From the manifests, and from the code of the plugins
 * (the items made from a registry: the panels, the scenes).
 */
export class MenuRegistry {
  readonly #entries: MenuEntry[] = [];
  readonly #sorted = new Map<string, readonly MenuItem[]>();
  readonly #listeners = new Set<() => void>();

  append(menu: string, item: MenuItem): IDisposable {
    const entry = { menu, item };
    this.#entries.push(entry);
    this.#changed(menu);
    return {
      dispose: () => {
        const index = this.#entries.indexOf(entry);
        if (index < 0) return;
        this.#entries.splice(index, 1);
        this.#changed(menu);
      },
    };
  }

  /** The items of the menu, sorted; the same array until it changes. */
  items(menu: string): readonly MenuItem[] {
    let items = this.#sorted.get(menu);
    if (!items) {
      items = this.#entries
        .filter((entry) => entry.menu === menu)
        .map((entry) => entry.item)
        // Stable: in the order of registration within an order.
        .sort(byGroup);
      this.#sorted.set(menu, items);
    }
    return items;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(menu: string): void {
    this.#sorted.delete(menu);
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The items split in their groups, for the separators. */
export function menuGroups<T extends { readonly group?: string }>(
  items: readonly T[],
): T[][] {
  const groups: T[][] = [];
  let group: string | undefined;
  for (const item of items) {
    const last = groups.at(-1);
    if (last && item.group === group) last.push(item);
    else groups.push([item]);
    group = item.group;
  }
  return groups;
}

const modifiers = ['ctrl', 'shift', 'alt', 'meta'] as const;

const keyNames: Readonly<Record<string, string>> = {
  esc: 'escape',
  ' ': 'space',
  cmd: 'meta',
  command: 'meta',
  control: 'ctrl',
  option: 'alt',
  del: 'delete',
  return: 'enter',
};

/**
 * A key written in a manifest, in a single form: lower case, the modifiers
 * first, in the order ctrl, shift, alt, meta (`Shift+Ctrl+P` gives
 * `ctrl+shift+p`).
 */
export function normalizeKey(key: string): string {
  const parts = key
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .map((part) => keyNames[part] ?? part);
  const pressed = modifiers.filter((modifier) => parts.includes(modifier));
  const rest = parts.filter(
    (part) => !(modifiers as readonly string[]).includes(part),
  );
  return [...pressed, ...rest].join('+');
}

/**
 * The key of an event, in the form of `normalizeKey`; undefined for a
 * modifier alone. Letters and digits by their place on the keyboard, the
 * others by their name.
 */
export function keyOfEvent(event: KeyboardEvent): string | undefined {
  const code = /^(?:Key([A-Z])|Digit(\d))$/.exec(event.code);
  const key = code
    ? (code[1] ?? code[2] ?? '').toLowerCase()
    : (keyNames[event.key.toLowerCase()] ?? event.key.toLowerCase());
  if ((modifiers as readonly string[]).includes(key) || key === 'dead') {
    return undefined;
  }
  const pressed = [
    event.ctrlKey && 'ctrl',
    event.shiftKey && 'shift',
    event.altKey && 'alt',
    event.metaKey && 'meta',
  ].filter(Boolean);
  return [...pressed, key].join('+');
}

/** Whether the element takes the text typed: an input, a text area. */
export function isEditable(target: EventTarget | null): boolean {
  if (!target || !('tagName' in target)) return false;
  const element = target as HTMLElement;
  return (
    element.isContentEditable ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    (element.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'button', 'range'].includes(
        (element as HTMLInputElement).type,
      ))
  );
}

/**
 * The keybinding of the key whose clause holds, the last registered first;
 * in a text field, only those with ctrl, alt or meta, or escape.
 */
export function findKeybinding(
  bindings: readonly KeybindingSpec[],
  key: string,
  matches: (when: string | undefined) => boolean,
  editable: boolean,
): KeybindingSpec | undefined {
  if (editable && !/(^|\+)(ctrl|alt|meta)\+/.test(key) && key !== 'escape') {
    return undefined;
  }
  for (let index = bindings.length - 1; index >= 0; index--) {
    const binding = bindings[index];
    if (binding && normalizeKey(binding.key) === key && matches(binding.when)) {
      return binding;
    }
  }
  return undefined;
}

/** The keybinding shown for a command: its first one. */
export function keybindingLabel(
  bindings: readonly KeybindingSpec[],
  command: string,
): string | undefined {
  const binding = bindings.find(
    (item) => item.command === command && !item.args,
  );
  return binding
    ? normalizeKey(binding.key)
        .split('+')
        .map((part) =>
          part.length === 1
            ? part.toUpperCase()
            : part[0]?.toUpperCase() + part.slice(1),
        )
        .join('+')
    : undefined;
}
