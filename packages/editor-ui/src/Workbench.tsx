import {
  DockviewReact,
  GridviewReact,
  LayoutPriority,
  Orientation,
  type DockviewApi,
  type DockviewTheme,
  type GridviewApi,
  type IGridviewPanelProps,
} from 'dockview-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { areas, docks, type AreaId, type DockId, type Layout } from './layout';
import { defaultPanels, panels } from './panels';
import type { IDisposable } from './state/services';

/**
 * The theme of dockview: the sizes of its dark theme, the colors of
 * shadcn/ui (styles.css), for the grid and every area.
 */
export const dockviewTheme: DockviewTheme = {
  name: 'fdw',
  className: 'dockview-theme-dark dockview-theme-fdw',
  colorScheme: 'dark',
};

const components = Object.fromEntries(
  Object.entries(panels).map(([id, panel]) => [id, panel.component]),
);

/** What the shell does with the panels: the menus, the toolbars. */
export interface WorkbenchApi {
  /** The sizes of the docks and the panels of each area. */
  toJSON(): Pick<Layout, 'grid' | 'areas'>;
  /** The ids of the panels open, in any area. */
  openPanels(): string[];
  /** Shows the panel: in its area by default if it is not open. */
  openPanel(id: string): void;
  closePanel(id: string): void;
}

interface WorkbenchContextValue {
  /** Restores the panels of a new area: once. */
  restoreArea(area: AreaId, api: DockviewApi): void;
  /** Follows the panels of the area, while it is mounted. */
  connectArea(area: AreaId, api: DockviewApi): IDisposable;
  /** The area clicked or focused, and its active panel. */
  focusArea(area: AreaId, api: DockviewApi): void;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

const gridSizes: Readonly<Record<DockId, number>> = {
  left: 240,
  right: 280,
  bottom: 200,
};

// An area of the grid, a DockviewReact. Its panels stay mounted behind
// other tabs and when moved (the `always` renderer): the viewport keeps its
// canvas and its window.
// dockview keeps its instance through a remount (StrictMode), and gives it
// to onReady once: the subscriptions follow the mount, not onReady.
function AreaView({ params }: IGridviewPanelProps<{ area: AreaId }>) {
  const { area } = params;
  const workbench = useContext(WorkbenchContext);
  const [api, setApi] = useState<DockviewApi>();
  useEffect(() => {
    if (!api || !workbench) return;
    const connection = workbench.connectArea(area, api);
    return () => connection.dispose();
    // Not on the workbench, new at each render: its callbacks read refs.
  }, [area, api]);
  if (!workbench) throw new Error('AreaView outside of the Workbench');
  const focus = () => {
    if (api) workbench.focusArea(area, api);
  };
  return (
    // The focus of the editor: the area where the pointer goes down, or
    // the keyboard focus (captured: a panel may stop them).
    <div
      className="h-full w-full"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <DockviewReact
        theme={dockviewTheme}
        components={components}
        defaultRenderer="always"
        // Floating groups over the viewport only: a dock is too small.
        disableFloatingGroups={area !== 'center'}
        onReady={({ api }) => {
          workbench.restoreArea(area, api);
          setApi(api);
        }}
      />
    </div>
  );
}

const gridComponents = { area: AreaView };

// The layout of a new grid: the docks around the central area.
function defaultGrid(api: GridviewApi): void {
  api.addPanel({
    id: 'center',
    component: 'area',
    params: { area: 'center' },
    priority: LayoutPriority.High,
    minimumWidth: 120,
    minimumHeight: 120,
  });
  for (const [dock, direction] of [
    ['bottom', 'below'],
    ['left', 'left'],
    ['right', 'right'],
  ] as const) {
    api.addPanel({
      id: dock,
      component: 'area',
      params: { area: dock },
      size: gridSizes[dock],
      position: { referencePanel: 'center', direction },
      minimumWidth: 120,
      minimumHeight: 60,
    });
  }
}

function defaultArea(area: AreaId, api: DockviewApi): void {
  for (const id of defaultPanels[area]) {
    api.addPanel({ id, component: id, title: panels[id]?.title });
  }
}

/** Restores a layout, or makes the default one if it does not restore. */
function restore<T extends { fromJSON(data: D): void; clear(): void }, D>(
  api: T,
  saved: D | undefined,
  valid: () => boolean,
  makeDefault: () => void,
): void {
  if (saved) {
    try {
      api.fromJSON(saved);
      if (valid()) return;
    } catch (error) {
      console.warn('[editor] The layout does not restore:', error);
    }
    api.clear();
  }
  makeDefault();
}

/**
 * The panels of the editor: a GridviewReact with the central area and the
 * docks around it, each a DockviewReact (design/editor-ui.md §3). The menu
 * bar, the toolbars and the status bar are around it, in the shell.
 */
export function Workbench({
  saved,
  docksShown,
  onReady,
  onChange,
  onPanelsChange,
  onFocus,
  onActivePanelChange,
}: {
  /** The layout to restore; the default one if undefined. */
  readonly saved?: Layout;
  readonly docksShown: Readonly<Record<DockId, boolean>>;
  readonly onReady: (api: WorkbenchApi) => void;
  /** Called at each change of the layout: a panel opened, a sash moved. */
  readonly onChange: () => void;
  /** Called when panels are opened or closed. */
  readonly onPanelsChange: () => void;
  /** Called when an area is clicked or focused, with its active panel. */
  readonly onFocus: (area: AreaId, view?: string) => void;
  /** Called when the active panel of an area changes. */
  readonly onActivePanelChange: (area: AreaId, view?: string) => void;
}) {
  const grid = useRef<GridviewApi>(undefined);
  const areaApis = useRef<Partial<Record<AreaId, DockviewApi>>>({});
  // The latest callbacks, for the subscriptions made once.
  const latest = {
    onChange,
    onPanelsChange,
    onFocus,
    onActivePanelChange,
    docksShown,
  };
  const callbacks = useRef(latest);
  callbacks.current = latest;

  const showDocks = () => {
    for (const dock of docks) {
      const panel = grid.current?.getPanel(dock);
      const shown = callbacks.current.docksShown[dock];
      if (panel && panel.api.isVisible !== shown) panel.api.setVisible(shown);
    }
  };
  useEffect(showDocks, [docksShown]);

  const findPanel = (id: string) => {
    for (const area of areas) {
      const panel = areaApis.current[area]?.getPanel(id);
      if (panel) return panel;
    }
    return undefined;
  };

  const workbench: WorkbenchApi = {
    toJSON: () => ({
      ...(grid.current && { grid: grid.current.toJSON() }),
      areas: Object.fromEntries(
        Object.entries(areaApis.current).map(([area, api]) => [
          area,
          api.toJSON(),
        ]),
      ),
    }),
    openPanels: () =>
      areas.flatMap(
        (area) => areaApis.current[area]?.panels.map((panel) => panel.id) ?? [],
      ),
    openPanel: (id) => {
      const open = findPanel(id);
      if (open) open.api.setActive();
      else {
        const spec = panels[id];
        const api = spec && areaApis.current[spec.area];
        api?.addPanel({ id, component: id, title: spec.title });
      }
      // Its area gets the focus.
      for (const area of areas) {
        if (areaApis.current[area]?.getPanel(id)) {
          callbacks.current.onFocus(area, id);
        }
      }
    },
    closePanel: (id) => findPanel(id)?.api.close(),
  };

  const context: WorkbenchContextValue = {
    restoreArea: (area, api) =>
      restore(
        api,
        saved?.areas[area],
        () => api.panels.every((panel) => panel.id in panels),
        () => defaultArea(area, api),
      ),
    connectArea: (area, api) => {
      areaApis.current[area] = api;
      const changed = () => callbacks.current.onChange();
      const panelsChanged = () => {
        callbacks.current.onPanelsChange();
        changed();
      };
      const subscriptions = [
        api.onDidLayoutChange(changed),
        api.onDidAddPanel(panelsChanged),
        api.onDidRemovePanel(panelsChanged),
        api.onDidActivePanelChange(({ panel }) =>
          callbacks.current.onActivePanelChange(area, panel?.id),
        ),
      ];
      callbacks.current.onPanelsChange();
      return {
        dispose: () => {
          subscriptions.forEach((subscription) => subscription.dispose());
          if (areaApis.current[area] === api) delete areaApis.current[area];
        },
      };
    },
    focusArea: (area, api) =>
      callbacks.current.onFocus(area, api.activePanel?.id),
  };

  return (
    <WorkbenchContext.Provider value={context}>
      <GridviewReact
        className={dockviewTheme.className}
        orientation={Orientation.HORIZONTAL}
        proportionalLayout={false}
        components={gridComponents}
        onReady={({ api }) => {
          grid.current = api;
          restore(
            api,
            saved?.grid,
            () => areas.every((area) => api.getPanel(area)),
            () => defaultGrid(api),
          );
          showDocks();
          api.onDidLayoutChange(() => callbacks.current.onChange());
          onReady(workbench);
        }}
      />
    </WorkbenchContext.Provider>
  );
}
