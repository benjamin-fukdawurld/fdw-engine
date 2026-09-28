# Audit du code — FdwEngine

_Audit initial : 26/09/2026. Mise à jour : 28/09/2026, après une première passe de correction (non commitée, 27 fichiers modifiés)._
_Périmètre : `packages/engine-backend`, `packages/engine-core`, `packages/engine-webgpu`, `apps/demo`, outillage (≈ 11 000 lignes)._

**Légende des statuts :**

| Statut | Signification |
|---|---|
| 🟢 Corrigé | Correction vérifiée dans le code |
| 🟡 Partiel | Correction commencée mais incomplète, ou qui déplace le problème |
| 🔴 À faire | Pas encore traité |
| 🆕 Nouveau | Problème introduit par la passe de correction |

Les points marqués « (vérifié) » ont été confirmés par relecture ciblée ou par exécution. Les autres viennent de la lecture du code.

---

## Sommaire

0. [Bilan de la passe de correction du 28/09](#0--bilan-de-la-passe-de-correction-du-2809)
1. [Compilation](#1--compilation)
2. [Bugs critiques de rendu](#2--bugs-critiques-de-rendu)
3. [Architecture : écarts avec la vision multi-backend](#3--architecture--écarts-avec-la-vision-multi-backend)
4. [engine-backend](#4--engine-backend)
5. [engine-core](#5--engine-core)
6. [engine-webgpu](#6--engine-webgpu)
7. [Application demo](#7--application-demo)
8. [Outillage et hygiène du dépôt](#8--outillage-et-hygiène-du-dépôt)
9. [Plan de correction mis à jour](#9--plan-de-correction-mis-à-jour)

---

## 0. Bilan de la passe de correction du 28/09

**Ce qui a bien avancé :** les trois packages **compilent maintenant sans erreur** (vérifié avec `tsc -b`). Cinq des dix bugs critiques de rendu sont corrigés, et `wgpu-matrix` a disparu de l'API abstraite.

**Ce qui pose problème :**

- 🆕 **4 problèmes introduits par la passe** (détails en §0.1) :
  - le calcul du padding des buffers est faux ;
  - les textures chargées depuis un tableau typé lèvent désormais une exception ;
  - la suppression de `Material` casse la démo ;
  - le type `source` des textures est devenu `unknown`.
- 🔴 **La démo et l'outillage n'ont pas été touchés** : aucune modification dans `apps/`, `package.json`, `nx.json` ni `.gitignore`.
- 🔴 La plupart des points majeurs et mineurs des packages restent ouverts.

### 0.1 Nouveaux problèmes introduits

| # | Emplacement | Problème | Correction proposée |
|---|---|---|---|
| N1 | `engine-webgpu/src/gpu/BufferFactory.ts:116` | `size + (size % 4)` ne donne pas un multiple de 4 : 5 → 6, 7 → 10, 9 → 10 (vérifié). En plus, la branche `writeBuffer` (utilisée quand le buffer a `copy-dst` et n'est pas `static`, ce qui est **le cas de la démo**) n'est pas complétée du tout. Enfin, `Buffer.size` renvoie maintenant la taille arrondie, pas la taille demandée. | `const paddedSize = Math.ceil(size / 4) * 4;` ; dans la branche `writeBuffer`, copier les données dans un `Uint8Array(paddedSize)` avant l'écriture. |
| N2 | `engine-webgpu/src/gpu/TextureFactory.ts:54` | `source instanceof ArrayBuffer` rejette les `Uint8Array` et les autres `ArrayBufferView`, alors que le contrat annonce justement `ArrayBufferView`. Toute texture chargée depuis un tableau typé lève maintenant « Unsupported source type ». | `else if (ArrayBuffer.isView(source) \|\| source instanceof ArrayBuffer)`. |
| N3 | `engine-backend/src/gpu/GpuTexture.ts:68` et `TextureFactory.ts:23` | `ArrayBufferView<ArrayBuffer> \| unknown` se réduit à `unknown` : le type n'apporte plus aucune vérification. | Rendre la factory générique sur la source externe : `GpuTextureFactory<TExternalSource = never>`, avec `source?: ArrayBufferView \| TExternalSource`. Le backend WebGPU déclare alors `GpuTextureFactory<ImageBitmap>`. Le DOM reste hors de l'API abstraite et le typage est préservé. |
| N4 | `engine-backend/src/material/Material.ts` (supprimé), `material/index.ts:3` | La classe est supprimée et son export est laissé en commentaire. `apps/demo/src/utils3d/RenderPipeline.ts:4` importe toujours `Material` depuis `@fdw/engine-backend`, d'où l'erreur TS2305 (vérifié). | Choisir : soit restaurer `Material` en corrigeant le constructeur (et `isStructural`, voir §4), soit supprimer la ligne commentée et faire pointer la démo vers `./Material`. Pour la vision frontend / backend, le Material a plutôt sa place dans engine-core. |
| N5 | `engine-backend/tsconfig.lib.json:5` | `vite/client` a été ajouté aux `types` d'engine-backend, qui ne contient aucun import `?raw`. Ça attache inutilement l'API abstraite aux types de Vite. | Retirer `vite/client` de ce tsconfig ; le garder uniquement dans celui d'engine-webgpu. |

### 0.2 Tableau de suivi

| Réf. | Point | Statut |
|---|---|---|
| §1 | Erreurs de compilation d'engine-backend (`Material`, `Mat4`, types `GPU*`) | 🟢 |
| §1 | Déclaration des imports `?raw` | 🟢 (option 1, via `vite/client`) |
| §1 | Formats de vertex absents de `@webgpu/types` | 🟢 (cases retirés ; cohérent avec la liste d'engine-backend) |
| §1 | Erreurs restantes dans la démo | 🔴 (6 erreurs) |
| §2.1 | Writer mat3 | 🟢 |
| §2.2 | Normal matrix | 🟢 |
| §2.3 | View-projection | 🟢 |
| §2.4 | `SpotLight` | 🟢 |
| §2.5 | `RENDER_ATTACHMENT` pour `ImageBitmap` | 🟢 (mais voir N2) |
| §2.6 | Taille des structs arrondie | 🟡 (arrondie dans le builder ; tableaux uniform et `hasDynamicSize` toujours ouverts, §6) |
| §2.7 | `bool` en uniform | 🟢 |
| §2.8 | Padding des buffers à 4 octets | 🆕 (N1) |
| §2.9 | Indices uint16 dans la démo | 🔴 |
| §2.10 | `CachedValue` sans `try/finally` | 🔴 |
| §3.1 | `wgpu-matrix` dans engine-backend | 🟢 |
| §3.1 | Types `GPU*` dans engine-backend | 🟢 |
| §3.1 | `ImageBitmap` dans engine-backend | 🟡 (retiré, mais remplacé par `unknown`, voir N3) |
| §3.1 | `EventTarget`, clip-space, `GpuSerializer`, format mat3 | 🔴 |
| §3.2 | Dépendance d'engine-webgpu vers engine-core | 🟡 (plus importée ; toujours dans `package.json:6` et `tsconfig.lib.json:11`) |
| §3.2 | Dépendances non déclarées | 🔴 |
| §3.3 – 3.4 | La démo contourne le frontend, API abstraite incomplète | 🔴 |
| §4 – §8 | Points majeurs et mineurs | voir chaque section |

---

## 1. Compilation

🟢 **Les trois packages compilent** (`tsc -b` vérifié le 28/09). Les corrections :

- `Material.ts` supprimé, l'import de `Mat4` corrigé, les types `_` en doublon supprimés de `types.ts` ;
- `vite/client` ajouté pour les imports `?raw` ;
- l'import inutilisé de `StructBuilder` supprimé.

🔴 **La démo a encore 6 erreurs** (vérifié) :

| Fichier | Erreur |
|---|---|
| `apps/demo/src/utils3d/RenderPipeline.ts:4` | 🆕 `Material` n'est plus exporté par `@fdw/engine-backend` (voir N4) |
| `apps/demo/src/routes/index.tsx:13` | `onSurfaceReady` renvoie `void` au lieu de `Promise<void>` |
| `apps/demo/src/components/Header.tsx:5` | Variable `engine` inutilisée |
| `apps/demo/src/main.tsx:1` | Import `StrictMode` inutilisé |
| `apps/demo/src/routes/depth-testing/route.tsx:98` | `setRotation` inutilisé |
| `apps/demo/src/routes/index-buffer/route.tsx:98` | `setRotation` inutilisé |

🟡 **Imports `?raw`** : le typecheck passe, mais le JavaScript produit par `tsc` contient toujours `import … from '….eta?raw'`, et les fichiers `.eta` ne sont pas copiés dans `dist/`. Le package ne fonctionne donc qu'à travers Vite. À traiter avant de publier les packages ou d'attaquer un backend natif : build en library mode Vite, ou templates convertis en modules `.ts`.

🔴 `packages/engine-webgpu/src/gpu/TextureFactory.ts:55` : l'erreur de type sur `ArrayBufferView<ArrayBufferLike>` a disparu, mais seulement parce que la branche a été modifiée, ce qui a introduit N2.

---

## 2. Bugs critiques de rendu

| # | Emplacement | Problème | Statut |
|---|---|---|---|
| 1 | `engine-webgpu/src/gpu/writers.ts:146` | Le writer mat3 lisait `column*3+row` alors que wgpu-matrix stocke une mat3 sur 12 floats. | 🟢 `column*4+row` |
| 2 | `engine-backend/src/math/TransformMath.ts:35` | Normal matrix = `inverse(M)` au lieu de `transpose(inverse(M))`. | 🟢 |
| 3 | `engine-backend/src/camera/CameraAdapter.ts:99-103` | `viewProjectionMatrixBuffer` contenait la matrice de vue seule. | 🟢 dépend maintenant de `cameraCache.viewProjectionMatrix` |
| 4 | `engine-core/src/light/SpotLight.ts:12` | Buffer trop court : `new SpotLight()` levait toujours une exception. | 🟢 92 octets |
| 5 | `engine-webgpu/src/gpu/TextureFactory.ts:37-42` | Usage `RENDER_ATTACHMENT` manquant pour `copyExternalImageToTexture`. | 🟢 (mais voir N2) |
| 6 | `engine-backend/src/gpu/structs.ts:53` | Taille des structs non arrondie à l'alignement. | 🟡 corrigé dans `build()`. Toujours ouverts : stride des tableaux uniform et `hasDynamicSize` (§6) |
| 7 | `engine-webgpu/src/gpu/serializers.ts:8-14` | Le type WGSL `bool` est interdit dans les uniforms. | 🟢 sérialisé en `u32`, cohérent avec le writer |
| 8 | `engine-webgpu/src/gpu/BufferFactory.ts:116` | Ni la taille ni les données n'étaient complétées à un multiple de 4 octets. | 🆕 formule fausse et branche `writeBuffer` non traitée (N1) |
| 9 | `apps/demo/src/utils3d/Mesh.ts:23`, `Scene.ts:326` | Indices `Uint16` alors que Mustang.obj dépasse 65 535 sommets par objet (vérifié). | 🔴 |
| 10 | `engine-backend/src/utils/CachedValue.ts:59-63` | `_updating` n'est pas remis à `false` si `updateStrategy` lève une exception : chaque accès suivant lève « Circular dependency detected ». | 🔴 il faut un `try/finally` |

---

## 3. Architecture : écarts avec la vision multi-backend

### 3.1 Code spécifique à une plateforme dans l'API abstraite

- 🟢 `wgpu-matrix` n'est plus importé dans engine-backend. Les `identity()` de `TransformCache` passent maintenant par `transformMath.primitiveApis`.
- 🟢 Les types `GPUVertexFormat`, `GPUIndexFormat` et `GPUVertexStepMode` ont été supprimés.
- 🟡 `ImageBitmap` a été retiré de `GpuTexture.ts`, mais remplacé par `unknown` (N3).
- 🆕 `vite/client` a été ajouté aux types d'engine-backend (N5).
- 🔴 `Engine extends EventTarget` (`Engine.ts:13`) suppose un environnement DOM ou Node.
- 🔴 Les conventions de clip-space sont implicitement celles de WebGPU, via `perspective` et `ortho`. Vulkan inverse l'axe Y et OpenGL utilise une profondeur de -1 à 1.
- 🔴 `GpuSerializer.serialize(): string` génère du code shader (WGSL) depuis l'API abstraite.
- 🔴 Le format de mat3 (9 floats compacts ou 12 avec padding) n'est pas spécifié dans `Mat3Api`. `TransformCache.ts:72,96` initialise encore les mat3 avec `new Float32Array(9)`, alors que le backend WebGPU en produit 12.

### 3.2 Dépendances entre couches

- 🟡 engine-webgpu n'importe plus rien d'engine-core, mais la dépendance est toujours déclarée dans `packages/engine-webgpu/package.json:6` et `tsconfig.lib.json:11`.
- 🔴 `engine-backend/package.json` ne déclare que `tslib`, alors que le code importe `@preact/signals-core`.
- 🔴 engine-webgpu ne déclare ni `eta`, ni `wgpu-matrix`, ni `@preact/signals-core`.

### 3.3 La démo ne passe pas par le frontend — 🔴

Toutes les routes et `apps/demo/src/utils3d` appellent WebGPU directement : `engine.device!`, pipelines, bind groups, command encoder, WGSL écrit à la main, boucle `requestAnimationFrame`. La démo instancie aussi elle-même les adaptateurs d'engine-backend. Scene, Mesh, Material et RenderPipeline existent dans la démo mais pas dans le moteur.

### 3.4 Ce qui manque à l'API abstraite pour un backend Vulkan / SDL — 🔴

- **`Engine`** ne gère que le cycle de vie : il n'a ni factories de ressources, ni boucle de rendu, ni `render(scene, camera, surface)`.
- **`Surface`** se limite à `width`, `height` et `init(engine)`. Il manque le resize, `present` et l'acquisition des frames, la gestion du DPI, la requête de format, et une abstraction de fenêtre native (par exemple un handle SDL).
- **Il manque aussi :**
  - des shader modules avec une source neutre (sortie SPIR-V ou HLSL, ou une étape de cross-compilation) ;
  - des layouts de bind groups ;
  - des descriptions de render pipeline et de render pass ;
  - un command encoder et la soumission à la queue ;
  - la swapchain et la synchronisation ;
  - `destroy()` et `dispose()` sur toutes les ressources.

---

## 4. engine-backend

### Majeur

- 🔴 **`CameraAdapter.ts:55-56`** : `positionBuffer` lit `options.camera` et non `cameraCache.camera`. Si on change de caméra, l'uniform de position n'est plus mis à jour.
- 🔴 **Fuites de buffers GPU** : `CameraAdapter` (4 buffers) et `TransformAdapter` (5 buffers) n'ont pas de `destroy()`.
- 🔴 **`CameraAdapter.ts:70,85,99`** : `buffer.write(0, m.buffer as ArrayBuffer)` envoie tout l'`ArrayBuffer` sous-jacent en ignorant `byteOffset` et `byteLength`. `GpuBuffer.write` devrait accepter un `ArrayBufferView`.
- ⚪ **`Material.isStructural`** ignorait les changements de type ou de format des textures. Ce point est sans objet tant que `Material` est supprimé ; à reprendre s'il est restauré (N4).

### Mineur — 🔴 tous ouverts

- `gpu/structs.ts:56-61` : `build()` renvoie le tableau `fields` du builder, pas une copie.
- `gpu/arrays.ts:47` : avec une `length` fixe et une valeur plus courte, le writer reçoit `undefined`.
- Les vues `Vec*View`, `QuatView` et `ColorView` : `asArray()` lève une exception si le `byteOffset` n'est pas un multiple de 4, et le getter `buffer` renvoie une `DataView`.
- Incohérences :
  - `GpuShaderStageNames` n'est pas exporté ;
  - `mat2` est présent sans `Mat2Api` ;
  - les signatures des `*Api` mélangent `Float32Array` et `ArrayLike` ;
  - les modes de wrap ont des noms de style OpenGL (`wrapModeS`, `T`, `R`) ;
  - les couleurs des lumières sont typées `IVec3` alors que `IColor` existe maintenant ;
  - `CameraCache._camera` est public ;
  - `transformParentProvider` est en lecture seule.
- Typage : `any` et `as unknown as` dans `CachedValue`, `as any` dans `material/utils.ts`.
- `CachedValue.version` déclenche un recalcul à chaque lecture.

---

## 5. engine-core

Seul `SpotLight.ts` a été modifié par la passe de correction.

### Critique

- 🔴 **`light/index.ts:1`** n'exporte que `BaseLight`, dont le constructeur est `protected`. Aucune lumière utilisable n'est donc exportée (vérifié). Il suffit d'ajouter trois lignes `export * from`.
- 🔴 **`Object.freeze` sur les vues renvoyées ne protège rien** (13 occurrences). `cam.position.x = 5` fonctionne toujours, **sans incrémenter la version** : les caches deviennent périmés sans erreur. Il vaut mieux renvoyer une interface en lecture seule ou une copie.

### Majeur — 🔴

- **Disposition des buffers de lumière** (`BaseLight.ts:18`) : les offsets 0, 12 et 24 ne respectent pas les règles d'alignement WGSL (0, 16 et 32).
- **`Camera`** : il n'y a ni `lookAt`, ni forward et up, ni moyen simple de changer l'aspect ratio. Le setter de `projection` garde une référence à l'objet de l'appelant.
- **Pas de graphe de scène** : pas de Scene, Node, Mesh ni Material, et pas de parent sur `Transform`.

### Mineur — 🔴

- Les compteurs de version des sous-classes de lumière ne démarrent pas à 0 (1 pour Directional, 4 pour Point, 7 pour Spot).
- Les valeurs par défaut de `SpotLight` ne produisent aucun cône à pleine intensité, et l'unité n'est pas documentée.
- `Camera` réimplémente position et rotation au lieu de réutiliser `Transform`.
- Les lumières mélangent exports nommés et exports par défaut.

---

## 6. engine-webgpu

### Majeur

- 🔴 **Règles uniform de WGSL** (`gpu/layouts.ts`, `gpu/structs.ts:179-189`) : dans un buffer uniform, le stride d'un tableau doit être un multiple de 16. Aujourd'hui `array<f32, N>` a un stride de 4.
- 🔴 **`gpu/structs.ts:42,158`** : `'hasDynamicSize' in field.type` est toujours vrai, car `build()` définit toujours la clé, même à `undefined`. Toutes les structs imbriquées sont donc rejetées. Il faut tester `field.type.hasDynamicSize === true`.
- 🔴 **`gpu/structs.ts:132-142,220-231`** : une struct est sérialisée en `{ ... }` anonyme, ce qui n'est pas du WGSL valide.
- 🔴 **`math/primitives/vec4.ts:119-157`** : plusieurs fonctions ignorent `w`.
- 🔴 **`math/primitives/mat4.ts:160-169`** : `setRotation` est faux, et `getRotation` renvoie un quaternion non unitaire si l'objet a un scale.
- 🔴 **Textures** :
  - `3d` est créée en 2D ;
  - `2d-array` lève une exception ;
  - l'upload n'écrit que la couche 0 ;
  - il n'y a pas de mipmaps ;
  - le nombre d'octets par pixel n'est défini que pour les formats 8 bits.
- 🔴 **Cycle de vie de `WebGpuEngine`** :
  - l'état reste à `initializing` en cas d'échec ;
  - `device.lost` n'est pas géré ;
  - `destroy()` plante avec `device!` si `init()` n'a pas été appelé ;
  - `pause()` et `resume()` ne font que changer l'état.
- 🔴 **Shader Phong** :
  - l'ambient par défaut est blanc ;
  - le spéculaire n'est pas conditionné à N·L > 0 ;
  - la texture de shininess multiplie la valeur au lieu de la remplacer ;
  - `if (it.shininess)` ignore la valeur 0 ;
  - le shader ne compile pas pour un mesh sans normales ni UV ;
  - le nom des textures dépend d'un `label` optionnel.
- 🆕 **N1 et N2** (voir §0.1).

### Mineur — 🔴

- `quat.equals` a un epsilon de 0 par défaut, et `mat4.setScaling` divise par le scale courant (division par zéro possible).
- Le label du sampler n'est pas transmis, les casts sur les modes de wrap et de filtre laissent passer des valeurs invalides, et `maxAnisotropy` n'est pas validé.
- `WebGpuSurface` : pas d'init possible si le moteur est en pause, une nouvelle vue est créée à chaque accès, et rien n'est reconfiguré après une perte du device.
- Le code mort `if (!device)` dans `WebGpuEngine`.
- Nommage : `ShaderWritter` devrait être `ShaderWriter`, `uniformStructBuilder` et `storageStruct` ne suivent pas la même convention, et `in_usage` est en snake_case.
- `@webgpu/types` 0.1.64 (la dernière version est 0.1.74) : la mise à jour permettrait de rétablir `unorm8x4-bgra` et `unorm10-10-10-2` si besoin.

---

## 7. Application demo — 🔴 aucune modification

### Critique

- Indices `Uint16` alors que Mustang.obj dépasse 65 535 sommets par objet (`Mesh.ts:23`, `Scene.ts:326`, vérifié).
- `RenderPipeline.ts:4` importe un `Material` qui n'est plus exporté (🆕 N4).

### Majeur

- **Quads tronqués** : `tessellate: false` par défaut dans `@thi.ng/geom-io-obj`, et `obj-importer.ts:61-83` ne lit que les 3 premiers sommets de chaque face. Environ la moitié des triangles de Mustang.obj sont perdus.
- **`obj-importer.ts:55-57`** : `hasUVs` et `hasNormals` sont calculés pour tout le modèle et non par face. Le stride peut être décalé, et `vertex.n!` plante. teapot.obj n'a pas d'UV mais la route déclare un attribut uv.
- **`utils.ts:221-224` (`readLines`)** coupe des lignes MTL au milieu.
- **`Scene.ts:296`** appelle `createRenderPipeline` à chaque frame.
- **Aucun nettoyage** : la boucle `requestAnimationFrame` n'est jamais annulée, et ni la surface, ni les buffers, ni les textures ne sont détruits.
- **Race condition** dans `globals/engine.ts:16-33`.
- **`RenderSurface.tsx:25-61`** : le `ResizeObserver` est déconnecté juste après sa création.
- **`Application.ts:31-39`** : la depth texture n'est jamais recréée au resize.

### Mineur

- `mtl-parser.ts:44` résout le chemin du MTL par rapport à la page et non par rapport à l'OBJ.
- `StrictMode` n'est pas utilisé ; l'activer créerait deux surfaces sur le même canvas.
- `Layout.tsx:37` appelle une fonction async sans `.catch`, et `destroyEngine` n'attend pas le `destroy()`.

---

## 8. Outillage et hygiène du dépôt — 🔴 aucune modification

- **Tests** : `nx test` est cassé (preset Jest et `@types/jest` absents, 3 plugins Nx créent chacun une cible `test`), et il n'y a **aucun fichier de test**. Il vaudrait mieux garder uniquement Vitest.
- **Lint** : les `packages/*/.eslintrc.json` sont toujours présents et ignorés par ESLint 9, donc la règle `@nx/dependency-checks` ne s'applique jamais.
- **Dépendances** : `three` et `@11ty/nunjucks` sont morts, `node@^24` est en devDependency, et les dépendances de la démo sont à la racine.
- **Fichiers volumineux** : `apps/demo/public/Mustang.obj` fait 95,7 Mo (vérifié). Il vaudrait mieux passer par Git LFS.
- **Artefacts commités** : `apps/demo/tsconfig.tsbuildinfo` (vérifié). Il faut ajouter `*.tsbuildinfo` au `.gitignore`.
- `tsconfig.base.json` contient des `paths` vers un `packages/ui/...` qui n'existe pas.
- Les `exports` des packages pointent vers `src/*.ts` : ce n'est pas publiable en l'état.

---

## 9. Plan de correction mis à jour

1. **Corriger les régressions de la passe (petit, urgent)** :
   - N1 : `Math.ceil(size / 4) * 4`, et padding de la branche `writeBuffer` ;
   - N2 : `ArrayBuffer.isView(source)` ;
   - N4 : décider du sort de `Material` et faire compiler la démo ;
   - N5 : retirer `vite/client` d'engine-backend ;
   - N3 : factory de textures générique.
2. **Finir les critiques restants** :
   - le `try/finally` dans `CachedValue` ;
   - l'export des lumières dans engine-core ;
   - les indices uint32 dans la démo (et `tessellate: true`) ;
   - `hasDynamicSize` et le stride des tableaux uniform.
3. **Faire compiler la démo** : les 5 erreurs triviales restantes.
4. **Mettre en place Vitest** et écrire les premiers tests. Les régressions N1 et N2 auraient été attrapées par des tests unitaires simples sur `BufferFactory` et les layouts. Priorités : layouts et alignement WGSL, padding des buffers, primitives mathématiques, `CachedValue`, lumières.
5. **Nettoyer les dépendances** :
   - retirer engine-core de `package.json` et de `tsconfig.lib.json` d'engine-webgpu ;
   - déclarer les dépendances réelles dans chaque package ;
   - migrer ESLint vers le format flat pour activer `dependency-checks`.
6. **Traiter la démo** : fuites de ressources, resize, race sur le moteur, parser OBJ/MTL.
7. **Compléter l'API abstraite**, puis déplacer Scene, Mesh et Material de la démo vers le moteur (voir §3.3 et §3.4).
