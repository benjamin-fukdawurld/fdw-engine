# @fdw/engine-tessellation

The tessellation of FdwEngine, without hardware tessellation: surfaces of quad patches, each drawn from a template subdivided 1, 2, 4… 64 times, at the level its size on the screen asks for, and displaced by a height map. See [design/p3b-tessellation.md](../../design/p3b-tessellation.md) (in French) and the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/tessellation/).

```ts
import { patchGrid, PatchSurface, patchVertex } from '@fdw/engine-tessellation';

const g = new GraphBuilder('terrain');
const vertex = patchVertex(g, {
  displacement: {
    texture: g.texture('heightMap'),
    sampler: g.sampler('heightSampler'),
    scale: 120,
  },
});
g.surface({ shadingModel: 'phong', baseColor: [0.3, 0.4, 0.2] });

const terrain = new PatchSurface(backend, {
  patches: patchGrid({ width: 1024, depth: 1024, columns: 32, rows: 32 }),
  material: new Material({
    graph: g.build(),
    values: { heightMap, heightSampler },
  }),
  displacement: 120,
});
// Each frame:
terrain.update(camera, surface);
renderer.render({ items: [terrain], camera, surface });
```

## How it works

1. **Levels**, on the CPU, each frame (`LevelSelection`): each edge gets the level that makes its triangles `edgePixels` long on the screen; each patch, the finest level of its edges; the patches outside the frustum are left out.
2. **One draw**, without vertex buffer: the patches sorted by level in an `rgba32float` texture, a texel each; from its index, a vertex finds its level, its patch and its point in the template.
3. **The vertex shader** (`patchVertex`): reads the corners of the patch (`std.textureLoad`), moves the points of each edge to the grid of the edge's level (no crack), interpolates, displaces by the height map and computes the normal. It sets the `position`, `normal` and `uv` attributes of the graph (`g.vertexAttribute`).

The same on WebGPU, Vulkan and WebGL2.

## Options of `PatchSurface`

| Option         | Default  | Role                                                              |
| -------------- | -------- | ----------------------------------------------------------------- |
| `edgePixels`   | 8        | The length of the edges of the triangles on the screen, in pixels |
| `minLevel`     | 0        | The coarsest level (2^level quads along an edge)                  |
| `maxLevel`     | 6        | The finest level                                                  |
| `displacement` | 0        | How far the points move: the bounds grow by it                    |
| `cull`         | true     | Leaves out the patches outside the view                           |
| `matrix`       | identity | The world matrix                                                  |

## Limits

- One `update` per frame: the shadow maps and the other views draw the patches chosen for its camera; the patches left out cast no shadows (`cull: false`).
- One material per surface: it holds the textures and the ranges of the patches drawn.
- At most 2^24 vertices a frame (the vertex index is read as a float): beyond, the levels are lowered.
- Quad patches, bilinear: no Phong tessellation nor Bézier patches yet.
