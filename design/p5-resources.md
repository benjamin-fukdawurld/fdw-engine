# P5 — Le système de ressources

_Design validé, implémenté (voir l'état par étape au §8). Les décisions du §10 sont prises._ Contexte : [roadmap P5](roadmap.md#p5-ressources), [backlog « Import de ressources »](backlog.md). Convention des documents : [design-process](../apps/docs/src/content/docs/contributing/design-process.md).

## 1. Résumé

Un système de ressources **abstrait**, indépendant du graphique, et ses extensions graphiques :

- `@fdw/engine-resources` : le cœur. Des **types** de ressources, des **chargeurs** enregistrés par type, des **sources** montées comme un système de fichiers virtuel (URL, fichiers, archives), un `ResourceStore` qui charge de façon asynchrone, annulable, avec progression, cache, **poignées partagées** à comptage de références, dépendances entre ressources et rechargement à chaud. Il ne connaît ni le GPU ni la scène : il sert aussi bien aux sons (P7) qu'aux modèles.
- `@fdw/engine-assets` : les types graphiques (`ImageAsset`, `Texture`, `MeshData`, `Material`, `ModelData`, `Model`) et leurs **réalisations** sur un `RenderBackend`.
- Les formats (`engine-gltf`, `engine-obj`, `engine-ktx2`) sont des **chargeurs purs** : des octets en entrée, des données CPU en sortie, sans GPU. Ils se testent sans backend.
- Deux paquets de plateforme (`-web`, `-native`), comme `engine-input-web` / `engine-input-native` : décodeurs d'images, sources de fichiers, surveillance des changements, pools de workers.

Le principe directeur : **deux niveaux**. Les chargeurs produisent des _données_ (CPU, indépendantes du backend, mises en cache) ; des _réalisations_ en font des objets du moteur (textures GPU, `Mesh`, `Material`). Ce découpage donne le changement de backend de la démo (WebGPU ↔ WebGL2) sans relire un octet, les tests sans GPU, et un chemin unique pour tous les formats.

## 2. Le problème

Ce que fait le moteur aujourd'hui :

- **Les images** : la démo écrit `loadTexture` dans chaque route (`fetch` → `createImageBitmap` → `backend.textures.createTexture({ source })`, voir `routes/loading-model`). Rien n'est partagé ni mis en cache ; la couleur (sRGB ou linéaire) est un paramètre local ; pas de natif (`createImageBitmap` n'existe pas dans Node).
- **Les modèles** : `apps/demo/src/utils3d/obj-importer.ts` (OBJ via `@thi.ng/geom-io-obj`, MTL à part) produit des `number[]` puis `meshFromObj` fabrique un `Mesh`. Chaque appel recharge tout ; rien n'est annulable ; les tableaux JS et les copies (`[...v]`) coûtent cher sur un gros modèle.
- **Les durées de vie** : un `Material` tient des `GpuTexture` créées par l'application, qui les détruit à la main. Le `Renderer` garde les buffers GPU d'un `Mesh` dans un `WeakMap` (`_meshes`) : il les libère au changement de version ou à `destroy()`, jamais quand le mesh n'est plus utilisé. Sur Vulkan, un `WeakMap` ne libère rien de déterministe.
- **Le backend** n'a aucun format compressé : `GpuTextureFormatNames` s'arrête aux formats 8/16/32 bits et de profondeur, et `writeTexture` n'écrit que le premier niveau de mip.
- **Les sommets** : `MeshAttributeSemanticNames` n'a qu'un `uv` et qu'un `color`, alors que glTF a `TEXCOORD_n` et `COLOR_n`.

Ce qui existe déjà et que l'on réutilise : `Mesh` (CPU, versionné, `setVertices`), `Material` (versionné, `setValue`, `renderState` qui a déjà `alphaMode` `opaque|mask|blend` et `doubleSided`), `computeTangents` (convention glTF), les samplers (`wrapModeS/T`, `minFilter`…, `maxAnisotropy`), `mipLevelCount` et la génération des mipmaps, le modèle de shading `pbr` du material graph (ports `baseColor`, `alpha`, `emissive`, `normal`, `occlusion`, `metallic`, `roughness`), `Node.setMesh(mesh, material)`, et l'instancing de P1 (les objets qui partagent mesh et matériau sont dessinés en un appel).

## 3. Objectif et bénéfice

- Une API **unique** pour tout type de ressource ; ajouter un format ou un type, c'est enregistrer un chargeur.
- Charger sans bloquer, annuler, afficher une progression (écran de chargement), ne pas charger deux fois, libérer ce qui n'est plus utilisé.
- Les démos, la doc (« Charger des modèles »), l'éditeur de P13 et l'audio de P7 partagent le même système.
- Le rechargement à chaud raccourcit la boucle de travail sur les modèles, les textures et plus tard les matériaux.

## 4. Coût

- Cinq à six paquets nouveaux (cœur, assets, plateforme ×2, formats) : du travail de structure (Nx, `package.json`, frontières de modules) avant le premier modèle.
- Trois extensions de l'API abstraite (§7), dont une touche les quatre backends (formats compressés).
- Un décodeur d'images natif à ajouter à l'addon `engine-native`.
- Ce que cela contraint : les URI et les identifiants de sous-ressources deviennent un format de sérialisation (les scènes de l'éditeur les stockeront) ; ils doivent être stables.

## 5. Alternatives

| Choix                         | Option retenue                                                                                 | Alternatives écartées                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Données et GPU**            | Deux niveaux : données CPU + réalisations                                                      | _Les chargeurs créent directement les objets GPU_ : plus simple, mais lie les formats au backend, empêche de tester sans GPU et de changer de backend |
| **Un store ou un singleton**  | Un `ResourceStore` créé et passé explicitement                                                 | _Un singleton global_ : pratique, mais interdit les tests isolés, plusieurs moteurs (démo web + natif) et l'éditeur à plusieurs scènes                |
| **Durée de vie**              | Comptage de références, poignées partagées, **scopes** qui les regroupent, cache en inactivité | _GC seul (`WeakRef`, `FinalizationRegistry`)_ : non déterministe, inacceptable pour la mémoire GPU ; _tout manuel_ : fuites                           |
| **Identité**                  | URI de chaîne `schéma:chemin#sous-ressource` + type                                            | _GUID_ : robuste aux déplacements, mais demande un catalogue ; compatible plus tard (§10)                                                             |
| **Décodage natif des images** | `stb_image` dans l'addon, décodage asynchrone                                                  | _SDL3_image_ : plus de formats, mais une dépendance de plus à construire ; _décodeurs JS/WASM_ : portables, mais plus lents et un second chemin       |
| **Rechargement**              | Remplacement atomique de la valeur, **mise à jour en place** quand le chargeur sait la faire   | _Toujours recréer_ : les nœuds de la scène garderaient un objet périmé ; _toujours en place_ : impossible quand le format change                      |

## 6. Conception

### 6.1 Les paquets

```
engine-resources          cœur abstrait ; sources memory, http, archive (zip)
engine-resources-web      décodage createImageBitmap, source File, surveillance (HMR), pool de Workers
engine-resources-native   source fichiers (fs), surveillance (fs.watch), décodage stb (addon), worker_threads
engine-assets             types et réalisations graphiques ; instantiate() dans une scène
engine-gltf  engine-obj  engine-ktx2   chargeurs de formats (octets → données)
```

Dépendances : `engine-resources` ne dépend que de `@preact/signals-core` (déjà utilisé par `Engine`). `engine-assets` dépend de `engine-resources`, `engine-core`, `engine-scene`, `engine-shader`, `engine-backend`. Les formats dépendent de `engine-assets` pour les types de données, jamais du backend.

Les paquets de plateforme ne dépendent **pas** d'`engine-assets` : leurs décodeurs rendent des pixels ou un `ImageBitmap`, et `engine-assets` les adapte en _codecs_ d'images (§6.9). `engine-resources-native` dépend d'`engine-native` pour l'addon (comme `engine-input-native`) ; `stb_image.h` est vendu dans `packages/engine-native/native/third_party/stb/`, compilé dans `fdw_native.node`.

Les décodeurs lourds (Basis Universal, Draco, meshopt, zstd) ne sont **pas** des dépendances des paquets du moteur : l'application les passe aux installeurs (`installGltf(store, { meshopt, draco })`, `installKtx2(registry, { transcoder })`). Les paquets restent légers et l'application choisit ses binaires WASM.

### 6.2 Le vocabulaire

| Terme        | Sens                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| **Type**     | `ResourceType<T>` : un jeton typé (`ImageAssetType`, `ModelType`, `AudioClipType`…), comme `defineComponent` |
| **URI**      | `schéma:chemin#sous-ressource` ; sans schéma, celui par défaut ; `model.glb#mesh/2`, `pack:trees/oak.glb`    |
| **Source**   | Lit des octets pour un chemin (HTTP, fichiers, mémoire, archive) ; montée sous un schéma                     |
| **Chargeur** | `ResourceLoader<T, O>` : transforme les octets d'une URI en valeur de type `T`, avec des options `O`         |
| **Store**    | `ResourceStore` : registre des chargeurs et des sources, cache, file de chargement                           |
| **Entrée**   | L'état partagé d'une ressource (valeur, état, version, dépendances) ; une par (type, URI, options)           |
| **Poignée**  | `ResourceHandle<T>` : une référence comptée vers une entrée ; plusieurs poignées, une entrée                 |
| **Scope**    | Un groupe de poignées libérées d'un coup (un niveau, un modèle instancié)                                    |

### 6.3 L'API du cœur

```ts
// --- Types and identity -------------------------------------------------

export interface ResourceType<T> {
  readonly name: string;
  readonly [phantom]?: T; // carries T, never set
}
export const defineResourceType = <T>(name: string): ResourceType<T> => ({
  name,
});

export type ResourceUri = string; // 'scheme:path#fragment'

// A service of the store (the render backend, the image codecs…).
export interface ServiceKey<S> {
  readonly name: string;
  readonly id: symbol;
}
export const defineServiceKey = <S>(name: string): ServiceKey<S> => ({
  name,
  id: Symbol(name),
});

// --- Sources -------------------------------------------------------------

export type ResourceBytes = Uint8Array<ArrayBuffer>;
// The bytes of a sub-resource (an image embedded in a GLB), provided by the
// loader of its parent; `ctx.bytes()` of `model.glb#image/0` reads them.
export const ResourceBytesType: ResourceType<ResourceBytes>;

export interface ReadOptions {
  readonly signal: AbortSignal;
  onProgress?(loaded: number, total?: number): void;
}

export interface ResourceSource {
  read(path: string, options: ReadOptions): Promise<ResourceBytes>;
  // A token that changes when the content does (ETag, mtime), to validate
  // the cache and to detect a change.
  stat?(path: string): Promise<{ size?: number; revision?: string }>;
  list?(prefix: string): Promise<string[]>;
  // The change notifications of a path, for the hot reload. Returns the
  // function that stops watching.
  watch?(path: string, onChange: () => void): () => void;
}

// --- Loaders --------------------------------------------------------------

export interface ResourceLoader<T, O = void> {
  readonly type: ResourceType<T>;
  readonly extensions?: readonly string[]; // ['glb', 'gltf']
  readonly mimeTypes?: readonly string[];
  // Recognizes a format from its first bytes, when the extension lies.
  sniff?(head: Uint8Array): boolean;
  // Part of the cache key: two option values with the same key share an entry.
  cacheKey?(options: O): string;
  load(context: LoadContext<O>): Promise<T>;
  // Updates `current` from the freshly loaded `next` without replacing it
  // (a texture rewritten, a mesh whose vertices change). Returns false when
  // it cannot: the entry then switches to `next`.
  update?(current: T, next: T): boolean;
  // Frees what the value holds: GPU objects, workers…
  dispose?(value: T): void;
  // Memory held, for the budget of the cache.
  sizeOf?(value: T): number;
}

export interface LoadContext<O> {
  readonly uri: ResourceUri;
  readonly options: O;
  // Aborted when nobody waits for the result any more. Pass it to fetch and
  // decoders, and check it between the steps.
  readonly signal: AbortSignal;

  bytes(): Promise<ResourceBytes>; // read once: every call returns the same array
  text(): Promise<string>;
  // Resolves a path relative to this resource (a glTF and its textures).
  resolve(relative: string): ResourceUri;

  // Loads another resource this one depends on. The handle is owned by this
  // entry: it is released with it, and a change of the dependency reloads or
  // updates this one (§6.7). Progress is aggregated into this one's.
  use<U, P>(
    type: ResourceType<U>,
    uri: ResourceUri,
    options?: P
  ): ResourceHandle<U>;
  // Registers a sub-resource, addressable as `uri#id`, owned by this entry.
  provide<U>(type: ResourceType<U>, id: string, value: U): ResourceHandle<U>;
  // A service of the store: the render backend, the audio device…
  service<S>(key: ServiceKey<S>): S;

  progress(loaded: number, total?: number): void;
}

// --- Handles ---------------------------------------------------------------

export type ResourceStatus =
  | 'pending'
  | 'loading'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface ResourceHandle<T> {
  readonly type: ResourceType<T>;
  readonly uri: ResourceUri;
  readonly status: ReadonlySignal<ResourceStatus>;
  readonly progress: ReadonlySignal<number>; // 0 to 1
  readonly error: ReadonlySignal<ResourceError | undefined>;
  // Incremented each time the value changes (loaded, reloaded).
  readonly version: ReadonlySignal<number>;
  // The current value: the previous one stays while a reload is under way.
  readonly value: T | undefined;
  readonly ready: Promise<T>; // first load; rejects on failure or cancel
  require(): T; // throws when not ready
  readonly dependencies: readonly ResourceHandle<unknown>[];

  // Idempotent. The last handle of an entry that is loading cancels the load.
  release(): void;
  [Symbol.dispose](): void; // `using handle = store.load(…)`
}

// --- The store ---------------------------------------------------------------

export interface LoadOptions<O> {
  readonly options?: O;
  readonly priority?: 'high' | 'normal' | 'low';
  readonly signal?: AbortSignal; // an external cancellation
}

export class ResourceStore {
  constructor(options?: {
    concurrency?: number; // loads under way at once, 8 by default; dependencies do not count
    budget?: number; // bytes kept for unused entries, 256 MiB by default
    debounceMs?: number; // quiet time after a change before reloading, 50 ms
    warn?: (message: string, cause?: unknown) => void; // leaks, failing dispose()
  });

  registerLoader<T, O>(loader: ResourceLoader<T, O>): this;
  // Several sources under one scheme are tried by priority (patch over archive).
  mount(
    scheme: string,
    source: ResourceSource,
    options?: { priority?: number; default?: boolean }
  ): this;
  provideService<S>(key: ServiceKey<S>, value: S): this;

  load<T, O = void>(
    type: ResourceType<T>,
    uri: ResourceUri,
    options?: LoadOptions<O>
  ): ResourceHandle<T>;
  // A handle to an entry already known, without starting a load. Like any
  // handle, it must be released.
  peek<T>(
    type: ResourceType<T>,
    uri: ResourceUri
  ): ResourceHandle<T> | undefined;
  // A resource made in memory (a generated mesh) with the same handle
  // semantics. It cannot be read again: it is disposed with its last handle,
  // never cached.
  define<T>(
    type: ResourceType<T>,
    uri: ResourceUri,
    value: T
  ): ResourceHandle<T>;

  scope(name?: string): ResourceScope;
  group(handles: Iterable<ResourceHandle<unknown>>): LoadGroup;

  reload(uri: ResourceUri): Promise<void>;
  watch(enabled: boolean): void; // the hot reload, §6.7
  // Frees unused entries down to the budget; all of them with 0.
  trim(budget?: number): void;
  // Called once per frame: applies the pending changes, within a time budget.
  update(budgetMs?: number): void;
  dispose(): void;
}

export interface ResourceScope {
  readonly name?: string;
  load: ResourceStore['load']; // handles owned by the scope
  adopt<T>(handle: ResourceHandle<T>): ResourceHandle<T>;
  dispose(): void; // releases every handle
}

// Aggregated progress, for a loading screen.
export interface LoadGroup {
  readonly progress: ReadonlySignal<number>;
  readonly pending: ReadonlySignal<number>;
  readonly ready: Promise<void>; // rejects with the first failure
}
```

Un exemple de bout en bout :

```ts
const resources = new ResourceStore();
resources.mount('http', new HttpSource({ base: '/' }), { default: true });
installAssets(resources, { backend: engine.backend! }); // textures, meshes, materials, models
installGltf(resources);
installObj(resources);

const scope = resources.scope('forest');
const oak = scope.load(ModelType, 'models/oak.glb');
const loading = resources.group([oak]);
// loading.progress drives the progress bar.

const model = await oak.ready;
const instance = instantiate(model, scene, {
  parent: forest,
  position: { x: 3, y: 0, z: 1 },
});

// Leaving the level:
instance.dispose();
scope.dispose();
```

### 6.4 Les sources et l'espace d'URI

- Une URI est `schéma:chemin`. `resources.mount('assets', source)` définit le schéma ; sans schéma, le défaut. Plusieurs sources sous un même schéma sont essayées par priorité : une archive de jeu sous des fichiers de correction, un dossier de développement sous le package de production.
- Les chemins relatifs d'un chargeur (`ctx.resolve('textures/a.png')`) se résolvent contre l'URI de la ressource : le glTF et ses textures, l'OBJ et son MTL, un MTL et ses images. Normalisation commune (`..`, séparateurs, casse laissée à la source).
- **HttpSource** (cœur, `fetch` existe dans les navigateurs et Node) : progression par lecture du flux, annulation par `AbortSignal`, `stat` par `ETag`.
- **MemorySource** : tests, ressources embarquées ; **DataUriSource**, montée sous `data`, pour les URI `data:` (les tampons et images base64 des `.gltf`).
- **Les octets des sous-ressources** : un chargeur fournit les octets d'une partie de son fichier par `ctx.provide(ResourceBytesType, 'image/0', bytes)`. `ctx.bytes()` d'une URI à fragment (`model.glb#image/0`) lit d'abord ces octets, sinon le fichier. Une image intégrée à un GLB se charge donc comme une autre (`TextureType`, `model.glb#image/0`), sans copie en `data:`.
- **ArchiveSource** (cœur) : enveloppe une autre source et un lecteur d'archive ; zip d'abord, par `DecompressionStream('deflate-raw')` pour éviter une dépendance (support à vérifier sur les navigateurs visés, sinon `fflate`). L'index est lu une fois, les entrées à la demande.
- **FileSource** : dans `-native` (`fs`, avec surveillance), et dans `-web` pour les `File` d'un `<input>` ou d'un glisser-déposer, utile à l'éditeur.

### 6.5 Le cycle d'un chargement

1. `load()` normalise l'URI, calcule la clé `(type, uri, cacheKey(options))` et **trouve ou crée l'entrée** ; la poignée rendue la compte. Deux appels, une seule lecture.
2. L'entrée passe de `pending` à `loading` quand la file la prend (priorité, puis ordre d'arrivée ; `concurrency` chargements en même temps ; une limite par source est possible plus tard).
3. Le chargeur est choisi par type (un type à un seul chargeur l'utilise toujours), puis par extension, puis par `sniff`, puis le chargeur générique du type (sans extension ni `sniff`) ; sinon `ResourceError('unsupported')`. À égalité, le dernier enregistré gagne.
4. Le chargeur lit (`ctx.bytes()`), décode, et charge ses dépendances par `ctx.use()`. Chaque `use` enregistre une arête de dépendance, et la progression du parent agrège celle des enfants (en octets quand les totaux sont connus, à parts égales sinon).
5. Il rend la valeur ; l'entrée passe à `ready`, `version` augmente, `ready` se résout.

**Annulation** : un `AbortSignal` par entrée, passé au chargeur. Il est déclenché quand la **dernière** poignée est libérée pendant le chargement (les autres demandeurs n'en pâtissent pas) ou quand `LoadOptions.signal` l'est. Les dépendances que personne d'autre ne demande s'annulent avec elle.

**Erreurs** : `ResourceError` avec un code (`not-found`, `decode`, `unsupported`, `aborted`, `dependency`, `io`), l'URI et le chemin de dépendances (`oak.glb → bark.png`). Un chargeur choisit sa tolérance : une texture manquante d'un glTF échoue le modèle (`onMissing: 'fail'`) ou le laisse avec une texture de remplacement (`'placeholder'`, une damier magenta, par défaut en développement).

**Cycles** : `use` d'une ressource qui dépend déjà de l'appelante est refusé avec le chemin du cycle.

### 6.6 Le cache et les durées de vie

- Une entrée vit tant qu'elle a des poignées **ou des dépendants**. Une dépendance est une poignée détenue par l'entrée parente : un `Material` garde donc ses `Texture` en vie, sans règle spéciale.
- À zéro référence, l'entrée passe en **inactivité** : sa valeur reste (recharger un modèle qu'on vient de quitter est instantané) et elle est libérée, la moins récemment utilisée d'abord, quand `budget` est dépassé ou à `trim()`. `loader.sizeOf` mesure l'occupation ; les ressources GPU la déclarent en octets de texture ou de buffer.
- La libération appelle `loader.dispose(value)` : c'est là que les `GpuTexture` sont détruites. Le `Renderer` doit pouvoir libérer les buffers d'un `Mesh` (§7).
- **`FinalizationRegistry` n'est qu'un filet** pour les poignées oubliées (avertissement en développement) ; jamais le mécanisme.
- Les **scopes** servent aux durées de vie de haut niveau : un niveau, un modèle instancié. `scope.dispose()` libère toutes ses poignées.

### 6.7 Le rechargement à chaud

- `store.watch(true)` demande à chaque source de surveiller les chemins des entrées chargées (`source.watch`) : `-web` écoute le serveur de développement (Vite le sait déjà : un point d'entrée WebSocket ou `import.meta.hot`), `-native` utilise `fs.watch`. Une rafale d'événements est regroupée (un changement d'éditeur en produit souvent plusieurs).
- Le changement relance le chargeur ; **l'ancienne valeur reste utilisée** jusqu'à ce que la nouvelle soit complète et valide. En cas d'échec, l'ancienne reste et l'erreur est publiée (`handle.error`), sans écran cassé.
- Le remplacement se fait **entre deux frames**, dans `store.update()` (appelé par l'ordonnanceur de P4, `engine-scene/systems/Scheduler`), jamais pendant un rendu.
- Deux façons d'appliquer, au choix du chargeur :
  - **en place** quand `update(current, next)` sait faire : un `Mesh` reçoit les nouveaux sommets (`Mesh.setVertices` incrémente déjà sa version, et le `Renderer` rebascule) ; un `Material` reçoit `setValue`. Les nœuds de la scène, qui tiennent ces objets, voient le changement sans rien faire. La `Texture` est toujours remplacée : réécrire la `GpuTexture` demanderait de garder les pixels de la nouvelle valeur, et le matériau qui en dépend, mis à jour en place avec la nouvelle, donne le même effet aux nœuds ;
  - **par remplacement** sinon : `handle.value` change, `version` augmente, les dépendants sont **invalidés** transitivement et se réalisent à nouveau (un `Material` dont la texture a changé de dimensions rebind la nouvelle).
- Un modèle rechargé dont la **hiérarchie** change ne modifie pas les `ModelInstance` existantes (on ne devine pas ce que l'application a fait des nœuds). Les meshes et matériaux mis à jour en place sont vus par les instances ; un `Model` remplacé ne l'est pas. `ModelInstance.rebuild()` recrée les nœuds depuis le `Model` courant ; le suivi automatique (`follow`) est laissé à l'éditeur (P13), qui sait ce que l'utilisateur a modifié.
- **Le `Material` en place** : seulement quand le graphe généré est le même (mêmes caractéristiques, §6.11) ; ses valeurs sont alors réécrites par `setValue`. Un graphe différent (une texture ajoutée) donne un nouveau `Material` par remplacement : `Material.graph` est `readonly`, et c'est voulu (le programme en dépend).
- Les sous-ressources ont des identifiants stables (`#mesh/2`, `#material/Bark`) pour que la mise à jour retrouve ses objets.

### 6.8 Intégration au moteur

- **Un store par moteur.** Il est créé avec l'application et reçoit le backend comme service quand le moteur est prêt (`resources.provideService(RenderBackendService, engine.backend)`). Le service est observé : au changement de backend (le bouton WebGPU/WebGL2 de la démo, ou une perte de device), les entrées qui en dépendent sont **réalisées à nouveau depuis leurs données CPU**, sans relecture.
- **Les réalisations** (dans `engine-assets`) sont des chargeurs comme les autres, dont la dépendance est le niveau de données :

  | Données (CPU, sans backend)                               | Réalisation (dépend du service `RenderBackend`)                                |
  | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
  | `ImageAsset` (`image`)                                    | `Texture` : `GpuTexture` + `GpuSampler` (option `colorSpace`, `mips`, sampler) |
  | `MeshData` (tampons typés, description)                   | `Mesh` (la classe d'`engine-core`, qui s'envoie au GPU au premier dessin)      |
  | `MaterialData` (PBR, Phong, graph)                        | `Material` : graphe + valeurs (les `Texture` en dépendances)                   |
  | `ModelData` (nœuds, meshes, matériaux, peaux, animations) | `Model` : les `Mesh` et `Material` réalisés, la hiérarchie                     |

  Les chargeurs de formats ne produisent que le niveau de données ; `ImageAsset` peut garder un `ImageBitmap` (envoi direct par `createTexture({ source })`) ou des octets.

- **Le GPU et la mémoire CPU** : une politique par type, `keepCpuData: 'always' | 'never'` (défaut `'never'` pour les images une fois envoyées, `'always'` pour les meshes, déjà tenus par `Mesh`). Quand `'never'`, un changement de backend relit la source (la plupart du temps depuis le cache HTTP) : c'est le prix de la mémoire économisée.

  La mise en œuvre pour les images : une dépendance (`ctx.use`) garde sa cible en vie aussi longtemps que le parent, donc une `Texture` qui `use` son `ImageAsset` le garderait toujours. Avec `'never'`, la `Texture` **décode elle-même** les octets de son URI (par les mêmes codecs, §6.9) et ne garde rien ; avec `'always'`, elle `use` l'`ImageAsset` de la même URI, partagé entre ses réalisations (sRGB et linéaire). Dans les deux cas l'entrée de la `Texture` a l'URI de l'image : elle est surveillée et rechargée directement.

- **Les clés de services** d'`engine-assets` : `RenderBackendService` (le `RenderBackend`), `ImageCodecsService` (les codecs d'images, §6.9) et `AssetsConfigService` (`keepCpuData`, la texture de remplacement).
- **`instantiate(model, scene, options)`** (dans `engine-assets`) crée les nœuds avec `scene.create(parent, { name, position, rotation, scale })` puis `node.setMesh(mesh, material)` pour chaque primitive, et rend une `ModelInstance { root, entities, dispose() }`. Les nœuds qui partagent un `Mesh` et un `Material` (un glTF qui les référence plusieurs fois, ou dix instances du même arbre) sont **dessinés en un appel** par l'instancing de P1, sans rien de plus. La `ModelInstance` détient une poignée vers le `Model` (donc la mémoire GPU reste) et la libère à `dispose()`.
- **L'ordonnanceur** : un système `ResourceSystem` appelle `store.update(budgetMs)` une fois par frame, au début, pour appliquer les remplacements et les envois GPU en attente sans dépasser un budget (quelques ms) : pas de saccade à l'arrivée d'une grosse texture.
- **Les sons (P7)** : `AudioClipType` et un chargeur par plateforme (`decodeAudioData` sur le web ; décodage natif en `-native`). Le système n'a rien à changer.

### 6.9 Les images

- **`ImageAsset`** : `{ type: '2d' | 'cube' | '2d-array' | '3d', width, height, format, levels }`. `format` est un format de texture du backend (`rgba8unorm`, `rgba16float`, puis les formats compressés de §7) ; `levels` sont les octets (niveau par niveau, face par face) ou un `ImageBitmap` pour un niveau 0 sur le web.
- **Le décodage** est une interface `ImageDecoder` avec deux implémentations derrière une suite de tests commune (des images de référence) :
  - `-web` : `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`. Sans ces options, le navigateur convertit les couleurs et préinterprète l'alpha : une carte de normales serait faussée. Il tourne aussi dans un Worker ;
  - `-native` : `stb_image` dans l'addon `engine-native`. L'addon est en C sur Node-API (pas `node-addon-api`) : le décodage passe par `napi_create_async_work`, sur le pool de libuv, pour ne pas bloquer la boucle ; PNG, JPEG, TGA, BMP, GIF (première image), **HDR** (utile à l'IBL de P2). WebP et AVIF restent au navigateur dans un premier temps. Le HDR est rendu en `float32` et converti en `rgba16float` (filtrable partout, contrairement à `rgba32float`).
- **Les codecs** : `engine-assets` ne connaît pas les décodeurs de plateforme. Il définit `ImageCodec { name, extensions?, sniff?(head), decode(bytes, { signal, uri }): Promise<ImageAsset> }` et un registre (le service `ImageCodecsService`), choisi par `sniff` puis par extension. Les adaptateurs `bitmapCodec(decoder)` (web) et `pixelCodec(decoder)` (natif) enveloppent les décodeurs des paquets de plateforme ; `engine-ktx2` ajoute le sien. Le chargeur d'`ImageAsset` et la `Texture` (§6.8) passent par ce registre.
- **L'espace colorimétrique n'est pas une propriété du fichier mais de l'usage** : la couleur de base d'un matériau est sRGB, une carte de normales est linéaire. Comme `loadTexture(…, colorSpace)` de la démo, c'est donc une option de la **réalisation** (`Texture`), qui choisit `rgba8unorm-srgb` ou `rgba8unorm` ; le même `ImageAsset` sert aux deux.
- **Les mips** : `mips: 'generate' | 'none' | 'file'` (défaut `'generate'` quand le format le permet : `canGenerateMipmaps`), avec `mipLevelCount: fullMipLevelCount(dimensions)` et la passe de génération existante. `'file'` écrit ceux du fichier (KTX2). L'anisotropie vient du `GpuSampler`.
- **Les textures compressées** : KTX2 (conteneur, supercompression zstd/BasisLZ) puis Basis Universal. Le transcodeur (WASM, chargé à la demande) choisit le format cible selon la capacité du backend (`compressedFormats`, §7) : BC7 sur le bureau, ASTC sur mobile, ETC2, repli en `rgba8unorm`. Le choix est fait à la réalisation, donc propre à chaque backend.

  Conséquence sur les données : un KTX2 Basis n'est **pas** transcodé dans le codec (il ignore le backend) ; son `ImageAsset` garde les données universelles (`format: 'universal'`, les octets du fichier, et une fonction `transcode(formats)`), et la `Texture` les transcode vers un format du backend. Un KTX2 déjà dans un format GPU (BC7…) passe tel quel si le backend le prend, sinon échoue avec `unsupported` (la décompression logicielle n'est pas prévue). Le transcodeur et le décodeur zstd sont fournis par l'application (`installKtx2(registry, { transcoder, zstd })`, sur le registre de codecs que rend `installAssets`).

### 6.10 Les formats de sommets et le partage de meshes

- **Sémantiques** : une convention de nommage pour les jeux multiples, `uv`, `uv1`, `uv2`…, `color`, `color1`, `joints`, `joints1`, `weights`, `weights1`, `tangent` (le type `MeshAttributeSemantic` accepte déjà les chaînes libres : `(string & {})`). Les graphes lisent `g.attribute('uv1', BuiltinTypes.vec2f)` ; une texture glTF qui a `texCoord: 1` échantillonne `uv1`.
- **Les formats glTF → formats de sommets** : float32 tels quels ; entiers normalisés (`KHR_mesh_quantization`) vers `snorm16x2/x4`, `unorm8x4`, `unorm16x2/x4`… WebGPU n'a **pas** de formats à 3 composantes de 8 ou 16 bits : ces attributs sont complétés à 4 composantes (une copie, une fois). Les indices `uint8` sont convertis en `uint16` (WebGPU n'a pas d'index 8 bits). Les accessors _sparse_ sont développés au chargement.
- **Les tangentes** : lues si `TANGENT` existe ; sinon, si le matériau a une carte de normales, `computeTangents(mesh)` (option `tangents: 'missing' | 'always' | 'never'`, défaut `'missing'`). Sans tangentes, les macros de P2b calculent déjà un repère par les dérivées d'écran.
- **Les couleurs** (`COLOR_n`) multiplient la couleur de base ; elles sont ajoutées au graphe seulement si la primitive en a.
- **Le partage de meshes** va en deux temps :
  1. _Entre nœuds_ : un seul `Mesh` et un seul `Material` pour plusieurs nœuds. C'est le cas de `instantiate`, qui profite de l'instancing de P1. Rien à ajouter au moteur.
  2. _Entre meshes_ : les primitives d'un glTF partagent souvent un même tampon de sommets, avec des plages d'indices différentes. Le `Mesh` d'aujourd'hui possède ses tampons. On propose une **plage de dessin** (`firstIndex`, `indexCount`, `baseVertex`) et des tampons de sommets partageables entre `Mesh` (un `MeshBuffers` compté), pour n'envoyer qu'une fois au GPU. C'est une extension du `Mesh` et du `Renderer` ; elle peut venir après la première version de glTF (qui crée un `Mesh` par primitive).

### 6.11 glTF 2.0

Le chargeur lit `.gltf` (JSON et ressources externes) et `.glb`, et rend un `ModelData` :

- **Tampons** : `ctx.use(BufferType, …)` pour les fichiers externes (dépendances, donc partagées et annulables), le BIN du GLB sinon. Les `bufferView` entrelacées se mappent directement sur `MeshBufferDescription { stride, attributes }`, sans copie quand les formats vont.
- **Meshes** : un `MeshData` par primitive (le matériau est par primitive). Le `Renderer` crée tous ses pipelines en `triangle-list` (vérifié) : les bandes et éventails de triangles (modes 5 et 6) sont convertis en listes au chargement ; lignes et points (modes 0 à 3) sont ignorés avec un avertissement, jusqu'à ce que la topologie entre dans `MeshDescription`.
- **Hiérarchie** : nœuds (TRS ou matrice, décomposée), enfants, références aux meshes, peaux, caméras ; `KHR_lights_punctual` vers les lumières du moteur.
- **Peaux et animations** : lues dans `ModelData` comme des données (`SkinData` : joints, matrices inverses de bind ; `AnimationClipData` : canaux, temps, valeurs, interpolation `LINEAR`/`STEP`/`CUBICSPLINE`) ; P6 les utilise, rien ne les joue en P5. Elles sont définies dans `engine-assets` avec `ModelData`, pas dans glTF, pour que P6 ne dépende pas du format.
- **Matériaux** : le chargeur ne crée **aucun graphe**. Il remplit un `PbrMaterialData` neutre :

  ```ts
  export interface PbrMaterialData {
    readonly kind: 'pbr';
    readonly baseColor: [number, number, number, number];
    readonly baseColorTexture?: TextureRef;
    readonly metallic: number;
    readonly roughness: number;
    readonly metallicRoughnessTexture?: TextureRef; // roughness in g, metallic in b
    readonly normalTexture?: TextureRef & { scale: number };
    readonly occlusionTexture?: TextureRef & { strength: number };
    readonly emissive: [number, number, number];
    readonly emissiveTexture?: TextureRef;
    readonly alphaMode: 'opaque' | 'mask' | 'blend';
    readonly alphaCutoff: number;
    readonly doubleSided: boolean;
    readonly unlit?: boolean; // KHR_materials_unlit
  }
  export interface TextureRef {
    // Serializable: `textures/bark.png`, or `model.glb#image/0` for an
    // embedded image (its bytes are a sub-resource, §6.4).
    readonly image: ResourceUri;
    readonly texCoord: number; // 0 → 'uv', 1 → 'uv1'…
    readonly sampler: GpuSamplerConfiguration;
    readonly transform?: UvTransform; // KHR_texture_transform
  }
  ```

  La **réalisation** `PbrMaterialData → Material` (dans `engine-assets`) construit le graphe :

  - Un graphe est généré **par jeu de caractéristiques**, pas par matériau : quelles textures sont présentes, quels `texCoord`, couleurs de sommets, `unlit`. Les facteurs (`baseColor`, `metallic`, `roughness`, `emissive`, `scale`, `strength`, `alphaCutoff`) sont des **uniforms** (`g.uniform(name, type, { default })`) fixés par `Material.values`. Comme « changer une valeur ne recompile jamais le shader », tous les matériaux d'un modèle ayant les mêmes caractéristiques partagent un programme et un pipeline.
  - `shadingModel: 'pbr'` avec les ports `baseColor`, `alpha`, `metallic`, `roughness`, `normal`, `occlusion`, `emissive` (déjà ceux de `lighting.ts`) ; `normalTexture` utilise `macro.normalMapping`.
  - `alphaMode` et `doubleSided` correspondent un pour un au `renderState` de `Material` ; `alphaCutoff` à l'uniform `alphaCutoff` des matériaux `mask`.
  - Les samplers : `GpuSamplerConfiguration` (`wrapModeS/T`, `minFilter`, `magFilter`, `mipmapFilter`) est mémoïsé par configuration.

- **Extensions** : un registre `GltfExtension` pour que chacune soit un module : d'abord `KHR_materials_unlit`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_mesh_quantization`, `KHR_texture_basisu` (images KTX2) ; ensuite `KHR_draco_mesh_compression` et `EXT_meshopt_compression`, dont les décodeurs (WASM) sont passés par l'application (`installGltf(store, { meshopt: MeshoptDecoder, draco })`) : le moteur ne les embarque pas. Une extension requise et inconnue fait échouer le chargement avec son nom ; une extension optionnelle inconnue est ignorée avec un avertissement.

### 6.12 L'importeur OBJ

L'importeur de la démo devient `engine-obj`, un chargeur parmi d'autres de `ModelDataType` (extension `obj`). Il remplace `@thi.ng/geom-io-obj` par un analyseur de quelques dizaines de lignes qui écrit directement dans des tableaux typés (plus de `number[]` ni de `[...v]` par sommet) et ne produit plus de `Mesh` : un nœud par objet ou groupe, un `MeshData` par groupe de matériau. Le MTL est une dépendance (`mtllib`, résolu par `ctx.resolve`) qui rend des `PhongMaterialData`, réalisés par le graphe Phong d'`engine-assets` (cartes diffuse, spéculaire, de brillance `map_Ns`, émissive, de normales `norm`). `utils3d/obj-importer.ts`, `mtl-parser.ts` et `meshFromObj` sortent de la démo, qui appelle `scope.load(ModelType, '/sphere.obj')`.

### 6.13 Autres types

Tout type s'ajoute par `defineResourceType` et un chargeur : `AudioClipType`, un type JSON (`json`, des paramètres de niveau), les **graphes de matériaux sérialisés** (le `MaterialGraphData` du `engine-shader` est déjà sérialisable, donc rechargeable à chaud), les programmes de shader, plus tard les graphes d'animation (P6) et de comportement (P9).

## 7. Extensions de l'API abstraite

1. **Textures compressées** (`engine-backend`, les quatre backends, plus lavapipe/Dawn pour les tests) :
   - `GpuTextureFormatNames` reçoit les formats compressés (BC1–BC7, ETC2, ASTC) ;
   - `BackendCapabilities.compressedFormats?: readonly GpuTextureFormat[]` : sur WebGPU les fonctionnalités `texture-compression-bc`, `-etc2`, `-astc` ; sur WebGL2 les extensions `WEBGL_compressed_texture_s3tc`, `_etc`, `_astc` ; sur Vulkan les `VkFormatFeatureFlags` du device. Le chargeur choisit parmi ce que le backend a déclaré ;
   - `canGenerateMipmaps` renvoie `false` pour ces formats (c'est déjà le cas du motif `int$|^depth`, à étendre) : leurs niveaux viennent du fichier.
2. **Écrire un niveau** : `writeTexture(texture, data, { level?, layer?, region? })`, ou `createTexture({ …, levels })`, pour les mips précalculés et les cubemaps. Aujourd'hui le premier niveau seul est écrit et les autres sont calculés (`generateMipmaps`).
3. **Libérer un `Mesh`** : `Renderer.releaseMesh(mesh)`, qui détruit ses `GpuBuffer` (le `WeakMap` `_meshes` ne suffit pas : non déterministe, et sur Vulkan une fuite). **Décision** : un événement du `Mesh`, pas un service. `Mesh.destroy()` prévient ses écouteurs (`mesh.onDestroy(listener)`, qui rend la fonction de désabonnement) ; chaque `Renderer` qui a envoyé le mesh s'y abonne et libère ses buffers. Le store n'a pas à connaître les renderers, et un mesh dessiné par deux renderers (la démo et une vignette) est libéré des deux. `loader.dispose` du type `Mesh` appelle `mesh.destroy()` ; dessiner un mesh détruit est une erreur.
4. **Plages de dessin et tampons partagés** du `Mesh` (§6.10, étape 2), après la première version.
5. **Sémantiques** : documentation de la convention `uvN`, `colorN`, `jointsN`, `weightsN` ; rien à changer dans les types.

## 8. Plan d'implémentation

Chaque étape se teste et se fusionne seule.

| Étape                               | Contenu                                                                                                                                                           | Vérifiable par                                                              | État                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **R1** Le cœur                      | `engine-resources` : types, `ResourceStore`, entrées, poignées, scopes, comptage, cache en inactivité, `MemorySource`, `HttpSource`, enregistrement des chargeurs | Tests unitaires : partage, comptage, libération, budget                     | Fait                                                                                                                                 |
| **R2** Le cycle                     | File et priorités, annulation, progression agrégée, `LoadGroup`, dépendances (`use`), cycles, erreurs                                                             | Tests : annulation à la dernière poignée, progression, cycle                | Fait                                                                                                                                 |
| **R3** Les images                   | `ImageAsset`, `Texture`, décodage web (`-web`), refonte de `loadTexture` de la démo ; puis le décodage natif (stb, addon)                                         | Suite de rendu : une même image sur les trois backends                      | Fait ; décodeurs testés à part (jsdom, addon réel), pas de cas image dans la suite de rendu                                          |
| **R4** Meshes et formats de sommets | Convention des sémantiques, `MeshData`/`Mesh`, `releaseMesh`, `ModelData`/`Model`/`instantiate`, `engine-obj` (l'importeur de la démo migre)                      | La démo `loading-model` sur le store ; tests de l'importeur sans GPU        | Fait                                                                                                                                 |
| **R5** glTF                         | JSON/GLB, tampons, meshes, `PbrMaterialData` → `Material`, hiérarchie, `instantiate` ; peaux et animations lues ; extensions de base                              | Modèles d'échantillon de Khronos comparés à des références (suite de rendu) | Fait ; testé sans GPU, dont `BoxTextured` de Khronos                                                                                 |
| **R6** Textures compressées         | Extension du backend (§7.1, 7.2) sur les quatre backends, `engine-ktx2`, transcodage Basis                                                                        | Test de la suite de rendu par backend, repli en `rgba8`                     | Fait ; Basis et zstd par des décodeurs fournis, testés avec des doublures                                                            |
| **R7** Sources et rechargement      | `FileSource`, `ArchiveSource`, montage en couches, `watch`, mise à jour en place (`Mesh`, `Material`)                                                             | Tests avec une source de test qui émet des changements                      | Fait                                                                                                                                 |
| **R8** Hors thread, démo, doc       | Pool de Workers (décodage, Draco, meshopt), la forêt avec des modèles, la page « Charger des modèles » (EN/FR), mise à jour de `loading-model`                    | Captures de la doc comparées à des références                               | Fait : pools web et natif, guide « Ressources », tutoriels « Charger des modèles » et « Ressources et rechargement à chaud » (EN/FR) |

Les étapes R1 à R5 couvrent le sens du mot « modèles chargés dans les démos » ; R6 à R8 peuvent se réordonner selon les besoins de la forêt.

## 9. Stratégie de test

- **Sans GPU** : les formats et le cœur (`MemorySource`, un chargeur de test, le `fakeBackend` d'`engine-core/testing` pour les réalisations) : comptage, annulation, dépendances, rechargement, libération de la mémoire.
- **Rendu** : la suite partagée (`tests/rendering`) ajoute un modèle glTF et une image par cas, sur Dawn, WebGL2 et Vulkan : même rendu, quel que soit le chemin de chargement. Les modèles d'échantillon de Khronos (licences à vérifier modèle par modèle) servent de jeu de référence, en copiant les petits modèles dans `tests/`.
- **Décodeurs** : le même jeu d'images (une par format et par profondeur, avec alpha, avec profil de couleur) passe par le décodeur web (Chromium headless) et natif ; mêmes octets attendus.
- **Fuites** : un test qui charge, instancie, libère, puis vérifie que le backend de test n'a plus de texture ni de buffer vivants.
- **Benchmarks** (P0) : le chargement d'un gros OBJ ou glTF, avant et après le passage aux tableaux typés.

## 10. Risques et décisions ouvertes

**Décisions prises** (les options recommandées)

1. **Découpage en paquets** : cœur séparé (`engine-resources`) avec paquets de plateforme.
2. **Mémoire CPU après l'envoi GPU** : `'never'` par défaut pour les images, `'always'` à choisir dans l'éditeur (`installAssets(store, { keepCpuData: 'always' })`). La mise en œuvre est au §6.8.
3. **Décodage natif** : `stb_image` dans l'addon.
4. **Libération explicite** : poignées comptées avec `release()`, et scopes.
5. **Partage de meshes** : un `Mesh` par primitive pour la première version de glTF ; les plages de dessin (§7.4) viendront après.

**Vérifié dans le code**

- La **topologie** : le `Renderer` crée ses pipelines en `triangle-list`, en dur. Voir §6.11 pour les modes de glTF.
- `DecompressionStream('deflate-raw')` : dans les navigateurs actuels et Node ≥ 18 ; `ZipReader` accepte une fonction `inflate` (fflate) pour les autres.
- Le **rechargement du `Material`** quand un graphe change : par remplacement (§6.7).
- La **perte de device** WebGPU : même mécanique que le changement de backend, `provideService(RenderBackendService, nouveau)`, le jour où le moteur la détecte (hors P5).

**Risques**

- _Le transcodeur Basis_ est une dépendance WASM lourde ; il se charge à la demande et reste hors du chemin des images ordinaires.
- _Le rechargement en place_ promet beaucoup : chaque chargeur doit déclarer ce qu'il sait mettre à jour. Le défaut sûr est le remplacement.
- _Les identifiants de sous-ressources_ deviennent une API stable : `#mesh/2` (index) casse si le modèle change de contenu ; le nom (`#mesh/Body`) est plus stable, l'index sert de repli.
- _Les GUID_ (renommer un fichier sans casser une scène) ne sont pas prévus : l'éditeur (P13) ajoutera un catalogue au-dessus des URI.
