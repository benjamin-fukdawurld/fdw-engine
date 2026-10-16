# @fdw/engine-resources-native

The Node platform extensions of `@fdw/engine-resources`: a file source with change notifications, image decoding with `stb_image` in the addon of `@fdw/engine-native`, and a pool of `worker_threads`. No graphics dependency: `@fdw/engine-assets` turns the decoded pixels into textures (`pixelCodec`). See [design/p5-resources.md](../../design/p5-resources.md) (in French).

```ts
import { installAssets, pixelCodec } from '@fdw/engine-assets';
import { ResourceStore } from '@fdw/engine-resources';
import {
  createStbImageDecoder,
  FileSource,
  withFileWatch,
} from '@fdw/engine-resources-native';

const resources = new ResourceStore();
resources.mount('assets', withFileWatch(new FileSource('./assets')), {
  default: true,
});
installAssets(resources, {
  backend,
  codecs: [pixelCodec(createStbImageDecoder())],
});
resources.watch(true); // hot reload
```

| Export                             | Kind               | Description                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FileSource`                       | class              | The files under a root, with `/` on every platform; a path that leaves the root is `not-found`. `stat()` revisions (mtime, size), recursive `list()`, byte progress                                                                               |
| `withFileWatch(source)`            | function           | Adds `watch` with `fs.watch`, one watcher per directory. The store regroups a burst of events into one reload. `fs.watch` depends on the platform: `store.reload(uri)` stays the explicit way                                                     |
| `createStbImageDecoder()`          | function           | PNG, JPEG, TGA, BMP, GIF (first frame), HDR (floats), decoded by `stb_image` (vendored in `packages/engine-native/native/third_party/stb`) on the thread pool of libuv: the event loop never blocks                                               |
| `sniffStbImage`, `stbImageFormats` | function, constant | The formats of the decoder                                                                                                                                                                                                                        |
| `WorkerPool`, `serveWorker`        | class, function    | A few `worker_threads` spread by load, the protocol of the `WorkerPool` of `@fdw/engine-resources-web`; transfers, cancellation (the result of a cancelled job is dropped), a crashed worker replaced. Idle workers do not keep the process alive |

The decoder needs the addon built: `npx nx run engine-native:build-native`.
