# @fdw/engine-resources-web

The web platform extensions of FdwEngine's resource system: browser image decoding, file sources, hot-reload watching and worker-based processing. Built on top of `@fdw/engine-resources`, without a graphics backend dependency. See [design/resources.md](../../design/resources.md) (in French).

The package provides the browser-specific implementations while `@fdw/engine-resources` owns resource identity, caching, dependencies, cancellation and lifetime management.

- **Browser image decoding**: decodes images with `createImageBitmap`, with explicit color-space conversion and alpha-premultiplication settings so that pixel data remains suitable for textures such as normal maps.
- **File sources**: loads browser `File` objects, including files selected through an `<input>` or dropped into the application. Useful for asset importers and editors.
- **Hot reload**: watches supported resource sources for changes during development and notifies the resource system so that affected resources can be updated.
- **Worker-based processing**: supports moving image decoding and other expensive resource-processing tasks away from the main thread.
- **Shared resource pipeline**: browser-specific operations integrate with the same `ResourceStore`, loaders, handles, dependencies and progress reporting used by the rest of the engine.
- **No graphics backend dependency**: decoded image data is produced independently of WebGPU or WebGL2. The `@fdw/engine-assets` package is responsible for turning that data into graphics resources.
- **Platform-specific by design**: browser APIs stay in this package rather than leaking into the resource core, keeping the core usable by native applications and tests.

## Usage

```ts
import { WorkerPool, createImageBitmapDecoder, createWorkerImageDecoder,
         createImageDecoderWorker, FileSource, hotChannel, withChangeChannel } from '@fdw/engine-resources-web';

// Decode on the main thread…
const decoder = createImageBitmapDecoder();
// …or in a pool of workers (the buffer is transferred, not copied).
const pool = new WorkerPool({ create: createImageDecoderWorker });
const workerDecoder = createWorkerImageDecoder(pool);

// Files picked or dropped by the user, as a source.
const files = new FileSource();
resources.mount('files', files);
dropZone.ondrop = (e) => files.addFromDataTransfer(e.dataTransfer!);

// Hot reload from the Vite dev server.
resources.mount('http', withChangeChannel(new HttpSource({ base: '/' }), hotChannel(import.meta.hot!)), { default: true });
resources.watch(true);
```

The dev server must send the event (static files do not trigger HMR by themselves):

```ts
// vite.config.ts
{ name: 'fdw-resources', configureServer(server) {
    server.watcher.on('change', (file) => server.ws.send('fdw:resource-changed', { path: file }));
} }
```

Without a dev server, `withPolling(source)` compares `stat()` revisions (ETag, Last-Modified) instead.

## Architecture

`@fdw/engine-resources-web` complements the platform-independent resource system:

| Package                        | Responsibility                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `@fdw/engine-resources`        | Resource types, loaders, sources, caching, handles, dependencies and cancellation             |
| `@fdw/engine-resources-web`    | Browser image decoding, browser file sources, change watching and worker-based processing     |
| `@fdw/engine-resources-native` | Native file access, filesystem watching, native image decoding and worker threads             |
| `@fdw/engine-assets`           | CPU asset types and their realizations as engine resources, including GPU textures and meshes |

The intended image pipeline is:

```text
Image URI
    │
    ▼
ResourceStore
    │
    ▼
Image loader
    │
    ▼
Web image decoder
(createImageBitmap)
    │
    ▼
ImageAsset (CPU data)
    │
    ▼
@fdw/engine-assets
    │
    ▼
Texture (GPU resource)
```

The same CPU-side asset can be realized by different rendering backends without coupling the decoder to WebGPU or WebGL2.

## Related packages

- [`@fdw/engine-resources`](../engine-resources/README.md) — the platform-independent resource system.
- `@fdw/engine-resources-native` — native platform implementations.
- `@fdw/engine-assets` — graphics asset types and backend-dependent realizations.

See the [P5 resource system design](../../design/roadmap.md#p5-ressources) for the architecture, implementation plan and open decisions.
