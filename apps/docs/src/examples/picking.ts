import {
  Camera,
  DirectionalLight,
  Material,
  pickIds,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import type { GpuTexture } from '@fdw/engine-backend';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Selection under the mouse: the scene passes also write the identifier of
// the object of each pixel into a texture, read back where the mouse is.
// Hover a cube to highlight it, click to select it, drag a rectangle to
// select all the cubes in it.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // One graph, three colors: normal, hovered, selected.
  const g = new GraphBuilder('cube');
  g.surface({
    shadingModel: 'phong',
    baseColor: g.uniform('color', BuiltinTypes.vec3f, {
      default: [0.9, 0.5, 0.2],
    }),
  });
  const graph = g.build();
  const normal = new Material({ graph });
  const hovered = new Material({ graph, values: { color: [1, 0.85, 0.4] } });
  const selected = new Material({ graph, values: { color: [0.2, 0.5, 1] } });

  // 5 × 3 cubes; the identifiers go from 1 (top left) to 15.
  const cube = createCube();
  const cubes = [...Array(15)].map((_, i) => ({
    id: i + 1,
    transform: new Transform({
      position: { x: (i % 5) - 2, y: 1 - Math.floor(i / 5), z: 0 },
      scale: { x: 0.6, y: 0.6, z: 0.6 },
    }),
  }));
  const camera = new Camera({
    position: { x: 0, y: 0, z: 5 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sun = new DirectionalLight({ direction: { x: -1, y: -1, z: -1 } });
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);

  // The texture of the identifiers, of the size of the canvas: created by
  // the application, to read it back (copy-src) when the mouse moves.
  let ids: GpuTexture | undefined;
  const idTexture = (width: number, height: number) => {
    if (ids?.dimensions.width !== width || ids.dimensions.height !== height) {
      ids?.destroy();
      ids = backend.textures.createTexture({
        label: 'identifiers',
        type: '2d',
        format: 'r32uint',
        dimensions: { width, height },
        usage: ['render-attachment', 'copy-src'],
      });
    }
    return ids;
  };

  let hover = 0;
  let selection = new Set<number>();
  const show = () =>
    info(
      `hover ${hover || '—'} · selected ${[...selection].join(', ') || '—'}`
    );
  show();

  // From the CSS pixels of the mouse to the pixels of the texture.
  const pixel = (event: PointerEvent) => ({
    x: (event.offsetX * canvas.width) / canvas.clientWidth,
    y: (event.offsetY * canvas.height) / canvas.clientHeight,
  });
  // The rectangle being dragged, drawn over the canvas.
  const box = document.createElement('div');
  box.style.cssText =
    'position:absolute;display:none;pointer-events:none;border:1px solid #6af;background:#6af3';
  canvas.parentElement?.style.setProperty('position', 'relative');
  canvas.parentElement?.append(box);
  let start: PointerEvent | undefined;

  canvas.addEventListener('pointermove', async (event) => {
    if (start) {
      box.style.display = 'block';
      box.style.left = `${
        canvas.offsetLeft + Math.min(start.offsetX, event.offsetX)
      }px`;
      box.style.top = `${
        canvas.offsetTop + Math.min(start.offsetY, event.offsetY)
      }px`;
      box.style.width = `${Math.abs(event.offsetX - start.offsetX)}px`;
      box.style.height = `${Math.abs(event.offsetY - start.offsetY)}px`;
    }
    if (ids) {
      // The pixel under the mouse: its identifier, or none.
      [hover = 0] = await pickIds(backend, ids, pixel(event));
      show();
    }
  });
  canvas.addEventListener('pointerdown', (event) => {
    start = event;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointerup', async (event) => {
    const from = start && pixel(start);
    start = undefined;
    box.style.display = 'none';
    if (!ids || !from) {
      return;
    }
    // A click: the pixel; a drag: the rectangle.
    const to = pixel(event);
    const dragged = Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 4;
    selection = new Set(
      await pickIds(
        backend,
        ids,
        dragged
          ? {
              x: from.x,
              y: from.y,
              width: to.x - from.x,
              height: to.y - from.y,
            }
          : to
      )
    );
    show();
  });

  onFrame((time) => {
    const target = surface.getCurrentTarget();
    cubes.forEach(({ transform }, i) => {
      transform.rotation = axisAngle(0, 1, 0, time * 0.5 + i * 0.4);
    });
    const frame = new RenderGraph();
    renderer.addScenePasses(frame, {
      items: cubes.map(({ id, transform }) => ({
        mesh: cube,
        material: selection.has(id)
          ? selected
          : id === hover
          ? hovered
          : normal,
        transform,
        id,
      })),
      camera,
      lights: [sun],
      target: frame.importTexture('surface', target),
      format: surface.format,
      clearColor: { r: 0.1, g: 0.1, b: 0.12, a: 1 },
      outputs: {
        // Written with the color, in the same pass.
        id: {
          format: 'r32uint',
          value: 'object-id',
          target: frame.importTexture(
            'identifiers',
            idTexture(target.width, target.height)
          ),
        },
      },
    });
    runner.execute(frame);
    surface.present();
  });
};

export default example;
