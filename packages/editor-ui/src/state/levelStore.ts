import { createStore } from '@xstate/store';
import type { EngineConnection } from '../host';
import type {
  EngineMessage,
  LevelNode,
  LevelProperties,
  ViewportBounds,
} from '../protocol';

/**
 * The projection of the level the engine edits (design/editor-state.md
 * §2): its tree, its selection, the properties of its active node, its
 * history, by ids, from the messages of the engine. Never kept: the level
 * is the engine's, saved as a file.
 */
export interface LevelStoreContext {
  /** The name of its file; empty until the engine tells it. */
  readonly name: string;
  /** The id of the root of its tree. */
  readonly root: string;
  readonly dirty: boolean;
  readonly nodes: Readonly<Record<string, LevelNode>>;
  /** The nodes selected, the active one last. */
  readonly selection: readonly string[];
  readonly properties?: LevelProperties;
  /** The labels of the commands undone and redone next. */
  readonly undo?: string;
  readonly redo?: string;
  /** The rectangle of a selection being dragged, in device pixels of the viewport. */
  readonly rectangle?: ViewportBounds;
}

export function createLevelStore() {
  return createStore({
    context: {
      name: '',
      root: '',
      dirty: false,
      nodes: {},
      selection: [],
    } as LevelStoreContext,
    on: {
      message: (
        context,
        { message }: { message: EngineMessage },
      ): LevelStoreContext => {
        switch (message.type) {
          case 'level':
            return {
              ...context,
              name: message.name,
              root: message.root,
              dirty: message.dirty,
            };
          case 'level.nodes': {
            const nodes = message.reset ? {} : { ...context.nodes };
            for (const id of message.removed) delete nodes[id];
            for (const node of message.nodes) nodes[node.id] = node;
            return { ...context, nodes };
          }
          case 'level.selection':
            return { ...context, selection: message.ids };
          case 'level.properties':
            return { ...context, properties: message.properties };
          case 'level.history':
            return { ...context, undo: message.undo, redo: message.redo };
          case 'level.rectangle':
            return { ...context, rectangle: message.rectangle };
          default:
            return context;
        }
      },
    },
  });
}

export type LevelStore = ReturnType<typeof createLevelStore>;

/** Writes the messages of the engine in the store; returns the unsubscription. */
export function connectLevelStore(
  engine: EngineConnection,
  store: LevelStore,
): () => void {
  return engine.subscribe((message) => {
    if (message.type === 'level' || message.type.startsWith('level.')) {
      store.trigger.message({ message });
    }
  });
}

/** The parent of each node of the tree, by id. */
export function levelParents(
  nodes: LevelStoreContext['nodes'],
): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const node of Object.values(nodes)) {
    for (const child of node.children) parents.set(child, node.id);
  }
  return parents;
}
