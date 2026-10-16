# @fdw/engine-obj

The loader of Wavefront OBJ files and their MTL materials for `@fdw/engine-assets`: bytes in, CPU data out (`ModelData`, `MeshData`, `PhongMaterialData`), no GPU. See [design/p5-resources.md](../../design/p5-resources.md) §6.12 (in French).

```ts
import {
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { installObj } from '@fdw/engine-obj';

installAssets(resources, { backend, codecs });
installObj(resources);
const sphere = await resources.load<Model>(ModelType, 'sphere.obj').ready;
instantiate(sphere, scene);
```

- **Typed arrays**: positions, normals and uv interleaved in one `Float32Array` per primitive, `Uint16Array` indices (`Uint32Array` beyond 65 535 vertices). Polygons are split in fans of triangles; negative indices count from the end; smooth normals are computed when the file has none.
- **Structure**: a node per object (`o`) or group (`g`), a primitive per material (`usemtl`). Meshes are sub-resources `sphere.obj#mesh/<group>/<n>`, materials `sphere.obj#material/<name>`.
- **MTL** files are dependencies (`MtlType`), resolved next to the OBJ: `Kd`, `Ks`, `Ns`, `Ke`, `d` / `Tr` and the maps `map_Kd`, `map_Ks`, `map_Ns` (multiplies `Ns` by its red channel), `map_Ke`, `norm` (normal map), with the options `-s`, `-o`, `-clamp`. A missing MTL file is a warning: the model gets default materials.
- **Conventions**: OBJ puts `v = 0` at the bottom of the images; it is flipped by default (`installObj(store, { flipV: false })` keeps it).

| Export                              | Kind             | Description                                         |
| ----------------------------------- | ---------------- | --------------------------------------------------- |
| `installObj(store, options)`        | function         | Registers the OBJ and MTL loaders (`flipV`, `warn`) |
| `parseObj`, `parseMtl`              | function         | The parsers, without a store                        |
| `objLoader`, `mtlLoader`, `MtlType` | loader, constant | The loaders, to register by hand                    |
