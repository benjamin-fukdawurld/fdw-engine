import { Camera, DirectionalLight, Renderer } from '@fdw/engine-core';
import {
  installAssets,
  MaterialDataType,
  MeshDataType,
  type MaterialData,
  type MeshData,
} from '@fdw/engine-assets';
import {
  MemorySource,
  ResourceError,
  ResourceStore,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import {
  instantiateScene,
  sceneCodecs,
  SceneDataType,
  type ComponentCodec,
  type SceneData,
  type SceneNodeData,
} from '@fdw/engine-scene-io';
import {
  axisAngle,
  createCube,
  createSphere,
  multiplyQuat,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A format of our own: a level drawn in text, one character per cell. The
// importer is a loader of SceneData, registered in the store like the
// others: the scene then loads as a glTF or a scene of the engine would.
const level = `
##########
#S..#....#
#.#.#.##g#
#.#...#..#
#.###.#.##
#..g..#..#
####.##.##
#g.......#
##########
`;

/** The meshes and materials of the cells, as data. */
const box: MeshData = { name: 'box', ...dataOf(createCube()) };
const ball: MeshData = { name: 'gem', ...dataOf(createSphere()) };
const color = (rgb: [number, number, number], emissive = 0): MaterialData => ({
  kind: 'pbr',
  baseColor: [...rgb, 1],
  metallic: 0,
  roughness: 0.8,
  emissive: [rgb[0] * emissive, rgb[1] * emissive, rgb[2] * emissive],
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  doubleSided: false,
});

/**
 * `.level` files: `#` a wall, `g` a gem, `S` the start, `.` the floor. The
 * walls are a batch (one mesh, a transform each), the gems nodes with a
 * light and a `gem` component, the start a node to find by its name.
 */
const levelImporter: ResourceLoader<SceneData> = {
  type: SceneDataType,
  extensions: ['level'],
  async load(ctx) {
    const rows = (await ctx.text())
      .split('\n')
      .map((row) => row.trimEnd())
      .filter((row) => row.length > 0);
    if (rows.length === 0)
      throw new ResourceError('decode', ctx.uri, 'Empty level');
    // The meshes and materials: sub-resources of the file (`#mesh/0`).
    ctx.provide(MeshDataType, 'mesh/0', box);
    ctx.provide(MeshDataType, 'mesh/1', ball);
    ctx.provide(MaterialDataType, 'material/0', color([0.55, 0.52, 0.48]));
    ctx.provide(MaterialDataType, 'material/1', color([0.25, 0.27, 0.3]));
    ctx.provide(MaterialDataType, 'material/2', color([0.2, 0.9, 0.5], 2));
    const width = Math.max(...rows.map((row) => row.length));
    const at = (column: number, row: number) =>
      [column - width / 2 + 0.5, row - rows.length / 2 + 0.5] as const;
    const walls: number[] = [];
    const nodes: SceneNodeData[] = [
      {
        name: 'floor',
        position: [0, -0.05, 0],
        scale: [width, 0.1, rows.length],
        static: true,
        components: {
          'mesh renderer': {
            version: 1,
            data: { mesh: '#mesh/0', material: '#material/1' },
          },
        },
      },
    ];
    rows.forEach((line, row) => {
      [...line].forEach((cell, column) => {
        const [x, z] = at(column, row);
        if (cell === '#') walls.push(x, 0.5, z);
        else if (cell === 'S')
          nodes.push({ name: 'start', position: [x, 0, z] });
        else if (cell === 'g') {
          nodes.push({
            name: 'gem',
            position: [x, 0.5, z],
            scale: [0.35, 0.35, 0.35],
            components: {
              'mesh renderer': {
                version: 1,
                data: {
                  mesh: '#mesh/1',
                  material: '#material/2',
                  castShadow: false,
                },
              },
              gem: { version: 1, data: { value: 10 } },
            },
          });
          nodes.push({
            name: 'glow',
            parent: nodes.length - 1,
            components: {
              light: {
                version: 1,
                data: {
                  type: 'point',
                  ambient: [0, 0, 0],
                  diffuse: [0.2, 1.2, 0.6],
                  specular: [0.2, 1.2, 0.6],
                  attenuation: [1, 0.5, 1.5],
                },
              },
            },
          });
        } else if (cell !== '.') {
          throw new ResourceError(
            'decode',
            ctx.uri,
            `Unknown cell "${cell}" at row ${row + 1}, column ${column + 1}`,
          );
        }
      });
    });
    const count = walls.length / 3;
    return {
      name: 'maze',
      nodes,
      batches: [
        {
          name: 'wall',
          count,
          positions: Float32Array.from(walls),
          rotations: new Float32Array(count * 4).map((_, i) =>
            i % 4 === 3 ? 1 : 0,
          ),
          scales: new Float32Array(count * 3).fill(1),
          static: true,
          occluder: true,
          mesh: '#mesh/0',
          material: '#material/0',
        },
      ],
      meshes: [],
      materials: [],
    };
  },
};

const example: Example = async ({ backend, surface, onFrame, info }) => {
  const resources = new ResourceStore();
  resources.mount('mem', new MemorySource({ 'maze.level': level }), {
    default: true,
  });
  installAssets(resources, { backend });
  resources.registerLoader(levelImporter);

  const scene = new Scene();
  // The component of the gems, and its codec: what the importer wrote under
  // `gem`, read into the component.
  const Gem = scene.world.defineComponent('gem', { value: 'u16' });
  const gemCodec: ComponentCodec<{ value: number }> = {
    name: 'gem',
    version: 1,
    write: (entity) => ({ value: Gem.value[entity] }),
    read: (data, entity, ctx) => ctx.scene.world.add(entity, Gem, data),
  };
  const handle = resources.load(SceneDataType, 'maze.level');
  const maze = await instantiateScene(handle, scene, {
    store: resources,
    codecs: [...sceneCodecs, gemCodec],
  });
  handle.release();
  maze.root.add({ rotation: axisAngle(1, 0.4, 0, -1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.2, y: 0.2, z: 0.25 },
      diffuse: { x: 0.8, y: 0.75, z: 0.7 },
    }),
  );

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 60,
    },
  });
  const renderer = new Renderer(backend);
  const start = scene.find('start')!.worldPosition;
  const total = [...Gem.entities].reduce((sum, e) => sum + Gem.value[e], 0);

  onFrame((time) => {
    // Around the maze; the gems turn and bob.
    const angle = time * 0.2;
    camera.position = {
      x: Math.sin(angle) * 11,
      y: 9,
      z: Math.cos(angle) * 11,
    };
    camera.rotation = multiplyQuat(
      axisAngle(0, 1, 0, angle),
      axisAngle(1, 0, 0, -0.7),
    );
    for (const entity of Gem.entities) {
      const t = scene.node(entity).transform;
      t.rotation = axisAngle(0, 1, 0, time * 2);
      t.position = {
        ...t.position,
        y: 0.5 + Math.sin(time * 3 + entity) * 0.1,
      };
    }
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.08, g: 0.09, b: 0.12, a: 1 },
    });
    info(
      `maze.level: ${Gem.count} gems (${total} points), start at ${start.x.toFixed(1)}, ${start.z.toFixed(1)}`,
    );
  });
};

// The data of a mesh of the engine (createCube, createSphere), for the importer.
function dataOf(mesh: ReturnType<typeof createCube>) {
  return {
    description: mesh.description,
    vertices: mesh.vertices,
    indices: mesh.indices,
  };
}

export default example;
