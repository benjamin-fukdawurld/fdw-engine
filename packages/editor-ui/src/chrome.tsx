import {
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  Fragment,
  useContext,
  type FunctionComponent,
} from 'react';
import { Button } from './components/ui/button';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from './components/ui/menubar';
import {
  useEditor,
  useEditorMachine,
  useEditorStore,
  useEngine,
} from './editorContext';
import {
  docks,
  toolbarSides,
  type Chrome,
  type DockId,
  type ToolbarLayout,
  type ToolbarSide,
} from './layout';
import { objectMode, toolSlots } from './state/editorMachine';
import { cn } from './lib/utils';
import { panels } from './panels';

/** What the bars change of the panels; the chrome is in the editor store. */
export interface ShellValue {
  /** The ids of the panels open. */
  readonly openPanels: readonly string[];
  /** Opens the panel, or closes it. */
  togglePanel(id: string, open: boolean): void;
  resetLayout(): void;
}

export const ShellContext = createContext<ShellValue | null>(null);

function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell outside of the EditorShell');
  return value;
}

const dockTitles: Readonly<Record<DockId, string>> = {
  left: 'Left dock',
  right: 'Right dock',
  bottom: 'Bottom dock',
};

const dockIcons: Readonly<Record<DockId, LucideIcon>> = {
  left: PanelLeftIcon,
  right: PanelRightIcon,
  bottom: PanelBottomIcon,
};

const sideTitles: Readonly<Record<ToolbarSide, string>> = {
  top: 'Top',
  left: 'Left',
  right: 'Right',
  bottom: 'Bottom',
};

/** A toolbar: its layout by default, its items. */
export interface ToolbarSpec {
  readonly title: string;
  readonly layout: ToolbarLayout;
  readonly component: FunctionComponent;
}

// The docks, shown and hidden.
function DocksToolbar() {
  const { editor } = useEditor();
  const chrome = useEditorStore();
  return docks.map((dock) => {
    const Icon = dockIcons[dock];
    const shown = chrome.docks[dock];
    return (
      <Button
        key={dock}
        variant="ghost"
        size="icon-xs"
        aria-label={dockTitles[dock]}
        title={dockTitles[dock]}
        aria-pressed={shown}
        className={cn(shown && 'bg-accent text-accent-foreground')}
        onClick={() => editor.trigger.setDock({ dock, shown: !shown })}
      >
        <Icon />
      </Button>
    );
  });
}

/**
 * The toolbars, by id. They come from the plugins with the registries
 * (step 12 of P18).
 */
export const toolbars: Readonly<Record<string, ToolbarSpec>> = {
  docks: {
    title: 'Docks',
    layout: { side: 'top', visible: true },
    component: DocksToolbar,
  },
};

/** The layout of a toolbar: the one saved, or its default. */
export function toolbarLayout(chrome: Chrome, id: string): ToolbarLayout {
  return (
    chrome.toolbars[id] ??
    toolbars[id]?.layout ?? { side: 'top', visible: false }
  );
}

/** The toolbars of a side, in a row (top, bottom) or a column. */
export function ToolbarArea({ side }: { readonly side: ToolbarSide }) {
  const chrome = useEditorStore();
  const shown = Object.entries(toolbars).filter(([id]) => {
    const layout = toolbarLayout(chrome, id);
    return layout.visible && layout.side === side;
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
      {shown.map(([id, toolbar], index) => (
        <Fragment key={id}>
          {index > 0 && (
            <div className={cn('bg-border', vertical ? 'h-px' : 'w-px')} />
          )}
          <div
            role="toolbar"
            aria-label={toolbar.title}
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            className={cn('flex gap-0.5', vertical ? 'flex-col' : 'flex-row')}
          >
            <toolbar.component />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function ViewMenu() {
  const shell = useShell();
  const { editor } = useEditor();
  const chrome = useEditorStore();
  return (
    <MenubarMenu>
      <MenubarTrigger>View</MenubarTrigger>
      <MenubarContent>
        {docks.map((dock) => (
          <MenubarCheckboxItem
            key={dock}
            checked={chrome.docks[dock]}
            onCheckedChange={(shown) => editor.trigger.setDock({ dock, shown })}
          >
            {dockTitles[dock]}
          </MenubarCheckboxItem>
        ))}
        <MenubarSeparator />
        <MenubarLabel>Panels</MenubarLabel>
        {Object.entries(panels).map(([id, panel]) => (
          <MenubarCheckboxItem
            key={id}
            checked={shell.openPanels.includes(id)}
            onCheckedChange={(open) => shell.togglePanel(id, open)}
          >
            {panel.title}
          </MenubarCheckboxItem>
        ))}
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger inset>Toolbars</MenubarSubTrigger>
          <MenubarSubContent>
            {Object.entries(toolbars).map(([id, toolbar]) => {
              const layout = toolbarLayout(chrome, id);
              const change = (next: ToolbarLayout) =>
                editor.trigger.setToolbar({ id, layout: next });
              return (
                <Fragment key={id}>
                  <MenubarLabel>{toolbar.title}</MenubarLabel>
                  <MenubarRadioGroup
                    value={layout.visible ? layout.side : 'hidden'}
                    onValueChange={(value) =>
                      change(
                        value === 'hidden'
                          ? { ...layout, visible: false }
                          : { side: value as ToolbarSide, visible: true },
                      )
                    }
                  >
                    {toolbarSides.map((side) => (
                      <MenubarRadioItem key={side} value={side}>
                        {sideTitles[side]}
                      </MenubarRadioItem>
                    ))}
                    <MenubarRadioItem value="hidden">Hidden</MenubarRadioItem>
                  </MenubarRadioGroup>
                </Fragment>
              );
            })}
          </MenubarSubContent>
        </MenubarSub>
        <MenubarCheckboxItem
          checked={chrome.statusBar}
          onCheckedChange={(shown) => editor.trigger.setStatusBar({ shown })}
        >
          Status bar
        </MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarItem inset onSelect={() => shell.resetLayout()}>
          Reset layout
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function SceneMenu() {
  const { showScene } = useEditor();
  const { scenes, scene } = useEngine();
  return (
    <MenubarMenu>
      <MenubarTrigger disabled={scenes.length === 0}>Scene</MenubarTrigger>
      <MenubarContent>
        <MenubarRadioGroup value={scene} onValueChange={showScene}>
          {scenes.map((name) => (
            <MenubarRadioItem key={name} value={name}>
              {name}
            </MenubarRadioItem>
          ))}
        </MenubarRadioGroup>
      </MenubarContent>
    </MenubarMenu>
  );
}

/** The menu bar: the menus of the editor, then those of the plugins (step 12). */
export function MenuBar() {
  return (
    <header className="flex items-center gap-2 border-b bg-card px-2">
      <strong className="px-1 text-xs font-semibold">FDW Editor</strong>
      <Menubar>
        <ViewMenu />
        <SceneMenu />
      </Menubar>
    </header>
  );
}

// The mode and the tools active, by their titles.
function EditingStatus() {
  const { tools, modes } = useEditor();
  const mode = useEditorMachine((snapshot) => snapshot.context.mode);
  const active = useEditorMachine((snapshot) => snapshot.context.tools);
  const toolTitles = toolSlots.flatMap((slot) => {
    const id = active[slot];
    return id ? [tools.get(id)?.title ?? id] : [];
  });
  return (
    <span className="text-muted-foreground">
      {mode === objectMode ? 'Object' : (modes.get(mode)?.title ?? mode)} mode
      {toolTitles.length > 0 && ` · ${toolTitles.join(', ')}`}
    </span>
  );
}

/** The status bar: the backend, the device, the frames; the mode; the host. */
export function StatusBar() {
  const { host } = useEditor();
  const { device, backend, fallback, loading, stats, error } = useEngine();
  return (
    <footer className="flex h-6 items-center gap-3 overflow-hidden whitespace-nowrap border-t bg-card px-3 text-xs">
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : (
        <span>
          {device ? `${backend} · ${device}` : 'Starting the engine…'}
          {stats &&
            ` · ${stats.fps} fps · ${stats.width} × ${stats.height}${
              stats.info ? ` · ${stats.info}` : ''
            }`}
        </span>
      )}
      {loading && <span className="text-muted-foreground">Loading…</span>}
      {fallback && (
        <span className="text-amber-500" title={fallback}>
          Fallback: {fallback}
        </span>
      )}
      <span className="ml-auto" />
      <EditingStatus />
      <span className="text-muted-foreground">{host.about}</span>
    </footer>
  );
}
