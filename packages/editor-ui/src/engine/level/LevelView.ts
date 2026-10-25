import { followAspect, type Scene as ShownScene } from '@fdw/demo-scenes';
import type { RenderBackend, Surface } from '@fdw/engine-backend';
import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import {
  Camera,
  type Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import {
  EditingTools,
  GizmoRenderer,
  isAlive,
  Outline,
  Picker,
  renderablesOf,
  TransformGizmo,
  Viewport,
  worldBounds,
  type ToolPointer,
} from '@fdw/engine-editing';
import { Aabb } from '@fdw/engine-geometry';
import {
  ActionMap,
  Input,
  type InputSink,
  type InputSource,
} from '@fdw/engine-input';
import type {
  GraphTarget,
  MaterialGraphTarget,
} from '@fdw/engine-graph-editing';
import type { Node } from '@fdw/engine-scene';
import type {
  EngineMessage,
  GizmoSettings,
  ViewportBounds,
  ViewportTool,
} from '../../protocol';
import type { LevelDocument } from './LevelDocument';

export interface LevelViewOptions {
  readonly backend: RenderBackend;
  readonly surface: Surface;
  /** The inputs of the viewport: the main button is the tools', the others the camera's. */
  readonly input: InputSource;
  readonly post: (message: EngineMessage) => void;
  readonly tool: ViewportTool;
  readonly gizmo: GizmoSettings;
}

const modifierCodes: Readonly<Record<string, keyof Modifiers>> = {
  ShiftLeft: 'shiftKey',
  ShiftRight: 'shiftKey',
  ControlLeft: 'ctrlKey',
  ControlRight: 'ctrlKey',
  AltLeft: 'altKey',
  AltRight: 'altKey',
  MetaLeft: 'metaKey',
  MetaRight: 'metaKey',
};

interface Modifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * An input source whose events go first to the tools of the viewport:
 * the main button and the moves while it is pressed, when the tool active
 * takes it; the rest to the sink of the camera.
 */
class RoutedInput implements InputSource {
  #sink?: InputSink;

  constructor(
    private readonly _source: InputSource,
    private readonly _route: (sink: InputSink) => InputSink,
  ) {}

  attach(sink: InputSink): void {
    this.#sink = sink;
    this._source.attach(this._route(sink));
  }

  detach(): void {
    this.#sink = undefined;
    this._source.detach();
  }

  readGamepads(): number {
    return 0;
  }

  get sink(): InputSink | undefined {
    return this.#sink;
  }
}

/**
 * The level in the viewport: drawn with the outline of its selection and
 * of the node hovered, and the gizmo of the tool; the camera turns around
 * a pivot (the secondary button turns, the middle one pans, the wheel
 * zooms); the main button is the tool's (click and rectangle select,
 * handles of the gizmo drag), as the page chose it (the tool of the
 * primary slot of the editor). A demo scene for the EditorEngine.
 */
export class LevelView implements ShownScene {
  readonly #document: LevelDocument;
  readonly #surface: Surface;
  readonly #post: (message: EngineMessage) => void;
  readonly #camera: Camera;
  readonly #input: Input;
  readonly #orbit: OrbitOperator;
  readonly #renderer: Renderer;
  readonly #runner: RenderGraphRunner;
  readonly #viewport: Viewport;
  readonly #picker: Picker<Node>;
  readonly #gizmo: TransformGizmo;
  readonly #outline: Outline;
  readonly #gizmoRenderer: GizmoRenderer;
  // Without and with the gizmo: the tool chooses.
  readonly #select: EditingTools<Node>;
  readonly #transform: EditingTools<Node>;
  #tool: ViewportTool;
  // The tools that have the main button pressed, until released.
  #pressed?: EditingTools<Node>;
  readonly #pointer = { x: 0, y: 0 };
  readonly #modifiers: Modifiers = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };
  #rectangle?: string;
  #previous?: number;
  readonly #stop: (() => void)[] = [];
  // The materials of the level for the editors of graphs, by the material
  // they draw now.
  #materials = new Map<Material, MaterialGraphTarget>();

  /**
   * The materials of the level, each a graph an editor may change: the
   * nodes drawn with it are drawn with the material edited (not saved with
   * the level yet: P20).
   */
  get graphs(): readonly GraphTarget[] {
    const { scene } = this.#document;
    const renderers = scene.MeshRenderer;
    const drawn: Material[] = [];
    for (const entity of scene.world.query(renderers).entities) {
      const material = renderers.material[entity] as Material;
      if (!drawn.includes(material)) drawn.push(material);
    }
    const targets = new Map<Material, MaterialGraphTarget>();
    drawn.forEach((material, index) => {
      let target = this.#materials.get(material);
      if (!target) {
        let current = material;
        target = {
          kind: 'material',
          id: `level/material${index + 1}`,
          name: material.label ?? `Material ${index + 1}`,
          material: () => current,
          setMaterial: (next) => {
            for (const entity of scene.world.query(renderers).entities) {
              if (renderers.material[entity] === current) {
                renderers.material[entity] = next;
                scene.rendererChanged(entity);
              }
            }
            this.#materials.delete(current);
            current = next;
            this.#materials.set(next, target as MaterialGraphTarget);
          },
        };
      }
      targets.set(material, target);
    });
    this.#materials = targets;
    return [...targets.values()];
  }

  constructor(document: LevelDocument, options: LevelViewOptions) {
    const { backend, surface } = options;
    this.#document = document;
    this.#surface = surface;
    this.#post = options.post;
    this.#tool = options.tool;
    const { scene, selection, history } = document;

    this.#camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 45,
        aspect: 16 / 9,
        near: 0.1,
        far: 500,
      },
    });
    this.#viewport = new Viewport(this.#camera);
    this.#renderer = new Renderer(backend);
    // Its passes measured on the GPU, for the statistics (gpuTime).
    this.#runner = new RenderGraphRunner(backend, { timing: true });
    // A click selects the node under the root: a group, a model, whole;
    // the tree selects the nodes inside.
    this.#picker = Picker.forScene(backend, scene, (node) => {
      let top = node;
      while (top.parent && top.parent !== scene.root) top = top.parent;
      return top;
    });
    this.#gizmo = new TransformGizmo({
      history,
      snap: { translate: 0.5, rotate: 15, scale: 0.25 },
    });
    this.setGizmo(options.gizmo);
    this.setTool(options.tool);
    const tools = (gizmo?: TransformGizmo) =>
      new EditingTools({
        viewport: this.#viewport,
        selection,
        picker: this.#picker,
        history,
        ...(gizmo && { gizmo }),
      });
    this.#select = tools();
    this.#transform = tools(this.#gizmo);
    this.#outline = new Outline(this.#renderer, backend);
    this.#gizmoRenderer = new GizmoRenderer(this.#renderer);

    const routed = new RoutedInput(options.input, (sink) => this.#route(sink));
    this.#input = new Input(routed);
    this.#orbit = new OrbitOperator(
      this.#camera,
      new ActionMap(this.#input, {
        ...OrbitActions,
        move: { type: 'vector', bindings: [] },
        orbit: { type: 'vector', bindings: [] },
        zoom: { type: 'axis', bindings: [] },
        orbitDrag: { type: 'button', bindings: ['pointer:2'] },
        panDrag: { type: 'button', bindings: ['pointer:1'] },
      }),
      { pivot: { x: 0, y: 0.5, z: 0 }, distance: 13, yaw: 0.35, pitch: -0.6 },
    );
    this.#stop.push(
      this.#select.onChange(() => this.#sendRectangle()),
      this.#transform.onChange(() => this.#sendRectangle()),
    );
    document.interrupt = () => this.#cancel();
  }

  /** What the main button does: the tool of the primary slot of the page. */
  setTool(tool: ViewportTool): void {
    if (tool !== this.#tool) this.#cancel();
    this.#tool = tool;
    if (tool === 'translate' || tool === 'rotate' || tool === 'scale') {
      this.#gizmo.mode = tool;
    }
  }

  setGizmo({ space, pivot, snapping }: GizmoSettings): void {
    this.#gizmo.space = space;
    this.#gizmo.pivot = pivot;
    this.#gizmo.snapping = snapping;
  }

  /** Puts the camera in front of the selection, or of the whole level. */
  frameSelection(): void {
    const { selection, scene } = this.#document;
    const nodes = selection.items.filter(isAlive);
    const box = Aabb.empty();
    const part = new Aabb();
    for (const node of nodes.length > 0 ? nodes : scene.root.children) {
      box.union(worldBounds(node, part));
    }
    if (box.isEmpty()) return;
    const [x, y, z] = box.center();
    const radius = Math.max(
      0.5,
      Math.hypot(
        box.max[0] - box.min[0],
        box.max[1] - box.min[1],
        box.max[2] - box.min[2],
      ) / 2,
    );
    Object.assign(this.#orbit.pivot, { x, y, z });
    // The sphere of the bounds fills the height of the view.
    this.#orbit.distance = (radius / Math.sin((45 * Math.PI) / 360)) * 1.1;
  }

  frame(time: number): void {
    const dt = Math.min(0.1, time - (this.#previous ?? time));
    this.#previous = time;
    this.#input.update();
    this.#orbit.update(dt);
    const surface = this.#surface;
    followAspect(this.#camera, surface);
    const target = surface.getCurrentTarget();
    const size = { width: target.width, height: target.height };
    this.#viewport.resize(size.width, size.height);
    const { scene, selection } = this.#document;

    const graph = new RenderGraph({ size });
    let color = this.#renderer.addScenePasses(graph, {
      source: scene,
      camera: this.#camera,
      target: graph.importTexture('surface', target),
      format: surface.format,
      clearColor: { r: 0.12, g: 0.13, b: 0.15, a: 1 },
      outputs: { id: this.#picker.output(graph, size.width, size.height) },
    }).color;
    const hovered = selection.hovered;
    if (hovered && isAlive(hovered) && !selection.has(hovered)) {
      color = this.#outline.addPasses(graph, {
        name: 'hover outline',
        items: renderablesOf([hovered]),
        camera: this.#camera,
        target: color,
        format: surface.format,
        size,
        color: [1, 1, 1, 0.6],
        width: 1.5,
      });
    }
    color = this.#outline.addPasses(graph, {
      items: renderablesOf(selection.items.filter(isAlive)),
      camera: this.#camera,
      target: color,
      format: surface.format,
      size,
    });
    if (this.#hasGizmo()) {
      this.#gizmoRenderer.addPasses(graph, this.#gizmo, this.#viewport, {
        target: color,
        format: surface.format,
      });
    }
    this.#runner.execute(graph);
    surface.present();
  }

  /**
   * The GPU time of the passes of a recent frame, in milliseconds; none
   * before the first measures, or where the backend cannot measure.
   */
  get gpuTime(): number | undefined {
    const times = this.#runner.passTimes;
    if (times.size === 0) return undefined;
    let total = 0;
    times.forEach((duration) => (total += duration));
    return total;
  }

  destroy(): void {
    this.#cancel();
    this.#document.interrupt = undefined;
    this.#stop.forEach((stop) => stop());
    this.#input.dispose();
    this.#post({ type: 'level.rectangle' });
    this.#document.selection.hovered = undefined;
    this.#gizmoRenderer.destroy();
    this.#picker.destroy();
    this.#runner.destroy();
    this.#renderer.destroy();
  }

  #hasGizmo(): boolean {
    return (
      this.#tool === 'translate' ||
      this.#tool === 'rotate' ||
      this.#tool === 'scale'
    );
  }

  // The tools of the main button, if the tool of the page lets them have it.
  #tools(): EditingTools<Node> | undefined {
    if (this.#tool === 'none') return undefined;
    return this.#hasGizmo() ? this.#transform : this.#select;
  }

  #cancel(): void {
    this.#pressed?.cancel();
    this.#pressed = undefined;
  }

  // The pointer in pixels of the viewport, with the modifiers held.
  #toolPointer(button = 0): ToolPointer {
    const { width, height } = this.#viewport;
    return {
      x: this.#pointer.x * width,
      y: this.#pointer.y * height,
      button,
      pointerType: 'mouse',
      ...this.#modifiers,
    };
  }

  #route(camera: InputSink): InputSink {
    return {
      keyDown: (code, key) => {
        const modifier = modifierCodes[code];
        if (modifier) this.#modifiers[modifier] = true;
        camera.keyDown(code, key);
      },
      keyUp: (code, key) => {
        const modifier = modifierCodes[code];
        if (modifier) this.#modifiers[modifier] = false;
        camera.keyUp(code, key);
      },
      pointerMove: (x, y, dx, dy) => {
        this.#pointer.x = x;
        this.#pointer.y = y;
        // The tools of the press, else those that hover.
        (this.#pressed ?? this.#tools())?.pointerMove(this.#toolPointer());
        camera.pointerMove(x, y, dx, dy);
      },
      pointerLock: (locked) => camera.pointerLock(locked),
      pointerButton: (button, down) => {
        const tools = this.#tools();
        if (button === 0 && down && tools && !this.#pressed) {
          if (tools.pointerDown(this.#toolPointer())) {
            this.#pressed = tools;
            return;
          }
        }
        if (button === 0 && !down && this.#pressed) {
          const pressed = this.#pressed;
          this.#pressed = undefined;
          pressed.pointerUp(this.#toolPointer());
          return;
        }
        camera.pointerButton(button, down);
      },
      wheel: (notches) => camera.wheel(notches),
      blur: () => {
        Object.assign(this.#modifiers, {
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
        });
        this.#cancel();
        this.#tools()?.pointerLeave();
        camera.blur();
      },
    };
  }

  // The rectangle being dragged, to the page: it draws it over the view.
  #sendRectangle(): void {
    const from = this.#pressed?.rectangle;
    const rectangle: ViewportBounds | undefined = from && {
      x: Math.round(Math.min(from.from.x, from.to.x)),
      y: Math.round(Math.min(from.from.y, from.to.y)),
      width: Math.round(Math.abs(from.to.x - from.from.x)),
      height: Math.round(Math.abs(from.to.y - from.from.y)),
    };
    const key = JSON.stringify(rectangle ?? null);
    if (key === this.#rectangle) return;
    this.#rectangle = key;
    this.#post({ type: 'level.rectangle', ...(rectangle && { rectangle }) });
  }
}
