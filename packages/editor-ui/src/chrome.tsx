import { Fragment, useSyncExternalStore } from 'react';
import { Button } from './components/ui/button';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from './components/ui/menubar';
import {
  useEditor,
  useEditorStore,
  useItems,
  useMenu,
  useWhen,
} from './editorContext';
import type { ToolbarSide } from './layout';
import { cn } from './lib/utils';
import { keybindingLabel, menuGroups } from './plugins/contributions';
import { editorIcons } from './plugins/icons';
import type {
  MenuCommandItem,
  MenuItem,
  MenuSubmenuItem,
  ToolbarItem,
} from './plugins/manifest';
import type { ContextKeys } from './state/contextKeys';
import type { EditorRuntime } from './state/runtime';
import { toolbarLayout } from './toolbarLayout';

// Whether the context keys satisfy the clause, for a list of them.
function useMatcher(): ContextKeys['matches'] {
  const { keys } = useEditor();
  // Rendered again when a key changes.
  useSyncExternalStore(keys.subscribe, keys.values);
  return keys.matches;
}

/** The icon of a manifest, by its name; nothing if unknown. */
export function ContributedIcon({ name }: { readonly name?: string }) {
  const Icon = name ? editorIcons[name] : undefined;
  return Icon ? <Icon /> : null;
}

function execute(
  runtime: EditorRuntime,
  command: string,
  args: readonly unknown[] = [],
) {
  void runtime.commands.execute(command, ...args);
}

// A command of a menu: an item, a checkbox when toggled, or a radio item.
function CommandMenuItem({ item }: { readonly item: MenuCommandItem }) {
  const runtime = useEditor();
  const spec = runtime.commands.specs.get(item.command);
  const enabled = useWhen(spec?.enablement) && spec !== undefined;
  const toggled = item.toggled ?? spec?.toggled;
  const checked = useWhen(toggled ?? 'false');
  const bindings = useItems(runtime.keybindings);
  const title = item.title ?? spec?.title ?? item.command;
  const select = () => execute(runtime, item.command, item.args);
  const shortcut = !item.args && keybindingLabel(bindings, item.command);
  const content = (
    <>
      {title}
      {shortcut && <MenubarShortcut>{shortcut}</MenubarShortcut>}
    </>
  );
  if (toggled === undefined) {
    return (
      <MenubarItem inset disabled={!enabled} onSelect={select}>
        {content}
      </MenubarItem>
    );
  }
  if (item.radio) {
    return (
      <MenubarRadioGroup value={checked ? 'on' : ''}>
        <MenubarRadioItem value="on" disabled={!enabled} onSelect={select}>
          {content}
        </MenubarRadioItem>
      </MenubarRadioGroup>
    );
  }
  return (
    <MenubarCheckboxItem
      checked={checked}
      disabled={!enabled}
      onSelect={select}
    >
      {content}
    </MenubarCheckboxItem>
  );
}

function SubmenuItem({ item }: { readonly item: MenuSubmenuItem }) {
  return (
    <MenubarSub>
      <MenubarSubTrigger inset>{item.title}</MenubarSubTrigger>
      <MenubarSubContent>
        <MenuItems menu={item.submenu} />
      </MenubarSubContent>
    </MenubarSub>
  );
}

// The items of a menu shown, by groups between separators.
function MenuItems({ menu }: { readonly menu: string }) {
  const matches = useMatcher();
  const groups = menuGroups(useMenu(menu).filter((item) => matches(item.when)));
  return groups.map((group, index) => (
    <Fragment key={index}>
      {index > 0 && <MenubarSeparator />}
      {group.map((item, itemIndex) =>
        'submenu' in item ? (
          <SubmenuItem key={itemIndex} item={item} />
        ) : (
          <CommandMenuItem key={itemIndex} item={item} />
        ),
      )}
    </Fragment>
  ));
}

// A menu of the menu bar, disabled while it has no item.
function BarMenu({ item }: { readonly item: MenuSubmenuItem }) {
  const matches = useMatcher();
  const items = useMenu(item.submenu).filter((entry) => matches(entry.when));
  return (
    <MenubarMenu>
      <MenubarTrigger disabled={items.length === 0}>
        {item.title}
      </MenubarTrigger>
      <MenubarContent>
        <MenuItems menu={item.submenu} />
      </MenubarContent>
    </MenubarMenu>
  );
}

/** The menu bar: the submenus of the menu `menubar`. */
export function MenuBar() {
  const matches = useMatcher();
  const menus = useMenu('menubar').filter(
    (item: MenuItem): item is MenuSubmenuItem =>
      'submenu' in item && matches(item.when),
  );
  return (
    <header className="flex items-center gap-2 border-b bg-card px-2">
      <strong className="px-1 text-xs font-semibold">FDW Editor</strong>
      <Menubar>
        {menus.map((item) => (
          <BarMenu key={item.submenu} item={item} />
        ))}
      </Menubar>
    </header>
  );
}

/** A command as a button of a toolbar: its icon, or its title without one. */
export function CommandButton({
  command,
  args,
}: {
  readonly command: string;
  readonly args?: readonly unknown[];
}) {
  const runtime = useEditor();
  const spec = runtime.commands.specs.get(command);
  const enabled = useWhen(spec?.enablement) && spec !== undefined;
  const pressed = useWhen(spec?.toggled ?? 'false');
  const bindings = useItems(runtime.keybindings);
  const title = spec?.title ?? command;
  const shortcut = !args && keybindingLabel(bindings, command);
  const Icon = spec?.icon ? editorIcons[spec.icon] : undefined;
  return (
    <Button
      variant="ghost"
      size={Icon ? 'icon-xs' : 'xs'}
      aria-label={title}
      title={shortcut ? `${title} (${shortcut})` : title}
      disabled={!enabled}
      {...(spec?.toggled !== undefined && { 'aria-pressed': pressed })}
      className={cn(pressed && 'bg-accent text-accent-foreground')}
      onClick={() => execute(runtime, command, args)}
    >
      {Icon ? <Icon /> : title}
    </Button>
  );
}

const itemOf = (item: ToolbarItem) =>
  typeof item === 'string' ? { command: item } : item;

/** The toolbars of a side, in a row (top, bottom) or a column. */
export function ToolbarArea({ side }: { readonly side: ToolbarSide }) {
  const chrome = useEditorStore();
  const matches = useMatcher();
  const shown = useItems(useEditor().toolbars).filter((toolbar) => {
    const layout = toolbarLayout(chrome, toolbar);
    return layout.visible && layout.side === side && matches(toolbar.when);
  });
  if (shown.length === 0) return null;
  const vertical = side === 'left' || side === 'right';
  return (
    <div
      className={cn(
        'flex gap-1 bg-card p-1',
        vertical ? 'flex-col' : 'flex-row',
        {
          top: 'border-b',
          bottom: 'border-t',
          left: 'border-r',
          right: 'border-l',
        }[side],
      )}
      data-side={side}
    >
      {shown.map((toolbar, index) => (
        <Fragment key={toolbar.id}>
          {index > 0 && (
            <div className={cn('bg-border', vertical ? 'h-px' : 'w-px')} />
          )}
          <div
            role="toolbar"
            aria-label={toolbar.title}
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            className={cn('flex gap-0.5', vertical ? 'flex-col' : 'flex-row')}
          >
            {toolbar.items
              .map(itemOf)
              .filter((item) => matches(item.when))
              .map((item, itemIndex) => (
                <CommandButton
                  key={itemIndex}
                  command={item.command}
                  {...(item.args && { args: item.args })}
                />
              ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// An item of the status bar: its component once its plugin is active, or
// its text, a button if it runs a command.
function StatusBarItem({ id }: { readonly id: string }) {
  const runtime = useEditor();
  const spec = runtime.statusBar.get(id);
  const component = useItems(runtime.statusComponents).find(
    (item) => item.id === id,
  );
  if (component) return <component.component />;
  if (!spec?.text) return null;
  if (!spec.command) {
    return <span className="text-muted-foreground">{spec.text}</span>;
  }
  const { command } = spec;
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground"
      onClick={() => execute(runtime, command)}
    >
      {spec.text}
    </button>
  );
}

/** The status bar: the items of the plugins, on the left and on the right. */
export function StatusBar() {
  const matches = useMatcher();
  const items = useItems(useEditor().statusBar).filter((item) =>
    matches(item.when),
  );
  const side = (alignment: 'left' | 'right') =>
    items
      .filter((item) => (item.alignment ?? 'left') === alignment)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return (
    <footer className="flex h-6 items-center gap-3 overflow-hidden whitespace-nowrap border-t bg-card px-3 text-xs">
      {side('left').map((item) => (
        <StatusBarItem key={item.id} id={item.id} />
      ))}
      <span className="ml-auto" />
      {side('right')
        .reverse()
        .map((item) => (
          <StatusBarItem key={item.id} id={item.id} />
        ))}
    </footer>
  );
}
