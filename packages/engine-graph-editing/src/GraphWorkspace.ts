import type { BehaviorDebugger, BehaviorNodeType } from '@fdw/engine-behavior';
import type { RenderBackend } from '@fdw/engine-backend';
import { Material } from '@fdw/engine-core';
import type { GraphDocument, Registry } from '@fdw/engine-graph';
import type { MaterialGraphData, NodeRegistry } from '@fdw/engine-shader';
import type { GraphKind } from './GraphKind';
import { GraphSession } from './GraphSession';
import { animationGraphKind } from './kinds/animation';
import { behaviorGraphKind } from './kinds/behavior';
import { materialGraphKind } from './kinds/material';
import { debugState, setBreakpoint } from './live/behavior';
import {
  compileMaterial,
  materialCode,
  MaterialPreview,
  type PreviewMeshes,
  type PreviewShape,
} from './live/material';
import type {
  GraphEvent,
  GraphKindId,
  GraphRequest,
  GraphView,
  TargetInfo,
} from './protocol';
import {
  applyGraph,
  type GraphTarget,
  targetGraph,
  targetInfo,
  targetKind,
} from './targets';

/** What a {@link GraphWorkspace} gets from where it runs. */
export interface GraphWorkspaceOptions {
  /** Sends an event to the page; `data`: the bytes of the preview. */
  post(event: GraphEvent, data?: Uint8Array<ArrayBuffer>): void;
  /** The backend of the engine: the code of the materials, their previews. */
  readonly backend?: RenderBackend;
  /** The meshes of the previews of the materials (none: no preview). */
  readonly meshes?: PreviewMeshes;
  /** The registries of the graphs that are not those of a target (files, new graphs). */
  readonly registries?: {
    readonly material?: NodeRegistry;
    readonly behavior?: Registry<BehaviorNodeType>;
  };
}

// The live updates and the previews, ten times a second.
const livePeriod = 0.1;
// The compilations of a material being edited, at most every 0.1 s.
const compilePeriod = 0.1;

interface Open {
  readonly session: GraphSession;
  target?: GraphTarget;
  catalogKey?: string;
  applied?: number;
  applyError?: string;
  stop(): void;
  // The materials: the revision compiled, the preview.
  compiled?: number;
  material?: Material;
  preview?: { shape: PreviewShape; animate: boolean; drawn: boolean };
  // The animations: the animator followed.
  animator?: string;
  // The behaviors: the debugger opened, the entity followed.
  debug?: BehaviorDebugger<unknown>;
  entity?: number;
  stopPause?: () => void;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The graphs an editor edits, on the side of the engine: a
 * {@link GraphSession} per editor, bound to a graph of the scene shown
 * ({@link GraphTarget}) or to a document of its own; the messages of the
 * page ({@link GraphRequest}) and its events ({@link GraphEvent}). Each
 * valid change runs in the target: the material made again, the graph of
 * the animators and of the behavior system replaced. The application
 * calls {@link frame} at each frame: the live states, the compilations,
 * the previews.
 */
export class GraphWorkspace {
  readonly #options: GraphWorkspaceOptions;
  readonly #sessions = new Map<string, Open>();
  #targets: readonly GraphTarget[] = [];
  #targetsKey = '';
  #lastLive = -Infinity;
  #lastCompile = -Infinity;
  #time = 0;
  #preview?: MaterialPreview;

  constructor(options: GraphWorkspaceOptions) {
    this.#options = options;
  }

  /** The graphs of the scene shown. */
  get targets(): readonly GraphTarget[] {
    return this.#targets;
  }

  /** Whether a debugger stopped a graph: the scene waits. */
  get paused(): boolean {
    for (const open of this.#sessions.values()) {
      if (open.debug?.paused) return true;
    }
    return false;
  }

  /** A session, by id. */
  session(id: string): GraphSession | undefined {
    return this.#sessions.get(id)?.session;
  }

  /**
   * The graphs of the scene shown, when it changes: the sessions on a
   * target gone go on with their document; a target made again (the scene
   * loaded again) runs the document of its session.
   */
  setTargets(targets: readonly GraphTarget[]): void {
    const key = JSON.stringify(targets.map(targetInfo));
    const same =
      key === this.#targetsKey &&
      targets.every((target, i) => target === this.#targets[i]);
    this.#targets = targets;
    if (same) return;
    for (const open of this.#sessions.values()) {
      const id = open.session.source.target;
      if (id === undefined) continue;
      const target = targets.find((t) => t.id === id);
      if (target === open.target) continue;
      this.#detach(open);
      open.target = target;
      if (!target) {
        open.session.source = { ...open.session.source, target: undefined };
        this.#postView(open);
        continue;
      }
      // The edits go on in the new one.
      if (open.session.revision > 0) this.#apply(open, true);
      else this.#postView(open);
    }
    if (key !== this.#targetsKey) {
      this.#targetsKey = key;
      this.#options.post({ op: 'targets', targets: this.#infos() });
    }
  }

  /** A message of the page. */
  receive(request: GraphRequest): void {
    switch (request.op) {
      case 'targets':
        this.#options.post({ op: 'targets', targets: this.#infos() });
        return;
      case 'open':
        this.#open(request);
        return;
      case 'close':
        this.#close(request.session);
        return;
      case 'command': {
        const open = this.#sessions.get(request.session);
        if (!open) return;
        const result = open.session.execute(request.command);
        if (result.refused) {
          this.#options.post({
            op: 'refused',
            session: request.session,
            message: result.refused,
          });
        }
        return;
      }
      case 'save': {
        const open = this.#sessions.get(request.session);
        if (!open) return;
        const { session } = open;
        const name =
          request.name ??
          session.source.file ??
          `${session.document.name}${session.kind.extension}`;
        this.#options.post({
          op: 'file',
          session: session.id,
          name,
          text: session.kind.serialize(session.document),
        });
        return;
      }
      case 'saved':
        this.#sessions.get(request.session)?.session.markSaved(request.name);
        return;
      case 'preview': {
        const open = this.#sessions.get(request.session);
        if (!open || open.session.kind.id !== 'material') return;
        open.preview = {
          shape: request.shape,
          animate: request.animate,
          drawn: false,
        };
        return;
      }
      case 'animation': {
        const open = this.#sessions.get(request.session);
        if (open?.target?.kind !== 'animation') return;
        if (request.animator !== undefined) open.animator = request.animator;
        const parameter = request.parameter;
        if (parameter) {
          const animator = this.#animator(open);
          try {
            animator?.set(parameter.name, parameter.value);
          } catch (error) {
            this.#refuse(open, errorText(error));
          }
        }
        this.#postLive(open);
        return;
      }
      case 'debug':
        this.#debug(request);
        return;
    }
  }

  /**
   * At each frame of the engine, at a time in seconds: the compilations of
   * the materials, their previews, the live states of the animations and
   * of the behaviors (ten times a second).
   */
  frame(time: number): void {
    this.#time = time;
    if (time - this.#lastCompile >= compilePeriod) {
      for (const open of this.#sessions.values()) {
        if (
          open.session.kind.id === 'material' &&
          open.compiled !== open.session.revision
        ) {
          this.#lastCompile = time;
          this.#compile(open);
        }
      }
    }
    const live = time - this.#lastLive >= livePeriod;
    if (live) this.#lastLive = time;
    for (const open of this.#sessions.values()) {
      if (
        open.preview &&
        (!open.preview.drawn || (live && open.preview.animate))
      ) {
        this.#drawPreview(open);
      }
      if (!live) continue;
      if (open.target?.kind === 'animation') this.#postLive(open);
      if (open.debug) this.#postDebug(open);
    }
  }

  /** Ends the sessions: the debuggers closed, the preview destroyed. */
  dispose(): void {
    for (const id of [...this.#sessions.keys()]) this.#close(id);
    this.#preview?.destroy();
    this.#preview = undefined;
  }

  #infos(): TargetInfo[] {
    return this.#targets.map(targetInfo);
  }

  #kind(kind: GraphKindId): GraphKind {
    const registries = this.#options.registries ?? {};
    switch (kind) {
      case 'material':
        return materialGraphKind(registries.material) as unknown as GraphKind;
      case 'animation':
        return animationGraphKind() as unknown as GraphKind;
      case 'behavior': {
        // The nodes of the game, when the scene runs a behavior graph.
        const target = this.#targets.find((t) => t.kind === 'behavior');
        return behaviorGraphKind(
          registries.behavior ??
            (target?.kind === 'behavior' ? target.registry : undefined),
        ) as unknown as GraphKind;
      }
    }
  }

  #refuse(open: Open, message: string): void {
    this.#options.post({ op: 'refused', session: open.session.id, message });
  }

  #open(request: Extract<GraphRequest, { op: 'open' }>): void {
    this.#close(request.session, false);
    let session: GraphSession;
    let target: GraphTarget | undefined;
    try {
      if (request.target !== undefined) {
        target = this.#targets.find((t) => t.id === request.target);
        if (!target)
          throw new Error(`No graph "${request.target}" in the scene`);
        session = new GraphSession(
          request.session,
          targetKind(target),
          targetGraph(target),
          { target: target.id },
        );
      } else {
        const kind = this.#kind(request.kind);
        const document: GraphDocument = request.file
          ? kind.parse(request.file.text)
          : kind.create(request.create ?? `new ${request.kind}`);
        session = new GraphSession(
          request.session,
          kind,
          document,
          request.file ? { file: request.file.name } : {},
        );
      }
    } catch (error) {
      this.#options.post({
        op: 'closed',
        session: request.session,
        message: errorText(error),
      });
      return;
    }
    const open: Open = {
      session,
      ...(target && { target }),
      stop: () => undefined,
    };
    // A material without preview until the page asks for one.
    const stop = session.subscribe(() => this.#changed(open));
    open.stop = stop;
    this.#sessions.set(session.id, open);
    open.applied = session.revision;
    this.#postView(open);
  }

  #close(id: string, post = true): void {
    const open = this.#sessions.get(id);
    if (!open) return;
    this.#detach(open);
    open.stop();
    this.#sessions.delete(id);
    if (post) this.#options.post({ op: 'closed', session: id });
  }

  // The debugger of a session, closed (its target changes or goes).
  #detach(open: Open): void {
    open.stopPause?.();
    open.stopPause = undefined;
    if (open.debug) {
      open.debug.close();
      open.debug = undefined;
    }
  }

  #changed(open: Open): void {
    const { session } = open;
    if (open.applied !== session.revision && open.target) this.#apply(open);
    this.#postView(open);
  }

  // Runs the document in the target, when it has no error (a material:
  // once compiled, in frame()).
  #apply(open: Open, force = false): void {
    const { session, target } = open;
    if (!target) return;
    if (target.kind === 'material') {
      open.compiled = undefined;
      return;
    }
    if (!force && open.applied === session.revision) return;
    open.applied = session.revision;
    if (session.diagnostics().some((d) => d.severity === 'error')) return;
    try {
      applyGraph(target, session.document);
      open.applyError = undefined;
    } catch (error) {
      open.applyError = errorText(error);
    }
  }

  #postView(open: Open): void {
    const { session } = open;
    const view: GraphView = {
      ...session.projection(),
      ...(open.applyError !== undefined && { applyError: open.applyError }),
    };
    const key = session.catalogKey();
    if (key !== open.catalogKey) {
      open.catalogKey = key;
      this.#options.post({
        op: 'catalog',
        session: session.id,
        templates: session.templates(),
      });
    }
    this.#options.post({ op: 'graph', view });
  }

  #compile(open: Open): void {
    const { session, target } = open;
    open.compiled = session.revision;
    const graph = session.document as MaterialGraphData;
    const backend = this.#options.backend;
    const start = performance.now();
    const compilation = compileMaterial(graph, {
      ...(target?.kind === 'material' &&
        target.registry && {
          registry: target.registry,
        }),
      ...(target?.kind === 'material' &&
        target.vertexAttributes && {
          vertexAttributes: target.vertexAttributes,
        }),
      ...(backend && { capabilities: backend.capabilities }),
    });
    const time = performance.now() - start;
    const nodes = new Set(graph.nodes.map((node) => node.id));
    let code;
    if (compilation.program && backend) {
      try {
        code = materialCode(backend, compilation.program, nodes, time);
      } catch (error) {
        code = undefined;
        this.#refuse(
          open,
          `The code could not be generated: ${errorText(error)}`,
        );
      }
    }
    this.#options.post({
      op: 'code',
      session: session.id,
      code: code ?? {
        language: backend?.pipelines.codegen.language ?? '',
        sources: [],
        lines: [],
        diagnostics: compilation.diagnostics,
        time,
      },
    });
    if (!compilation.program) return;
    // The material drawn: the target's with the graph edited, or the graph
    // alone.
    open.material =
      target?.kind === 'material'
        ? target.material().withGraph(graph)
        : new Material({ graph });
    if (open.preview) open.preview.drawn = false;
    if (target?.kind === 'material' && open.applied !== session.revision) {
      open.applied = session.revision;
      try {
        target.setMaterial(open.material);
        open.applyError = undefined;
      } catch (error) {
        open.applyError = errorText(error);
      }
    }
  }

  #drawPreview(open: Open): void {
    const { backend, meshes } = this.#options;
    const preview = open.preview;
    if (!backend || !meshes || !preview) return;
    // The material of the session, once compiled.
    if (!open.material) {
      if (open.compiled === undefined) this.#compile(open);
      if (!open.material) return;
    }
    this.#preview ??= new MaterialPreview(backend, meshes);
    const renderer = this.#preview;
    renderer.shape = preview.shape;
    renderer.material = open.material;
    preview.drawn = true;
    const session = open.session.id;
    void renderer.render(this.#time).then(
      (pixels) => {
        if (!pixels || !this.#sessions.has(session)) return;
        this.#options.post(
          {
            op: 'preview',
            session,
            width: renderer.width,
            height: renderer.height,
          },
          pixels,
        );
      },
      (error: unknown) => {
        this.#refuse(
          open,
          `The preview could not be drawn: ${errorText(error)}`,
        );
      },
    );
  }

  #animator(open: Open) {
    if (open.target?.kind !== 'animation') return undefined;
    const animators = open.target.animators();
    return (animators.find((a) => a.name === open.animator) ?? animators[0])
      ?.animator;
  }

  #postLive(open: Open): void {
    if (open.target?.kind !== 'animation') return;
    const animators = open.target.animators();
    const followed =
      animators.find((a) => a.name === open.animator) ?? animators[0];
    const inspection = followed?.animator.inspect();
    this.#options.post({
      op: 'animation',
      session: open.session.id,
      live: {
        animators: animators.map((a) => a.name),
        ...(followed && { animator: followed.name }),
        nodes: inspection?.nodes ?? {},
        machines: inspection?.machines ?? {},
        parameters: inspection?.parameters ?? {},
      },
    });
  }

  #debug(request: Extract<GraphRequest, { op: 'debug' }>): void {
    const open = this.#sessions.get(request.session);
    if (open?.target?.kind !== 'behavior') {
      if (open) this.#refuse(open, 'Only the graphs of the scene are debugged');
      return;
    }
    const { system } = open.target;
    try {
      switch (request.action) {
        case 'attach':
          if (!open.debug) {
            const debug = system.debug();
            open.debug = debug;
            if (open.entity !== undefined) debug.entity = open.entity;
            open.stopPause = debug.onPause(() => this.#postDebug(open));
          }
          break;
        case 'detach':
          this.#detach(open);
          break;
        case 'follow':
          open.entity = request.entity;
          if (open.debug) open.debug.entity = request.entity;
          break;
        case 'breakpoint': {
          const debug = open.debug ?? system.debug();
          if (!open.debug) {
            open.debug = debug;
            open.stopPause = debug.onPause(() => this.#postDebug(open));
          }
          setBreakpoint(system, debug, request.scope, request.node, request.on);
          break;
        }
        case 'continue':
          open.debug?.continue();
          break;
        case 'step':
          open.debug?.step();
          break;
      }
    } catch (error) {
      this.#refuse(open, errorText(error));
    }
    this.#postDebug(open);
  }

  #postDebug(open: Open): void {
    if (open.target?.kind !== 'behavior') return;
    const target = open.target;
    this.#options.post({
      op: 'debug',
      session: open.session.id,
      state: debugState(target.system, open.debug, {
        ...(open.entity !== undefined && { entity: open.entity }),
        ...(open.session.scope !== undefined && { scope: open.session.scope }),
        ...(target.entityName && {
          name: (entity: number) => target.entityName?.(entity) ?? `#${entity}`,
        }),
      }),
    });
  }
}
