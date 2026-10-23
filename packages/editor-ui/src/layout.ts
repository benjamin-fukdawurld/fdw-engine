import type {
  SerializedDockview,
  SerializedGridviewComponent,
} from 'dockview-react';

/** The docks around the central area. */
export type DockId = 'left' | 'right' | 'bottom';

/** Where a panel lives: the central area or a dock. */
export type AreaId = 'center' | DockId;

export const docks: readonly DockId[] = ['left', 'right', 'bottom'];
export const areas: readonly AreaId[] = ['center', ...docks];

export type ToolbarSide = 'top' | 'left' | 'right' | 'bottom';

export const toolbarSides: readonly ToolbarSide[] = [
  'top',
  'left',
  'right',
  'bottom',
];

export interface ToolbarLayout {
  readonly side: ToolbarSide;
  readonly visible: boolean;
}

/**
 * What the shell shows around the panels: the docks, the toolbars and their
 * side, the status bar. React state, unlike the panels, which dockview
 * keeps.
 */
export interface Chrome {
  readonly docks: Readonly<Record<DockId, boolean>>;
  readonly toolbars: Readonly<Record<string, ToolbarLayout>>;
  readonly statusBar: boolean;
}

/**
 * The layout document, kept by the host between sessions (design/editor-ui.md
 * §3): the chrome, the sizes of the docks (the toJSON of the GridviewReact)
 * and the panels of each area (that of each DockviewReact); with them, the
 * state of the editor (design/editor-state.md §6): that of its machine and
 * of its plugins.
 */
export interface Layout extends Chrome {
  readonly version: typeof layoutVersion;
  readonly grid?: SerializedGridviewComponent;
  readonly areas: Partial<Record<AreaId, SerializedDockview>>;
  /** The machine of the editor (persistEditor), checked when restored. */
  readonly machine?: unknown;
  /** The state of each plugin, by its id. */
  readonly plugins?: Readonly<Record<string, unknown>>;
}

export const layoutVersion = 1;

/** Its key in the storage of the host. */
export const layoutKey = 'layout';

// The toolbars missing here have the layout they declare (toolbars.tsx).
export const defaultChrome: Chrome = {
  docks: { left: true, right: true, bottom: true },
  toolbars: {},
  statusBar: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The layout read from the storage: what is valid of it over the defaults;
 * undefined if it is not a layout of this version (none yet, or an older
 * one). The JSON of dockview is checked by dockview, and that of the
 * machine by the machine, when restored.
 */
export function readLayout(saved: unknown): Layout | undefined {
  if (!isRecord(saved) || saved['version'] !== layoutVersion) return undefined;
  const savedDocks = isRecord(saved['docks']) ? saved['docks'] : {};
  const docksShown = Object.fromEntries(
    docks.map((dock) => {
      const shown = savedDocks[dock];
      return [dock, typeof shown === 'boolean' ? shown : true];
    }),
  ) as Record<DockId, boolean>;
  const toolbars: Record<string, ToolbarLayout> = {};
  if (isRecord(saved['toolbars'])) {
    for (const [id, toolbar] of Object.entries(saved['toolbars'])) {
      if (
        isRecord(toolbar) &&
        toolbarSides.includes(toolbar['side'] as ToolbarSide) &&
        typeof toolbar['visible'] === 'boolean'
      ) {
        toolbars[id] = {
          side: toolbar['side'] as ToolbarSide,
          visible: toolbar['visible'],
        };
      }
    }
  }
  const savedAreas = isRecord(saved['areas']) ? saved['areas'] : {};
  return {
    version: layoutVersion,
    docks: docksShown,
    toolbars,
    statusBar:
      typeof saved['statusBar'] === 'boolean' ? saved['statusBar'] : true,
    ...(isRecord(saved['grid']) && {
      grid: saved['grid'] as unknown as SerializedGridviewComponent,
    }),
    areas: Object.fromEntries(
      areas
        .filter((area) => isRecord(savedAreas[area]))
        .map((area) => [area, savedAreas[area] as SerializedDockview]),
    ),
    ...(saved['machine'] !== undefined && { machine: saved['machine'] }),
    ...(isRecord(saved['plugins']) && { plugins: saved['plugins'] }),
  };
}
