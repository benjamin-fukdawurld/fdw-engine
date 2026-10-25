import { areas, toolbarSides, type AreaId, type ToolbarSide } from '../layout';
import { toolSlots, type SlotId } from '../state/editorMachine';

/**
 * The version of the API of the plugins: the `engine` of a manifest is a
 * range of it (`^1.0.0`).
 */
export const editorApiVersion = '1.0.0';

/** A command: what menus, toolbars, keybindings and the palette run. */
export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  /** Before the title in the palette: `View: Left dock`. */
  readonly category?: string;
  /** A name of the icons of the editor (`editorIcons`). */
  readonly icon?: string;
  /** The clause under which it runs; disabled otherwise. */
  readonly enablement?: string;
  /** The clause under which it is checked, in menus and toolbars. */
  readonly toggled?: string;
  /** Listed in the palette (the default); not for a command that needs arguments. */
  readonly palette?: boolean;
}

/** A panel: the area where it opens, and whether a new layout has it. */
export interface ViewContribution {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly location: AreaId;
  /** Open in the default layout. */
  readonly open?: boolean;
  /**
   * Opened beside the panels of its area rather than in a tab of theirs:
   * a group of its own at its right or below (an editor of graphs next to
   * the viewport).
   */
  readonly split?: 'right' | 'below';
  /** The clause under which the View menu lists it. */
  readonly when?: string;
}

/** An item of a menu: a command, or a submenu. */
export type MenuItem = MenuCommandItem | MenuSubmenuItem;

interface MenuItemBase {
  /** The items are sorted by group, then by order; groups are separated. */
  readonly group?: string;
  readonly order?: number;
  /** The clause under which it is shown. */
  readonly when?: string;
}

export interface MenuCommandItem extends MenuItemBase {
  readonly command: string;
  readonly args?: readonly unknown[];
  /** Over the title of the command. */
  readonly title?: string;
  /** Over the `toggled` of the command. */
  readonly toggled?: string;
  /** A radio item rather than a checkbox, when toggled. */
  readonly radio?: boolean;
}

export interface MenuSubmenuItem extends MenuItemBase {
  /** The id of the menu it opens. */
  readonly submenu: string;
  readonly title: string;
}

/** An item of a toolbar: a command, by its id or with arguments. */
export type ToolbarItem =
  | string
  | {
      readonly command: string;
      readonly args?: readonly unknown[];
      readonly when?: string;
    };

export interface ToolbarContribution {
  readonly id: string;
  readonly title: string;
  /** Its side by default; `top` if none. */
  readonly side?: ToolbarSide;
  /** Shown by default (the default). */
  readonly visible?: boolean;
  readonly when?: string;
  readonly items: readonly ToolbarItem[];
}

/**
 * An item of the status bar: a component of the plugin, registered once
 * active, or a text, which may run a command.
 */
export interface StatusBarContribution {
  readonly id: string;
  /** Its side; `left` if none. */
  readonly alignment?: 'left' | 'right';
  /** The highest first, from the side; 0 if none. */
  readonly priority?: number;
  readonly when?: string;
  readonly text?: string;
  readonly command?: string;
}

/** A key, as `ctrl+shift+p`, `escape` or `f1`, that runs a command. */
export interface KeybindingContribution {
  readonly command: string;
  readonly key: string;
  readonly args?: readonly unknown[];
  readonly when?: string;
}

/** A tool (design/editor-state.md §4): a machine in a slot. */
export interface ToolContribution {
  readonly id: string;
  readonly title: string;
  readonly slot: SlotId;
  readonly icon?: string;
  readonly when?: string;
}

/** A mode of editing, with a machine or not. */
export interface ModeContribution {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly when?: string;
}

export interface PluginContributions {
  readonly commands?: readonly CommandContribution[];
  readonly views?: readonly ViewContribution[];
  /** The items of each menu, by its id (`menubar`, then the submenus). */
  readonly menus?: Readonly<Record<string, readonly MenuItem[]>>;
  readonly toolbars?: readonly ToolbarContribution[];
  readonly statusBar?: readonly StatusBarContribution[];
  readonly keybindings?: readonly KeybindingContribution[];
  readonly tools?: readonly ToolContribution[];
  readonly modes?: readonly ModeContribution[];
}

/**
 * The manifest of a plugin (design/editor-ui.md §6): what it contributes,
 * read without its code, which is loaded at its first activation event.
 */
export interface PluginManifest {
  readonly id: string;
  readonly title?: string;
  readonly version: string;
  /** The range of `editorApiVersion` it is written for. */
  readonly engine: string;
  readonly description?: string;
  /**
   * The events that activate it, over those its contributions imply
   * (`onView:`, `onCommand:`, `onTool:`, `onMode:`): `onStartup`.
   */
  readonly activationEvents?: readonly string[];
  readonly contributes?: PluginContributions;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idPattern = /^[A-Za-z0-9][\w.-]*$/;

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether the version is in the range: `*`, `1.2.3`, `^1.2.3` (the same
 * major, or minor under 1), `~1.2.3` (the same minor) or `>=1.2.3`.
 */
export function satisfiesVersion(range: string, version: string): boolean {
  const current = parseVersion(version);
  const text = range.trim();
  if (!current) return false;
  if (text === '*') return true;
  const operator = /^(\^|~|>=)?(.*)$/.exec(text);
  const base = parseVersion(operator?.[2] ?? '');
  if (!base) return false;
  if (compare(current, base) < 0) return false;
  switch (operator?.[1]) {
    case '^':
      return base[0] > 0
        ? current[0] === base[0]
        : current[0] === 0 && current[1] === base[1];
    case '~':
      return current[0] === base[0] && current[1] === base[1];
    case '>=':
      return true;
    default:
      return compare(current, base) === 0;
  }
}

// The checks of a manifest: each adds its errors, at a path.
class Checker {
  readonly errors: string[] = [];

  record(value: unknown, path: string): Record<string, unknown> | undefined {
    if (isRecord(value)) return value;
    this.errors.push(`${path} is not an object`);
    return undefined;
  }

  string(
    record: Record<string, unknown>,
    key: string,
    path: string,
    required = false,
  ): void {
    const value = record[key];
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || value === '') {
      this.errors.push(`${path}.${key} is not a string`);
    }
  }

  id(record: Record<string, unknown>, key: string, path: string): void {
    const value = record[key];
    if (typeof value !== 'string' || !idPattern.test(value)) {
      this.errors.push(`${path}.${key} is not an id`);
    }
  }

  oneOf(
    record: Record<string, unknown>,
    key: string,
    values: readonly unknown[],
    path: string,
    required = false,
  ): void {
    const value = record[key];
    if (value === undefined && !required) return;
    if (!values.includes(value)) {
      this.errors.push(`${path}.${key} is not one of ${values.join(', ')}`);
    }
  }

  type(
    record: Record<string, unknown>,
    key: string,
    type: 'boolean' | 'number',
    path: string,
  ): void {
    const value = record[key];
    if (value !== undefined && typeof value !== type) {
      this.errors.push(`${path}.${key} is not a ${type}`);
    }
  }

  array(
    value: unknown,
    path: string,
    each: (item: unknown, path: string) => void,
  ): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      this.errors.push(`${path} is not an array`);
      return;
    }
    value.forEach((item, index) => each(item, `${path}[${index}]`));
  }
}

function checkContributions(check: Checker, value: unknown, path: string) {
  const contributes = check.record(value, path);
  if (!contributes) return;
  const ids = (kind: string) => {
    const seen = new Set<string>();
    return (record: Record<string, unknown>, itemPath: string) => {
      check.id(record, 'id', itemPath);
      const id = record['id'];
      if (typeof id !== 'string') return;
      if (seen.has(id))
        check.errors.push(`${itemPath}: the ${kind} ${id} twice`);
      seen.add(id);
    };
  };
  const commandId = ids('command');
  check.array(contributes['commands'], `${path}.commands`, (item, at) => {
    const command = check.record(item, at);
    if (!command) return;
    commandId(command, at);
    check.string(command, 'title', at, true);
    for (const key of ['category', 'icon', 'enablement', 'toggled']) {
      check.string(command, key, at);
    }
    check.type(command, 'palette', 'boolean', at);
  });
  const viewId = ids('view');
  check.array(contributes['views'], `${path}.views`, (item, at) => {
    const view = check.record(item, at);
    if (!view) return;
    viewId(view, at);
    check.string(view, 'title', at, true);
    check.string(view, 'icon', at);
    check.string(view, 'when', at);
    check.oneOf(view, 'location', areas, at, true);
    check.oneOf(view, 'split', ['right', 'below'], at);
    check.type(view, 'open', 'boolean', at);
  });
  if (contributes['menus'] !== undefined) {
    const menus = check.record(contributes['menus'], `${path}.menus`);
    for (const [menu, items] of Object.entries(menus ?? {})) {
      check.array(items, `${path}.menus.${menu}`, (item, at) => {
        const entry = check.record(item, at);
        if (!entry) return;
        if ('submenu' in entry) {
          check.id(entry, 'submenu', at);
          check.string(entry, 'title', at, true);
        } else {
          check.id(entry, 'command', at);
          check.string(entry, 'title', at);
          check.string(entry, 'toggled', at);
          check.type(entry, 'radio', 'boolean', at);
          check.array(entry['args'], `${at}.args`, () => undefined);
        }
        check.string(entry, 'group', at);
        check.string(entry, 'when', at);
        check.type(entry, 'order', 'number', at);
      });
    }
  }
  const toolbarId = ids('toolbar');
  check.array(contributes['toolbars'], `${path}.toolbars`, (item, at) => {
    const toolbar = check.record(item, at);
    if (!toolbar) return;
    toolbarId(toolbar, at);
    check.string(toolbar, 'title', at, true);
    check.string(toolbar, 'when', at);
    check.oneOf(toolbar, 'side', toolbarSides, at);
    check.type(toolbar, 'visible', 'boolean', at);
    if (toolbar['items'] === undefined) {
      check.errors.push(`${at}.items is not an array`);
    }
    check.array(toolbar['items'], `${at}.items`, (entry, entryAt) => {
      if (typeof entry === 'string') return;
      const command = check.record(entry, entryAt);
      if (!command) return;
      check.id(command, 'command', entryAt);
      check.string(command, 'when', entryAt);
      check.array(command['args'], `${entryAt}.args`, () => undefined);
    });
  });
  const statusId = ids('status bar item');
  check.array(contributes['statusBar'], `${path}.statusBar`, (item, at) => {
    const status = check.record(item, at);
    if (!status) return;
    statusId(status, at);
    check.oneOf(status, 'alignment', ['left', 'right'], at);
    check.type(status, 'priority', 'number', at);
    for (const key of ['when', 'text']) check.string(status, key, at);
    if (status['command'] !== undefined) check.id(status, 'command', at);
  });
  check.array(contributes['keybindings'], `${path}.keybindings`, (item, at) => {
    const binding = check.record(item, at);
    if (!binding) return;
    check.id(binding, 'command', at);
    check.string(binding, 'key', at, true);
    check.string(binding, 'when', at);
    check.array(binding['args'], `${at}.args`, () => undefined);
  });
  const toolId = ids('tool');
  check.array(contributes['tools'], `${path}.tools`, (item, at) => {
    const tool = check.record(item, at);
    if (!tool) return;
    toolId(tool, at);
    check.string(tool, 'title', at, true);
    check.oneOf(tool, 'slot', toolSlots, at, true);
    check.string(tool, 'icon', at);
    check.string(tool, 'when', at);
  });
  const modeId = ids('mode');
  check.array(contributes['modes'], `${path}.modes`, (item, at) => {
    const mode = check.record(item, at);
    if (!mode) return;
    modeId(mode, at);
    check.string(mode, 'title', at, true);
    check.string(mode, 'icon', at);
    check.string(mode, 'when', at);
  });
}

/** A manifest checked: the manifest, or why it is not one. */
export type ManifestResult =
  | { readonly manifest: PluginManifest; readonly errors?: undefined }
  | { readonly manifest?: undefined; readonly errors: readonly string[] };

/**
 * Checks a manifest, as JSON: its fields, and its `engine` against the
 * version of the API.
 */
export function readManifest(value: unknown): ManifestResult {
  const check = new Checker();
  const manifest = check.record(value, 'manifest');
  if (!manifest) return { errors: check.errors };
  check.id(manifest, 'id', 'manifest');
  check.string(manifest, 'title', 'manifest');
  check.string(manifest, 'description', 'manifest');
  check.string(manifest, 'version', 'manifest', true);
  if (
    typeof manifest['version'] === 'string' &&
    !parseVersion(manifest['version'])
  ) {
    check.errors.push('manifest.version is not a version (1.0.0)');
  }
  check.string(manifest, 'engine', 'manifest', true);
  const engine = manifest['engine'];
  if (
    typeof engine === 'string' &&
    !satisfiesVersion(engine, editorApiVersion)
  ) {
    check.errors.push(
      `manifest.engine ${engine} does not accept the API ${editorApiVersion}`,
    );
  }
  check.array(
    manifest['activationEvents'],
    'manifest.activationEvents',
    (event, at) => {
      if (typeof event !== 'string') check.errors.push(`${at} is not a string`);
    },
  );
  if (manifest['contributes'] !== undefined) {
    checkContributions(check, manifest['contributes'], 'manifest.contributes');
  }
  return check.errors.length > 0
    ? { errors: check.errors }
    : { manifest: manifest as unknown as PluginManifest };
}

/**
 * The events that activate the plugin: those of its manifest, and those its
 * contributions imply.
 */
export function activationEvents(manifest: PluginManifest): Set<string> {
  const { contributes = {} } = manifest;
  return new Set([
    ...(manifest.activationEvents ?? []),
    ...(contributes.views ?? []).map((view) => `onView:${view.id}`),
    ...(contributes.commands ?? []).map((command) => `onCommand:${command.id}`),
    ...(contributes.tools ?? []).map((tool) => `onTool:${tool.id}`),
    ...(contributes.modes ?? []).map((mode) => `onMode:${mode.id}`),
  ]);
}
