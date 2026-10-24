import {
  Button,
  IEngineConnection,
  ILevelStore,
  levelParents,
  useEditor,
  useSelector,
  useWhen,
  type IDisposable,
  type LevelNode,
  type LevelStoreContext,
  type PluginContext,
} from '@fdw/editor-ui';
import { useMemo } from 'react';
import {
  isolateCommand,
  isolatedKey,
  isolateId,
  showAllCommand,
  statisticsView,
} from './manifest';

/**
 * What the statistics count: the nodes by kind, those hidden (themselves
 * or by a parent), those selected.
 */
export interface LevelStatistics {
  readonly nodes: number;
  readonly kinds: Readonly<Record<LevelNode['kind'], number>>;
  readonly hidden: number;
  readonly selected: number;
}

/** The statistics of the projection of the level, without its root. */
export function levelStatistics(level: LevelStoreContext): LevelStatistics {
  const kinds = { node: 0, mesh: 0, light: 0, camera: 0 };
  let hidden = 0;
  // Down the tree: a node is hidden under a parent hidden.
  const count = (id: string, parentShown: boolean) => {
    const node = level.nodes[id];
    if (!node) return;
    const shown = parentShown && node.visible;
    if (id !== level.root) {
      kinds[node.kind]++;
      if (!shown) hidden++;
    }
    node.children.forEach((child) => count(child, shown));
  };
  count(level.root, true);
  return {
    nodes: kinds.node + kinds.mesh + kinds.light + kinds.camera,
    kinds,
    hidden,
    selected: level.selection.length,
  };
}

/**
 * The nodes under the root that hold none of the selection: those to hide.
 * A node selected deep in a group keeps its group.
 */
export function nodesToHide(level: LevelStoreContext): string[] {
  const parents = levelParents(level.nodes);
  const kept = new Set<string>();
  for (const id of level.selection) {
    let top = id;
    let parent = parents.get(top);
    while (parent !== undefined && parent !== level.root) {
      top = parent;
      parent = parents.get(top);
    }
    kept.add(top);
  }
  const root = level.nodes[level.root];
  return (root?.children ?? []).filter(
    (id) => !kept.has(id) && level.nodes[id]?.visible,
  );
}

// The projection of the level (the editor makes it from the messages of
// the engine), counted again when it changes.
function useStatistics(): LevelStatistics {
  const level = useSelector(useEditor().level, (snapshot) => snapshot.context);
  return useMemo(() => levelStatistics(level), [level]);
}

function StatisticsPanel({ context }: { readonly context: PluginContext }) {
  const statistics = useStatistics();
  const isolated = useWhen(isolatedKey);
  const rows: [string, number][] = [
    ['Meshes', statistics.kinds.mesh],
    ['Lights', statistics.kinds.light],
    ['Cameras', statistics.kinds.camera],
    ['Groups', statistics.kinds.node],
    ['Hidden', statistics.hidden],
    ['Selected', statistics.selected],
  ];
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
      <p>{statistics.nodes} nodes in the level.</p>
      <table className="w-full">
        <tbody>
          {rows.map(([label, count]) => (
            <tr key={label}>
              <td className="text-muted-foreground">{label}</td>
              <td className="text-right tabular-nums">{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button
        variant="outline"
        size="xs"
        disabled={!isolated && statistics.selected === 0}
        onClick={() =>
          void context.commands.execute(
            isolated ? showAllCommand : isolateCommand,
          )
        }
      >
        {isolated ? 'Show everything' : 'Isolate the selection'}
      </Button>
    </div>
  );
}

function IsolateStatus() {
  const { nodes, hidden } = useStatistics();
  const isolated = useWhen(isolatedKey);
  if (!isolated) return null;
  return (
    <span className="text-amber-500">
      Isolated: {nodes - hidden} of {nodes} nodes shown
    </span>
  );
}

/** Called by the editor at the first activation event of the plugin. */
export function activate(context: PluginContext): void {
  const { services } = context;
  const level = () => services.get(ILevelStore).getSnapshot().context;
  const engine = () => services.get(IEngineConnection);
  // The nodes the plugin hid, shown again by Show everything; the context
  // key that tells the commands and the panel.
  let hidden: string[] = [];
  let isolated: IDisposable | undefined;

  const setVisible = (ids: readonly string[], visible: boolean) => {
    for (const id of ids) {
      engine().post({
        type: 'level.command',
        command: 'edit',
        id,
        property: 'visible',
        value: visible,
      });
    }
  };

  context.commands.register(isolateCommand, () => {
    if (isolated || level().selection.length === 0) return;
    hidden = nodesToHide(level());
    setVisible(hidden, false);
    isolated = context.keys.set(isolatedKey, true);
  });
  context.commands.register(showAllCommand, () => {
    // Those removed meanwhile are left.
    const { nodes } = level();
    setVisible(
      hidden.filter((id) => nodes[id]),
      true,
    );
    hidden = [];
    isolated?.dispose();
    isolated = undefined;
  });
  context.views.registerComponent(statisticsView, () => (
    <StatisticsPanel context={context} />
  ));
  context.statusBar.registerComponent(`${isolateId}.status`, IsolateStatus);
}
