import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  RenderItem,
  Transform,
} from '@fdw/engine-core';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import {
  axisAngle,
  createCapsule,
  createCube,
  createPlane,
  createSphere,
} from '../geometry';
import { followAspect, SceneFactory } from '../scene';
import {
  bakeRockTexture,
  bricksGraph,
  checkerGraph,
  lavaGraph,
  marbleGraph,
  rockGraph,
  tilesGraph,
  triplanarRockGraph,
  woodGraph,
} from './materials';

/** The gallery of procedural materials, to draw. */
export interface Gallery {
  /** The objects and the floor. */
  readonly items: readonly RenderItem[];
  readonly light: DirectionalLight;
  /** The names of the materials, front row then back row, left to right. */
  readonly names: readonly string[];
  /** Whether the checkerboard of the floor is filtered. */
  filtered: boolean;
  destroy(): void;
}

/**
 * The procedural materials of the demo on a floor checkerboard: in front,
 * wood, marble, rock and lava (animated); behind, bricks and tiles (on the
 * uv of cubes) and the baked rock in triplanar mapping (a sphere, its uv
 * ignored). The rock texture is baked first, once.
 */
export async function buildGallery(renderer: Renderer): Promise<Gallery> {
  const rock = await bakeRockTexture(renderer);
  const backend = renderer.backend;
  const repeat = backend.textures.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    wrapModeS: 'repeat',
    wrapModeT: 'repeat',
    maxAnisotropy: 8,
  });
  const place = (x: number, y: number, z: number, scale = 1) =>
    new Transform({
      position: { x, y, z },
      scale: { x: scale, y: scale, z: scale },
    });
  const sphere = createSphere(64, 32);
  const objects: [string, RenderItem][] = [
    [
      'wood',
      {
        mesh: createCapsule(0.35, 0.5, 48, 24),
        material: new Material({ graph: woodGraph() }),
        transform: place(-3.3, 0.86, 0),
      },
    ],
    [
      'marble',
      {
        mesh: sphere,
        material: new Material({ graph: marbleGraph() }),
        transform: place(-1.1, 0.8, 0, 1.6),
      },
    ],
    [
      'rock',
      {
        mesh: sphere,
        material: new Material({ graph: rockGraph() }),
        transform: place(1.1, 0.8, 0, 1.6),
      },
    ],
    [
      'lava',
      {
        mesh: sphere,
        material: new Material({ graph: lavaGraph() }),
        transform: place(3.3, 0.8, 0, 1.6),
      },
    ],
    [
      'bricks',
      {
        mesh: createCube(),
        material: new Material({ graph: bricksGraph() }),
        transform: new Transform({
          position: { x: -2.2, y: 0.75, z: -2.4 },
          rotation: axisAngle(0, 1, 0, 0.5),
          scale: { x: 1.5, y: 1.5, z: 1.5 },
        }),
      },
    ],
    [
      'tiles',
      {
        mesh: createCube(),
        material: new Material({ graph: tilesGraph() }),
        transform: new Transform({
          position: { x: 0, y: 0.75, z: -2.4 },
          rotation: axisAngle(0, 1, 0, -0.4),
          scale: { x: 1.5, y: 1.5, z: 1.5 },
        }),
      },
    ],
    [
      'baked rock, triplanar',
      {
        mesh: sphere,
        material: new Material({
          graph: triplanarRockGraph(),
          values: { rock, rockSampler: repeat },
        }),
        transform: place(2.2, 0.8, -2.4, 1.6),
      },
    ],
  ];
  const floors = [true, false].map(
    (filtered) => new Material({ graph: checkerGraph({ size: 1, filtered }) }),
  );
  let filtered = true;
  const floor = {
    mesh: createPlane(),
    material: floors[0],
    transform: place(0, 0, -20, 80),
  };
  const items: RenderItem[] = [...objects.map(([, item]) => item), floor];
  const light = new DirectionalLight({
    direction: { x: -0.4, y: -0.75, z: -0.5 },
    ambient: { x: 0.3, y: 0.32, z: 0.36 },
    diffuse: { x: 1.6, y: 1.52, z: 1.38 },
  });
  return {
    items,
    light,
    names: objects.map(([name]) => name),
    get filtered() {
      return filtered;
    },
    set filtered(on: boolean) {
      filtered = on;
      floor.material = floors[on ? 0 : 1];
    },
    destroy: () => {
      rock.destroy();
    },
  };
}

/** The camera of the gallery: in front, slowly swaying. */
export function galleryCamera(camera: Camera, time: number): void {
  const yaw = 0.22 * Math.sin(time * 0.2);
  camera.position = {
    x: 7 * Math.sin(yaw),
    y: 2.3,
    z: 5.6 * Math.cos(yaw),
  };
  const turn = axisAngle(0, 1, 0, yaw);
  const tilt = axisAngle(1, 0, 0, -0.22);
  camera.rotation = {
    x: turn.w * tilt.x + turn.x * tilt.w + turn.y * tilt.z - turn.z * tilt.y,
    y: turn.w * tilt.y - turn.x * tilt.z + turn.y * tilt.w + turn.z * tilt.x,
    z: turn.w * tilt.z + turn.x * tilt.y - turn.y * tilt.x + turn.z * tilt.w,
    w: turn.w * tilt.w - turn.x * tilt.x - turn.y * tilt.y - turn.z * tilt.z,
  };
}

/**
 * The gallery of procedural materials in a native window: F switches the
 * filter of the floor checkerboard.
 */
export const createProceduralGallery: SceneFactory = (
  backend,
  surface,
  context = {},
) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 1,
      near: 0.1,
      far: 200,
    },
  });
  const input = new Input(context.input ?? new FakeInputSource());
  const actions = new ActionMap(input, {
    filter: { type: 'button', bindings: ['key:KeyF', 'gamepad:north'] },
  });
  let gallery: Gallery | undefined;
  let destroyed = false;
  void buildGallery(renderer).then((built) => {
    if (destroyed) {
      built.destroy();
    } else {
      gallery = built;
    }
  });
  return {
    frame: (time) => {
      input.update();
      galleryCamera(camera, time);
      followAspect(camera, surface);
      if (gallery && actions.button('filter').pressed) {
        gallery.filtered = !gallery.filtered;
      }
      renderer.render({
        items: gallery?.items ?? [],
        lights: gallery ? [gallery.light] : [],
        camera,
        surface,
        time,
        clearColor: { r: 0.55, g: 0.66, b: 0.8, a: 1 },
      });
      context.info?.(
        gallery
          ? `${gallery.names.join(' · ')} — floor ${
              gallery.filtered ? 'filtered' : 'not filtered'
            } (F)`
          : 'baking the rock…',
      );
    },
    destroy: () => {
      destroyed = true;
      gallery?.destroy();
      input.dispose();
      renderer.destroy();
    },
  };
};
