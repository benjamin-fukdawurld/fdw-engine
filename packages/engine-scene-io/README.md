# @fdw/engine-scene-io

Saving and loading the scenes of FdwEngine: whole levels, pieces placed in other scenes (prefabs), files of other tools. Everything goes through `SceneData`, a scene as plain data: `captureScene` writes a branch of a `Scene`, `instantiateScene` makes its nodes again, importers (resource loaders of `SceneDataType`) read formats into it, exporters write it. See [design/p16-scenes.md](../../design/p16-scenes.md) (in French), the tutorials « Saving and loading scenes » and « Writing an importer », and the guide « Scenes and formats » of the documentation.

```ts
import {
  captureScene,
  installSceneIo,
  instantiateScene,
  SceneDataType,
  writeFdwScene,
} from '@fdw/engine-scene-io';

const data = captureScene(scene, { store, uri: 'levels/forest.scene.json' });
const files = await writeFdwScene(data, 'levels/forest.scene.json');

installSceneIo(store);
const handle = store.load(SceneDataType, 'levels/forest.scene.json');
const instance = await instantiateScene(handle, other, { store });
```

## Public API

| Export                                                                          | Description                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SceneData`, `SceneNodeData`, `SceneBatchData`, `SceneDataType`                 | A scene as data: nodes, batches, meshes and materials written with it                   |
| `captureScene`                                                                  | A branch of a scene as `SceneData`: resources by URI, instances by source and overrides |
| `instantiateScene`, `SceneInstance`                                             | The nodes of a `SceneData` in a scene, its resources held until `dispose()`             |
| `ComponentCodec`, `SceneCodecs`, `numericCodec`                                 | How the components are written and read; components of numbers with `persist: true`     |
| `sceneCodecs`, `meshRendererCodec`, `lightCodec`, `cameraViewCodec`, `lodCodec` | The codecs of `engine-scene`                                                            |
| `writeFdwScene`, `parseFdwScene`, `fdwSceneLoader`, `installSceneIo`            | The format of the engine: JSON and its binary                                           |
| `migrateFdwScene`, `fdwSceneMigrations`                                         | The versions of the format and their migrations                                         |
| `SceneExporter`, `ExportedFile`                                                 | Exporters give files; the application writes them                                       |
| `modelPaths`, `scenePaths`, `resolveMember`, `sceneInstanceOf`                  | The instances and the paths of their nodes                                              |
| `SceneWriter`                                                                   | What writes the nodes and their components                                              |

The codecs of the other packages: `physicsCodec` (`@fdw/engine-physics`), `soundEmitterCodec` (`@fdw/engine-audio`), `behaviorCodec` (`@fdw/engine-behavior`). glTF: `installGltfScenes` and `writeGltf` of `@fdw/engine-gltf`.
