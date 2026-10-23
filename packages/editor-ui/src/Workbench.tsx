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
import { createContext, useContext, useEffect, useRef } from 'react';
import { areas, docks, type AreaId, type DockId, type Layout } from './layout';
import { defaultPanels, panels } from './panels';

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
  areaReady(area: AreaId, api: DockviewApi): IDisposable;
}

interface IDisposable {
  dispose(): void;
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
function AreaView({ params }: IGridviewPanelProps<{ area: AreaId }>) {
  const { area } = params;
  const workbench = useContext(WorkbenchContext);
  const subscription = useRef<IDisposable>(undefined);
  useEffect(() => () => subscription.current?.dispose(), []);
  if (!workbench) throw new Error('AreaView outside of the Workbench');
  return (
    <DockviewReact
      theme={dockviewTheme}
      components={components}
      defaultRenderer="always"
      // Floating groups over the viewport only: a dock is too small.
      disableFloatingGroups={area !== 'center'}
      onReady={({ api }) => {
        subscription.current?.dispose();
        subscription.current = workbench.areaReady(area, api);
      }}
    />
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
}: {
  /** The layout to restore; the default one if undefined. */
  readonly saved?: Layout;
  readonly docksShown: Readonly<Record<DockId, boolean>>;
  readonly onReady: (api: WorkbenchApi) => void;
  /** Called at each change of the layout: a panel opened, a sash moved. */
  readonly onChange: () => void;
  /** Called when panels are opened or closed. */
  readonly onPanelsChange: () => void;
}) {
  const grid = useRef<GridviewApi>(undefined);
  const areaApis = useRef<Partial<Record<AreaId, DockviewApi>>>({});
  // The latest callbacks, for the subscriptions made once.
  const callbacks = useRef({ onChange, onPanelsChange, docksShown });
  callbacks.current = { onChange, onPanelsChange, docksShown };

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
      if (open) {
        open.api.setActive();
        return;
      }
      const spec = panels[id];
      const api = spec && areaApis.current[spec.area];
      api?.addPanel({ id, component: id, title: spec.title });
    },
    closePanel: (id) => findPanel(id)?.api.close(),
  };

  const context: WorkbenchContextValue = {
    areaReady: (area, api) => {
      areaApis.current[area] = api;
      restore(
        api,
        saved?.areas[area],
        () => api.panels.every((panel) => panel.id in panels),
        () => defaultArea(area, api),
      );
      const changed = () => callbacks.current.onChange();
      const panelsChanged = () => {
        callbacks.current.onPanelsChange();
        changed();
      };
      const subscriptions = [
        api.onDidLayoutChange(changed),
        api.onDidAddPanel(panelsChanged),
        api.onDidRemovePanel(panelsChanged),
      ];
      callbacks.current.onPanelsChange();
      return {
        dispose: () => {
          subscriptions.forEach((subscription) => subscription.dispose());
          if (areaApis.current[area] === api) delete areaApis.current[area];
        },
      };
    },
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
