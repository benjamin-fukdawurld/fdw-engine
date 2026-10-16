# @fdw/engine-assets

The graphical resources of FdwEngine on top of `@fdw/engine-resources`: images, textures, meshes, materials and models, with their **two levels** — the _data_ made by the format loaders (CPU, independent of the backend, cached) and the _realizations_ that make objects of the engine from it (`GpuTexture`, `Mesh`, `Material`). See [design/p5-resources.md](../../design/p5-resources.md) (in French).

```ts
import {
  bitmapCodec,
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';

const resources = new ResourceStore();
resources.mount('http', new HttpSource({ base: '/' }), { default: true });
installAssets(resources, {
  backend,
  codecs: [bitmapCodec(createImageBitmapDecoder())],
});
installGltf(resources);

const scope = resources.scope('forest');
const oak = scope.load<Model>(ModelType, 'models/oak.glb');
await oak.ready;
// The instance keeps its own handle: the model lives as long as it does.
const instance = instantiate(oak, scene, { position: { x: 3, y: 0, z: 1 } });

// Leaving the level:
instance.dispose();
scope.dispose();
```

## Types

| Data (CPU, no backend)                                                            | Realization (needs `RenderBackendService`)                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ImageAssetType` → `ImageAsset`                                                   | `TextureType` → `Texture` (`GpuTexture` + shared `GpuSampler`), options `colorSpace`, `mips`, `sampler` |
| `MeshDataType` → `MeshData` (typed arrays, a `MeshDescription`)                   | `MeshType` → `Mesh` of `@fdw/engine-core`, option `tangents`                                            |
| `MaterialDataType` → `PbrMaterialData`, `PhongMaterialData`                       | `MaterialType` → `Material`: a graph per set of features, factors as uniforms, textures as dependencies |
| `ModelDataType` → `ModelData` (nodes, meshes, skins, animations, cameras, lights) | `ModelType` → `Model`: the meshes and materials of its primitives                                       |

The format loaders (`@fdw/engine-gltf`, `@fdw/engine-obj`) only make the data level, and provide the meshes and materials of a model as sub-resources of its URI: `oak.glb#mesh/Trunk/0`, `oak.glb#material/Bark`.

## Public API

| Export                                                                                | Kind                  | Description                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `installAssets(store, options)`                                                       | function              | Registers the loaders and services: `backend`, `codecs`, `keepCpuData` (`'never'` by default: images are freed once uploaded), `onMissing` (`'placeholder'`: a magenta checker), `warn`. Returns the `ImageCodecRegistry`            |
| `RenderBackendService`, `ImageCodecsService`, `AssetsConfigService`                   | constant              | The services of the store. Providing another backend realizes the textures, materials and models again                                                                                                                               |
| `ImageCodec`, `ImageCodecRegistry`, `bitmapCodec`, `pixelCodec`                       | type, class, function | Image decoding, chosen by the first bytes then the extension. `bitmapCodec` wraps the browser decoders of `@fdw/engine-resources-web`, `pixelCodec` the `stb_image` decoder of `@fdw/engine-resources-native` (HDR as `rgba16float`) |
| `createTextureFromImage`, `sharedSampler`, `placeholderTexture`                       | function              | The GPU side of textures, usable without a store                                                                                                                                                                                     |
| `materialGraph`, `featureKey`, `materialFactors`, `realizeMaterial`, `updateMaterial` | function              | The graphs of the material data (PBR, Phong, unlit; normal, occlusion, emissive maps, `KHR_texture_transform`, vertex colors), and the realization of a material in a loader                                                         |
| `Model`, `instantiate(model, scene, options)`, `ModelInstance`                        | class, function       | The nodes of a model in a scene, sharing its meshes and materials (drawn in one call by the instancing); `rebuild()`, `dispose()`. Given a handle, the instance keeps the model alive                                                |
| `createLight`                                                                         | function              | An engine light from `KHR_lights_punctual` data                                                                                                                                                                                      |
| `addResourceSystem(scheduler, store)`                                                 | function              | Applies the reloads between two frames, in the `begin` phase                                                                                                                                                                         |

## Lifetimes and reloads

- A material holds its textures, a model its meshes and materials, as dependencies: releasing the model releases the rest, once nobody else uses them. `Mesh.destroy()` frees the GPU buffers of a mesh in every renderer.
- A reload updates in place what can be: a mesh with the same layout gets its new vertices, a material with the same graph its new values (a texture that changed). The nodes drawing them see the change. A model whose hierarchy changed keeps its instances; `instance.rebuild()` makes them again.

## Testing

`npx vitest run --config packages/engine-assets/vitest.config.mts`: the loaders run on the fake backend of `@fdw/engine-core/testing`, with in-memory files and a test codec.
