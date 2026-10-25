import type { GamepadState, InputSink } from '@fdw/engine-input';

// The messages between the page and the engine, the contract of the hosts:
// a utility process over a MessagePort (Electron), the page itself (web).

/** The bounds of the viewport in the window, in device pixels. */
export interface ViewportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A call of the InputSink of the page (a WebInputSource), replayed by the engine. */
export type InputCall = {
  [K in keyof InputSink]: {
    readonly method: K;
    readonly args: Parameters<InputSink[K]>;
  };
}[keyof InputSink];

// The level: a document of P16 edited with the tools of P15, in the engine.
// The page holds its projection only (the tree, the selection, the
// properties of the active node), by ids, and changes it by commands.

/** The scene of the viewport that shows the level, beside the demo scenes. */
export const levelScene = 'level';

/** The formats a level is saved in: the scene of the engine, or glTF. */
export type LevelFormat = 'fdw-scene' | 'glb';

/** What the tools of the viewport do with the main button. */
export type ViewportTool =
  // Click and rectangle select.
  | 'select'
  // The gizmo, and selection elsewhere.
  | 'translate'
  | 'rotate'
  | 'scale'
  // Another tool has the button (a tool of a plugin): only the camera moves.
  | 'none';

/** The settings of the gizmo (see TransformGizmo). */
export interface GizmoSettings {
  readonly space: 'world' | 'local';
  readonly pivot: 'center' | 'origin';
  readonly snapping: boolean;
}

/** A node of the level, as the tree of the scene shows it. */
export interface LevelNode {
  /** Its entity and its generation: never reused for another node. */
  readonly id: string;
  readonly name: string;
  /** What it draws or carries: the icon of the tree. */
  readonly kind: 'node' | 'mesh' | 'light' | 'camera';
  readonly visible: boolean;
  /** In their order. */
  readonly children: readonly string[];
}

/** A field of a component, edited by the inspector. */
export interface LevelField {
  readonly name: string;
  readonly value: number;
}

/** The properties of a node, for the inspector. */
export interface LevelProperties {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly position: readonly [number, number, number];
  /** Euler angles in degrees, X then Y then Z. */
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  /** Its components, by name; the numbers of those saved field by field. */
  readonly components: readonly {
    readonly name: string;
    readonly fields?: readonly LevelField[];
  }[];
}

/** A property of a node the inspector changes, with its new value. */
export type LevelEdit =
  | { readonly property: 'name'; readonly value: string }
  | { readonly property: 'visible'; readonly value: boolean }
  | {
      readonly property: 'position' | 'rotation' | 'scale';
      readonly value: readonly [number, number, number];
    }
  | {
      readonly property: 'field';
      readonly component: string;
      readonly field: string;
      readonly value: number;
    };

/** What the Add menu creates. */
export type LevelPrimitive = 'empty' | 'cube' | 'sphere' | 'light';

/** A command of the page on the level: one entry of its history, or none. */
export type LevelCommand =
  | { readonly command: 'undo' }
  | { readonly command: 'redo' }
  | { readonly command: 'delete' }
  | { readonly command: 'add'; readonly primitive: LevelPrimitive }
  | ({ readonly command: 'edit'; readonly id: string } & LevelEdit)
  // Moves a node under another, in the last place.
  | {
      readonly command: 'reparent';
      readonly id: string;
      readonly parent: string;
    }
  // Not in the history (as in most editors).
  | { readonly command: 'select'; readonly ids: readonly string[] }
  // Puts the camera in front of the selection.
  | { readonly command: 'frame' };

/** From the page to the engine. */
export type PageMessage =
  // An empty area hides the viewport.
  | ({ readonly type: 'bounds' } & ViewportBounds)
  // The parts of the page over the viewport (menus, floating panels), in
  // device pixels in the window: a window over the page leaves them out.
  | { readonly type: 'holes'; readonly holes: readonly ViewportBounds[] }
  | { readonly type: 'scene'; readonly name: string }
  | ({ readonly type: 'input' } & InputCall)
  // At each animation frame while gamepads are connected (then once empty).
  | { readonly type: 'gamepads'; readonly states: readonly GamepadState[] }
  // A new level, the sample one; or a file of the user (a scene of the
  // engine, glTF), shown in the viewport.
  | { readonly type: 'level.new' }
  | {
      readonly type: 'level.open';
      readonly name: string;
      readonly data: Uint8Array<ArrayBuffer>;
    }
  // Answered by level.file, the level written in one file.
  | {
      readonly type: 'level.save';
      readonly format: LevelFormat;
      readonly name: string;
    }
  // The file of level.file written by the host: the level is saved.
  | { readonly type: 'level.saved'; readonly name: string }
  | ({ readonly type: 'level.command' } & LevelCommand)
  | { readonly type: 'level.tool'; readonly tool: ViewportTool }
  | ({ readonly type: 'level.gizmo' } & GizmoSettings)
  | ExtensionMessage;

/**
 * A message between a plugin and its part in the engine (an
 * EngineExtension, by its id), both ways: JSON, and bytes in `data` (the
 * relays encode them).
 */
export interface ExtensionMessage {
  readonly type: 'extension';
  readonly extension: string;
  readonly message: unknown;
  readonly data?: Uint8Array<ArrayBuffer>;
}

/** From the engine to the page. */
export type EngineMessage =
  | {
      readonly type: 'ready';
      // The backend running (a value of FDW_BACKEND), and the reason of a
      // fallback when it is not the one asked for.
      readonly backend: string;
      readonly fallback?: string;
      readonly device: string;
      readonly scenes: readonly string[];
      readonly scene: string;
    }
  // Once a second.
  | {
      readonly type: 'stats';
      readonly fps: number;
      // The mean CPU time of a frame of the scene, in milliseconds (that of
      // the process in Electron: EditorEnginePlatform.cpuTime); the GPU
      // time of its passes, where the scene measures it (the level).
      readonly cpu: number;
      readonly gpu?: number;
      readonly width: number;
      readonly height: number;
      readonly info: string;
    }
  | { readonly type: 'loading'; readonly scene: string }
  | { readonly type: 'error'; readonly message: string }
  // A line of the console only.
  | {
      readonly type: 'log';
      readonly level: 'info' | 'error';
      readonly text: string;
    }
  | { readonly type: 'pointerLock'; readonly locked: boolean }
  | {
      readonly type: 'rumble';
      readonly gamepad: number;
      readonly strong: number;
      readonly weak: number;
      readonly duration: number;
    }
  // The level opened (at its first message, a new one, a file): the tree
  // follows, whole.
  | {
      readonly type: 'level';
      readonly name: string;
      readonly root: string;
      // Changed since opened or saved.
      readonly dirty: boolean;
    }
  // The changes of the tree, grouped by batch of changes of the scene (one
  // command, one step of a drag): the nodes changed or added, whole, and
  // those removed. `reset`: the whole tree, the previous one dropped.
  | {
      readonly type: 'level.nodes';
      readonly nodes: readonly LevelNode[];
      readonly removed: readonly string[];
      readonly reset?: boolean;
    }
  // The selection, the active node last; its properties, when they change.
  | { readonly type: 'level.selection'; readonly ids: readonly string[] }
  | { readonly type: 'level.properties'; readonly properties?: LevelProperties }
  // The labels of the commands undone and redone next.
  | {
      readonly type: 'level.history';
      readonly undo?: string;
      readonly redo?: string;
    }
  // The rectangle of a selection being dragged, in device pixels of the
  // viewport; none when it ends.
  | { readonly type: 'level.rectangle'; readonly rectangle?: ViewportBounds }
  // The level written, for the host to save.
  | {
      readonly type: 'level.file';
      readonly name: string;
      readonly format: LevelFormat;
      readonly data: Uint8Array<ArrayBuffer>;
    }
  | ExtensionMessage;
