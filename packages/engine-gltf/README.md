# @fdw/engine-gltf

The glTF 2.0 loader of FdwEngine: `.gltf` (JSON, with external or `data:` buffers and images) and `.glb` (binary) files become `ModelData`, the CPU level of `@fdw/engine-assets`. A pure loader: bytes in, data out, no GPU and no shader graph. `installAssets` realizes the models (meshes, materials, textures) on the backend. See [§6.11 of the P5 design](../../design/p5-resources.md).

```ts
import { installAssets, instantiate, ModelType } from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { MeshoptDecoder } from 'meshoptimizer';

const resources = new ResourceStore();
resources.mount('http', new HttpSource({ base: '/' }), { default: true });
installAssets(resources, { backend: engine.backend! });
installGltf(resources, { meshopt: MeshoptDecoder }); // decoders are optional

const handle = resources.load(ModelType, 'models/oak.glb');
const instance = instantiate(await handle.ready, scene);
```

- **Sub-resources**: each primitive is a `MeshData`, `oak.glb#mesh/<mesh>/<primitive>`; each material a `PbrMaterialData`, `oak.glb#material/<material>`, plus `material/default` when a primitive has none. `<mesh>` and `<material>` are the name when it is unique (`/` and `#` become `_`), else the index. The images held by the file (buffer views, `data:` URIs) are provided as bytes, `oak.glb#image/<index>`, and load as textures like any other image.
- **Buffers**: the BIN chunk of a GLB; external files as `BufferType` resources (shared between files, cancelled with the load); `data:` URIs decoded by the loader itself, so nothing has to be mounted under `data`.
- **Geometry**: one vertex buffer per attribute, named `position`, `normal`, `tangent`, `uv`/`uv1`…, `color`/`color1`…, `joints`, `weights`. Float attributes stay as they are; normalized integers map to `snorm16x4`, `unorm8x4`… (`KHR_mesh_quantization`); joints to `uint8x4`/`uint16x4`; other integers become floats. WebGPU has no 3-component 8 or 16-bit format and wants 4-byte strides: such attributes are padded (colors get an opaque alpha). Indices: `uint8` widened to `uint16`. Sparse accessors are expanded. Strips and fans become lists; points and lines are skipped with a warning. A primitive without normals gets flat normals (unwelded), unless its material is unlit.
- **Materials**: the factors and textures of glTF (`TextureRef`: image URI, uv set, sampler from the glTF sampler), `vertexColors` when a primitive of the material has `COLOR_0`. No graph is made here.
- **Hierarchy**: nodes (a `matrix` is decomposed into translation, rotation and scale), the nodes of the default scene as roots, cameras, skins (`SkinData`) and animations (`AnimationClipData`, quantized outputs dequantized). They are data for P6: nothing plays them.
- **Extensions**: `KHR_materials_unlit`, `KHR_materials_emissive_strength`, `KHR_texture_transform`, `KHR_texture_basisu`, `KHR_mesh_quantization`, `KHR_lights_punctual`, `EXT_meshopt_compression` (with `options.meshopt`) and `KHR_draco_mesh_compression` (with `options.draco`). A required extension that is unknown, or whose decoder is missing, fails the load with a `ResourceError('unsupported')` naming it; an optional one is ignored with a warning.

## Extensions

An extension is a `GltfExtension`: a name and hooks, each called only for the objects that carry it, with its JSON. Hooks that change data return a modified copy:

```ts
const EXT_tint: GltfExtension = {
  name: 'EXT_tint',
  material: (ext, data) => ({
    ...data,
    baseColor: (ext as { color: Vec4Tuple }).color,
  }),
};
installGltf(resources, { extensions: [EXT_tint] }); // added to the built-in ones
```

The hooks are `prepare` (whether the extension can be used for a file), `bufferView` and `primitive` (decoding), `material`, `textureSource`, `textureInfo`, `node` and `model`.

## Decoders

The engine bundles no decoder: the application passes them to `installGltf`, and chooses its WASM builds.

- `meshopt`: the `MeshoptDecoder` of the `meshoptimizer` package fits as is.
- `draco`: a `DracoDecoder` the application writes over `draco3d`. `decode(bytes, attributes)` receives the compressed bytes and the Draco unique ids of the attributes by glTF name (`{ POSITION: 0, TEXCOORD_0: 1 }`), and returns `{ attributes: { POSITION: { array, components, normalized? }, … }, indices? }`.

## Limitations

- Morph targets are not read (a warning says so).
- Interleaved buffer views are copied into one buffer per attribute, and primitives sharing a vertex buffer get a copy each: the shared ranges of §6.10 come later.
- Points and lines are skipped until the topology enters `MeshDescription`.
- Integer matrices (MAT2 and MAT3 of bytes or shorts, with column padding) are not read correctly; glTF only uses float matrices in practice.
