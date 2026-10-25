import {
  type EngineConnection,
  type ExtensionChannel,
  extensionChannel,
} from '@fdw/editor-ui';
import type {
  AnimationLive,
  BehaviorDebugAction,
  BehaviorDebugState,
  GraphCommand,
  GraphEvent,
  GraphKindId,
  GraphRequest,
  GraphView,
  MaterialCode,
  NodeTemplate,
  TargetInfo,
} from '@fdw/engine-graph-editing';
import { useSyncExternalStore } from 'react';

/** The id of the part of the editors of graphs in the engine. */
export const graphsExtensionId = 'fdw.graphs';

/** Where a session's graph comes from. */
export type GraphSource =
  | { readonly target: string }
  | { readonly file: { readonly name: string; readonly text: string } }
  | { readonly create: string };

/** What an editor of graphs knows: the projection of its graph, and what runs. */
export interface GraphClientState {
  /** The graphs of the scene shown, of every kind. */
  readonly targets: readonly TargetInfo[];
  readonly view?: GraphView;
  readonly templates: readonly NodeTemplate[];
  /** The last command refused, or why the graph closed. */
  readonly message?: { readonly text: string; readonly id: number };
  /** The materials: their code. */
  readonly code?: MaterialCode;
  /** The materials: their preview, RGBA. */
  readonly preview?: {
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array<ArrayBuffer>;
  };
  /** The animations: what the animator followed plays. */
  readonly animation?: AnimationLive;
  /** The behaviors: what the debugger tells. */
  readonly debug?: BehaviorDebugState;
}

const empty: GraphClientState = { targets: [], templates: [] };

/**
 * The page side of an editor of graphs: a session in the engine (the
 * extension `fdw.graphs`), opened on a graph of the scene, a file or a new
 * graph, and what the engine tells of it, as a store (`useGraphClient`).
 * Opened again when the engine starts again (a page or a process
 * reloaded).
 */
export class GraphClient {
  readonly session: string;
  readonly kind: GraphKindId;
  readonly #channel: ExtensionChannel<GraphEvent, GraphRequest>;
  readonly #listeners = new Set<() => void>();
  readonly #stops: (() => void)[] = [];
  #state: GraphClientState = empty;
  #source?: GraphSource;
  #messages = 0;
  // The preview asked for: asked again for each graph opened.
  #preview?: { shape: 'sphere' | 'cube' | 'plane'; animate: boolean };
  // The files asked for, answered by their text.
  readonly #saving: ((file: { name: string; text: string }) => void)[] = [];

  constructor(
    connection: EngineConnection,
    session: string,
    kind: GraphKindId,
  ) {
    this.session = session;
    this.kind = kind;
    this.#channel = extensionChannel<GraphEvent, GraphRequest>(
      connection,
      graphsExtensionId,
    );
    this.#stops.push(
      this.#channel.subscribe((event, data) => this.#receive(event, data)),
      connection.subscribe((message) => {
        if (message.type !== 'ready') return;
        // An engine started again: its graphs, and the session again.
        this.#channel.post({ op: 'targets' });
        if (this.#source) this.open(this.#source);
      }),
    );
    this.#channel.post({ op: 'targets' });
  }

  getSnapshot = (): GraphClientState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Where the graph shown comes from. */
  get source(): GraphSource | undefined {
    return this.#source;
  }

  /** Opens a graph: of the scene, a file, a new one. */
  open(source: GraphSource): void {
    this.#source = source;
    this.#set({
      targets: this.#state.targets,
      templates: [],
      ...(this.#state.message && { message: this.#state.message }),
    });
    this.#channel.post({
      op: 'open',
      session: this.session,
      kind: this.kind,
      ...source,
    });
    if (this.#preview) {
      this.#channel.post({
        op: 'preview',
        session: this.session,
        ...this.#preview,
      });
    }
  }

  command(command: GraphCommand): void {
    this.#channel.post({ op: 'command', session: this.session, command });
  }

  /** The document as JSON, and the name of its file. */
  save(name?: string): Promise<{ name: string; text: string }> {
    return new Promise((resolve) => {
      this.#saving.push(resolve);
      this.#channel.post({
        op: 'save',
        session: this.session,
        ...(name !== undefined && { name }),
      });
    });
  }

  /** The file written: the graph is saved. */
  saved(name: string): void {
    this.#channel.post({ op: 'saved', session: this.session, name });
  }

  preview(shape: 'sphere' | 'cube' | 'plane', animate: boolean): void {
    this.#preview = { shape, animate };
    this.#channel.post({
      op: 'preview',
      session: this.session,
      shape,
      animate,
    });
  }

  animation(request: {
    readonly animator?: string;
    readonly parameter?: {
      readonly name: string;
      readonly value: number | boolean;
    };
  }): void {
    this.#channel.post({ op: 'animation', session: this.session, ...request });
  }

  debug(action: BehaviorDebugAction): void {
    this.#channel.post({ op: 'debug', session: this.session, ...action });
  }

  /** A message of the page itself: a value it could not read. */
  tell(text: string): void {
    this.#set({ ...this.#state, message: { text, id: ++this.#messages } });
  }

  /** Ends the session in the engine. */
  dispose(): void {
    this.#stops.forEach((stop) => stop());
    this.#channel.post({ op: 'close', session: this.session });
    this.#listeners.clear();
  }

  #set(state: GraphClientState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }

  #receive(event: GraphEvent, data?: Uint8Array<ArrayBuffer>): void {
    if (event.op === 'targets') {
      this.#set({ ...this.#state, targets: event.targets });
      return;
    }
    const session = event.op === 'graph' ? event.view.session : event.session;
    if (session !== this.session) return;
    switch (event.op) {
      case 'graph':
        this.#set({ ...this.#state, view: event.view });
        return;
      case 'catalog':
        this.#set({ ...this.#state, templates: event.templates });
        return;
      case 'refused':
        this.tell(event.message);
        return;
      case 'closed': {
        // No graph shown anymore.
        const { targets, templates, message } = this.#state;
        this.#set({
          targets,
          templates,
          ...(message && { message }),
          ...(event.message && {
            message: { text: event.message, id: ++this.#messages },
          }),
        });
        if (event.message) this.#source = undefined;
        return;
      }
      case 'file':
        this.#saving.shift()?.({ name: event.name, text: event.text });
        return;
      case 'code':
        this.#set({ ...this.#state, code: event.code });
        return;
      case 'preview':
        if (data) {
          this.#set({
            ...this.#state,
            preview: { width: event.width, height: event.height, pixels: data },
          });
        }
        return;
      case 'animation':
        this.#set({ ...this.#state, animation: event.live });
        return;
      case 'debug':
        this.#set({ ...this.#state, debug: event.state });
        return;
    }
  }
}

/** What the engine tells a client, in React. */
export function useGraphClient(client: GraphClient): GraphClientState {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}
