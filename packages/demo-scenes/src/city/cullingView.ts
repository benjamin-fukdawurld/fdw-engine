import type { RenderBackend, Surface } from '@fdw/engine-backend';
import {
  Camera,
  DirectionalLight,
  Material,
  Renderable,
  Renderer,
  RenderGraph,
  RenderSource,
  TextureHandle,
} from '@fdw/engine-core';
import type { OcclusionCulling } from '@fdw/engine-occlusion';
import { NodeFlags, Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import { insetGraph, insetRect } from '../maze/inset';
import { TopViewLayer } from '../maze/topView';

const flat = (color: [number, number, number]) => {
  const g = new GraphBuilder('flat');
  g.surface({
    shadingModel: 'phong',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
  });
  return new Material({ graph: g.build(), values: { color } });
};

/**
 * The city seen from above, around the camera, in a corner of the screen:
 * what the frustum of the camera kept, the occluders (the buildings) light
 * when they are drawn, everything red when the occlusion culling found it
 * hidden. What is out of the frustum is not shown. Drawn after the main view, in the same graph: it reads the last
 * camera query of the scene (NodeState.lastVisible).
 */
export class CullingView {
  readonly camera: Camera;
  private readonly _source: RenderSource;
  private readonly _inset: Material;
  private readonly _drawn = flat([0.85, 0.85, 0.8]);
  private readonly _hidden = flat([0.9, 0.12, 0.1]);
  // The ground and the sidewalks, under the buildings.
  private readonly _ground = flat([0.22, 0.22, 0.24]);
  // The items standing for those kept, by item: red where hidden.
  private readonly _red = new WeakMap<Renderable, Renderable>();
  private readonly _white = new WeakMap<Renderable, Renderable>();
  private readonly _gray = new WeakMap<Renderable, Renderable>();
  private readonly _light = new DirectionalLight({
    direction: { x: 0.3, y: -1, z: 0.2 },
    ambient: { x: 0.35, y: 0.35, z: 0.35 },
    diffuse: { x: 0.8, y: 0.8, z: 0.8 },
    specular: { x: 0, y: 0, z: 0 },
  });
  private _stamp = 0;

  constructor(
    private readonly _renderer: Renderer,
    scene: Scene,
    private readonly _occlusion: OcclusionCulling,
    backend: RenderBackend,
    // Meters from the camera to the edges of the view.
    extent = 260
  ) {
    this.camera = new Camera({
      // Straight down.
      rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
      projection: {
        type: 'orthographic',
        left: -extent,
        right: extent,
        bottom: -extent,
        top: extent,
        near: 1,
        far: 600,
      },
    });
    const { lastVisible, layers: layerColumn, flags } = scene.NodeState;
    const standIn = (
      cache: WeakMap<Renderable, Renderable>,
      item: Renderable,
      material: Material
    ) => {
      let stand = cache.get(item);
      if (!stand) {
        stand = { ...placement(item), mesh: item.mesh, material };
        cache.set(item, stand);
      }
      return stand;
    };
    this._source = {
      query: (frustum, layers, visit) =>
        scene.query(
          frustum,
          layers,
          (item: Renderable) => {
            const entity = (item as unknown as { entity: number }).entity;
            if (layerColumn[entity] === TopViewLayer) {
              visit(item);
            } else if (lastVisible[entity] === this._stamp) {
              visit(
                this._occlusion.isHidden(item)
                  ? standIn(this._red, item, this._hidden)
                  : flags[entity] & NodeFlags.Occluder
                  ? standIn(this._white, item, this._drawn)
                  : standIn(this._gray, item, this._ground)
              );
            }
          },
          // Not a camera query: it must not change what was kept.
          'shadow'
        ),
      lights: () => [this._light],
    };
    this._inset = new Material({
      graph: insetGraph('culling inset', (g, local) =>
        g
          .call(std.textureSample, {
            texture: g.texture('view'),
            sampler: g.sampler('viewSampler'),
            uv: local,
          })
          .swizzle('rgb')
      ),
      values: {
        viewSampler: backend.textures.createSampler({
          wrapModeS: 'clamp-to-edge',
          wrapModeT: 'clamp-to-edge',
        }),
      },
    });
  }

  /** Adds the view over `target`, centered on a point of the ground. */
  add(
    graph: RenderGraph,
    target: TextureHandle,
    surface: Surface,
    center: { x: number; z: number },
    stamp: number
  ): TextureHandle {
    this._stamp = stamp;
    this.camera.position = { x: center.x, y: 400, z: center.z };
    const { size, rect } = insetRect(surface);
    const view = this._renderer.addScenePasses(graph, {
      name: 'culling view',
      source: this._source,
      camera: this.camera,
      target: graph.createTexture('culling view', {
        format: 'rgba8unorm',
        size: { width: size, height: size },
      }),
      format: 'rgba8unorm',
      shadows: false,
      clearColor: { r: 0.03, g: 0.03, b: 0.04, a: 1 },
    });
    this._inset.setValue('rect', rect);
    return this._renderer.addFullscreenPass(graph, 'culling inset', {
      material: this._inset,
      inputs: { view: view.color },
      target,
      format: surface.format,
      load: 'load',
      blend: true,
    });
  }
}

// Where an item is: its transform and bounds, without its material.
const placement = (item: Renderable) =>
  'transform' in item
    ? {
        transform: item.transform,
        ...(item.bounds ? { bounds: item.bounds } : {}),
      }
    : { world: item.world, ...(item.bounds ? { bounds: item.bounds } : {}) };
