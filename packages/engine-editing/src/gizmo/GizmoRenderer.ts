import type { GpuTextureFormat } from '@fdw/engine-backend';
import {
  Material,
  type Mesh,
  type RenderGraph,
  type Renderer,
  type RenderItem,
  type TextureHandle,
  Transform,
} from '@fdw/engine-core';
import type { Vec3 } from '@fdw/engine-geometry';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { Viewport } from '../Viewport';
import {
  axisHidden,
  type GizmoHandle,
  GizmoHandles,
  type GizmoMode,
  GizmoShape,
  handleAxis,
  handleVisible,
  isPlane,
} from './handles';
import { type Axis, ShapeBuilder } from './shapes';
import type { TransformGizmo } from './TransformGizmo';

/** The colors of a gizmo: linear RGB, from 0 to 1. */
export interface GizmoColors {
  readonly x: readonly [number, number, number];
  readonly y: readonly [number, number, number];
  readonly z: readonly [number, number, number];
  readonly view: readonly [number, number, number];
  /** The handle under the pointer, or dragged. */
  readonly highlight: readonly [number, number, number];
}

export const defaultGizmoColors: GizmoColors = {
  x: [0.8, 0.03, 0.04],
  y: [0.12, 0.55, 0.01],
  z: [0.03, 0.15, 0.85],
  view: [0.7, 0.7, 0.7],
  highlight: [1, 0.62, 0.02],
};

const axisNames = ['x', 'y', 'z'] as const;

// The meshes of the handles of a mode.
function handleMesh(mode: GizmoMode, handle: GizmoHandle): Mesh {
  const axis = handleAxis(handle);
  const label = `gizmo ${mode} ${handle}`;
  if (handle === 'view') {
    return mode === 'rotate'
      ? new ShapeBuilder(2).ring(GizmoShape.viewRing, 0.012).build(label)
      : new ShapeBuilder().sphere(GizmoShape.center * 0.7).build(label);
  }
  if (handle === 'uniform') {
    return new ShapeBuilder().box(0, GizmoShape.center * 0.75).build(label);
  }
  const shape = new ShapeBuilder(axis as Axis);
  if (isPlane(handle)) {
    return shape.square(GizmoShape.planeFrom, GizmoShape.planeTo).build(label);
  }
  if (mode === 'rotate') {
    return shape.ring(GizmoShape.ring, 0.015).build(label);
  }
  shape.tube(
    GizmoShape.axisFrom,
    mode === 'translate' ? 0.8 : 0.9,
    0.012,
    0.012,
  );
  return (
    mode === 'translate' ? shape.tube(0.8, 1, 0.06, 0) : shape.box(0.95, 0.05)
  ).build(label);
}

/**
 * Draws a TransformGizmo over the scene, in scene passes of its own: a
 * depth buffer of their own (the gizmo is never hidden by the objects, its
 * handles hide each other), unlit, without shadows. Its meshes are made
 * once, its transforms each frame from the gizmo and the viewport.
 *
 * ```ts
 * const drawer = new GizmoRenderer(renderer);
 * // Each frame, last:
 * color = drawer.addPasses(graph, gizmo, viewport, { target: color, format });
 * ```
 */
export class GizmoRenderer {
  colors: GizmoColors;
  private readonly _meshes = new Map<string, Mesh>();
  private readonly _materials = new Map<string, Material>();
  // The frame of the gizmo; the view handles, turned toward the camera.
  private readonly _frame = new Transform();
  private readonly _facing = new Transform();
  private readonly _graph;

  constructor(
    readonly renderer: Renderer,
    { colors = defaultGizmoColors }: { colors?: GizmoColors } = {},
  ) {
    this.colors = colors;
    const g = new GraphBuilder('gizmo');
    g.surface({
      shadingModel: 'unlit',
      baseColor: g.uniform('color', BuiltinTypes.vec3f, {
        default: [1, 1, 1],
      }),
      alpha: g.uniform('opacity', BuiltinTypes.f32, { default: 1 }),
    });
    this._graph = g.build();
  }

  /** The items drawing the gizmo for a viewport: none when it is not shown. */
  items(gizmo: TransformGizmo, viewport: Viewport): RenderItem[] {
    const frame = gizmo.shown ? gizmo.frame(viewport) : undefined;
    if (!frame) {
      return [];
    }
    const { origin, rotation, scale, axes } = frame;
    const position = { x: origin[0], y: origin[1], z: origin[2] };
    const size = { x: scale, y: scale, z: scale };
    this._frame.position = position;
    this._frame.rotation = {
      x: rotation[0],
      y: rotation[1],
      z: rotation[2],
      w: rotation[3],
    };
    this._frame.scale = size;
    this._facing.position = position;
    this._facing.rotation = viewport.camera.rotation;
    this._facing.scale = size;

    const direction = viewport.direction(origin);
    const view: Vec3 = [0, 1, 2].map(
      (i) =>
        direction[0] * axes[i][0] +
        direction[1] * axes[i][1] +
        direction[2] * axes[i][2],
    ) as Vec3;
    const items: RenderItem[] = [];
    for (const handle of GizmoHandles[gizmo.mode]) {
      const axis = handleAxis(handle);
      if (gizmo.active && gizmo.active !== handle) {
        // During a drag, only the handle dragged.
        continue;
      }
      if (
        !handleVisible(handle, view) ||
        (gizmo.mode !== 'rotate' &&
          axis !== undefined &&
          !isPlane(handle) &&
          axisHidden(axis, view))
      ) {
        continue;
      }
      items.push({
        mesh: this.mesh(gizmo.mode, handle),
        material: this.material(gizmo, handle),
        transform:
          handle === 'view' && gizmo.mode === 'rotate'
            ? this._facing
            : this._frame,
        castShadow: false,
      });
    }
    return items;
  }

  /**
   * Adds the passes drawing the gizmo over a target (what the scene passes
   * drew), and returns the version of the target they write (the target as
   * it was when the gizmo is not shown).
   */
  addPasses(
    graph: RenderGraph,
    gizmo: TransformGizmo,
    viewport: Viewport,
    {
      target,
      format,
      name = 'gizmo',
    }: {
      readonly target: TextureHandle;
      readonly format: GpuTextureFormat;
      readonly name?: string;
    },
  ): TextureHandle {
    const items = this.items(gizmo, viewport);
    if (items.length === 0) {
      return target;
    }
    return this.renderer.addScenePasses(graph, {
      name,
      items,
      camera: viewport.camera,
      target,
      format,
      load: 'load',
      lights: [],
      shadows: false,
    }).color;
  }

  private mesh(mode: GizmoMode, handle: GizmoHandle): Mesh {
    const key = `${mode} ${handle}`;
    let mesh = this._meshes.get(key);
    if (!mesh) {
      mesh = handleMesh(mode, handle);
      this._meshes.set(key, mesh);
    }
    return mesh;
  }

  // A material per handle, its color following the state of the handle.
  private material(gizmo: TransformGizmo, handle: GizmoHandle): Material {
    const plane = isPlane(handle);
    const key = `${handle}${plane ? '' : ' line'}`;
    let material = this._materials.get(key);
    if (!material) {
      material = new Material({
        graph: this._graph,
        values: { opacity: plane ? 0.55 : 1 },
        renderState: plane
          ? { alphaMode: 'blend', doubleSided: true }
          : { doubleSided: true },
        label: `gizmo ${handle}`,
      });
      this._materials.set(key, material);
    }
    const axis = handleAxis(handle);
    const color =
      gizmo.active === handle || gizmo.hovered === handle
        ? this.colors.highlight
        : axis === undefined
          ? this.colors.view
          : this.colors[axisNames[axis]];
    const current = material.getValue('color') as number[] | undefined;
    if (!current || current.some((c, i) => c !== color[i])) {
      material.setValue('color', [...color]);
    }
    return material;
  }

  /** Frees the meshes of the gizmo. */
  destroy(): void {
    for (const mesh of this._meshes.values()) {
      mesh.destroy();
    }
    this._meshes.clear();
  }
}
