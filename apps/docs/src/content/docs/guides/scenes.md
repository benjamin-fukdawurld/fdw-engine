---
title: Scenes and formats
description: Saving and loading scenes, the codecs of the components, the format of the engine, the instances and their changes, glTF.
sidebar:
  order: 17
---

`@fdw/engine-scene-io` saves the scenes and loads them: whole levels,
pieces placed in other scenes, files of other tools. Everything goes
through one representation, `SceneData`: importers make it, exporters
write it, `captureScene` and `instantiateScene` link it to a `Scene`. The
[tutorial](/fdw-engine/tutorials/saving-scenes/) saves and loads a scene,
[Writing an importer](/fdw-engine/tutorials/writing-an-importer/) loads a
format of its own.

| Export                                              | What it is                                                |
| --------------------------------------------------- | --------------------------------------------------------- |
| `SceneData`, `SceneDataType`                        | A scene as plain data; its resource type                  |
| `captureScene`                                      | A branch of a scene as `SceneData`                        |
| `instantiateScene`, `SceneInstance`                 | The nodes of a `SceneData` in a scene, with its resources |
| `ComponentCodec`, `SceneCodecs`, `numericCodec`     | How the components are written and read                   |
| `sceneCodecs`, `meshRendererCodec`, `lightCodec`, … | The codecs of `engine-scene`                              |
| `lodCodec`                                          | The levels of detail of a `SceneLods`                     |
| `writeFdwScene`, `parseFdwScene`, `fdwSceneLoader`  | The format of the engine: write, read, load               |
| `installSceneIo`                                    | Registers its loader in a store                           |
| `SceneExporter`, `ExportedFile`                     | What an exporter is: `SceneData` in, files out            |
| `migrateFdwScene`, `fdwSceneMigrations`             | The versions of the format and their migrations           |
| `modelPaths`, `scenePaths`, `resolveMember`         | The paths of the nodes of the instances                   |

The packages give the codecs of their components: `physicsCodec`
(`@fdw/engine-physics`), `soundEmitterCodec` (`@fdw/engine-audio`),
`behaviorCodec` (`@fdw/engine-behavior`). `@fdw/engine-gltf` reads glTF as
a scene (`installGltfScenes`) and writes it (`writeGltf`).

## SceneData

| Field       | What it holds                                                              |
| ----------- | -------------------------------------------------------------------------- |
| `nodes`     | `SceneNodeData`: the parents before their children                         |
| `batches`   | `SceneBatchData`: many leaf nodes alike, their transforms in flat arrays   |
| `meshes`    | The meshes written with the scene (`MeshData`): `#mesh/<index>`            |
| `materials` | The materials written with the scene (`MaterialData`): `#material/<index>` |

A node has `name`, `position`, `rotation` (x y z w), `scale`, `visible`,
`static`, `occluder`, `layers` (the defaults are left out), `parent` (an
index), and `components`: by name, `{ version, data }`. An `instance` makes
it the root of a model (`model`) or of a scene (`scene`), with its
`overrides`. `parentPath` places it under a node of the instance `parent`.

The entities are numbered for the references between them: the nodes,
then the entities of each batch in turn. The data of the components may
hold typed arrays (a heightfield): the formats write them as binary.

A **reference** to a resource (`ResourceRef`) is a URI, relative to the
scene or with its scheme, or `{ uri, options }` when it is loaded with
options (a texture in a color space).

## Writing: captureScene

| Option      | Default        | Description                                                         |
| ----------- | -------------- | ------------------------------------------------------------------- |
| `store`     |                | The store whose values are written by URI (`store.identify`)        |
| `codecs`    | `sceneCodecs`  | The codecs of the components                                        |
| `root`      | the root       | The branch written: the descendants of this node                    |
| `uri`       |                | Where the scene will be written: the references are relative to it  |
| `instances` | `'reference'`  | The instances by their source and changes, or `'expand'`ed as nodes |
| `batchMin`  | 16             | Leaf nodes alike under a parent, at least this many, become a batch |
| `warn`      | `console.warn` | What could not be written                                           |

A mesh or a material made by the store is written by its URI. The others
are written with the scene: the CPU data of a mesh; the graph of a
material, its values, its features and its render state (a graph material,
`kind: 'graph'`). Its textures must have a URI: a texture made by code
(baked, rendered) is defined in the store under one (`defineTexture`), and
defined again before the scene is loaded. The meshes and materials of a
scene file are written again with the scene saved, never referenced.

## Reading: instantiateScene

| Option   | Default        | Description                                                     |
| -------- | -------------- | --------------------------------------------------------------- |
| `store`  | (required)     | The store the resources are loaded from, kept until `dispose()` |
| `parent` | the root       | Where the instance goes                                         |
| `codecs` | `sceneCodecs`  | The codecs of the components                                    |
| `uri`    | the handle's   | The URI the relative references are resolved against            |
| `wrap`   | `true`         | Under a node of its own (`root`), or straight under the parent  |
| `signal` |                | Cancels: the nodes made are removed                             |
| `warn`   | `console.warn` | What could not be read                                          |

The instance makes the nodes in order, its models and scenes loaded
together, then its batches, then reads the components phase after phase
(`codec.phase`), the codecs of a phase together. Given a handle, the
instance is known by the URI of its scene: captured again, it is written
as a reference. `entities` gives the entity of each index.

## Codecs

| Member            | Description                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `name`, `version` | The component, by its name in its world; the version written with the data   |
| `write(e, ctx)`   | The data of an entity, or `undefined` for none                               |
| `read(d, e, ctx)` | Makes the component again; may be asynchronous (resources)                   |
| `migrate(v, d)`   | Brings data of the version `v` to the current one                            |
| `phase`           | Read after the lower phases (0 by default): `lod` reads in phase 1           |
| `has(e)`          | For the data kept outside the components of the world (the behavior systems) |

`WriteContext`: `resource(value)`, `mesh(mesh)`, `material(material)`
(by URI, or written with the scene), `indexOf(entity)`, `warn`.
`ReadContext`: `load(type, ref)`, `mesh(ref)`, `material(ref)`,
`entity(index)`, `service(key)`, `warn`.

`defineComponent(name, schema, { defaults, version, persist })`: a
component of numbers with `persist: true` is written field by field, by
`numericCodec`. Without a codec, a component is not written; read without
its codec (or of a newer version), its data is kept on the entity and
written again as it was.

| Codec                    | Component       | Data                                                             |
| ------------------------ | --------------- | ---------------------------------------------------------------- |
| `meshRendererCodec`      | `mesh renderer` | `mesh`, `material`, `castShadow`                                 |
| `lightCodec`             | `light`         | The light as it is: colors, attenuation, cone, shadows           |
| `cameraViewCodec`        | `camera view`   | The projection                                                   |
| `lodCodec(lods)`         | `lod`           | The levels: the entities of each, their distance                 |
| `physicsCodec(physics)`  | `physics body`  | The description of the body (`NodeBodyDesc`) or of the character |
| `soundEmitterCodec(a)`   | `sound emitter` | The sound of a node: its source by URI, its options              |
| `behaviorCodec(systems)` | `behavior`      | The graphs run for the entity, their variables                   |

The `userData` of the bodies is not written; a sound made by code neither.
The animators belong to the code of the characters: the animation graphs
are resources (`AnimationGraphType`), loaded by it.

## Instances and their changes

An instance of a model (`instantiate`) or of a scene keeps what it was
made from (components `model instance`, `scene instance`). Captured, it
is written as its source and its **overrides**: what differs from what
the source makes, by the **path** of the node from the root of the
instance — the names of the nodes (`trunk/leaves`), `#k` for the k-th
child when the names repeat, `name#i` for the child holding the i-th
primitive of a mesh. An override replaces fields or components, or
removes the node (`removed: true`) with its descendants. The nodes added
under a node of an instance are written as nodes, with their `parentPath`.

## The format of the engine

`writeFdwScene(data, path, { binary, indent })` gives the JSON and its
binary (`.bin` beside it, or `binary: 'embedded'`: base64 in the JSON).
The JSON is the `SceneData`, with `format: "fdw-scene"`,
`schemaVersion`, `buffers`, and the graphs of the materials written once
in `graphs`. Each typed array becomes
`{ "$binary": { "type": "f32", "byteOffset": 0, "length": 60 } }`, aligned
on 8 bytes.

The loader (`installSceneIo`) provides the meshes and materials as
sub-resources of the file (`level.scene.json#mesh/0`), shared by the
instances, reloaded with the file.

## Versions and migrations

Each format has its version, apart from the version of the engine:
`schemaVersion` of the scenes, `version` of the graphs (material,
animation, behavior), the version of each codec. A document of an older
version goes through its migrations, `n → n + 1`, until the current one:
`fdwSceneMigrations`, `materialGraphMigrations`,
`animationGraphMigrations`, `behaviorGraphMigrations`, `codec.migrate`. A
newer one is refused with a clear message.

The graphs are resources too: `MaterialGraphType` (registered by
`installAssets`), `AnimationGraphType` and `BehaviorGraphType` (their
loaders, `animationGraphLoader` and `behaviorGraphLoader`, to register).

## glTF

`installGltfScenes(store)` loads the `.gltf` and `.glb` as `SceneDataType`:
the nodes, the meshes (the sub-resources of the model), the lights
(`KHR_lights_punctual`), the cameras, the bodies
(`KHR_physics_rigid_bodies`, `KHR_implicit_shapes`), the instances of
`EXT_mesh_gpu_instancing` as batches, and the components of `FDW_scene`.

`writeGltf(data, path, { store, uri, binary, warn })` writes a `.glb` (or a
`.gltf` and its `.bin`): the meshes de-interleaved, the images copied as
they are, the lights as a color and an intensity, the batches as
`EXT_mesh_gpu_instancing`. What glTF has no place for — the graph of a
material, the exact light, a heightfield, the other components — goes to
`FDW_scene`, which other tools ignore: the engine reads the file back
without loss. glTF has no references: capture with `instances: 'expand'`.

## Stable identifiers

The scenes refer to the resources by their URI. For references that
survive a file moved, mount a `CatalogSource` under a scheme:
`asset:8d42c7e1` reads the path the catalog gives, `set` a new one and
what is loaded reloads.

```ts
import { CatalogSource } from '@fdw/engine-resources';

const catalog = new CatalogSource({
  source: files,
  entries: { '8d42c7e1': 'trees/oak.glb' },
});
store.mount('asset', catalog);
instantiate(await store.load(ModelType, 'asset:8d42c7e1').ready, scene);
```

## Archives

A game ships its files in a zip, read by an `ArchiveSource` mounted under
the files of development. Its `ZipReader` refuses an archive past its
limits, all of them options: `maxEntries` (65 535), `maxEntrySize`
(1 GiB) and `maxTotalSize` (4 GiB); an entry is never inflated past the
size it declares.
