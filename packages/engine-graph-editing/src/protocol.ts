import type {
  Diagnostic,
  GraphEdge,
  GraphFragment,
  GraphGroup,
  GraphLayout,
  GraphNote,
  NodeId,
  Point,
  PortRef,
} from '@fdw/engine-graph';

// What an editor of graphs sees of the graphs the engine edits, and what it
// asks: plain data, sent between the engine and the page (design/
// p19-graph-editor.md §3). The page imports these types only.

/** The kinds of graphs: their editors are plugins of the editor. */
export type GraphKindId = 'material' | 'animation' | 'behavior';

/** A port of a node, resolved: its type as a text. */
export interface PortView {
  readonly name: string;
  /** `vec3<f32>`, `pose`, `exec`… */
  readonly type: string;
  /** A port of the flow of execution (the behavior graphs). */
  readonly exec?: boolean;
  /** How many edges it takes: `one` for the inputs by default. */
  readonly connections: 'one' | 'many';
  readonly optional?: boolean;
  /** The value of an input not connected, when it has one. */
  readonly default?: unknown;
  readonly description?: string;
}

/** A parameter of a node type, for the inspector. */
export interface ParamView {
  readonly name: string;
  /** `string`, `number`, `boolean`, `numbers`, `json`, and those of a kind (`type`, `constant`). */
  readonly kind: string;
  readonly values?: readonly string[];
  readonly default?: unknown;
  readonly required?: boolean;
  readonly description?: string;
}

/** A node as the editor draws it. */
export interface NodeView {
  readonly id: NodeId;
  readonly type: string;
  /** What the editor writes on it: its label, or a title of its type and parameters. */
  readonly title: string;
  readonly label?: string;
  readonly category?: string;
  readonly description?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly inputs: readonly PortView[];
  readonly outputs: readonly PortView[];
  readonly schema: readonly ParamView[];
  /** Its type is unknown, or its parameters do not give ports. */
  readonly unresolved?: boolean;
}

/** A part of a document the editor can show: the graph, or one of its functions. */
export interface ScopeView {
  /** Undefined for the graph itself. */
  readonly id?: string;
  readonly title: string;
  /** `function`, `macro`. */
  readonly kind?: string;
}

/** What the editor shows of a graph: its projection, after each change. */
export interface GraphView {
  readonly session: string;
  readonly kind: GraphKindId;
  readonly name: string;
  /** The function shown; the graph itself when undefined. */
  readonly scope?: string;
  readonly scopes: readonly ScopeView[];
  readonly nodes: readonly NodeView[];
  readonly edges: readonly GraphEdge[];
  /** Every node placed. */
  readonly layout: GraphLayout;
  /** The problems of the scope shown, and those of the document. */
  readonly diagnostics: readonly Diagnostic[];
  /** Those of the whole document, in every scope. */
  readonly errors: number;
  readonly warnings: number;
  /** The labels of the commands undone and redone next. */
  readonly undo?: string;
  readonly redo?: string;
  /** Changed since opened or saved. */
  readonly dirty: boolean;
  /** Increased by each change. */
  readonly revision: number;
  /** The graph of the scene it edits, live; or the file it was opened from. */
  readonly target?: string;
  readonly file?: string;
  /** Why the target does not run the graph shown (a clip missing). */
  readonly applyError?: string;
  /**
   * The fields of the document that are not nodes: the variables, the
   * events, the parameters, the signatures of the functions.
   */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** A node the search adds: a type and parameters, with its ports. */
export interface NodeTemplate {
  /** Unique in the catalog. */
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly category: string;
  readonly description?: string;
  /** Other words it is found by. */
  readonly keywords?: readonly string[];
  readonly inputs: readonly PortView[];
  readonly outputs: readonly PortView[];
}

/**
 * A change of a graph: each one but `undo`, `redo` and `scope` is a step
 * of its history.
 */
export type GraphCommand =
  | { readonly op: 'undo' }
  | { readonly op: 'redo' }
  /** Shows a function of the document, or the graph (undefined). */
  | { readonly op: 'scope'; readonly scope?: string }
  /**
   * Adds a node of a template (or of a type and parameters) at a point;
   * connected to a port when given (its first port that fits).
   */
  | {
      readonly op: 'add';
      readonly template?: string;
      readonly node?: {
        readonly type: string;
        readonly params?: Readonly<Record<string, unknown>>;
      };
      readonly at: Point;
      readonly connect?: {
        readonly port: PortRef;
        readonly side: 'input' | 'output';
      };
    }
  /** Removes nodes, notes and groups. */
  | { readonly op: 'remove'; readonly ids: readonly string[] }
  | {
      readonly op: 'connect';
      readonly from: PortRef;
      readonly to: PortRef;
      /** The material graphs: `.xyz`. */
      readonly swizzle?: string;
    }
  | {
      readonly op: 'disconnect';
      readonly edges?: readonly GraphEdge[];
      readonly port?: PortRef;
    }
  /** Places nodes and notes, by id. */
  | { readonly op: 'move'; readonly positions: Readonly<Record<string, Point>> }
  /** Sets parameters of a node; undefined removes one. */
  | {
      readonly op: 'params';
      readonly node: NodeId;
      readonly params: Readonly<Record<string, unknown>>;
    }
  /** The value of an input not connected; undefined removes it. */
  | {
      readonly op: 'default';
      readonly node: NodeId;
      readonly port: string;
      readonly value: unknown;
    }
  | { readonly op: 'label'; readonly node: NodeId; readonly label?: string }
  | { readonly op: 'note'; readonly note: GraphNote }
  | {
      readonly op: 'editNote';
      readonly id: string;
      readonly change: Partial<Omit<GraphNote, 'id'>>;
    }
  | { readonly op: 'group'; readonly group: GraphGroup }
  | {
      readonly op: 'editGroup';
      readonly id: string;
      readonly change: Partial<Omit<GraphGroup, 'id'>>;
    }
  | {
      readonly op: 'paste';
      readonly fragment: GraphFragment;
      readonly at: Point;
    }
  /** Places the nodes of the scope again, by autoLayout. */
  | { readonly op: 'layout' }
  /** Sets a field of the document: `variables`, `parameters`, `name`… */
  | { readonly op: 'field'; readonly key: string; readonly value: unknown }
  /** Adds, changes (its signature) or removes a function of the document. */
  | {
      readonly op: 'function';
      readonly name: string;
      readonly change: 'create' | 'remove' | Readonly<Record<string, unknown>>;
    };

/** What a graph of the scene shown is, for the list of the editors. */
export interface TargetInfo {
  readonly id: string;
  readonly kind: GraphKindId;
  readonly name: string;
}

/** The code a material compiles to, and where its nodes are in it. */
export interface MaterialCode {
  /** `wgsl`, `glsl-es-300`, `hlsl`… */
  readonly language: string;
  /** The stages, by name: one module, or a vertex and a fragment source. */
  readonly sources: readonly {
    readonly stage: string;
    readonly code: string;
  }[];
  /** For each source, the node of each line marked (1-based), by line. */
  readonly lines: readonly Readonly<Record<number, NodeId>>[];
  /** The problems of the compilation (the validation's are in the projection). */
  readonly diagnostics: readonly Diagnostic[];
  /** The time of the compilation, in milliseconds. */
  readonly time: number;
}

/** What an animation graph does in the animator followed, ten times a second. */
export interface AnimationLive {
  /** The animators playing the graph, by name. */
  readonly animators: readonly string[];
  readonly animator?: string;
  /** By node id: its weight in the pose (0 to 1), its phase. */
  readonly nodes: Readonly<
    Record<NodeId, { readonly weight: number; readonly phase: number }>
  >;
  /** The state machines by node id. */
  readonly machines: Readonly<
    Record<
      NodeId,
      {
        readonly state: string;
        readonly next?: string;
        readonly progress: number;
        readonly time: number;
      }
    >
  >;
  readonly parameters: Readonly<Record<string, number | boolean>>;
}

/** The state of a node of an instance of a behavior graph. */
export interface BehaviorNodeLive {
  readonly runs: number;
  readonly outputs: Readonly<Record<string, unknown>>;
  /** It ran during the last run of the system. */
  readonly active: boolean;
  readonly waiting: boolean;
}

/** What the debugger of a behavior graph tells, ten times a second and at each pause. */
export interface BehaviorDebugState {
  /** Whether the debugger is open (the system interprets). */
  readonly attached: boolean;
  /** The entities running the graph. */
  readonly instances: readonly {
    readonly entity: number;
    readonly name: string;
  }[];
  /** The instance followed (and the one the breakpoints stop). */
  readonly entity?: number;
  /** Where the graph stopped. */
  readonly paused?: {
    readonly entity: number;
    readonly node: NodeId;
    readonly reason: 'breakpoint' | 'step';
  };
  /** Ids in the program: those of the nodes of a call of a function are `call/node`. */
  readonly breakpoints: readonly NodeId[];
  /** The states of the nodes of the instance followed, by program id. */
  readonly nodes: Readonly<Record<NodeId, BehaviorNodeLive>>;
  /** The nodes of the flow it ran during the last run, in order. */
  readonly trace: readonly NodeId[];
  readonly variables: Readonly<Record<string, unknown>>;
  /** The time of the instance. */
  readonly time: number;
  /** The call of the function shown whose nodes these are (`c3`, `c3/c7`). */
  readonly call?: string;
}

/** What the debugger is asked. */
export type BehaviorDebugAction =
  | { readonly action: 'attach' }
  | { readonly action: 'detach' }
  | { readonly action: 'follow'; readonly entity: number }
  /** A breakpoint on a node of the graph, or on a node of a function (on each of its calls). */
  | {
      readonly action: 'breakpoint';
      readonly node: NodeId;
      readonly scope?: string;
      readonly on: boolean;
    }
  | { readonly action: 'continue' }
  /** Stops before the next node to run (paused or not). */
  | { readonly action: 'step' };

/** From the page to the engine. */
export type GraphRequest =
  | { readonly op: 'targets' }
  /**
   * Opens a session of an editor on a graph of the scene, a file of the
   * user (its text) or a new graph; the session it had ends.
   */
  | {
      readonly op: 'open';
      readonly session: string;
      readonly kind: GraphKindId;
      readonly target?: string;
      readonly file?: { readonly name: string; readonly text: string };
      readonly create?: string;
    }
  | { readonly op: 'close'; readonly session: string }
  | {
      readonly op: 'command';
      readonly session: string;
      readonly command: GraphCommand;
    }
  /** Answered by `file`. */
  | { readonly op: 'save'; readonly session: string; readonly name?: string }
  /** The file written by the host. */
  | { readonly op: 'saved'; readonly session: string; readonly name: string }
  /** The shape of the preview of a material, and whether it plays its time. */
  | {
      readonly op: 'preview';
      readonly session: string;
      readonly shape: 'sphere' | 'cube' | 'plane';
      readonly animate: boolean;
    }
  /** The animator followed, a parameter forced. */
  | {
      readonly op: 'animation';
      readonly session: string;
      readonly animator?: string;
      readonly parameter?: {
        readonly name: string;
        readonly value: number | boolean;
      };
    }
  | ({ readonly op: 'debug'; readonly session: string } & BehaviorDebugAction);

/** From the engine to the page. */
export type GraphEvent =
  | { readonly op: 'targets'; readonly targets: readonly TargetInfo[] }
  | { readonly op: 'graph'; readonly view: GraphView }
  | {
      readonly op: 'catalog';
      readonly session: string;
      readonly templates: readonly NodeTemplate[];
    }
  /** A command not done, and why: a connection whose types do not fit. */
  | {
      readonly op: 'refused';
      readonly session: string;
      readonly message: string;
    }
  /** A session that could not open, or ended (its target gone). */
  | {
      readonly op: 'closed';
      readonly session: string;
      readonly message?: string;
    }
  | {
      readonly op: 'file';
      readonly session: string;
      readonly name: string;
      readonly text: string;
    }
  | {
      readonly op: 'code';
      readonly session: string;
      readonly code: MaterialCode;
    }
  /** The image of the preview: its RGBA pixels in the bytes of the message. */
  | {
      readonly op: 'preview';
      readonly session: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly op: 'animation';
      readonly session: string;
      readonly live: AnimationLive;
    }
  | {
      readonly op: 'debug';
      readonly session: string;
      readonly state: BehaviorDebugState;
    };
