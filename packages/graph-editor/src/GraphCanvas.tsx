import { cn } from '@fdw/editor-ui';
import {
  type GraphEdge,
  type GraphFragment,
  type GraphNode,
  NodeGeometry,
  type Point,
  type PortRef,
} from '@fdw/engine-graph';
import type {
  GraphCommand,
  GraphView,
  NodeTemplate,
  NodeView,
  PortView,
} from '@fdw/engine-graph-editing';
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  boundsOf,
  categoryColor,
  edgeKey,
  groupBounds,
  portPoint,
  positionOf,
  sizeOf,
  typeColor,
  wirePath,
} from './geometry';
import { NodeSearch, type SearchItem } from './NodeSearch';

/** What a node shows of the running graph: its state, its weight, its values. */
export interface NodeOverlay {
  /** Classes added to the node: `ring-2 ring-amber-400`… */
  readonly className?: string;
  /** A short text at its top right: `3×`, `0.42`. */
  readonly badge?: string;
  /** A bar under its title, from 0 to 1: its weight in a pose. */
  readonly weight?: number;
  /** A text next to an output, by port: its last value. */
  readonly values?: Readonly<Record<string, string>>;
  /** A dot before its title. */
  readonly marker?: 'breakpoint' | 'paused';
}

/** The state of the running graph, over the canvas. */
export interface GraphOverlay {
  readonly nodes?: Readonly<Record<string, NodeOverlay>>;
  /** The edges that just carried the flow, by {@link edgeKey}. */
  readonly edges?: ReadonlySet<string>;
}

/** A port being dragged from, or connected to. */
export interface PortTarget {
  readonly port: PortRef;
  readonly side: 'input' | 'output';
}

export interface GraphCanvasProps {
  readonly view: GraphView;
  readonly templates: readonly NodeTemplate[];
  /** Whether an output of a type may feed an input of another (the kind's hint). */
  readonly accepts: (from: string, to: string) => boolean;
  readonly dispatch: (command: GraphCommand) => void;
  /** The ids of the nodes, notes and groups selected, `edge:<key>` for the edges. */
  readonly selection: readonly string[];
  readonly onSelectionChange: (selection: readonly string[]) => void;
  readonly overlay?: GraphOverlay;
  /** A double click on a node: its own editor (a state machine). */
  readonly onOpenNode?: (node: NodeView) => void;
  /**
   * The keys the canvas does not use, while it has the focus: true when
   * handled (F9 on a node).
   */
  readonly onKey?: (event: KeyboardEvent) => boolean;
  /** Changed to frame the graph (or the selection). */
  readonly frameRequest?: number;
  /** Changed to frame and select a node (a problem clicked). */
  readonly reveal?: { readonly node: string; readonly request: number };
  readonly className?: string;
}

type Drag =
  | {
      readonly kind: 'move';
      readonly start: Point;
      readonly origins: ReadonlyMap<string, Point>;
      moved: Map<string, Point>;
      readonly notes: ReadonlySet<string>;
    }
  | {
      readonly kind: 'box';
      readonly start: Point;
      current: Point;
      readonly base: readonly string[];
    }
  | {
      readonly kind: 'pan';
      readonly start: Point;
      readonly origin: Point;
    }
  | {
      readonly kind: 'wire';
      readonly from: PortTarget;
      readonly type: string;
      readonly exec: boolean;
      current: Point;
    };

// What a copy holds: the nodes, their edges, the notes. In the page, for
// the editors of the same kind; on the system clipboard as JSON too.
let clipboard: { kind: string; fragment: GraphFragment } | undefined;

const nodeOf = (view: GraphView, id: string) =>
  view.nodes.find((node) => node.id === id);

function portOf(
  node: NodeView | undefined,
  side: 'input' | 'output',
  name: string,
): PortView | undefined {
  return (side === 'input' ? node?.inputs : node?.outputs)?.find(
    (port) => port.name === name,
  );
}

const shown = (value: unknown): string => {
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000);
  if (Array.isArray(value)) return value.map(shown).join(', ');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>)
      .map(shown)
      .join(', ');
  }
  return String(value);
};

/** The nodes, notes and groups selected, as a fragment to copy. */
export function fragmentOf(
  view: GraphView,
  ids: readonly string[],
): GraphFragment {
  const chosen = new Set(ids);
  const nodes: GraphNode[] = view.nodes
    .filter((node) => chosen.has(node.id))
    .map((node) => ({
      id: node.id,
      type: node.type,
      params: node.params,
      ...(node.defaults && { defaults: node.defaults }),
      ...(node.label !== undefined && { label: node.label }),
    }));
  const notes = (view.layout.notes ?? []).filter((note) => chosen.has(note.id));
  const kept = new Set(nodes.map((node) => node.id));
  const corners = [...nodes.map((node) => positionOf(view, node.id)), ...notes];
  const origin = {
    x: Math.min(...corners.map((p) => p.x)),
    y: Math.min(...corners.map((p) => p.y)),
  };
  return {
    nodes,
    edges: view.edges.filter(
      (edge) => kept.has(edge.from.node) && kept.has(edge.to.node),
    ),
    positions: Object.fromEntries(
      nodes.map((node) => {
        const p = positionOf(view, node.id);
        return [node.id, { x: p.x - origin.x, y: p.y - origin.y }];
      }),
    ),
    ...(notes.length > 0 && {
      notes: notes.map((note) => ({
        ...note,
        x: note.x - origin.x,
        y: note.y - origin.y,
      })),
    }),
  };
}

/**
 * The canvas of an editor of graphs: the nodes and their ports, the wires,
 * the notes and the groups of a {@link GraphView}, changed by
 * {@link GraphCommand}s. The middle or the right button moves the view,
 * the wheel zooms; a click selects (Shift adds, Ctrl toggles), a drag
 * on the background selects in a rectangle, a drag on a node moves the
 * selection; a drag from a port makes a wire (to a port, or into the void:
 * the search, for a node that takes it); Alt+click on a port disconnects
 * it. The keys, once it has the focus: Delete, Ctrl+C, X, V, D, A, Z, Y; F
 * frames, Space or Tab searches a node to add, Ctrl+F one of the graph, N
 * lays a note, Ctrl+G groups.
 */
export function GraphCanvas({
  view,
  templates,
  accepts,
  dispatch,
  selection,
  onSelectionChange,
  overlay,
  onOpenNode,
  onKey,
  frameRequest,
  reveal,
  className,
}: GraphCanvasProps) {
  const element = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState({ x: 40, y: 40, zoom: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag | undefined>(undefined);
  const [search, setSearch] = useState<{
    at: Point;
    world: Point;
    connect?: PortTarget & { readonly type: string; readonly exec: boolean };
  }>();
  const [finding, setFinding] = useState<Point>();
  const [editing, setEditing] = useState<string>();
  const pointer = useRef<Point>({ x: 0, y: 0 });
  const selected = useMemo(() => new Set(selection), [selection]);

  // The point of the graph under a point of the page.
  const toWorld = (clientX: number, clientY: number): Point => {
    const box = element.current?.getBoundingClientRect();
    const { x, y, zoom } = cameraRef.current;
    return {
      x: (clientX - (box?.left ?? 0) - x) / zoom,
      y: (clientY - (box?.top ?? 0) - y) / zoom,
    };
  };
  const toScreen = (point: Point): Point => {
    const { x, y, zoom } = cameraRef.current;
    return { x: point.x * zoom + x, y: point.y * zoom + y };
  };

  // Frames nodes: zoomed out down to `least` (a large graph framed whole
  // shows its middle, readable).
  const frame = (ids: readonly string[], least = 0.2) => {
    const host = element.current;
    const bounds = boundsOf(view, ids);
    if (!host || !bounds || host.clientWidth === 0) return;
    const margin = 60;
    const zoom = Math.min(
      1.25,
      Math.max(
        least,
        Math.min(
          host.clientWidth / (bounds.width + 2 * margin),
          host.clientHeight / (bounds.height + 2 * margin),
        ),
      ),
    );
    setCamera({
      zoom,
      x: host.clientWidth / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: host.clientHeight / 2 - (bounds.y + bounds.height / 2) * zoom,
    });
  };
  const all = () => [
    ...view.nodes.map((node) => node.id),
    ...(view.layout.notes ?? []).map((note) => note.id),
  ];

  // A new graph or another scope: framed whole.
  const shownKey = `${view.session}|${view.scope ?? ''}|${view.target ?? view.file ?? view.name}`;
  useEffect(() => {
    frame(all(), 0.5);
    // Framed once per graph shown, not at each edit.
  }, [shownKey]);
  const framed = useRef(frameRequest);
  useEffect(() => {
    if (frameRequest === framed.current) return;
    framed.current = frameRequest;
    frame(selection.length > 0 ? selection : all());
  }, [frameRequest]);
  const revealed = useRef(reveal?.request);
  useEffect(() => {
    if (!reveal || reveal.request === revealed.current) return;
    revealed.current = reveal.request;
    onSelectionChange([reveal.node]);
    frame([reveal.node]);
  }, [reveal?.request]);

  const select = (
    id: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    if (event.ctrlKey || event.metaKey) {
      onSelectionChange(
        selected.has(id)
          ? selection.filter((s) => s !== id)
          : [...selection, id],
      );
    } else if (event.shiftKey) {
      if (!selected.has(id)) onSelectionChange([...selection, id]);
    } else if (!selected.has(id)) {
      onSelectionChange([id]);
    }
  };

  // The drags follow the pointer over the whole page, and end where it is
  // released: on a port, a wire is connected.
  const startDrag = (next: Drag) => {
    dragRef.current = next;
    setDrag(next);
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const world = toWorld(event.clientX, event.clientY);
      pointer.current = world;
      switch (current.kind) {
        case 'move': {
          const dx = world.x - current.start.x;
          const dy = world.y - current.start.y;
          current.moved = new Map(
            [...current.origins].map(([id, p]) => [
              id,
              { x: Math.round(p.x + dx), y: Math.round(p.y + dy) },
            ]),
          );
          break;
        }
        case 'box':
        case 'wire':
          current.current = world;
          break;
        case 'pan':
          setCamera({
            ...cameraRef.current,
            x: current.origin.x + event.clientX - current.start.x,
            y: current.origin.y + event.clientY - current.start.y,
          });
          return;
      }
      dragRef.current = { ...current };
      setDrag(dragRef.current);
    };
    const up = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const current = dragRef.current;
      dragRef.current = undefined;
      setDrag(undefined);
      if (current) endDrag(current, event);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const endDrag = (current: Drag, event: PointerEvent) => {
    switch (current.kind) {
      case 'move': {
        const moved = [...current.moved].filter(([id, p]) => {
          const origin = current.origins.get(id);
          return origin && (origin.x !== p.x || origin.y !== p.y);
        });
        if (moved.length > 0) {
          dispatch({ op: 'move', positions: Object.fromEntries(moved) });
        }
        return;
      }
      case 'box': {
        const { start, current: end } = current;
        const box = {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          right: Math.max(start.x, end.x),
          bottom: Math.max(start.y, end.y),
        };
        if (box.right - box.x < 2 && box.bottom - box.y < 2) {
          onSelectionChange(current.base);
          return;
        }
        const inside = view.nodes
          .filter((node) => {
            const p = positionOf(view, node.id);
            const size = sizeOf(node);
            return (
              p.x < box.right &&
              p.x + size.width > box.x &&
              p.y < box.bottom &&
              p.y + size.height > box.y
            );
          })
          .map((node) => node.id);
        onSelectionChange([...new Set([...current.base, ...inside])]);
        return;
      }
      case 'wire': {
        const target = (event.target as Element | null)?.closest?.(
          '[data-port]',
        ) as HTMLElement | null;
        if (target) {
          const node = target.dataset['node'] as string;
          const port = target.dataset['port'] as string;
          const side = target.dataset['side'] as 'input' | 'output';
          if (side === current.from.side || node === current.from.port.node) {
            return;
          }
          const ends =
            side === 'input'
              ? { from: current.from.port, to: { node, port } }
              : { from: { node, port }, to: current.from.port };
          dispatch({ op: 'connect', ...ends });
          return;
        }
        // Into the void: a node that takes it.
        const box = element.current?.getBoundingClientRect();
        setSearch({
          at: {
            x: event.clientX - (box?.left ?? 0),
            y: event.clientY - (box?.top ?? 0),
          },
          world: current.current,
          connect: { ...current.from, type: current.type, exec: current.exec },
        });
        return;
      }
      case 'pan':
        return;
    }
  };

  const backgroundDown = (event: ReactPointerEvent) => {
    element.current?.focus({ preventScroll: true });
    if (search || finding) return;
    if (event.button === 1 || event.button === 2) {
      event.preventDefault();
      startDrag({
        kind: 'pan',
        start: { x: event.clientX, y: event.clientY },
        origin: { x: cameraRef.current.x, y: cameraRef.current.y },
      });
      return;
    }
    if (event.button !== 0) return;
    const world = toWorld(event.clientX, event.clientY);
    startDrag({
      kind: 'box',
      start: world,
      current: world,
      base: event.shiftKey || event.ctrlKey ? selection : [],
    });
  };

  // A drag on a node, a note or a group moves the selection (with the
  // nodes of the groups selected).
  const itemDown = (id: string, event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    element.current?.focus({ preventScroll: true });
    select(id, event);
    const ids = new Set(
      selected.has(id) || event.shiftKey || event.ctrlKey || event.metaKey
        ? [...selection, id]
        : [id],
    );
    for (const group of view.layout.groups ?? []) {
      if (ids.has(group.id)) group.nodes.forEach((node) => ids.add(node));
    }
    const origins = new Map<string, Point>();
    const notes = new Set<string>();
    for (const item of ids) {
      if (nodeOf(view, item)) origins.set(item, positionOf(view, item));
      const note = view.layout.notes?.find((n) => n.id === item);
      if (note) {
        origins.set(item, { x: note.x, y: note.y });
        notes.add(item);
      }
    }
    startDrag({
      kind: 'move',
      start: toWorld(event.clientX, event.clientY),
      origins,
      moved: new Map(origins),
      notes,
    });
  };

  const portDown = (
    node: NodeView,
    port: PortView,
    side: 'input' | 'output',
    event: ReactPointerEvent,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    element.current?.focus({ preventScroll: true });
    if (event.altKey) {
      dispatch({ op: 'disconnect', port: { node: node.id, port: port.name } });
      return;
    }
    startDrag({
      kind: 'wire',
      from: { port: { node: node.id, port: port.name }, side },
      type: port.type,
      exec: port.exec === true,
      current: toWorld(event.clientX, event.clientY),
    });
  };

  const wheel = (event: WheelEvent) => {
    const box = element.current?.getBoundingClientRect();
    const { x, y, zoom } = cameraRef.current;
    const next = Math.min(
      2.5,
      Math.max(0.15, zoom * Math.exp(-event.deltaY / 500)),
    );
    const px = event.clientX - (box?.left ?? 0);
    const py = event.clientY - (box?.top ?? 0);
    setCamera({
      zoom: next,
      x: px - ((px - x) / zoom) * next,
      y: py - ((py - y) / zoom) * next,
    });
  };

  const copy = (ids: readonly string[]) => {
    const fragment = fragmentOf(view, ids);
    if (fragment.nodes.length === 0 && !fragment.notes) return false;
    clipboard = { kind: view.kind, fragment };
    void navigator.clipboard
      ?.writeText(
        JSON.stringify({
          format: 'fdw-graph-fragment',
          kind: view.kind,
          fragment,
        }),
      )
      .catch(() => undefined);
    return true;
  };
  const paste = (at: Point) => {
    if (clipboard?.kind === view.kind) {
      dispatch({ op: 'paste', fragment: clipboard.fragment, at });
    }
  };
  const removeSelection = () => {
    const edges = selection
      .filter((id) => id.startsWith('edge:'))
      .map((id) => view.edges.find((edge) => `edge:${edgeKey(edge)}` === id))
      .filter((edge): edge is GraphEdge => edge !== undefined);
    const items = selection.filter((id) => !id.startsWith('edge:'));
    if (edges.length > 0) dispatch({ op: 'disconnect', edges });
    if (items.length > 0) dispatch({ op: 'remove', ids: items });
    onSelectionChange([]);
  };
  const nextId = (prefix: string, taken: readonly { id: string }[]) => {
    let i = 1;
    while (taken.some((item) => item.id === `${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  };

  const keyDown = (event: KeyboardEvent) => {
    if (event.target !== element.current) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let handled = true;
    if (key === 'delete' || key === 'backspace') {
      removeSelection();
    } else if (ctrl && key === 'z' && !event.shiftKey) {
      dispatch({ op: 'undo' });
    } else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) {
      dispatch({ op: 'redo' });
    } else if (ctrl && key === 'a') {
      onSelectionChange(all());
    } else if (ctrl && key === 'c') {
      copy(selection);
    } else if (ctrl && key === 'x') {
      if (copy(selection)) removeSelection();
    } else if (ctrl && key === 'v') {
      paste(pointer.current);
    } else if (ctrl && key === 'd') {
      const fragment = fragmentOf(view, selection);
      if (fragment.nodes.length > 0) {
        const bounds = boundsOf(view, selection);
        dispatch({
          op: 'paste',
          fragment,
          at: { x: (bounds?.x ?? 0) + 40, y: (bounds?.y ?? 0) + 40 },
        });
      }
    } else if (ctrl && key === 'f') {
      setFinding(toScreen(pointer.current));
    } else if (ctrl && key === 'g') {
      const nodes = selection.filter((id) => nodeOf(view, id));
      if (event.shiftKey) {
        const groups = selection.filter((id) =>
          view.layout.groups?.some((g) => g.id === id),
        );
        if (groups.length > 0) dispatch({ op: 'remove', ids: groups });
      } else if (nodes.length > 0) {
        const id = nextId('group', view.layout.groups ?? []);
        dispatch({ op: 'group', group: { id, title: 'Group', nodes } });
        onSelectionChange([id]);
      }
    } else if (!ctrl && key === 'f') {
      frame(selection.length > 0 ? selection : all());
    } else if (key === 'home') {
      frame(all());
    } else if (!ctrl && (key === ' ' || key === 'tab')) {
      setSearch({ at: toScreen(pointer.current), world: pointer.current });
    } else if (!ctrl && key === 'n') {
      const id = nextId('note', view.layout.notes ?? []);
      dispatch({
        op: 'note',
        note: {
          id,
          ...pointer.current,
          width: 200,
          height: 80,
          text: 'A note',
        },
      });
      setEditing(id);
    } else {
      handled = onKey?.(event) ?? false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // The templates the search offers: those that take the wire dragged.
  const searchItems = useMemo((): SearchItem[] => {
    const connect = search?.connect;
    return templates
      .filter((template) => {
        if (!connect) return true;
        const candidates =
          connect.side === 'output' ? template.inputs : template.outputs;
        return candidates.some(
          (port) =>
            Boolean(port.exec) === connect.exec &&
            (connect.side === 'output'
              ? accepts(connect.type, port.type)
              : accepts(port.type, connect.type)),
        );
      })
      .map((template) => ({
        id: template.id,
        title: template.title,
        category: template.category,
        ...(template.description && { detail: template.description }),
        keywords: [template.type, ...(template.keywords ?? [])],
      }));
  }, [templates, search, accepts]);

  const findItems = useMemo(
    (): SearchItem[] =>
      view.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        detail: `#${node.id} · ${node.type}`,
        ...(node.category && { category: node.category }),
      })),
    [view.nodes],
  );

  const moved = drag?.kind === 'move' ? drag.moved : undefined;
  const wire = drag?.kind === 'wire' ? drag : undefined;
  // Whether a port can take the wire dragged.
  const fits = (node: NodeView, port: PortView, side: 'input' | 'output') =>
    wire !== undefined &&
    side !== wire.from.side &&
    node.id !== wire.from.port.node &&
    Boolean(port.exec) === wire.exec &&
    (side === 'input'
      ? accepts(wire.type, port.type)
      : accepts(port.type, wire.type));

  const connected = useMemo(() => {
    const set = new Set<string>();
    for (const edge of view.edges) {
      set.add(`${edge.from.node}:${edge.from.port}`);
      set.add(`${edge.to.node}:${edge.to.port}`);
    }
    return set;
  }, [view.edges]);
  const problems = useMemo(() => {
    const byNode = new Map<string, string[]>();
    for (const d of view.diagnostics) {
      if (!d.node || d.severity !== 'error') continue;
      byNode.set(d.node, [...(byNode.get(d.node) ?? []), d.message]);
    }
    return byNode;
  }, [view.diagnostics]);

  const { header, row } = NodeGeometry;
  const box =
    drag?.kind === 'box'
      ? {
          x: Math.min(drag.start.x, drag.current.x),
          y: Math.min(drag.start.y, drag.current.y),
          width: Math.abs(drag.current.x - drag.start.x),
          height: Math.abs(drag.current.y - drag.start.y),
        }
      : undefined;

  return (
    <div
      ref={element}
      tabIndex={0}
      role="application"
      aria-label={`${view.name}: graph`}
      className={cn(
        'relative h-full w-full touch-none overflow-hidden bg-[#1b1b1f] outline-none select-none',
        className,
      )}
      style={{
        backgroundImage:
          'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)',
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={backgroundDown}
      onPointerMove={(event) => {
        pointer.current = toWorld(event.clientX, event.clientY);
      }}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const world = toWorld(event.clientX, event.clientY);
        setSearch({ at: toScreen(world), world });
      }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={wheel}
      onKeyDown={keyDown}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
        }}
      >
        {(view.layout.groups ?? []).map((group) => {
          const bounds = groupBounds(view, group, moved);
          if (!bounds) return null;
          const color = group.color ?? '#71717a';
          return (
            <div
              key={group.id}
              data-group={group.id}
              className={cn(
                'absolute rounded-md border',
                selected.has(group.id) && 'ring-2 ring-sky-400',
              )}
              style={{
                left: bounds.x,
                top: bounds.y,
                width: bounds.width,
                height: bounds.height,
                borderColor: color,
                background: `color-mix(in srgb, ${color} 12%, transparent)`,
              }}
            >
              <div
                className="flex h-6 cursor-grab items-center px-2 text-xs font-medium text-white"
                style={{
                  background: `color-mix(in srgb, ${color} 45%, transparent)`,
                }}
                onPointerDown={(event) => itemDown(group.id, event)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setEditing(group.id);
                }}
              >
                {editing === group.id ? (
                  <input
                    autoFocus
                    aria-label="Group title"
                    className="w-full bg-transparent outline-none"
                    defaultValue={group.title}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter' || event.key === 'Escape') {
                        event.currentTarget.blur();
                      }
                    }}
                    onBlur={(event) => {
                      setEditing(undefined);
                      if (event.target.value !== group.title) {
                        dispatch({
                          op: 'editGroup',
                          id: group.id,
                          change: { title: event.target.value },
                        });
                      }
                    }}
                  />
                ) : (
                  group.title
                )}
              </div>
            </div>
          );
        })}

        <svg
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          width={1}
          height={1}
        >
          {view.edges.map((edge) => {
            const from = nodeOf(view, edge.from.node);
            const to = nodeOf(view, edge.to.node);
            if (!from || !to) return null;
            const a = portPoint(
              from,
              positionOf(view, from.id, moved),
              'output',
              edge.from.port,
            );
            const b = portPoint(
              to,
              positionOf(view, to.id, moved),
              'input',
              edge.to.port,
            );
            if (!a || !b) return null;
            const port = portOf(from, 'output', edge.from.port);
            const key = edgeKey(edge);
            const isSelected = selected.has(`edge:${key}`);
            const active = overlay?.edges?.has(key) ?? false;
            const path = wirePath(a, b);
            return (
              <g key={key} data-edge={key}>
                <path
                  d={path}
                  className="pointer-events-auto cursor-pointer"
                  stroke="transparent"
                  strokeWidth={12}
                  fill="none"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    element.current?.focus({ preventScroll: true });
                    select(`edge:${key}`, event);
                  }}
                />
                <path
                  d={path}
                  fill="none"
                  stroke={isSelected ? '#38bdf8' : typeColor(port?.type ?? '')}
                  strokeWidth={port?.exec ? 3 : 2}
                  opacity={active || isSelected ? 1 : 0.75}
                />
                {active && (
                  <path
                    d={path}
                    fill="none"
                    stroke="#fde047"
                    strokeWidth={4}
                    className="fdw-graph-flow"
                  />
                )}
              </g>
            );
          })}
          {wire &&
            (() => {
              const node = nodeOf(view, wire.from.port.node);
              const at = node
                ? portPoint(
                    node,
                    positionOf(view, node.id),
                    wire.from.side,
                    wire.from.port.port,
                  )
                : undefined;
              if (!at) return null;
              const path =
                wire.from.side === 'output'
                  ? wirePath(at, wire.current)
                  : wirePath(wire.current, at);
              return (
                <path
                  d={path}
                  fill="none"
                  stroke={typeColor(wire.type)}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
              );
            })()}
        </svg>

        {view.nodes.map((node) => {
          const p = positionOf(view, node.id, moved);
          const size = sizeOf(node);
          const state = overlay?.nodes?.[node.id];
          const errors = problems.get(node.id);
          const rows = Math.max(node.inputs.length, node.outputs.length);
          return (
            <div
              key={node.id}
              data-node={node.id}
              role="group"
              aria-label={node.title}
              title={errors?.join('\n') ?? node.description}
              className={cn(
                'absolute rounded-md border border-zinc-700 bg-zinc-900/95 text-[11px] text-zinc-100 shadow-md',
                selected.has(node.id) && 'ring-2 ring-sky-400',
                errors && 'border-red-500',
                node.unresolved && 'border-dashed border-red-500',
                state?.marker === 'paused' && 'ring-2 ring-amber-400',
                state?.className,
              )}
              style={{
                left: p.x,
                top: p.y,
                width: size.width,
                height: size.height,
              }}
              onPointerDown={(event) => itemDown(node.id, event)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onOpenNode?.(node);
              }}
            >
              <div
                className="flex items-center gap-1.5 truncate rounded-t-md px-2 font-medium"
                style={{
                  height: header,
                  background: categoryColor(node.category),
                }}
              >
                {state?.marker === 'breakpoint' && (
                  <span
                    aria-label="Breakpoint"
                    className="size-2 shrink-0 rounded-full bg-red-500"
                  />
                )}
                {state?.marker === 'paused' && (
                  <span
                    aria-label="Paused here"
                    className="size-2 shrink-0 rounded-full bg-amber-400"
                  />
                )}
                <span className="truncate">{node.title}</span>
                {state?.badge !== undefined && (
                  <span className="ml-auto shrink-0 rounded bg-black/40 px-1 font-normal tabular-nums">
                    {state.badge}
                  </span>
                )}
              </div>
              {state?.weight !== undefined && (
                <div
                  aria-label={`Weight ${Math.round(state.weight * 100)}%`}
                  className="absolute left-0 h-0.5 bg-sky-400"
                  style={{
                    top: header - 2,
                    width: `${Math.min(1, state.weight) * 100}%`,
                  }}
                />
              )}
              {Array.from({ length: rows }, (_, i) => {
                const input = node.inputs[i];
                const output = node.outputs[i];
                return (
                  <div
                    key={i}
                    className="relative flex items-center justify-between px-2"
                    style={{ height: row }}
                  >
                    {input ? (
                      <span className="flex min-w-0 items-center gap-1 truncate text-zinc-300">
                        {input.name}
                        {!connected.has(`${node.id}:${input.name}`) &&
                          !input.exec &&
                          (node.defaults?.[input.name] ?? input.default) !==
                            undefined && (
                            <span className="truncate text-zinc-500">
                              {shown(
                                node.defaults?.[input.name] ?? input.default,
                              )}
                            </span>
                          )}
                      </span>
                    ) : (
                      <span />
                    )}
                    {output && (
                      <span className="flex min-w-0 items-center gap-1 truncate text-zinc-300">
                        {state?.values?.[output.name] !== undefined && (
                          <span className="truncate text-amber-300">
                            {state.values[output.name]}
                          </span>
                        )}
                        {output.name}
                      </span>
                    )}
                    {input && (
                      <Port
                        node={node}
                        port={input}
                        side="input"
                        connected={connected.has(`${node.id}:${input.name}`)}
                        fits={fits(node, input, 'input')}
                        onPointerDown={(event) =>
                          portDown(node, input, 'input', event)
                        }
                      />
                    )}
                    {output && (
                      <Port
                        node={node}
                        port={output}
                        side="output"
                        connected={connected.has(`${node.id}:${output.name}`)}
                        fits={fits(node, output, 'output')}
                        onPointerDown={(event) =>
                          portDown(node, output, 'output', event)
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {(view.layout.notes ?? []).map((note) => {
          const p = moved?.get(note.id) ?? note;
          return (
            <div
              key={note.id}
              data-note={note.id}
              role="note"
              className={cn(
                'absolute overflow-hidden rounded-sm border border-amber-300/40 bg-amber-200/15 p-2 text-xs whitespace-pre-wrap text-amber-100',
                selected.has(note.id) && 'ring-2 ring-sky-400',
              )}
              style={{
                left: p.x,
                top: p.y,
                width: note.width,
                height: note.height,
              }}
              onPointerDown={(event) => itemDown(note.id, event)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditing(note.id);
              }}
            >
              {editing === note.id ? (
                <textarea
                  autoFocus
                  aria-label="Note"
                  className="h-full w-full resize-none bg-transparent outline-none"
                  defaultValue={note.text}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Escape') event.currentTarget.blur();
                  }}
                  onBlur={(event) => {
                    setEditing(undefined);
                    if (event.target.value !== note.text) {
                      dispatch({
                        op: 'editNote',
                        id: note.id,
                        change: { text: event.target.value },
                      });
                    }
                  }}
                />
              ) : (
                note.text
              )}
            </div>
          );
        })}

        {box && (
          <div
            className="pointer-events-none absolute border border-sky-400 bg-sky-400/10"
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            }}
          />
        )}
      </div>

      {search && (
        <NodeSearch
          items={searchItems}
          at={search.at}
          placeholder="Add a node"
          onClose={() => {
            setSearch(undefined);
            element.current?.focus({ preventScroll: true });
          }}
          onPick={(item) => {
            const connect = search.connect;
            dispatch({
              op: 'add',
              template: item.id,
              at: search.world,
              ...(connect && {
                connect: { port: connect.port, side: connect.side },
              }),
            });
            setSearch(undefined);
            element.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {finding && (
        <NodeSearch
          items={findItems}
          at={finding}
          placeholder="Find a node"
          onClose={() => {
            setFinding(undefined);
            element.current?.focus({ preventScroll: true });
          }}
          onPick={(item) => {
            setFinding(undefined);
            onSelectionChange([item.id]);
            frame([item.id]);
            element.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

// A port: the dot a wire starts from or ends at.
function Port({
  node,
  port,
  side,
  connected,
  fits,
  onPointerDown,
}: {
  readonly node: NodeView;
  readonly port: PortView;
  readonly side: 'input' | 'output';
  readonly connected: boolean;
  readonly fits: boolean;
  readonly onPointerDown: (event: ReactPointerEvent) => void;
}) {
  const color = typeColor(port.type);
  return (
    <span
      data-port={port.name}
      data-node={node.id}
      data-side={side}
      data-fits={fits || undefined}
      aria-label={`${node.title} ${side} ${port.name}`}
      title={`${port.name}: ${port.type}${port.description ? `\n${port.description}` : ''}`}
      className={cn(
        'absolute top-1/2 size-2.5 -translate-y-1/2 cursor-crosshair border-2',
        port.exec ? 'rotate-45 rounded-[1px]' : 'rounded-full',
        side === 'input' ? '-left-[5px]' : '-right-[5px]',
        fits && 'scale-150',
      )}
      style={{
        borderColor: color,
        background: connected || fits ? color : '#18181b',
      }}
      onPointerDown={onPointerDown}
    />
  );
}
