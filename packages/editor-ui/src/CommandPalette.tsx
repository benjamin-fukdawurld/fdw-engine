import { useSyncExternalStore } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './components/ui/command';
import { useEditor, useItems } from './editorContext';
import { keybindingLabel } from './plugins/contributions';
import { editorIcons } from './plugins/icons';

/**
 * The command palette (`workbench.commandPalette`, Ctrl+Shift+P): the
 * commands enabled, by their category and title, found by typing.
 */
export function CommandPalette() {
  const runtime = useEditor();
  const { workbench, keys, commands } = runtime;
  const open = useSyncExternalStore(workbench.subscribe, () =>
    workbench.paletteOpen(),
  );
  const specs = useItems(commands.specs);
  const bindings = useItems(runtime.keybindings);
  useSyncExternalStore(keys.subscribe, keys.values);
  const listed = open
    ? specs.filter(
        (spec) => spec.palette !== false && keys.matches(spec.enablement),
      )
    : [];
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => workbench.setPalette(next)}
    >
      <CommandInput placeholder="Type a command" />
      <CommandList>
        <CommandEmpty>No command found.</CommandEmpty>
        {listed.map((spec) => {
          const Icon = spec.icon ? editorIcons[spec.icon] : undefined;
          const title = spec.category
            ? `${spec.category}: ${spec.title}`
            : spec.title;
          const shortcut = keybindingLabel(bindings, spec.id);
          return (
            <CommandItem
              key={spec.id}
              value={`${title} ${spec.id}`}
              onSelect={() => {
                workbench.setPalette(false);
                void commands.execute(spec.id);
              }}
            >
              {Icon ? <Icon /> : <span className="size-3.5" />}
              {title}
              {shortcut && <CommandShortcut>{shortcut}</CommandShortcut>}
            </CommandItem>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
