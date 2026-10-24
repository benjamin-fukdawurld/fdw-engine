import {
  CreateNodeCommand,
  DeleteNodesCommand,
  History,
  isAlive,
  PropertyCommand,
  readTrs,
  ReparentCommand,
  SceneEvents,
  SceneTrash,
  Selection,
  topmost,
  writeTrs,
  type Command,
  type SceneChanges,
  type Trs,
} from '@fdw/engine-editing';
import { writeGltf } from '@fdw/engine-gltf';
import type { MemorySource, ResourceStore } from '@fdw/engine-resources';
import { Node, Scene } from '@fdw/engine-scene';
import {
  captureScene,
  instantiateScene,
  SceneDataType,
  unknownComponentsOf,
  writeFdwScene,
  type ComponentCodec,
  type SceneInstance,
} from '@fdw/engine-scene-io';
import type {
  EngineMessage,
  LevelCommand,
  LevelEdit,
  LevelFormat,
  LevelNode,
  LevelPrimitive,
  LevelProperties,
} from '../../protocol';
import { eulerFromQuat, quatFromEuler } from './euler';
import { buildSampleLevel, LevelParts } from './sampleLevel';

/** Where the files of the levels are kept, and how they are read. */
export interface LevelFiles {
  /** With the loaders of the scenes (installSceneIo, installGltfScenes). */
  readonly store: ResourceStore;
  /** Mounted in the store under `scheme`: the files opened. */
  readonly source: MemorySource;
  readonly scheme: string;
  /** The codecs of the components; those of engine-scene by default. */
  readonly codecs?: Iterable<ComponentCodec<any>>;
}

const None = -1;

// The components of the scene itself: its nodes, not shown by the inspector.
const internalComponents = new Set(['hierarchy', 'node state']);

// The names of the components shown, for those of the scene.
const componentTitles: Readonly<Record<string, string>> = {
  'mesh renderer': 'Mesh renderer',
  light: 'Light',
  'camera view': 'Camera',
};

const primitiveNames: Readonly<Record<LevelPrimitive, string>> = {
  empty: 'empty',
  cube: 'cube',
  sphere: 'sphere',
  light: 'light',
};

// The files opened, each under a path of its own: the store keeps what it
// loaded under a path.
let opened = 0;

/**
 * A level being edited (P16, with the tools of P15): its scene, its
 * history, its selection. It tells the page what changes, by ids: the
 * tree of the scene by batch of changes, the selection and the properties
 * of the active node, the history; and runs the commands of the page, the
 * only way the page changes it. The viewport (LevelView) draws it and runs
 * the tools of the pointer on the same history and selection.
 */
export class LevelDocument {
  readonly scene = new Scene();
  readonly history = new History();
  readonly selection = new Selection<Node>();
  readonly parts = new LevelParts();
  #name: string;
  #dirty = false;
  readonly #files: LevelFiles;
  #post: (message: EngineMessage) => void = () => undefined;
  // The nodes in the tree as the page knows them: their id (an entity
  // destroyed has no generation any more), their parent (a move under
  // another one changes two lists of children), their visibility (a move
  // too).
  readonly #known = new Map<
    number,
    { readonly id: string; parent: number; visible: boolean }
  >();
  // Made once the level is built: its changes after.
  #events?: SceneEvents;
  #instance?: SceneInstance;
  #properties?: string;
  // Called before a command: a drag of the viewport is cancelled.
  #interrupt?: () => void;
  readonly #stop: (() => void)[] = [];

  private constructor(name: string, files: LevelFiles) {
    this.#name = name;
    this.#files = files;
  }

  /** A new level: the sample one. */
  static create(files: LevelFiles, name = 'level.scene.json'): LevelDocument {
    const document = new LevelDocument(name, files);
    buildSampleLevel(document.scene.root, document.parts);
    document.#start();
    return document;
  }

  /**
   * A level read from a file: a scene of the engine (`.scene.json`, its
   * buffers in it) or glTF (`.glb`, `.gltf` with its buffers in it). The
   * references to other files are not found.
   */
  static async open(
    files: LevelFiles,
    name: string,
    data: Uint8Array<ArrayBuffer>,
    warn: (message: string) => void,
  ): Promise<LevelDocument> {
    const document = new LevelDocument(name, files);
    const path = `${++opened}/${name}`;
    files.source.set(path, data);
    const handle = files.store.load(SceneDataType, `${files.scheme}:${path}`);
    try {
      document.#instance = await instantiateScene(handle, document.scene, {
        store: files.store,
        ...(files.codecs && { codecs: files.codecs }),
        wrap: false,
        warn,
      });
    } catch (error) {
      document.dispose();
      throw error;
    } finally {
      handle.release();
    }
    document.#start();
    return document;
  }

  get name(): string {
    return this.#name;
  }

  /** Changed since opened or saved. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Called before each command of the page, to cancel a drag. */
  set interrupt(interrupt: (() => void) | undefined) {
    this.#interrupt = interrupt;
  }

  /** The id of a node in the messages: its entity and its generation. */
  idOf(entity: number): string {
    return `${entity}:${this.scene.world.generation(entity)}`;
  }

  /** The node of an id, if it is still in the tree. */
  nodeOf(id: string): Node | undefined {
    const [entity, generation] = id.split(':').map(Number);
    const { world } = this.scene;
    if (
      !Number.isInteger(entity) ||
      !world.isAlive(entity) ||
      world.generation(entity) !== generation
    ) {
      return undefined;
    }
    const node = this.scene.node(entity);
    return isAlive(node) ? node : undefined;
  }

  /**
   * Sends to the page from now on: the whole level first (a page loaded
   * again gets it again).
   */
  connect(post: (message: EngineMessage) => void): void {
    this.#post = post;
    this.#announce();
    this.#post({
      type: 'level.nodes',
      nodes: this.#tree(),
      removed: [],
      reset: true,
    });
    this.#sendSelection();
    this.#sendHistory();
  }

  /** A command of the page. */
  run(command: LevelCommand): void {
    if (command.command !== 'select') this.#interrupt?.();
    switch (command.command) {
      case 'undo':
        this.history.undo();
        this.selection.filter(isAlive);
        break;
      case 'redo':
        this.history.redo();
        this.selection.filter(isAlive);
        break;
      case 'delete':
        this.deleteSelection();
        break;
      case 'add':
        this.add(command.primitive);
        break;
      case 'edit': {
        const node = this.nodeOf(command.id);
        if (node) this.#edit(node, command);
        break;
      }
      case 'reparent':
        this.#reparent(command.id, command.parent);
        break;
      case 'select':
        this.selection.set(
          command.ids.flatMap((id) => {
            const node = this.nodeOf(id);
            return node && node !== this.scene.root ? [node] : [];
          }),
        );
        break;
      case 'frame':
        // The camera is the viewport's.
        break;
    }
  }

  /** Removes the selected nodes in one command (undone, they come back). */
  deleteSelection(): void {
    const nodes = topmost(this.selection.items.filter(isAlive));
    if (nodes.length === 0) return;
    this.history.execute(
      new DeleteNodesCommand(
        nodes.length === 1
          ? `Delete ${nodes[0].name}`
          : `Delete ${nodes.length} nodes`,
        nodes,
      ),
    );
    this.selection.clear();
  }

  /** Adds a node under the root, selected. */
  add(primitive: LevelPrimitive): void {
    const name = primitiveNames[primitive];
    const create = new CreateNodeCommand(
      `Add ${name}`,
      this.scene.root,
      {
        name,
        position: {
          y: primitive === 'light' ? 2 : primitive === 'empty' ? 0 : 0.5,
        },
      },
      (node) => this.parts.build(node, primitive),
    );
    this.history.execute(create);
    if (create.node) this.selection.set([create.node]);
  }

  /**
   * The level written in one file: a scene of the engine, its buffers in
   * it; or a `.glb`, its instances expanded (glTF has none).
   */
  async save(
    format: LevelFormat,
    name: string,
    warn: (message: string) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const { store, scheme, codecs } = this.#files;
    const uri = `${scheme}:${name}`;
    const data = captureScene(this.scene, {
      store,
      uri,
      name: name.replace(/\.(scene\.json|glb|gltf)$/, ''),
      ...(codecs && { codecs }),
      ...(format === 'glb' && { instances: 'expand' as const }),
      warn,
    });
    const [file] =
      format === 'glb'
        ? await writeGltf(data, name, { store, uri, warn })
        : await writeFdwScene(data, name, { binary: 'embedded' });
    return file.bytes;
  }

  /** The file of the level written by the host: no more changes to save. */
  saved(name: string): void {
    this.#name = name;
    this.#dirty = false;
    this.#announce();
  }

  dispose(): void {
    this.#stop.forEach((stop) => stop());
    this.#stop.length = 0;
    this.#events?.dispose();
    this.history.clear();
    this.#instance?.dispose();
    this.#instance = undefined;
  }

  #start(): void {
    this.scene.root.traverse(({ entity }) => this.#know(entity));
    const events = new SceneEvents(this.scene);
    this.#events = events;
    this.#stop.push(
      events.listen((changes) => this.#changed(changes)),
      this.selection.onChange(() => this.#sendSelection()),
      this.history.onChange(() => {
        if (!this.#dirty) {
          this.#dirty = true;
          this.#announce();
        }
        this.#sendHistory();
      }),
    );
  }

  #announce(): void {
    this.#post({
      type: 'level',
      name: this.#name,
      root: this.idOf(this.scene.root.entity),
      dirty: this.#dirty,
    });
  }

  #parentOf(entity: number): number {
    return this.scene.Hierarchy.parent[entity];
  }

  // Whether an entity is in the tree: alive, not in the trash.
  #inTree(entity: number): boolean {
    const { world } = this.scene;
    if (!world.isAlive(entity)) return false;
    const trash = SceneTrash.peek(this.scene);
    return !trash?.contains(this.scene.node(entity));
  }

  #node(entity: number): LevelNode {
    const { scene } = this;
    const children: string[] = [];
    for (
      let child = scene.Hierarchy.first[entity];
      child !== None;
      child = scene.Hierarchy.next[child]
    ) {
      children.push(this.idOf(child));
    }
    const kind = scene.MeshRenderer.has(entity)
      ? 'mesh'
      : scene.Light.has(entity)
        ? 'light'
        : scene.CameraView.has(entity)
          ? 'camera'
          : 'node';
    const node = scene.node(entity);
    return {
      id: this.idOf(entity),
      name: node.name,
      kind,
      visible: node.visible,
      children,
    };
  }

  #tree(): LevelNode[] {
    const nodes: LevelNode[] = [];
    this.scene.root.traverse(({ entity }) => {
      nodes.push(this.#node(entity));
    });
    return nodes;
  }

  #know(entity: number): void {
    this.#known.set(entity, {
      id: this.idOf(entity),
      parent: this.#parentOf(entity),
      visible: this.scene.node(entity).visible,
    });
  }

  // A batch of changes of the scene: the nodes changed, and the parents
  // whose children changed; the properties of the active node.
  #changed({ created, removed, moved, modified }: SceneChanges): void {
    const changed = new Set<number>();
    const removedIds: string[] = [];
    for (const entity of removed) {
      const known = this.#known.get(entity);
      if (!known) continue;
      this.#known.delete(entity);
      removedIds.push(known.id);
      // The parent of the top of a branch removed.
      if (!removed.has(known.parent)) changed.add(known.parent);
    }
    for (const entity of created) {
      if (!this.#inTree(entity)) continue;
      this.#know(entity);
      changed.add(entity);
      changed.add(this.#parentOf(entity));
    }
    for (const entity of moved) {
      const known = this.#known.get(entity);
      if (!known || created.has(entity) || !this.#inTree(entity)) continue;
      const parent = this.#parentOf(entity);
      if (parent !== known.parent) {
        changed.add(entity).add(parent).add(known.parent);
        known.parent = parent;
      }
      const { visible } = this.scene.node(entity);
      if (visible !== known.visible) {
        changed.add(entity);
        known.visible = visible;
      }
    }
    for (const entity of modified) {
      if (this.#inTree(entity)) changed.add(entity);
    }
    const nodes = [...changed]
      .filter((entity) => this.#inTree(entity))
      .map((entity) => this.#node(entity));
    if (nodes.length > 0 || removedIds.length > 0) {
      this.#post({ type: 'level.nodes', nodes, removed: removedIds });
    }
    const active = this.selection.active;
    if (
      active &&
      isAlive(active) &&
      (moved.has(active.entity) || modified.has(active.entity))
    ) {
      this.#sendProperties();
    }
  }

  #sendSelection(): void {
    this.#post({
      type: 'level.selection',
      ids: this.selection.items.map((node) => this.idOf(node.entity)),
    });
    this.#sendProperties();
  }

  #sendHistory(): void {
    this.#post({
      type: 'level.history',
      ...(this.history.canUndo && { undo: this.history.undoLabels.at(-1) }),
      ...(this.history.canRedo && { redo: this.history.redoLabels.at(-1) }),
    });
  }

  #sendProperties(): void {
    const properties = this.properties();
    // Not sent again when the same (a node moved without its active one).
    const key = JSON.stringify(properties ?? null);
    if (key === this.#properties) return;
    this.#properties = key;
    this.#post({ type: 'level.properties', ...(properties && { properties }) });
  }

  /** The properties of the active node, for the inspector. */
  properties(): LevelProperties | undefined {
    const node = this.selection.active;
    if (!node || !isAlive(node)) return undefined;
    const { position, rotation, scale } = readTrs(node.transform);
    const round = (value: number) => Math.round(value * 1e5) / 1e5 + 0;
    const triple = (values: readonly number[]) =>
      values.map(round) as unknown as [number, number, number];
    const { entity } = node;
    const components = this.scene.world.components.flatMap((component) => {
      if (internalComponents.has(component.name) || !component.has(entity)) {
        return [];
      }
      const title = componentTitles[component.name];
      if (title) return [{ name: title }];
      // Those saved field by field: their numbers.
      const columns = component as unknown as Record<string, ArrayLike<number>>;
      const scalar = Object.entries(component.schema).every(
        ([, field]) => typeof field === 'string' && field !== 'ref',
      );
      if (!component.persist || !scalar) return [{ name: component.name }];
      return [
        {
          name: component.name,
          fields: Object.keys(component.schema).map((field) => ({
            name: field,
            value: round(columns[field][entity]),
          })),
        },
      ];
    });
    // Those no codec read: kept as they are, saved again.
    const unknown = unknownComponentsOf(this.scene, entity);
    const unknownNames = unknown ? Object.keys(unknown) : [];
    return {
      id: this.idOf(entity),
      name: node.name,
      visible: node.visible,
      position: triple(position),
      rotation: triple(eulerFromQuat(rotation)),
      scale: triple(scale),
      components: [
        ...components.filter(({ name }) => name !== 'unknown components'),
        ...unknownNames.map((name) => ({ name: `${name} (unknown)` })),
      ],
    };
  }

  #edit(node: Node, edit: LevelEdit): void {
    const id = this.idOf(node.entity);
    let command: Command;
    switch (edit.property) {
      case 'name':
        command = new PropertyCommand(
          `Rename ${node.name}`,
          {
            get: () => node.name,
            set: (value) => {
              if (node.alive) node.name = value;
            },
          },
          edit.value,
          `${id}.name`,
        );
        break;
      case 'visible':
        command = new PropertyCommand(
          `${edit.value ? 'Show' : 'Hide'} ${node.name}`,
          {
            get: () => node.visible,
            set: (value) => {
              if (node.alive) node.visible = value;
            },
          },
          edit.value,
        );
        break;
      case 'position':
      case 'rotation':
      case 'scale': {
        const before = readTrs(node.transform);
        const value = [...edit.value] as [number, number, number];
        const after: Trs = {
          ...before,
          [edit.property]:
            edit.property === 'rotation' ? quatFromEuler(value) : value,
        };
        if (value.some((v) => !Number.isFinite(v))) return;
        const titles = { position: 'Move', rotation: 'Rotate', scale: 'Scale' };
        command = new PropertyCommand(
          `${titles[edit.property]} ${node.name}`,
          {
            get: () => readTrs(node.transform),
            set: (trs) => {
              if (node.alive) writeTrs(node.transform, trs);
            },
          },
          after,
          // The steps of a field dragged make one entry.
          `${id}.${edit.property}`,
        );
        break;
      }
      case 'field': {
        const component = this.scene.world.component(edit.component);
        const columns = component as unknown as
          Record<string, { [index: number]: number }> | undefined;
        const column = columns?.[edit.field];
        if (
          !component?.has(node.entity) ||
          !column ||
          !(edit.field in component.schema) ||
          !Number.isFinite(edit.value)
        ) {
          return;
        }
        const { entity } = node;
        command = new PropertyCommand(
          `Set ${edit.component} ${edit.field}`,
          {
            get: () => column[entity],
            set: (value) => {
              if (!node.alive) return;
              column[entity] = value;
              this.scene.notify(entity, 'modified');
            },
          },
          edit.value,
          `${id}.${edit.component}.${edit.field}`,
        );
        break;
      }
    }
    this.history.execute(command);
  }

  #reparent(id: string, parentId: string): void {
    const node = this.nodeOf(id);
    const parent = this.nodeOf(parentId);
    if (
      !node ||
      !parent ||
      node === this.scene.root ||
      node.parent === parent
    ) {
      return;
    }
    // Not under itself.
    for (let p: Node | undefined = parent; p; p = p.parent) {
      if (p === node) return;
    }
    this.history.execute(
      new ReparentCommand(
        `Move ${node.name} to ${parent.name}`,
        [node],
        parent,
      ),
    );
  }
}
