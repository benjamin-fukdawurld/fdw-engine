---
title: Ressources
description: Charger images, modèles et toute donnée de façon asynchrone, les partager et les mettre en cache, les libérer d'un coup, et les recharger pendant que l'application tourne.
sidebar:
  order: 11
---

Le système de ressources charge ce qu'une application lit dans des
fichiers : images, modèles, plus tard des sons, ses propres données. Il est
découpé comme l'entrée :

| Paquet                                                    | Contenu                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@fdw/engine-resources`                                   | Le store, les poignées, les scopes, les chargeurs, les sources (`HttpSource`, `MemorySource`, `DataUriSource`, `ArchiveSource`)         |
| `@fdw/engine-resources-web`                               | Le décodage des images par le navigateur, les fichiers choisis ou déposés (`FileSource`), le rechargement à chaud par Vite, les workers |
| `@fdw/engine-resources-native`                            | Les fichiers (`FileSource`, `withFileWatch`), le décodage `stb_image` dans l'addon, les `worker_threads`                                |
| `@fdw/engine-assets`                                      | Images, textures, meshes, matériaux, modèles ; `instantiate()` dans une scène                                                           |
| `@fdw/engine-gltf`, `@fdw/engine-obj`, `@fdw/engine-ktx2` | Les formats : des octets en entrée, des données CPU en sortie                                                                           |

Le cœur ne connaît ni le GPU ni la scène : le même store charge les modèles
d'un niveau et les réglages de ses ennemis.

## Le store

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

Un store par moteur, créé avec l'application et passé explicitement : pas
de singleton, donc les tests, deux moteurs et un éditeur à plusieurs scènes
restent séparés.

Une ressource est un **type** et une **URI**. `load()` rend une poignée
tout de suite ; le chargement continue en arrière-plan :

```ts
const texture = resources.load(TextureType, 'textures/bark.png');
texture.status.value; // 'pending' → 'loading' → 'ready' (ou 'failed')
texture.progress.value; // de 0 à 1, des signaux de @preact/signals-core
const value = await texture.ready;
```

- Deux `load()` du même type, de la même URI et des mêmes options partagent
  **une entrée** et une lecture. `resources.load(TextureType, 'a.png')` et
  `resources.load(TextureType, 'http:./a.png')` sont la même ressource.
- `handle.value` est la valeur courante — pendant un rechargement, la
  précédente — et `handle.require()` la valeur ou une erreur.
- `handle.version` augmente à chaque changement : un signal à suivre.
- `priority: 'high' | 'normal' | 'low'` ordonne la file ; `signal` annule
  de l'extérieur.

## URI et sources

Une URI est `schéma:chemin#fragment`. Sans schéma, celui par défaut. Les
sources sont montées sous un schéma comme les lecteurs d'un système de
fichiers :

```ts
resources.mount('pack', new ArchiveSource({ source: http, path: 'game.zip' }));
resources.mount('pack', patches, { priority: 10 }); // essayée d'abord
resources.mount('data', new DataUriSource());
```

Plusieurs sources sous un même schéma sont essayées par priorité jusqu'à ce
que l'une ait le fichier : un dossier de correctifs au-dessus de l'archive
du jeu.

| Source          | Paquet    | Lit                                                                                   |
| --------------- | --------- | ------------------------------------------------------------------------------------- |
| `HttpSource`    | cœur      | `fetch`, avec progression, annulation, `stat` par `ETag`                              |
| `MemorySource`  | cœur      | Des fichiers en mémoire (`set()` prévient les observateurs) : tests, données générées |
| `DataUriSource` | cœur      | Les URI `data:`, en base64 ou non                                                     |
| `ArchiveSource` | cœur      | Les entrées d'un zip lu depuis une autre source, à la demande                         |
| `FileSource`    | `-web`    | Les `File` d'un `<input>` ou d'un glisser-déposer, dossiers compris                   |
| `FileSource`    | `-native` | Les fichiers sous un dossier racine                                                   |

Le fragment nomme une **sous-ressource** : les meshes et matériaux d'un
modèle sont `oak.glb#mesh/Trunk/0` et `oak.glb#material/Bark`, ses images
intégrées `oak.glb#image/0`. Ces identifiants sont stables : un éditeur les
enregistrera dans ses scènes.

## Chargeurs et types

Un type est un jeton typé ; un chargeur transforme les octets d'une URI en
valeur :

```ts
const LevelType = defineResourceType<Level>('level');

resources.registerLoader({
  type: LevelType,
  extensions: ['json'],
  async load(context) {
    const level = JSON.parse(await context.text()) as Level;
    // Une dépendance : chargée avec lui, libérée avec lui.
    const music = context.use(AudioClipType, context.resolve(level.music));
    return { ...level, music: await music.ready };
  },
});
```

Le contexte donne au chargeur :

- `bytes()` et `text()` : le contenu, lu une fois ;
- `resolve(relative)` : un chemin relatif à la ressource (un glTF et ses
  textures) ;
- `use(type, uri, options)` : une **dépendance**. Sa progression compte
  dans celle du parent, elle est libérée avec lui, et son rechargement met
  le parent à jour. Un cycle est refusé avec son chemin ;
- `provide(type, id, value)` : une sous-ressource `uri#id` ;
- `service(key)` : un service du store (le backend de rendu) ;
- `signal` : déclenché quand plus personne n'attend le résultat.

Un chargeur peut aussi donner `update(current, next)` pour mettre une
valeur à jour en place au rechargement, `dispose(value)` pour la libérer,
`sizeOf(value)` pour le budget du cache, `cacheKey(options)`, et
`sniff(head)` pour reconnaître son format quand l'extension ment. Plusieurs
chargeurs d'un même type sont choisis par extension, puis par `sniff`.

## Durées de vie

Chaque poignée compte. Une entrée vit tant qu'elle a des poignées **ou des
dépendants** :

```ts
const scope = resources.scope('level-1');
const oak = scope.load(ModelType, 'models/oak.glb');
const ground = scope.load(TextureType, 'textures/ground.png');
// …
scope.dispose(); // libère toutes les poignées du scope
```

- `handle.release()` est idempotent ; `using handle = resources.load(…)`
  libère à la fin du bloc.
- La dernière poignée libérée pendant le chargement l'**annule**, avec les
  dépendances que personne d'autre n'utilise.
- Une entrée sans poignée reste en cache, sa valeur gardée : revenir dans un
  niveau qu'on vient de quitter est immédiat. Les moins récemment utilisées
  sont libérées quand les inutilisées dépassent le `budget`, ou par
  `trim()`. `trim(0)` les libère toutes.
- La libération appelle le `dispose` du chargeur : les textures GPU y sont
  détruites, les buffers d'un mesh libérés dans tous les renderers.
- Une poignée oubliée sans `release()` est signalée quand elle est
  collectée : un filet, jamais le mécanisme.

## Progression et erreurs

```ts
const loading = resources.group([oak, ground, music]);
effect(() => (bar.style.width = `${loading.progress.value * 100}%`));
await loading.ready; // rejetée avec le premier échec
```

La progression d'une ressource comprend celle de ses dépendances, en octets
quand les tailles sont connues.

Les échecs sont des `ResourceError` avec un `code` — `not-found`,
`decode`, `unsupported`, `aborted`, `dependency`, `io` — et la chaîne des
URI : `oak.glb → bark.png`. Une ressource en échec est rechargée par le
`load()` suivant. Une texture de matériau qui échoue affiche un damier
magenta par défaut (`installAssets(store, { onMissing: 'fail' })` fait
échouer le matériau).

## Le rechargement à chaud

```ts
resources.watch(true);

function frame() {
  resources.update(); // les rechargements sont appliqués ici, entre deux images
  render();
}
```

Les sources qui savent surveiller (`FileSource` et `withFileWatch` dans
Node, `MemorySource`, une source enveloppée par `withChangeChannel` ou
`withPolling` sur le web) disent au store quels fichiers ont changé. Le
store les recharge ; **l'ancienne valeur reste utilisée** jusqu'à ce que
la nouvelle soit complète, et un échec la garde, avec l'erreur sur
`handle.error`.

`update(budgetMs)` échange les valeurs rechargées, dans un budget de temps.
Avec l'ordonnanceur de la scène, `addResourceSystem(scheduler, resources)`
l'appelle au début de chaque image.

- Un mesh de même disposition reçoit ses nouveaux sommets **en place**, un
  matériau de même graphe ses nouvelles valeurs : les nœuds qui les
  dessinent voient le changement sans rien faire.
- Sinon la valeur est **remplacée**, et ses dépendants suivent : un
  matériau dont la texture a changé prend la nouvelle.
- `resources.reload(uri)` recharge explicitement.

Sur le web, le serveur de développement doit annoncer les changements (les
fichiers statiques ne déclenchent pas le HMR d'eux-mêmes) :

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
  // L'application, en développement
  resources.mount(
    'http',
    withChangeChannel(
      new HttpSource({ base: '/' }),
      hotChannel(import.meta.hot!),
    ),
    { default: true },
  ));
```

## Les ressources graphiques

`installAssets` enregistre les images, textures, meshes, matériaux et
modèles, sur **deux niveaux** : les chargeurs de formats produisent des
_données_ CPU (`ImageAsset`, `MeshData`, `PbrMaterialData`, `ModelData`),
les _réalisations_ en font des objets du moteur (`Texture`, `Mesh`,
`Material`, `Model`). Les formats se testent sans GPU, et un changement de
backend réalise tout à nouveau sans relire un fichier :

```ts
installAssets(resources, {
  backend: engine.backend,
  codecs: [bitmapCodec(createImageBitmapDecoder())],
});
installGltf(resources);
installObj(resources);

// Plus tard, un autre backend (WebGPU → WebGL2) :
resources.provideService(RenderBackendService, other.backend);
```

| Type           | Valeur                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `TextureType`  | Une `GpuTexture` et son sampler partagé ; options `colorSpace` (`'srgb'` par défaut, `'linear'` pour les données), `mips`, `sampler` |
| `MeshType`     | Un `Mesh` du moteur (une sous-ressource d'un modèle)                                                                                 |
| `MaterialType` | Un `Material` : un graphe par jeu de caractéristiques (quelles textures, quels jeux d'uv), les facteurs en uniforms                  |
| `ModelType`    | Un `Model` : sa hiérarchie, et les meshes et matériaux de ses primitives                                                             |

**L'espace colorimétrique est un choix de la texture, pas du fichier** :
une couleur de base est sRGB, une carte de normales linéaire, et une même
image peut servir aux deux.

Les images sont décodées par des **codecs** : `bitmapCodec` sur
`createImageBitmap` dans le navigateur (couleurs et alpha laissés tels
quels, ce dont une carte de normales a besoin), `pixelCodec` sur
`stb_image` dans Node (PNG, JPEG, TGA, BMP, GIF, HDR en `rgba16float`),
`ktx2Codec` pour les fichiers KTX2 et leurs formats compressés.

Avec `keepCpuData: 'never'` (par défaut) les pixels sont libérés une fois
sur le GPU ; un changement de backend relit les fichiers. `'always'` les
garde, pour un éditeur.

### Des modèles dans une scène

```ts
const oak = scope.load<Model>(ModelType, 'models/oak.glb');
await oak.ready;
for (const position of spots) {
  instantiate(oak, scene, { position, castShadow: true });
}
```

`instantiate` crée les nœuds du modèle sous un nouveau nœud, et rend une
`ModelInstance` (`root`, `nodes`, `rebuild()`, `dispose()`). Les instances
**partagent** les meshes et matériaux du modèle : dix arbres sont dessinés
en un appel par primitive grâce à l'instancing. Avec une poignée, une
instance garde le modèle en vie jusqu'à son `dispose()`.

## glTF, OBJ, KTX2

- **glTF 2.0** (`.gltf`, `.glb`) : meshes (un par primitive), matériaux
  metallic / roughness, hiérarchie, caméras, peaux et animations (lues,
  pour l'animation d'une phase suivante), et les extensions
  `KHR_materials_unlit`, `KHR_texture_transform`,
  `KHR_materials_emissive_strength`, `KHR_mesh_quantization`,
  `KHR_lights_punctual`, `KHR_texture_basisu`. `EXT_meshopt_compression` et
  `KHR_draco_mesh_compression` utilisent les décodeurs que donne
  l'application : `installGltf(resources, { meshopt: MeshoptDecoder })`, ou
  décodent dans des workers (plus bas). Le moteur ne les embarque pas.
- **OBJ** et ses fichiers **MTL** : un nœud par objet ou groupe, des
  matériaux Phong avec leurs cartes.
- **KTX2** : niveaux de mip, cubes, tableaux, formats BC / ETC2 / ASTC quand
  le backend sait les échantillonner (`capabilities.compressedFormats`),
  Basis Universal par un transcodeur donné par l'application.

## Le décodage dans des workers

Le décodage lourd peut tourner dans les workers d'un pool plutôt que sur le
thread principal. Un seul script de worker sert tous les décodeurs, et le
même pool est donné à chacun :

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
// L'application
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

| Format       | Dans les workers                                                                                                                           | Sur le thread principal                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Images (web) | `createImageBitmap`                                                                                                                        | L'`ImageBitmap` reçue                                                 |
| glTF         | La géométrie de chaque primitive (accesseurs, valeurs creuses, attributs quantifiés, bandes et éventails, normales plates), meshopt, Draco | Le JSON et le conteneur GLB, matériaux, hiérarchie, peaux, animations |
| KTX2         | La décompression des niveaux (zlib, zstd), le transcodage Basis Universal                                                                  | Les en-têtes du conteneur                                             |

- Sans `workers`, tout est décodé sur le thread principal par les décodeurs
  des options (`meshopt`, `draco`, `transcoder`, `zstd`), comme avant.
- Avec `workers`, les décodeurs vivent dans le script du worker : `draco3d`
  et `basis_transcoder` sont des modules WASM que l'application y charge,
  et ceux des options ne servent pas. Un fichier qui demande un décodeur
  absent du script échoue en `decode`, en le nommant.
- Ce qui est posté est une copie de sa plage du fichier, déplacée vers le
  worker (le fichier reste utilisable : une texture le transcode de nouveau
  pour un autre backend) ; les résultats reviennent déplacés, pas copiés.
  Un chargement annulé abandonne les résultats de ses tâches.
- `@fdw/engine-gltf/worker` et `@fdw/engine-ktx2/worker` n'importent que
  les tâches, pas le moteur : le script du worker reste petit.
- `createLocalPool(tasks)` exécute les tâches sur le thread appelant,
  clonées comme entre deux threads : pour les tests, ou une plateforme sans
  workers.

## En natif

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

Les images sont décodées par `stb_image` dans l'addon de
`@fdw/engine-native`, sur le pool de threads de Node : la boucle de rendu
ne les attend jamais.

glTF et KTX2 passent par des `worker_threads` avec le `WorkerPool` de
`-native`, donné en `workers` comme sur le web. Son module est du
JavaScript (le script du worker empaqueté) qui appelle le `serveWorker` de
`-native` :

```ts
// decode.worker.ts, empaqueté en decode.worker.js
import { taskHandler } from '@fdw/engine-resources';
import { serveWorker } from '@fdw/engine-resources-native';
import { gltfWorkerTasks } from '@fdw/engine-gltf/worker';
import { MeshoptDecoder } from 'meshoptimizer';

serveWorker(taskHandler(gltfWorkerTasks({ meshopt: MeshoptDecoder })));

// L'application
const workers = new WorkerPool({
  url: new URL('./decode.worker.js', import.meta.url),
});
installGltf(resources, { workers });
```
