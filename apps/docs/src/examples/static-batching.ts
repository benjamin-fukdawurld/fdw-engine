import {
  Camera,
  pickIds,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import type { GpuTexture } from '@fdw/engine-backend';
import { Scene, StaticBatches } from '@fdw/engine-scene';
import {
  buildDecor,
  followAspect,
  multiplyQuat,
  rotationAround,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A set of 1 600 static objects, each with a mesh of its own: columns,
// stones, crates, barrels, rocks. Instancing cannot draw them together;
// the static batching merges those of a cell and of a material into one
// mesh. Click the canvas to switch it off and on; hover an object to name
// it, batched or not. A fallen drum rolls to and fro: in its batch, only
// its vertices are written again.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const scene = new Scene();
  const decor = buildDecor(scene);
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 55,
      aspect: 16 / 9,
      near: 0.3,
      far: 600,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  const runner = new RenderGraphRunner(backend);
  let drawCalls = 0;
  let hover = '—';
  const show = () => {
    const stats = batches?.stats;
    info(
      `batching ${batches ? 'on' : 'off'} (click) · ${drawCalls} draw calls for ${
        decor.objects.length
      } objects${
        stats
          ? ` (${stats.batches} batches, ${(stats.bytes / 1e6).toFixed(
              1,
            )} MB on the GPU, ${(stats.cpuBytes / 1e6).toFixed(
              1,
            )} MB on the CPU, ${stats.updates} moves in place)`
          : ''
      } · under the mouse: ${hover}`,
    );
  };

  // The drum that rolls, along its axis, staying in its cell.
  const drum = decor.objects.find((node) => node.name === 'drum');
  const from = drum?.transform.position;
  const start = from && { x: from.x, y: from.y, z: from.z };

  // The static nodes of a cell of 40 m and of a material: one mesh each.
  let batches: StaticBatches | undefined = new StaticBatches(scene, {
    cellSize: 40,
  });
  canvas.addEventListener('click', () => {
    if (batches) {
      batches.destroy();
      batches = undefined;
    } else {
      batches = new StaticBatches(scene, { cellSize: 40 });
    }
    show();
  });

  // The identifiers of the objects, per pixel: those of the scene items
  // (Scene.objectId), per vertex in the batches.
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
  canvas.addEventListener('pointermove', async (event) => {
    if (!ids) {
      return;
    }
    const [id] = await pickIds(backend, ids, {
      x: (event.offsetX * canvas.width) / canvas.clientWidth,
      y: (event.offsetY * canvas.height) / canvas.clientHeight,
    });
    const entity = id === undefined ? undefined : scene.entityOf(id);
    hover =
      entity === undefined
        ? '—'
        : `${scene.node(entity).name} ${entity}${
            batches?.batchOf(entity) ? ', in a batch' : ''
          }`;
    show();
  });

  onFrame((time) => {
    if (drum && start) {
      drum.transform.position = {
        x: start.x + Math.sin(time * 1.5) * 0.8,
        y: start.y,
        z: start.z,
      };
    }
    // Around the square, looking at its center.
    const angle = time * 0.08;
    const radius = decor.half * 0.9;
    camera.position = {
      x: Math.sin(angle) * radius,
      y: 22,
      z: Math.cos(angle) * radius,
    };
    camera.rotation = multiplyQuat(
      rotationAround('y', angle),
      rotationAround('x', -Math.atan2(22, radius)),
    );
    followAspect(camera, surface);

    const target = surface.getCurrentTarget();
    const graph = new RenderGraph();
    renderer.addScenePasses(graph, {
      source: scene,
      camera,
      target: graph.importTexture('surface', target),
      format: surface.format,
      clearColor: { r: 0.62, g: 0.72, b: 0.85, a: 1 },
      outputs: {
        id: {
          format: 'r32uint',
          value: 'object-id',
          target: graph.importTexture(
            'identifiers',
            idTexture(target.width, target.height),
          ),
        },
      },
    });
    runner.execute(graph);
    surface.present();

    drawCalls = renderer.stats.get('scene')?.drawCalls ?? 0;
    show();
  });
};

export default example;
