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
import { useEditor } from './engineState';
import {
  docks,
  toolbarSides,
  type Chrome,
  type DockId,
  type ToolbarLayout,
  type ToolbarSide,
} from './layout';
import { cn } from './lib/utils';
import { panels } from './panels';

/** What the bars change: the chrome, the panels. */
export interface ShellValue {
  readonly chrome: Chrome;
  setChrome(change: (chrome: Chrome) => Chrome): void;
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

function setDock(shell: ShellValue, dock: DockId, shown: boolean): void {
  shell.setChrome((chrome) => ({
    ...chrome,
    docks: { ...chrome.docks, [dock]: shown },
  }));
}

/** A toolbar: its layout by default, its items. */
export interface ToolbarSpec {
  readonly title: string;
  readonly layout: ToolbarLayout;
  readonly component: FunctionComponent;
}

// The docks, shown and hidden.
function DocksToolbar() {
  const shell = useShell();
  return docks.map((dock) => {
    const Icon = dockIcons[dock];
    const shown = shell.chrome.docks[dock];
    return (
      <Button
        key={dock}
        variant="ghost"
        size="icon-xs"
        aria-label={dockTitles[dock]}
        title={dockTitles[dock]}
        aria-pressed={shown}
        className={cn(shown && 'bg-accent text-accent-foreground')}
        onClick={() => setDock(shell, dock, !shown)}
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
  const { chrome } = useShell();
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
  const { chrome } = shell;
  return (
    <MenubarMenu>
      <MenubarTrigger>View</MenubarTrigger>
      <MenubarContent>
        {docks.map((dock) => (
          <MenubarCheckboxItem
            key={dock}
            checked={chrome.docks[dock]}
            onCheckedChange={(shown) => setDock(shell, dock, shown)}
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
                shell.setChrome((current) => ({
                  ...current,
                  toolbars: { ...current.toolbars, [id]: next },
                }));
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
          onCheckedChange={(statusBar) =>
            shell.setChrome((current) => ({ ...current, statusBar }))
          }
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
  const { scenes, scene, showScene } = useEditor().engine;
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

/** The status bar: the backend, the device, the frames; the host. */
export function StatusBar() {
  const { host, engine } = useEditor();
  const { device, backend, fallback, loading, stats, error } = engine;
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
      <span className="ml-auto text-muted-foreground">{host.about}</span>
    </footer>
  );
}
