---
title: Scènes et formats
description: Enregistrer et charger des scènes, les codecs des composants, le format du moteur, les instances et leurs modifications, glTF.
sidebar:
  order: 17
---

`@fdw/engine-scene-io` enregistre les scènes et les charge : des niveaux
entiers, des pièces placées dans d'autres scènes, des fichiers d'autres
outils. Tout passe par une seule représentation, `SceneData` : les
importeurs la font, les exporteurs l'écrivent, `captureScene` et
`instantiateScene` la relient à une `Scene`. Le
[tutoriel](/fdw-engine/fr/tutorials/saving-scenes/) enregistre et charge une
scène, [Écrire un importeur](/fdw-engine/fr/tutorials/writing-an-importer/)
charge un format à soi.

| Export                                              | Ce que c'est                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `SceneData`, `SceneDataType`                        | Une scène en données simples ; son type de ressource                       |
| `captureScene`                                      | Une branche d'une scène en `SceneData`                                     |
| `instantiateScene`, `SceneInstance`                 | Les nœuds d'une `SceneData` dans une scène, avec ses ressources            |
| `ComponentCodec`, `SceneCodecs`, `numericCodec`     | Comment les composants s'écrivent et se lisent                             |
| `sceneCodecs`, `meshRendererCodec`, `lightCodec`, … | Les codecs de `engine-scene`                                               |
| `lodCodec`                                          | Les niveaux de détail d'une `SceneLods`                                    |
| `writeFdwScene`, `parseFdwScene`, `fdwSceneLoader`  | Le format du moteur : écrire, lire, charger                                |
| `installSceneIo`                                    | Enregistre son chargeur dans un store                                      |
| `SceneExporter`, `ExportedFile`                     | Ce qu'est un exporteur : une `SceneData` en entrée, des fichiers en sortie |
| `migrateFdwScene`, `fdwSceneMigrations`             | Les versions du format et leurs migrations                                 |
| `modelPaths`, `scenePaths`, `resolveMember`         | Les chemins des nœuds des instances                                        |

Les paquets donnent les codecs de leurs composants : `physicsCodec`
(`@fdw/engine-physics`), `soundEmitterCodec` (`@fdw/engine-audio`),
`behaviorCodec` (`@fdw/engine-behavior`). `@fdw/engine-gltf` lit glTF comme
une scène (`installGltfScenes`) et l'écrit (`writeGltf`).

## SceneData

| Champ       | Ce qu'il contient                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `nodes`     | `SceneNodeData` : les parents avant leurs enfants                                                 |
| `batches`   | `SceneBatchData` : beaucoup de nœuds feuilles semblables, leurs transformations en tableaux plats |
| `meshes`    | Les meshes écrits avec la scène (`MeshData`) : `#mesh/<index>`                                    |
| `materials` | Les matériaux écrits avec la scène (`MaterialData`) : `#material/<index>`                         |

Un nœud a `name`, `position`, `rotation` (x y z w), `scale`, `visible`,
`static`, `occluder`, `layers` (les valeurs par défaut sont omises),
`parent` (un indice), et `components` : par nom, `{ version, data }`. Une
`instance` en fait la racine d'un modèle (`model`) ou d'une scène
(`scene`), avec ses `overrides`. `parentPath` le place sous un nœud de
l'instance `parent`.

Les entités sont numérotées pour les références entre elles : les nœuds,
puis les entités de chaque lot à tour de rôle. Les données des composants
peuvent contenir des tableaux typés (un champ de hauteurs) : les formats les
écrivent en binaire.

Une **référence** à une ressource (`ResourceRef`) est une URI, relative à
la scène ou avec son schéma, ou `{ uri, options }` quand elle se charge
avec des options (une texture dans un espace colorimétrique).

## Écrire : captureScene

| Option      | Défaut         | Description                                                                      |
| ----------- | -------------- | -------------------------------------------------------------------------------- |
| `store`     |                | Le store dont les valeurs sont écrites par URI (`store.identify`)                |
| `codecs`    | `sceneCodecs`  | Les codecs des composants                                                        |
| `root`      | la racine      | La branche écrite : les descendants de ce nœud                                   |
| `uri`       |                | Où la scène sera écrite : les références y sont relatives                        |
| `instances` | `'reference'`  | Les instances par leur source et leurs modifications, ou `'expand'` en nœuds     |
| `batchMin`  | 16             | Des nœuds feuilles semblables sous un parent, au moins ce nombre, forment un lot |
| `warn`      | `console.warn` | Ce qui n'a pas pu être écrit                                                     |

Un mesh ou un matériau fait par le store est écrit par son URI. Les autres
sont écrits avec la scène : les données CPU d'un mesh ; le graphe d'un
matériau, ses valeurs, ses fonctionnalités et son état de rendu (un
matériau à graphe, `kind: 'graph'`). Ses textures doivent avoir une URI :
une texture faite par code (cuite, rendue) est définie dans le store sous
une URI (`defineTexture`), et définie de nouveau avant que la scène soit
chargée. Les meshes et les matériaux d'un fichier de scène sont réécrits
avec la scène enregistrée, jamais référencés.

## Lire : instantiateScene

| Option   | Défaut              | Description                                                             |
| -------- | ------------------- | ----------------------------------------------------------------------- |
| `store`  | (obligatoire)       | Le store d'où les ressources sont chargées, gardées jusqu'à `dispose()` |
| `parent` | la racine           | Où va l'instance                                                        |
| `codecs` | `sceneCodecs`       | Les codecs des composants                                               |
| `uri`    | celle de la poignée | L'URI par rapport à laquelle les références relatives sont résolues     |
| `wrap`   | `true`              | Sous un nœud à elle (`root`), ou directement sous le parent             |
| `signal` |                     | Annule : les nœuds créés sont retirés                                   |
| `warn`   | `console.warn`      | Ce qui n'a pas pu être lu                                               |

L'instance crée les nœuds dans l'ordre, ses modèles et ses scènes chargés
ensemble, puis ses lots, puis lit les composants phase après phase
(`codec.phase`), les codecs d'une phase ensemble. Avec une poignée,
l'instance est connue par l'URI de sa scène : capturée de nouveau, elle est
écrite comme une référence. `entities` donne l'entité de chaque indice.

## Codecs

| Membre            | Description                                                                          |
| ----------------- | ------------------------------------------------------------------------------------ |
| `name`, `version` | Le composant, par son nom dans son monde ; la version écrite avec les données        |
| `write(e, ctx)`   | Les données d'une entité, ou `undefined` pour aucune                                 |
| `read(d, e, ctx)` | Refait le composant ; peut être asynchrone (ressources)                              |
| `migrate(v, d)`   | Amène des données de la version `v` à la version courante                            |
| `phase`           | Lu après les phases plus basses (0 par défaut) : `lod` se lit en phase 1             |
| `has(e)`          | Pour les données gardées hors des composants du monde (les systèmes de comportement) |

`WriteContext` : `resource(value)`, `mesh(mesh)`, `material(material)`
(par URI, ou écrit avec la scène), `indexOf(entity)`, `warn`.
`ReadContext` : `load(type, ref)`, `mesh(ref)`, `material(ref)`,
`entity(index)`, `service(key)`, `warn`.

`defineComponent(name, schema, { defaults, version, persist })` : un
composant de nombres avec `persist: true` est écrit champ par champ, par
`numericCodec`. Sans codec, un composant n'est pas écrit ; lu sans son codec
(ou d'une version plus récente), ses données restent sur l'entité et sont
réécrites telles quelles.

| Codec                    | Composant       | Données                                                       |
| ------------------------ | --------------- | ------------------------------------------------------------- |
| `meshRendererCodec`      | `mesh renderer` | `mesh`, `material`, `castShadow`                              |
| `lightCodec`             | `light`         | La lumière telle quelle : couleurs, atténuation, cône, ombres |
| `cameraViewCodec`        | `camera view`   | La projection                                                 |
| `lodCodec(lods)`         | `lod`           | Les niveaux : les entités de chacun, leur distance            |
| `physicsCodec(physics)`  | `physics body`  | La description du corps (`NodeBodyDesc`) ou du personnage     |
| `soundEmitterCodec(a)`   | `sound emitter` | Le son d'un nœud : sa source par URI, ses options             |
| `behaviorCodec(systems)` | `behavior`      | Les graphes exécutés pour l'entité, leurs variables           |

Le `userData` des corps n'est pas écrit ; un son fait par code non plus.
Les animateurs relèvent du code des personnages : les graphes d'animation
sont des ressources (`AnimationGraphType`), chargées par lui.

## Instances et leurs modifications

Une instance d'un modèle (`instantiate`) ou d'une scène garde ce dont elle
a été faite (composants `model instance`, `scene instance`). Capturée, elle
est écrite comme sa source et ses **surcharges** : ce qui diffère de ce que
la source fait, par le **chemin** du nœud depuis la racine de l'instance —
les noms des nœuds (`trunk/leaves`), `#k` pour le k-ième enfant quand les
noms se répètent, `name#i` pour l'enfant qui porte la i-ième primitive d'un
mesh. Une surcharge remplace des champs ou des composants, ou retire le
nœud (`removed: true`) avec ses descendants. Les nœuds ajoutés sous un nœud
d'une instance sont écrits comme des nœuds, avec leur `parentPath`.

## Le format du moteur

`writeFdwScene(data, path, { binary, indent })` donne le JSON et son binaire
(`.bin` à côté, ou `binary: 'embedded'` : du base64 dans le JSON). Le JSON
est la `SceneData`, avec `format: "fdw-scene"`, `schemaVersion`, `buffers`,
et les graphes des matériaux écrits une fois dans `graphs`. Chaque tableau
typé devient
`{ "$binary": { "type": "f32", "byteOffset": 0, "length": 60 } }`, aligné
sur 8 octets.

Le chargeur (`installSceneIo`) fournit les meshes et les matériaux comme
sous-ressources du fichier (`level.scene.json#mesh/0`), partagées par les
instances, rechargées avec le fichier.

## Versions et migrations

Chaque format a sa version, à part de la version du moteur :
`schemaVersion` des scènes, `version` des graphes (matériau, animation,
comportement), la version de chaque codec. Un document d'une version plus
ancienne passe par ses migrations, `n → n + 1`, jusqu'à la version
courante : `fdwSceneMigrations`, `materialGraphMigrations`,
`animationGraphMigrations`, `behaviorGraphMigrations`, `codec.migrate`. Un
document plus récent est refusé avec un message clair.

Les graphes sont aussi des ressources : `MaterialGraphType` (enregistré par
`installAssets`), `AnimationGraphType` et `BehaviorGraphType` (leurs
chargeurs, `animationGraphLoader` et `behaviorGraphLoader`, sont à
enregistrer).

## glTF

`installGltfScenes(store)` charge les `.gltf` et `.glb` comme
`SceneDataType` : les nœuds, les meshes (les sous-ressources du modèle), les
lumières (`KHR_lights_punctual`), les caméras, les corps
(`KHR_physics_rigid_bodies`, `KHR_implicit_shapes`), les instances de
`EXT_mesh_gpu_instancing` en lots, et les composants de `FDW_scene`.

`writeGltf(data, path, { store, uri, binary, warn })` écrit un `.glb` (ou un
`.gltf` et son `.bin`) : les meshes désentrelacés, les images copiées
telles quelles, les lumières en couleur et intensité, les lots en
`EXT_mesh_gpu_instancing`. Ce pour quoi glTF n'a pas de place — le graphe
d'un matériau, la lumière exacte, un champ de hauteurs, les autres
composants — va dans `FDW_scene`, que les autres outils ignorent : le
moteur relit le fichier sans perte. glTF n'a pas de références : capturez
avec `instances: 'expand'`.

## Identifiants stables

Les scènes désignent les ressources par leur URI. Pour des références qui
survivent à un fichier déplacé, montez une `CatalogSource` sous un schéma :
`asset:8d42c7e1` lit le chemin que donne le catalogue, `set` en donne un
nouveau et ce qui est chargé se recharge.

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

Un jeu livre ses fichiers dans un zip, lu par une `ArchiveSource` montée
sous les fichiers de développement. Son `ZipReader` refuse une archive qui
dépasse ses limites, toutes des options : `maxEntries` (65 535),
`maxEntrySize` (1 Gio) et `maxTotalSize` (4 Gio) ; une entrée n'est jamais
décompressée au-delà de la taille qu'elle déclare.
