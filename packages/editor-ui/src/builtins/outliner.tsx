import {
  BoxIcon,
  CameraIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  LightbulbIcon,
  SquareDashedIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react';
import { useEditor, useSelector } from '../editorContext';
import { cn } from '../lib/utils';
import type { LevelNode, PageMessage } from '../protocol';
import { levelParents } from '../state/levelStore';
import { PanelMessage } from '../views';

const kindIcons = {
  node: SquareDashedIcon,
  mesh: BoxIcon,
  light: LightbulbIcon,
  camera: CameraIcon,
} as const;

// The type of the data of a node dragged in the tree.
const dragType = 'application/x-fdw-level-node';

interface Row {
  readonly node: LevelNode;
  readonly depth: number;
}

/**
 * The tree of the level: its projection, by ids. A click selects (Shift
 * adds, Ctrl toggles), a double click frames, the eye shows and hides, a
 * node dragged onto another goes under it (onto the empty part, under the
 * root). Each change is a command of the level, undone with the others.
 */
export function OutlinerPanel() {
  const { level, host } = useEditor();
  const root = useSelector(level, (snapshot) => snapshot.context.root);
  const nodes = useSelector(level, (snapshot) => snapshot.context.nodes);
  const selection = useSelector(
    level,
    (snapshot) => snapshot.context.selection,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const post = (message: PageMessage) => host.engine.post(message);

  // The parents of the nodes selected open, to show them.
  const parents = useMemo(() => levelParents(nodes), [nodes]);
  useEffect(() => {
    setExpanded((before) => {
      const next = new Set(before);
      for (const id of selection) {
        for (let p = parents.get(id); p && p !== root; p = parents.get(p)) {
          next.add(p);
        }
      }
      return next.size === before.size ? before : next;
    });
  }, [selection, parents, root]);

  const rows = useMemo(() => {
    const list: Row[] = [];
    const visit = (id: string, depth: number) => {
      const node = nodes[id];
      if (!node) return;
      list.push({ node, depth });
      if (expanded.has(id)) {
        for (const child of node.children) visit(child, depth + 1);
      }
    };
    for (const id of nodes[root]?.children ?? []) visit(id, 0);
    return list;
  }, [nodes, root, expanded]);

  if (!nodes[root]) return <PanelMessage text="No level." />;

  const selected = new Set(selection);
  const select = (id: string, event: MouseEvent) => {
    let ids: string[];
    if (event.ctrlKey || event.metaKey) {
      ids = selected.has(id)
        ? selection.filter((other) => other !== id)
        : [...selection, id];
    } else if (event.shiftKey) {
      ids = [...selection.filter((other) => other !== id), id];
    } else {
      ids = [id];
    }
    post({ type: 'level.command', command: 'select', ids });
  };
  const toggle = (id: string) =>
    setExpanded((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const drop = (parent: string) => (event: DragEvent) => {
    const id = event.dataTransfer.getData(dragType);
    if (!id || id === parent) return;
    event.preventDefault();
    event.stopPropagation();
    post({ type: 'level.command', command: 'reparent', id, parent });
  };
  const allowDrop = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(dragType)) event.preventDefault();
  };

  return (
    <div
      role="tree"
      aria-label="Level"
      aria-multiselectable
      className="h-full overflow-auto py-1 text-xs"
      onDragOver={allowDrop}
      onDrop={drop(root)}
    >
      {rows.map(({ node, depth }) => {
        const Icon = kindIcons[node.kind];
        const open = expanded.has(node.id);
        const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected.has(node.id)}
            {...(node.children.length > 0 && { 'aria-expanded': open })}
            draggable
            className={cn(
              'flex h-6 cursor-default items-center gap-1 pr-1 select-none hover:bg-accent/50',
              selected.has(node.id) && 'bg-accent text-accent-foreground',
              !node.visible && 'text-muted-foreground',
            )}
            style={{ paddingLeft: 4 + depth * 12 }}
            onClick={(event) => select(node.id, event)}
            onDoubleClick={() =>
              post({ type: 'level.command', command: 'frame' })
            }
            onDragStart={(event) => {
              event.dataTransfer.setData(dragType, node.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={allowDrop}
            onDrop={drop(node.id)}
          >
            {node.children.length > 0 ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={open ? 'Collapse' : 'Expand'}
                className="flex size-4 shrink-0 items-center justify-center"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(node.id);
                }}
              >
                <Chevron className="size-3" />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {node.name || '(node)'}
            </span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={
                node.visible ? `Hide ${node.name}` : `Show ${node.name}`
              }
              className="flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                post({
                  type: 'level.command',
                  command: 'edit',
                  id: node.id,
                  property: 'visible',
                  value: !node.visible,
                });
              }}
            >
              {node.visible ? (
                <EyeIcon className="size-3" />
              ) : (
                <EyeOffIcon className="size-3" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
