---
title: Resources
description: Load images, models and any data asynchronously, share and cache them, release them at once, and reload them while the application runs.
sidebar:
  order: 11
---

The resource system loads what an application reads from files: images,
models, sounds ([Audio](/fdw-engine/guides/audio/)), its own data. It is split like the input:

| Package                                                   | Contents                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@fdw/engine-resources`                                   | The store, handles, scopes, loaders, sources (`HttpSource`, `MemorySource`, `DataUriSource`, `ArchiveSource`) |
| `@fdw/engine-resources-web`                               | Image decoding by the browser, files picked or dropped (`FileSource`), hot reload from Vite, workers          |
| `@fdw/engine-resources-native`                            | Files (`FileSource`, `withFileWatch`), `stb_image` decoding in the addon, `worker_threads`                    |
| `@fdw/engine-assets`                                      | Images, textures, meshes, materials, models; `instantiate()` in a scene                                       |
| `@fdw/engine-gltf`, `@fdw/engine-obj`, `@fdw/engine-ktx2` | The formats: bytes in, CPU data out                                                                           |

The core knows neither the GPU nor the scene: the same store loads the
models of a level and the settings of its enemies.

## The store

```ts
import { HttpSource, ResourceStore } from '@fdw/engine-resources';

const resources = new ResourceStore({
  concurrency: 8,
  budget: 256 * 1024 * 1024,
});
resources.mount('http', new HttpSource({ base: '/assets/' }), {
  default: true,
});
```

One store per engine, created with the application and passed explicitly:
no singleton, so tests, two engines and an editor with several scenes stay
separate.

A resource is a **type** and a **URI**. `load()` returns a handle at once;
the loading goes on in the background:

```ts
const texture = resources.load(TextureType, 'textures/bark.png');
texture.status.value; // 'pending' → 'loading' → 'ready' (or 'failed')
texture.progress.value; // 0 to 1, signals of @preact/signals-core
const value = await texture.ready;
```

- Two `load()` of the same type, URI and options share **one entry** and
  one read. `resources.load(TextureType, 'a.png')` and
  `resources.load(TextureType, 'http:./a.png')` are the same resource.
- `handle.value` is the current value — during a reload, the previous one —
  and `handle.require()` the value or an error.
- `handle.version` increases at each change: a signal to follow.
- `priority: 'high' | 'normal' | 'low'` orders the queue; `signal` cancels
  from outside.

## URIs and sources

A URI is `scheme:path#fragment`. Without a scheme, the default one. Sources
are mounted under a scheme like the drives of a file system:

```ts
resources.mount('pack', new ArchiveSource({ source: http, path: 'game.zip' }));
resources.mount('pack', patches, { priority: 10 }); // tried first
resources.mount('data', new DataUriSource());
```

Several sources under one scheme are tried by priority until one has the
file: a folder of patches over the archive of the game.

| Source          | Package   | Reads                                                                  |
| --------------- | --------- | ---------------------------------------------------------------------- |
| `HttpSource`    | core      | `fetch`, with progress, cancellation, `stat` by `ETag`                 |
| `MemorySource`  | core      | Files in memory (`set()` notifies the watchers): tests, generated data |
| `DataUriSource` | core      | `data:` URIs, base64 or not                                            |
| `ArchiveSource` | core      | The entries of a zip read from another source, on demand               |
| `FileSource`    | `-web`    | The `File`s of an `<input>` or of a drop, folders included             |
| `FileSource`    | `-native` | The files under a root directory                                       |

The fragment names a **sub-resource**: the meshes and materials of a model
are `oak.glb#mesh/Trunk/0` and `oak.glb#material/Bark`, its embedded images
`oak.glb#image/0`. These identifiers are stable, since an editor will save
them in its scenes.

## Loaders and types

A type is a typed token; a loader turns the bytes of a URI into a value:

```ts
const LevelType = defineResourceType<Level>('level');

resources.registerLoader({
  type: LevelType,
  extensions: ['json'],
  async load(context) {
    const level = JSON.parse(await context.text()) as Level;
    // A dependency: loaded with it, released with it.
    const music = context.use(AudioClipType, context.resolve(level.music));
    return { ...level, music: await music.ready };
  },
});
```

The context gives the loader:

- `bytes()` and `text()`: the content, read once;
- `resolve(relative)`: a path relative to the resource (a glTF and its
  textures);
- `use(type, uri, options)`: a **dependency**. Its progress counts in that
  of the parent, it is released with the parent, and a reload of it
  updates the parent. A cycle is refused with its path;
- `provide(type, id, value)`: a sub-resource `uri#id`;
- `service(key)`: a service of the store (the render backend);
- `signal`: aborted when nobody waits for the result any more.

A loader may also give `update(current, next)` to update a value in place
on reload, `dispose(value)` to free it, `sizeOf(value)` for the budget of
the cache, `cacheKey(options)`, and `sniff(head)` to recognize its format
when the extension lies. Several loaders of one type are chosen by
extension, then by `sniff`.

## Lifetimes

Every handle counts. An entry lives as long as it has handles **or
dependents**:

```ts
const scope = resources.scope('level-1');
const oak = scope.load(ModelType, 'models/oak.glb');
const ground = scope.load(TextureType, 'textures/ground.png');
// …
scope.dispose(); // releases every handle of the scope
```

- `handle.release()` is idempotent; `using handle = resources.load(…)`
  releases at the end of the block.
- The last handle released during the loading **cancels** it, and the
  dependencies nobody else uses with it.
- An entry without handles stays cached, its value kept: coming back to a
  level just left is immediate. The least recently used are freed when the
  unused ones exceed the `budget`, or by `trim()`. `trim(0)` frees them all.
- Freeing calls the `dispose` of the loader: the GPU textures are destroyed
  there, the buffers of a mesh freed in every renderer.
- A handle forgotten without `release()` is reported when collected: a
  safety net, never the mechanism.

## Progress and errors

```ts
const loading = resources.group([oak, ground, music]);
effect(() => (bar.style.width = `${loading.progress.value * 100}%`));
await loading.ready; // rejects with the first failure
```

The progress of a resource includes that of its dependencies, in bytes
when the sizes are known.

Failures are `ResourceError`s with a `code` — `not-found`, `decode`,
`unsupported`, `aborted`, `dependency`, `io` — and the chain of URIs:
`oak.glb → bark.png`. A failed resource is loaded again by the next
`load()`. A texture of a material that fails shows a magenta checker by
default (`installAssets(store, { onMissing: 'fail' })` fails the material).

## Hot reload

```ts
resources.watch(true);

function frame() {
  resources.update(); // the reloads are applied here, between two frames
  render();
}
```

The sources that can watch (`FileSource` and `withFileWatch` in Node,
`MemorySource`, a source wrapped by `withChangeChannel` or `withPolling` on
the web) tell the store which files changed. The store reloads them; the
**previous value stays in use** until the new one is complete, and a
failure keeps it, with the error on `handle.error`.

`update(budgetMs)` swaps the reloaded values, within a time budget. With
the scheduler of the scene, `addResourceSystem(scheduler, resources)` calls
it at the start of each frame.

- A mesh with the same layout receives its new vertices **in place**, a
  material with the same graph its new values: the nodes that draw them see
  the change without doing anything.
- Otherwise the value is **replaced**, and its dependents follow: a
  material whose texture changed takes the new one.
- `resources.reload(uri)` reloads explicitly.

On the web, the dev server must announce the changes (static files do not
trigger HMR by themselves):

```ts
// vite.config.ts
plugins: ([
  {
    name: 'fdw-resources',
    configureServer(server) {
      server.watcher.on('change', (file) =>
        server.ws.send('fdw:resource-changed', { path: file }),
      );
    },
  },
],
  // The application, in development
  resources.mount(
    'http',
    withChangeChannel(
      new HttpSource({ base: '/' }),
      hotChannel(import.meta.hot!),
    ),
    { default: true },
  ));
```

## Graphical assets

`installAssets` registers the images, textures, meshes, materials and
models, in **two levels**: the format loaders make _data_ on the CPU
(`ImageAsset`, `MeshData`, `PbrMaterialData`, `ModelData`), the
_realizations_ make engine objects from it (`Texture`, `Mesh`, `Material`,
`Model`). The formats are tested without a GPU, and a change of backend
realizes everything again without reading a file:

```ts
installAssets(resources, {
  backend: engine.backend,
  codecs: [bitmapCodec(createImageBitmapDecoder())],
});
installGltf(resources);
installObj(resources);

// Later, another backend (WebGPU → WebGL2):
resources.provideService(RenderBackendService, other.backend);
```

| Type           | Value                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `TextureType`  | A `GpuTexture` and its shared sampler; options `colorSpace` (`'srgb'` by default, `'linear'` for data), `mips`, `sampler` |
| `MeshType`     | A `Mesh` of the engine (a sub-resource of a model)                                                                        |
| `MaterialType` | A `Material`: one graph per set of features (which textures, uv sets), the factors as uniforms                            |
| `ModelType`    | A `Model`: its hierarchy, and the meshes and materials of its primitives                                                  |

**The color space is a choice of the texture, not of the file**: a base
color is sRGB, a normal map linear, and one image can serve as both.

Images are decoded by **codecs**: `bitmapCodec` over `createImageBitmap` in
the browser (colors and alpha left alone, which a normal map needs),
`pixelCodec` over `stb_image` in Node (PNG, JPEG, TGA, BMP, GIF, HDR as
`rgba16float`), `ktx2Codec` for KTX2 files and their compressed formats.

With `keepCpuData: 'never'` (the default) the pixels are freed once on the
GPU; a change of backend reads the files again. `'always'` keeps them, for
an editor.

### Models in a scene

```ts
const oak = scope.load<Model>(ModelType, 'models/oak.glb');
await oak.ready;
for (const position of spots) {
  instantiate(oak, scene, { position, castShadow: true });
}
```

`instantiate` makes the nodes of the model under a new node, and returns a
`ModelInstance` (`root`, `nodes`, `rebuild()`, `dispose()`). The instances
**share** the meshes and materials of the model: ten trees are drawn in one
call per primitive by the instancing. Given a handle, an instance keeps the
model alive until its `dispose()`.

## glTF, OBJ, KTX2

- **glTF 2.0** (`.gltf`, `.glb`): meshes (one per primitive), metallic /
  roughness materials, hierarchy, cameras, skins and animations (read, for
  the animation of a later phase), and the extensions `KHR_materials_unlit`,
  `KHR_texture_transform`, `KHR_materials_emissive_strength`,
  `KHR_mesh_quantization`, `KHR_lights_punctual`, `KHR_texture_basisu`.
  `EXT_meshopt_compression` and `KHR_draco_mesh_compression` take the
  decoders the application gives: `installGltf(resources, { meshopt:
MeshoptDecoder })`, or decode in workers (below). The engine does not ship
  them.
- **OBJ** and its **MTL** files: a node per object or group, Phong
  materials with their maps.
- **KTX2**: mip levels, cubes, arrays, BC / ETC2 / ASTC formats when the
  backend samples them (`capabilities.compressedFormats`), Basis Universal
  through a transcoder given by the application.

## Decoding in workers

The heavy decoding can run in the workers of a pool rather than on the main
thread. One worker script serves every decoder, and the same pool is given
to each of them:

```ts
// decode.worker.ts
import { taskHandler } from '@fdw/engine-resources';
import { imageWorkerTasks, serveWorker } from '@fdw/engine-resources-web';
import { gltfWorkerTasks } from '@fdw/engine-gltf/worker';
import { ktx2WorkerTasks } from '@fdw/engine-ktx2/worker';
import { MeshoptDecoder } from 'meshoptimizer';

serveWorker(
  taskHandler({
    ...imageWorkerTasks(),
    ...gltfWorkerTasks({ meshopt: MeshoptDecoder, draco }),
    ...ktx2WorkerTasks({ transcoder, zstd }),
  }),
);
```

```ts
// The application
const workers = new WorkerPool({
  create: () =>
    new Worker(new URL('./decode.worker.ts', import.meta.url), {
      type: 'module',
    }),
});
const codecs = installAssets(resources, {
  backend: engine.backend,
  codecs: [bitmapCodec(createWorkerImageDecoder(workers, { shared: true }))],
});
installGltf(resources, { workers });
installKtx2(codecs, { workers });
```

| Format       | In the workers                                                                                                                 | On the main thread                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Images (web) | `createImageBitmap`                                                                                                            | The `ImageBitmap` received                                              |
| glTF         | The geometry of each primitive (accessors, sparse values, quantized attributes, strips and fans, flat normals), meshopt, Draco | The JSON and the GLB container, materials, hierarchy, skins, animations |
| KTX2         | The inflating of the levels (zlib, zstd), the Basis Universal transcoding                                                      | The headers of the container                                            |

- Without `workers`, everything is decoded on the main thread by the
  decoders of the options (`meshopt`, `draco`, `transcoder`, `zstd`), as
  before.
- With `workers`, the decoders live in the worker script: `draco3d` and
  `basis_transcoder` are WASM modules the application loads there, and
  those of the options are unused. A file that needs a decoder the script
  lacks fails with `decode`, naming it.
- What is posted is a copy of its range of the file, moved to the worker
  (the file stays usable: a texture transcodes it again for another
  backend); the results are moved back, not copied. A cancelled load drops
  the results of its jobs.
- `@fdw/engine-gltf/worker` and `@fdw/engine-ktx2/worker` import the tasks
  only, not the engine: the worker script stays small.
- `createLocalPool(tasks)` runs the tasks on the calling thread, cloned as
  between threads: for the tests, or a platform without workers.

## Native

```ts
import {
  createStbImageDecoder,
  FileSource,
  withFileWatch,
} from '@fdw/engine-resources-native';

resources.mount('assets', withFileWatch(new FileSource('./assets')), {
  default: true,
});
installAssets(resources, {
  backend,
  codecs: [pixelCodec(createStbImageDecoder())],
});
```

The images are decoded by `stb_image` in the addon of `@fdw/engine-native`,
on the thread pool of Node: the frame loop never waits for them.

glTF and KTX2 go to `worker_threads` with the `WorkerPool` of
`-native`, given as `workers` as on the web. Its module is JavaScript (bundle
the worker script) calling the `serveWorker` of `-native`:

```ts
// decode.worker.ts, bundled to decode.worker.js
import { taskHandler } from '@fdw/engine-resources';
import { serveWorker } from '@fdw/engine-resources-native';
import { gltfWorkerTasks } from '@fdw/engine-gltf/worker';
import { MeshoptDecoder } from 'meshoptimizer';

serveWorker(taskHandler(gltfWorkerTasks({ meshopt: MeshoptDecoder })));

// The application
const workers = new WorkerPool({
  url: new URL('./decode.worker.js', import.meta.url),
});
installGltf(resources, { workers });
```
