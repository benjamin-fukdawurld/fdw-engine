# @fdw/engine-resources

The resource system of FdwEngine: asynchronous loading, caching and lifetime management for assets and other data, independent of the graphics backend. Resources are identified by a type and a URI, and loaded by registered loaders. Pure TypeScript, with no graphics dependency. Sources can be mounted like a virtual file system (`MemorySource`, `HttpSource`, archives, and platform-specific file sources). See the [P5 roadmap](../../design/roadmap.md#p5-ressources).

```ts
import { defineResourceType, HttpSource, ResourceStore } from '@fdw/engine-resources';

interface LevelConfig {
  readonly name: string;
  readonly enemies: number;
}

const LevelConfigType = defineResourceType<LevelConfig>('level-config');

const resources = new ResourceStore();

resources.mount('http', new HttpSource({ base: '/' }), { default: true });

// Register a loader that reads and parses the configuration.
resources.registerLoader({
  type: LevelConfigType,
  async load(context) {
    return JSON.parse(await context.text()) as LevelConfig;
  },
});

const scope = resources.scope('level-1');
const config = scope.load(LevelConfigType, 'levels/level-1.json');

const level = await config.ready;

// Leaving the level:
scope.dispose();
```

- **One API for every resource**: define a type and register a loader. The same system can load models, images, JSON, audio clips, and application-specific data.
- **Shared handles and caching**: concurrent requests for the same resource share one entry and one load. Reference counting and scopes make resource lifetimes explicit.
- **Asynchronous and cancellable**: configurable concurrency, load priorities, `AbortSignal` support, progress reporting, and aggregated `LoadGroup` progress.
- **Resource dependencies**: loaders can use other resources through `context.use()`. Dependencies are shared, tracked, and released with their parent.
- **Virtual file system**: mount sources under URI schemes, resolve relative paths, and layer sources by priority. HTTP, in-memory data, files and archives can use the same loader API.
- **Hot reload**: watch resource sources and update or replace loaded values when their contents change.
- **Deterministic cleanup**: release handles explicitly or group them in a `ResourceScope`. Unused entries can remain cached within a configurable memory budget.
- **Backend-independent data**: format loaders produce CPU-side data. Graphics resources are realized separately by `@fdw/engine-assets`, allowing resources to be rebuilt for another rendering backend without coupling format loaders to the GPU.
- **Frame-budgeted updates**: `update()` applies pending replacements and resource updates within a configurable time budget, helping avoid frame-time spikes.
- **Typed errors**: failures are `ResourceError`s with a `code` (`not-found`, `decode`, `unsupported`, `aborted`, `dependency`, `io`) and the chain of URIs that failed (`oak.glb → bark.png`).
- **Testable without a GPU**: loaders and resource dependencies can be tested with in-memory sources and test data.
