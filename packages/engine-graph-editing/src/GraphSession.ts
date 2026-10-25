import { type Command, History } from '@fdw/engine-editing';
import {
  addNode,
  addNote,
  autoLayout,
  connect,
  type Diagnostic,
  disconnect,
  editGroup,
  editNote,
  type GraphBody,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  groupNodes,
  moveNodes,
  type NodeShape,
  pasteFragment,
  type Point,
  type PortRef,
  removeDecorations,
  removeNodes,
  setDefault,
  setLabel,
  setParams,
  uniqueNodeId,
} from '@fdw/engine-graph';
import type { GraphKind, KindValidation } from './GraphKind';
import type {
  GraphCommand,
  GraphView,
  NodeTemplate,
  NodeView,
  PortView,
} from './protocol';

/** Where a session's document comes from. */
export interface SessionSource {
  /** The graph of the scene it edits, live. */
  readonly target?: string;
  /** The file it was opened from, or last saved to. */
  readonly file?: string;
}

/** The result of {@link GraphSession.execute}. */
export interface CommandResult {
  /** Why the command was not done: a connection refused, a value unread. */
  readonly refused?: string;
}

// A change of the document, undone by putting back the document before.
// Consecutive changes of the same thing (a node dragged, a field typed)
// make one entry.
class DocumentCommand<D> implements Command {
  constructor(
    readonly label: string,
    private readonly _session: { set(document: D): void },
    private readonly _before: D,
    private _after: D,
    private readonly _key?: string,
  ) {}

  do(): void {
    this._session.set(this._after);
  }

  undo(): void {
    this._session.set(this._before);
  }

  merge(next: Command): boolean {
    if (
      !(next instanceof DocumentCommand) ||
      this._key === undefined ||
      next._key !== this._key
    ) {
      return false;
    }
    this._after = next._after as D;
    return true;
  }
}

const sameRef = (a: PortRef, b: PortRef) =>
  a.node === b.node && a.port === b.port;
const errorKey = (d: Diagnostic) =>
  `${d.scope ?? ''}|${d.node ?? ''}|${d.port ?? ''}|${d.message}`;
const plural = (count: number, word: string) =>
  `${count} ${word}${count > 1 ? 's' : ''}`;

/**
 * A graph being edited: its document, its history (the commands of P15),
 * the scope shown (the graph or one of its functions). The editor changes
 * it by {@link GraphCommand}s and shows its {@link projection}; the
 * documents are values: each change makes a new one.
 *
 * @example
 * ```ts
 * const session = new GraphSession('s1', behaviorGraphKind(registry), graph);
 * session.execute({ op: 'add', template: 'math.add', at: { x: 0, y: 0 } });
 * session.execute({ op: 'undo' });
 * session.projection().nodes;
 * ```
 */
export class GraphSession<D extends GraphDocument = GraphDocument> {
  readonly history = new History({ limit: 200 });
  source: SessionSource;
  #document: D;
  #scope: string | undefined;
  #revision = 0;
  #saved: D;
  #validation?: { revision: number; scope?: string; result: KindValidation };
  #check?: { revision: number; result: readonly Diagnostic[] };
  #templates?: { key: string; templates: readonly NodeTemplate[] };
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly kind: GraphKind<D>,
    document: D,
    source: SessionSource = {},
  ) {
    this.source = source;
    this.#document = this.#placed(document);
    this.#saved = this.#document;
    this.history.onChange(() => this.#notify());
  }

  get document(): D {
    return this.#document;
  }

  get scope(): string | undefined {
    return this.#scope;
  }

  /** Increased by each change of the document. */
  get revision(): number {
    return this.#revision;
  }

  get dirty(): boolean {
    return this.#document !== this.#saved;
  }

  /** The document is as saved (or as the target runs it). */
  markSaved(file?: string): void {
    this.#saved = this.#document;
    if (file !== undefined) this.source = { ...this.source, file };
    this.#notify();
  }

  /** Called after each change: of the document, the scope, the history. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The nodes the search offers in the scope shown. */
  templates(): readonly NodeTemplate[] {
    const key = this.catalogKey();
    if (this.#templates?.key !== key) {
      this.#templates = {
        key,
        templates: this.kind.templates(this.#document, this.#scope),
      };
    }
    return this.#templates.templates;
  }

  /** Changes when the templates do. */
  catalogKey(): string {
    return this.kind.catalogKey(this.#document, this.#scope);
  }

  /** The nodes of the scope shown, resolved; the problems of the document. */
  validation(): KindValidation {
    const cached = this.#validation;
    if (cached?.revision === this.#revision && cached.scope === this.#scope) {
      return cached.result;
    }
    const result = this.kind.validate(this.#document, this.#scope);
    this.#validation = { revision: this.#revision, scope: this.#scope, result };
    return result;
  }

  /** The problems of every scope. */
  diagnostics(): readonly Diagnostic[] {
    if (this.#check?.revision !== this.#revision) {
      this.#check = {
        revision: this.#revision,
        result: this.kind.check(this.#document),
      };
    }
    return this.#check.result;
  }

  /** What the editor shows. */
  projection(): GraphView {
    const body = this.#body();
    const validation = this.validation();
    const all = this.diagnostics();
    const nodes = body.nodes.map((node) => this.#nodeView(node, validation));
    const scope = this.#scope;
    return {
      session: this.id,
      kind: this.kind.id,
      name: this.#document.name,
      ...(scope !== undefined && { scope }),
      scopes: this.kind.scopes(this.#document),
      nodes,
      edges: body.edges,
      layout: body.layout ?? {},
      diagnostics: all.filter(
        (d) => d.scope === scope || (d.scope === undefined && !d.node),
      ),
      errors: all.filter((d) => d.severity === 'error').length,
      warnings: all.filter((d) => d.severity === 'warning').length,
      ...(this.history.canUndo && {
        undo: this.history.undoLabels.at(-1),
      }),
      ...(this.history.canRedo && {
        redo: this.history.redoLabels[0],
      }),
      dirty: this.dirty,
      revision: this.#revision,
      ...(this.source.target !== undefined && { target: this.source.target }),
      ...(this.source.file !== undefined && { file: this.source.file }),
      fields: this.kind.fields(this.#document),
    };
  }

  /** Replaces the document, outside of the history (the target changed it). */
  reset(document: D): void {
    this.#document = this.#placed(document);
    this.#revision++;
    this.#saved = this.#document;
    this.history.clear();
    if (this.#scope !== undefined) {
      const scopes = this.kind.scopes(document);
      if (!scopes.some((s) => s.id === this.#scope)) this.#scope = undefined;
    }
    this.#notify();
  }

  /**
   * Does a command: a step of the history, but `undo`, `redo` and `scope`.
   * A connection whose types do not fit is refused, with the message of
   * the validation.
   */
  execute(command: GraphCommand): CommandResult {
    try {
      return this.#execute(command);
    } catch (error) {
      return { refused: (error as Error).message };
    }
  }

  #execute(command: GraphCommand): CommandResult {
    const body = this.#body();
    switch (command.op) {
      case 'undo':
        this.history.undo();
        return {};
      case 'redo':
        this.history.redo();
        return {};
      case 'scope': {
        if (
          command.scope !== undefined &&
          !this.kind
            .scopes(this.#document)
            .some((scope) => scope.id === command.scope)
        ) {
          return { refused: `No function "${command.scope}"` };
        }
        this.#scope = command.scope;
        this.#document = this.#placed(this.#document);
        this.#notify();
        return {};
      }
      case 'add': {
        const template = command.template
          ? this.templates().find((t) => t.id === command.template)
          : undefined;
        if (command.template && !template) {
          return { refused: `No node "${command.template}" here` };
        }
        const type = template?.type ?? command.node?.type;
        if (!type) return { refused: 'No node to add' };
        const params = {
          ...(template?.params ?? {}),
          ...(command.node?.params
            ? (this.kind.editorParams?.(
                this.#document,
                type,
                command.node.params,
              ) ?? command.node.params)
            : {}),
        };
        const id = uniqueNodeId(body, this.kind.idPrefix ?? 'n');
        let next = addNode(body, { id, type, params } as GraphNode, command.at);
        if (command.connect) {
          const ports = template ?? this.#portsOf(next, id);
          const connected = this.#autoConnect(next, id, ports, command.connect);
          if (connected) next = connected;
        }
        return this.#change(`Add ${template?.title ?? type}`, next);
      }
      case 'remove': {
        const ids = new Set(command.ids);
        const nodes = body.nodes.filter((node) => ids.has(node.id));
        let next = removeNodes(body, ids);
        next = removeDecorations(next, ids);
        const count = ids.size;
        return this.#change(
          nodes.length === 1 && count === 1
            ? `Delete ${this.#title(nodes[0])}`
            : `Delete ${plural(count, 'item')}`,
          next,
        );
      }
      case 'connect':
        return this.#connect(body, command.from, command.to, command.swizzle);
      case 'disconnect': {
        const next = command.port
          ? disconnect(body, { port: command.port })
          : disconnect(body, command.edges ?? []);
        if (next.edges.length === body.edges.length) return {};
        return this.#change('Disconnect', next);
      }
      case 'move': {
        const ids = Object.keys(command.positions).sort();
        return this.#change(
          ids.length === 1 ? 'Move' : `Move ${plural(ids.length, 'item')}`,
          moveNodes(body, command.positions),
          `move:${ids.join(',')}`,
        );
      }
      case 'params': {
        const node = this.#node(body, command.node);
        const params =
          this.kind.editorParams?.(this.#document, node.type, command.params) ??
          command.params;
        const names = Object.keys(params).sort();
        return this.#change(
          `Edit ${names.join(', ')}`,
          setParams(body, command.node, params),
          `params:${command.node}:${names.join(',')}`,
        );
      }
      case 'default':
        this.#node(body, command.node);
        return this.#change(
          `Edit ${command.port}`,
          setDefault(body, command.node, command.port, command.value),
          `default:${command.node}:${command.port}`,
        );
      case 'label':
        this.#node(body, command.node);
        return this.#change(
          'Rename',
          setLabel(body, command.node, command.label),
          `label:${command.node}`,
        );
      case 'note':
        return this.#change('Add a note', addNote(body, command.note));
      case 'editNote':
        return this.#change(
          'Edit the note',
          editNote(body, command.id, command.change),
          `note:${command.id}:${Object.keys(command.change).sort().join(',')}`,
        );
      case 'group':
        return this.#change('Group', groupNodes(body, command.group));
      case 'editGroup':
        return this.#change(
          'Edit the group',
          editGroup(body, command.id, command.change),
          `group:${command.id}:${Object.keys(command.change).sort().join(',')}`,
        );
      case 'paste': {
        // The parameters as the editor copied them (the types by name).
        const fragment = {
          ...command.fragment,
          nodes: command.fragment.nodes.map((node) => ({
            ...node,
            params: (this.kind.editorParams?.(
              this.#document,
              node.type,
              node.params,
            ) ?? node.params) as GraphNode['params'],
          })),
        };
        const { body: next, ids } = pasteFragment(body, fragment, command.at);
        return this.#change(`Paste ${plural(ids.length, 'item')}`, next);
      }
      case 'layout':
        return this.#change('Arrange', moveNodes(body, this.#autoLayout(body)));
      case 'field': {
        const next = this.kind.setField(
          this.#document,
          command.key,
          command.value,
        );
        return this.#changeDocument(`Edit ${command.key}`, next);
      }
      case 'function': {
        if (!this.kind.editFunction) {
          return {
            refused: `A ${this.kind.title.toLowerCase()} has no functions`,
          };
        }
        const next = this.kind.editFunction(
          this.#document,
          command.name,
          command.change,
        );
        const label =
          command.change === 'create'
            ? `Create ${command.name}`
            : command.change === 'remove'
              ? `Remove ${command.name}`
              : `Edit ${command.name}`;
        // A function renamed is shown by its new name.
        const renamed =
          typeof command.change === 'object' &&
          typeof command.change['name'] === 'string'
            ? command.change['name']
            : undefined;
        if (this.#scope === command.name && renamed !== undefined) {
          this.#scope = renamed;
        }
        return this.#changeDocument(label, next);
      }
    }
  }

  // The body of the scope shown.
  #body(): GraphBody {
    return this.kind.body(this.#document, this.#scope);
  }

  #node(body: GraphBody, id: string): GraphNode {
    const node = body.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`No node "${id}"`);
    return node;
  }

  #title(node: GraphNode): string {
    return this.validation().nodes.get(node.id)?.title ?? node.label ?? node.id;
  }

  #change(label: string, body: GraphBody, key?: string): CommandResult {
    return this.#changeDocument(
      label,
      this.kind.withBody(this.#document, this.#scope, body),
      key && `${this.#scope ?? ''}|${key}`,
    );
  }

  #changeDocument(label: string, document: D, key?: string): CommandResult {
    if (document === this.#document) return {};
    this.history.execute(
      new DocumentCommand(
        label,
        { set: (next: D) => this.#set(next) },
        this.#document,
        this.#placed(document),
        key,
      ),
    );
    return {};
  }

  #set(document: D): void {
    this.#document = document;
    this.#revision++;
    // The scope of a function removed by an undo.
    if (
      this.#scope !== undefined &&
      !this.kind.scopes(document).some((s) => s.id === this.#scope)
    ) {
      this.#scope = undefined;
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  // Refuses an edge that adds an error on its nodes, or a cycle.
  #connect(
    body: GraphBody,
    from: PortRef,
    to: PortRef,
    swizzle?: string,
  ): CommandResult {
    const validation = this.validation();
    const output = validation.nodes
      .get(from.node)
      ?.outputs.find((port) => port.name === from.port);
    const input = validation.nodes
      .get(to.node)
      ?.inputs.find((port) => port.name === to.port);
    if (!output)
      return { refused: `No output "${from.port}" on #${from.node}` };
    if (!input) return { refused: `No input "${to.port}" on #${to.node}` };
    if (from.node === to.node) return { refused: 'A node cannot feed itself' };
    if (Boolean(output.exec) !== Boolean(input.exec)) {
      return {
        refused: output.exec
          ? 'The flow of execution goes into an exec input'
          : 'A value goes into a value input',
      };
    }
    const edge: GraphEdge = {
      from,
      to,
      ...(swizzle !== undefined && { swizzle }),
    } as GraphEdge;
    const next = connect(body, edge, {
      replaceInput: input.connections === 'one',
      replaceOutput: output.connections === 'one',
    });
    const document = this.kind.withBody(this.#document, this.#scope, next);
    const before = new Set(
      this.validation()
        .diagnostics.filter((d) => d.severity === 'error')
        .map(errorKey),
    );
    const after = this.kind
      .validate(document, this.#scope)
      .diagnostics.filter(
        (d) => d.severity === 'error' && !before.has(errorKey(d)),
      );
    const problem = after.find(
      (d) => d.node === undefined || d.node === to.node || d.node === from.node,
    );
    if (problem) return { refused: problem.message };
    const target = this.validation().nodes.get(to.node)?.title ?? to.node;
    return this.#changeDocument(`Connect ${target}.${to.port}`, document);
  }

  // The ports of a node of a body, resolved.
  #portsOf(
    body: GraphBody,
    id: string,
  ): { inputs: readonly PortView[]; outputs: readonly PortView[] } {
    const document = this.kind.withBody(this.#document, this.#scope, body);
    return (
      this.kind.validate(document, this.#scope).nodes.get(id) ?? {
        inputs: [],
        outputs: [],
      }
    );
  }

  // Connects a new node to a port: its first port of the other side that
  // fits (by the kind's hint), the first one of the same flow otherwise.
  #autoConnect(
    body: GraphBody,
    id: string,
    ports: { inputs: readonly PortView[]; outputs: readonly PortView[] },
    { port, side }: { port: PortRef; side: 'input' | 'output' },
  ): GraphBody | undefined {
    const validation = this.validation();
    const other = validation.nodes.get(port.node);
    const known =
      side === 'output'
        ? other?.outputs.find((p) => p.name === port.port)
        : other?.inputs.find((p) => p.name === port.port);
    if (!known) return undefined;
    const candidates = side === 'output' ? ports.inputs : ports.outputs;
    const fits = (candidate: PortView) =>
      Boolean(candidate.exec) === Boolean(known.exec) &&
      (side === 'output'
        ? this.kind.accepts(known.type, candidate.type)
        : this.kind.accepts(candidate.type, known.type));
    const chosen = candidates.find(fits);
    if (!chosen) return undefined;
    const edge =
      side === 'output'
        ? { from: port, to: { node: id, port: chosen.name } }
        : { from: { node: id, port: chosen.name }, to: port };
    const input = side === 'output' ? chosen : known;
    const output = side === 'output' ? known : chosen;
    if (
      body.edges.some(
        (e) => sameRef(e.from, edge.from) && sameRef(e.to, edge.to),
      )
    ) {
      return body;
    }
    return connect(body, edge, {
      replaceInput: input.connections === 'one',
      replaceOutput: output.connections === 'one',
    });
  }

  #nodeView(node: GraphNode, validation: KindValidation): NodeView {
    const resolved = validation.nodes.get(node.id);
    const params = this.kind.viewParams?.(node.params) ?? node.params;
    return {
      id: node.id,
      type: node.type,
      title: resolved?.title ?? node.label ?? node.type,
      ...(node.label !== undefined && { label: node.label }),
      ...(resolved?.category && { category: resolved.category }),
      ...(resolved?.description && { description: resolved.description }),
      params,
      ...(node.defaults && { defaults: node.defaults }),
      inputs: resolved?.inputs ?? [],
      outputs: resolved?.outputs ?? [],
      schema: resolved?.schema ?? [],
      ...(!resolved && { unresolved: true }),
    };
  }

  // The positions of the nodes of a body, by autoLayout.
  #autoLayout(body: GraphBody): Record<string, Point> {
    const document = this.kind.withBody(this.#document, this.#scope, body);
    const nodes = this.kind.validate(document, this.#scope).nodes;
    const shapes = new Map<string, NodeShape>(
      body.nodes.map((node) => {
        const resolved = nodes.get(node.id);
        return [
          node.id,
          {
            title: resolved?.title ?? node.label ?? node.type,
            inputs: resolved?.inputs.map((p) => p.name) ?? [],
            outputs: resolved?.outputs.map((p) => p.name) ?? [],
          },
        ];
      }),
    );
    return autoLayout(body, shapes);
  }

  // The document with every node of the scope shown placed: those without
  // a position laid out by autoLayout, right of the others.
  #placed(document: D): D {
    let body: GraphBody;
    try {
      body = this.kind.body(document, this.#scope);
    } catch {
      return document;
    }
    const placed = body.layout?.nodes ?? {};
    const missing = body.nodes.filter((node) => !placed[node.id]);
    if (missing.length === 0) return document;
    const positions = this.#autoLayout({
      nodes: missing,
      edges: body.edges,
    });
    if (missing.length < body.nodes.length) {
      // Right of what is placed already.
      const right = Math.max(...Object.values(placed).map((p) => p.x));
      for (const id of Object.keys(positions)) {
        positions[id] = {
          x: positions[id].x + right + 320,
          y: positions[id].y,
        };
      }
    }
    return this.kind.withBody(
      document,
      this.#scope,
      moveNodes(body, positions),
    );
  }
}
