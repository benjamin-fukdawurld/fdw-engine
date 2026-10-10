# Audit du code — FdwEngine

_Date : 02/10/2026 — état du dépôt : commit `f722411`._
_Périmètre : `packages/engine-backend`, `packages/engine-core`, `packages/engine-webgpu`, `apps/demo`, outillage. Cet audit remplace le précédent (26/09, mis à jour le 28/09) et reprend ses points comme liste de contrôle._

**Légende des statuts :**

| Statut     | Signification                                                |
| ---------- | ------------------------------------------------------------ |
| 🟢 Corrigé | Corrigé depuis l'audit précédent, vérifié dans le code       |
| 🟡 Partiel | Correction commencée mais incomplète                         |
| 🔴 Ouvert  | Toujours présent                                             |
| 🆕 Nouveau | Nouveau constat (souvent introduit par les derniers commits) |

Les points marqués « (vérifié) » ont été confirmés par exécution : compilation, script Node ou commande Nx. Les autres viennent de la relecture du code.

**Sur la partie material :** elle est en cours d'implémentation, et la cible est décrite dans [design/material-graph.md](design/material-graph.md). La section 2 ne la juge donc pas sur ce qui manque, mais classe les constats en quatre catégories : les bugs du code utilisé aujourd'hui, ce qui entre en conflit avec le design cible, les fondations à conserver, et les prochaines étapes.

---

## Sommaire

0. [Synthèse](#0-synthèse)
1. [Compilation, CI et outillage de build](#1-compilation-ci-et-outillage-de-build)
2. [Partie material (en cours d'implémentation)](#2-partie-material-en-cours-dimplémentation)
3. [engine-backend](#3-engine-backend)
4. [engine-core](#4-engine-core)
5. [engine-webgpu](#5-engine-webgpu)
6. [Application demo](#6-application-demo)
7. [Hygiène du dépôt](#7-hygiène-du-dépôt)
8. [Plan d'action recommandé](#8-plan-daction-recommandé)

---

## 0. Synthèse

### Ce qui a avancé depuis l'audit précédent

- 🟢 Les régressions N1 à N5 de l'audit du 28/09 sont presque toutes corrigées :
  - la formule du padding des buffers ;
  - `ArrayBuffer.isView` pour les sources de textures ;
  - la factory de textures générique (`GpuTextureFactory<ImageBitmap>`) ;
  - `vite/client` retiré d'engine-backend ;
  - l'import de `Material` retiré de la démo.
- 🟢 La normal matrix est maintenant calculée en 3×3 (`transpose(inverse(mat3(M)))`). Elle a été **vérifiée numériquement** contre wgpu-matrix, composition avec le parent comprise.
- 🟢 Les tailles des buffers de lumières sont exprimées par des constantes nommées (`LightColorDataSize`…). Il n'y a plus ni chevauchement ni débordement (vérifié : Directional 48 o, Point 60 o, Spot 80 o).
- 🟢 Le contrat de format des mat3 est documenté, `@webgpu/types` est mis à jour en 0.1.74, et la dépendance d'engine-webgpu vers engine-core est retirée du `package.json`.

### Ce qui bloque aujourd'hui

1. 🆕 **Le workspace Nx est désynchronisé** (vérifié) : `packages/engine-webgpu/tsconfig.lib.json:11` référence encore engine-core, ce qui fait échouer `nx sync:check`, et donc les tâches Nx en CI ou en mode non interactif (§1).
2. 🆕 **engine-webgpu ne compile plus** (vérifié) : la mise à jour de `@webgpu/types` fait apparaître une erreur de type dans `TextureFactory.ts:59` (§1).
3. 🔴 **Aucun test**, et la cible `nx test` est cassée (§1).

### Les 10 priorités

| #   | Point                                                                                                                              | Section |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Supprimer la référence obsolète à engine-core dans `engine-webgpu/tsconfig.lib.json`                                               | §1      |
| 2   | Restreindre les sources de données à `ArrayBufferView<ArrayBuffer>` (erreur de compilation)                                        | §1, §5  |
| 3   | Padding de la branche `writeBuffer` de `BufferFactory` (le chemin utilisé par la démo)                                             | §5      |
| 4   | `try/finally` dans `CachedValue`                                                                                                   | §3      |
| 5   | Exporter `DirectionalLight`, `PointLight` et `SpotLight`                                                                           | §4      |
| 6   | Shader Phong : texture de shininess et spéculaire non conditionné à N·L (bugs visibles dans la démo)                               | §2.1    |
| 7   | Mettre en cache le pipeline créé à chaque frame, et rendre explicite le rafraîchissement de la caméra                              | §2.1    |
| 8   | Corriger la stratégie de structs uniform (`hasDynamicSize`, alignement à 16, `runtimeSize`) avant d'en dépendre pour les matériaux | §2.1    |
| 9   | Installer Vitest et écrire les premiers tests (layouts WGSL, padding des buffers, maths)                                           | §1      |
| 10  | Indices uint32 et triangulation OBJ                                                                                                | §6      |

---

## 1. Compilation, CI et outillage de build

### Compilation (`tsc -b`, vérifié)

| Projet         | État            | Détail                                                                                                                                 |
| -------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| engine-backend | 🟢 compile      | —                                                                                                                                      |
| engine-core    | 🟢 compile      | —                                                                                                                                      |
| engine-webgpu  | 🆕 **1 erreur** | `src/gpu/TextureFactory.ts:59` : `ArrayBuffer \| ArrayBufferView<ArrayBufferLike>` n'est pas assignable à `GPUAllowSharedBufferSource` |
| demo           | 🔴 5 erreurs    | voir ci-dessous                                                                                                                        |

**Cause de l'erreur dans engine-webgpu.** Depuis la version 0.1.74, `@webgpu/types` définit `GPUAllowSharedBufferSource` comme `BufferSource | SharedArrayBuffer`. Avec la lib DOM de TypeScript 5.9, `BufferSource` n'accepte que `ArrayBuffer | ArrayBufferView<ArrayBuffer>`. Or le contrat utilise un `ArrayBufferView` nu, qui vaut par défaut `ArrayBufferView<ArrayBufferLike>` et inclut donc les vues sur un `SharedArrayBuffer`.

**Correction.** Restreindre le type à `ArrayBufferView<ArrayBuffer>` dans trois fichiers :

- `engine-backend/src/gpu/GpuTexture.ts:68` ;
- `engine-backend/src/gpu/GpuBuffer.ts:31` (`initialData`) ;
- `engine-webgpu/src/gpu/TextureFactory.ts:25`.

Il faut éviter les casts `as BufferSource` : celui de `BufferFactory.ts:145` masque déjà ce problème.

Comme `noEmitOnError` est actif, cette erreur empêche aussi de régénérer les déclarations d'engine-webgpu dans `dist/`.

**Erreurs de la démo** (🔴 inchangées, toutes triviales) :

- `Header.tsx:5` et `main.tsx:1` : imports et variables inutilisés ;
- `routes/depth-testing/route.tsx:98` et `routes/index-buffer/route.tsx:98` : `setRotation` inutilisé ;
- `routes/index.tsx:13` : `onSurfaceReady` renvoie `void` au lieu de `Promise<void>`.

🟢 L'erreur de `RenderPipeline.ts:4` (import de `Material`) est corrigée.

### Nx

- 🆕 **Workspace désynchronisé** (vérifié) : `nx sync:check` signale « Stale references: packages/engine-core/tsconfig.lib.json » dans `packages/engine-webgpu/tsconfig.lib.json:11`. La dépendance a été retirée du `package.json` mais pas de la référence TypeScript. Il suffit de supprimer cette ligne ou de lancer `npx nx sync`.
- 🔴 **`nx test` est cassé** : « externalDependency 'jest' could not be found ». Il manque `jest`, `jest.preset.js` et `@swc/jest`, et trois plugins de `nx.json` (`@nx/jest`, `@nx/vite`, `@nx/vitest`) créent chacun une cible `test`. Il vaudrait mieux garder uniquement Vitest et supprimer les `jest.config.ts`.

### Tests

- 🔴 **Il n'y a aucun fichier `*.spec.ts` ni `*.test.ts`.** C'est le manque le plus coûteux à ce stade : les régressions de la dernière passe (padding, types de source) et plusieurs bugs de ce rapport (stride des tableaux uniform, `setRotation`, `hasDynamicSize`) auraient été détectés par des tests unitaires de quelques lignes, exécutables dans Node sans GPU.

### Lint

- 🔴 0 erreur et 269 warnings (247 au précédent audit), dont 258 dans la démo et parmi eux 243 `no-non-null-assertion`.
- 🔴 Les `packages/*/.eslintrc.json` sont au format legacy et ignorés par ESLint 9, donc la règle `@nx/dependency-checks` ne s'applique jamais.

---

## 2. Partie material (en cours d'implémentation)

Ce que couvre cette section :

- dans engine-backend : `material/` (`types.ts`, `utils.ts`) et le système de types GPU (`gpu/`) ;
- dans engine-webgpu : le générateur de shaders (`shader/`) et la stratégie de structs (`gpu/structs.ts`, `layouts.ts`, `writers.ts`, `serializers.ts`) ;
- dans la démo : l'usage actuel (`utils3d/Material.ts`, `Scene.ts`, `RenderPipeline.ts`, `routes/loading-model`).

La classe `Material` d'engine-backend a été supprimée volontairement. C'est cohérent avec le design, qui la place dans engine-core.

### 2.1 Bugs du code utilisé aujourd'hui

Ces bugs ont un effet visible ou un risque de plantage **maintenant**, indépendamment de la suite du chantier.

**Dans le shader Phong** (`engine-webgpu/src/shader/templates/phong/functions.wgsl.eta`) :

- 🔴 **Texture de shininess** (lignes 60-71, vérifié) : la valeur de la texture multiplie la valeur uniform au lieu de la remplacer (`result * tex.r * 255`), ce qui donne jusqu'à environ 16 000 et fait disparaître les reflets. Là où `tex.r == 0`, la shininess vaut 0 et `pow(x, 0.0)` vaut 1 : ces texels ont un spéculaire blanc plein (et `pow(0, 0)` est indéfini en WGSL). De plus, `if (it.shininess)` à la ligne 61 ignore la valeur 0. La démo charge une texture de shininess (`loading-model/route.tsx:146`), donc le bug est visible.
- 🔴 **Spéculaire non conditionné à N·L** (lignes 94-105, 124) : des reflets apparaissent sur les faces opposées à la lumière.
- 🔴 **Ambient par défaut blanc** (lignes 6 et 81) : l'ambient égale le diffus plein, et le rendu est jusqu'à 2x trop clair.

**Dans la démo** (`apps/demo/src/utils3d`) :

- 🔴 **`createRenderPipeline` à chaque frame et pour chaque mesh** (`Scene.ts:296-322`), avec le vertex layout et le descripteur reconstruits à chaque fois, alors que tout est statique. Il faut les créer une fois dans `setupMesh` et les stocker dans `MeshRenderData`.
- 🆕 **Un effet de bord caché** (`Scene.ts:292-294`, vérifié) : les deux réaffectations `material.frameUniforms[n].value = cameraAdapter.*.value` ressemblent à du code mort (le bind group est déjà construit avec ces buffers), mais c'est la lecture de `.value` qui déclenche l'upload de la position et de la vue de la caméra par `CachedValue`. Si on supprime ces lignes, la caméra se fige. Et `projectionMatrixBuffer` n'est jamais relu : un changement d'aspect ou un resize n'atteint jamais le GPU. Il faut un `update()` explicite qui lit les trois buffers à chaque frame.
- 🆕 **`setupMesh` modifie le matériau** (`Scene.ts:113, 189, 218`) : il ajoute des uniforms au matériau et crée 7 buffers de lumière à chaque appel. Un matériau partagé par deux meshs, ou un second appel, produit des `var` WGSL et des bindings en double, et le shader ne compile pas.
- 🆕 **Stride de vertex calculé par un `switch` incomplet** (`Material.ts:46-74`) : les formats non listés (`float16x2`, `unorm8x4`…) comptent pour 0 octet. Le `stride` déjà calculé par l'importeur (`obj-importer.ts:57`) est ignoré.
- 🔴 **Attributs codés en dur** (`loading-model/route.tsx:73-77`) : la route suppose position, normale et UV, et le template lit toujours `in.normal` et `in.uv` (`phong-shader.wgsl.eta:38-39`). Un OBJ sans normales ou sans UV donne un layout incohérent et une erreur de compilation WGSL.

**Bugs latents dans la stratégie de structs.** Elle est exportée mais pas encore utilisée par la démo. Ces bugs se déclencheront dès que les matériaux en dépendront :

- 🔴 **Toutes les structs imbriquées sont rejetées** (`engine-webgpu/src/gpu/structs.ts:42, 158`) : `'hasDynamicSize' in field.type` est toujours vrai, car `build()` définit toujours la clé, même à `undefined` (`engine-backend/src/gpu/structs.ts:59`). Il faut tester `field.type.hasDynamicSize === true`.
- 🔴 **Règles WGSL de l'espace uniform non appliquées** (`engine-webgpu/src/gpu/structs.ts:178-189`, `layouts.ts`) : le stride des tableaux n'est pas arrondi à 16 (`uniformArrays.float32` a un stride de 4, donc `array<f32, N>` est invalide en uniform), et l'alignement et la taille des tableaux et des structs imbriquées ne sont pas arrondis à 16.
- 🟡 **`runtimeSize` et `size` incohérents** (`engine-webgpu/src/gpu/structs.ts:93, 204`) : depuis la dernière passe, `size` est arrondi, mais `runtimeSize()` renvoie toujours la taille brute. Par exemple, une struct `{ vec3 }` donne 16 d'un côté et 12 de l'autre.
- 🔴 **`build()` partage son état** (`engine-backend/src/gpu/structs.ts:51-62`) : il renvoie le `blueprint` et le tableau `fields` vivants du builder, donc un `withField` après `build()` modifie la struct déjà construite.
- 🔴 **Sérialisation invalide** (`engine-webgpu/src/gpu/structs.ts:138-140, 226-228`) : une struct est émise en `{ a: f32 }` anonyme, ce qui donne `var<uniform> x: {…}`, invalide en WGSL.
- 🔴 **Écriture de tableau** (`engine-backend/src/gpu/arrays.ts:47`) : avec une `length` fixe et une valeur plus courte, le writer reçoit `undefined` et lève une exception.

### 2.2 Ce qui entre en conflit avec le design cible

Ce n'est pas un bug, mais ces éléments devront changer ou disparaître pour atteindre [design/material-graph.md](design/material-graph.md). Mieux vaut le savoir avant de construire dessus.

**Du code WGSL dans l'API abstraite.** `GpuType.serialize()` (`GpuType.ts:6`), `GpuArray.serialize()` (`GpuArray.ts:9`), `GpuSerializer`, `SerializerApi` et `StructBuildStrategy.getSerializeCallback` (`GpuStruct.ts:43`) produisent du texte WGSL depuis engine-backend. Dans le design (§13), la génération de code passe dans `WgslCodegen`. **Recommandation : ne plus ajouter d'usages de `serialize()`.**

**Les types de `material/types.ts` mélangent logique et physique :**

- `MaterialUniformType` (lignes 20-30) utilise les types physiques `GpuType` et `GpuStruct`, là où le design prévoit des types logiques `ShaderType`.
- Chaque uniform a son propre binding, là où le design prévoit **un bloc uniform par slot**.
- `MaterialTextureBindingShape` (lignes 32-56) associe une texture et un sampler optionnel dans un même binding, et stocke un `format` (physique) au lieu d'un `sampleType`. Le design sépare textures et samplers.
- Les bindings contiennent des valeurs d'exécution (`CachedValue`) à côté de la forme : le design sépare la forme (`ProgramLayout`) des valeurs (`Material`).
- `MaterialBinding` (ligne 58) porte le même nom que le `MaterialBinding` d'exécution du design (un par couple matériau et programme). Il faudra renommer l'un des deux.
- `MaterialDescription` (lignes 60-64) est l'équivalent de `ProgramLayout` dans le design.
- `GpuTextureType` (`GpuTexture.ts:1`) n'a ni `1d` ni `cube-array`.

**La numérotation des bindings se fait dans les templates Eta :**

- un `@binding(i)` par uniform (`uniforms.wgsl.eta:2`) ;
- les textures à `bindingOffset + 2i` (`textures.wgsl.eta:1-3`, `phong-shader.wgsl.eta:19`), avec le même calcul recopié dans `Material.ts:157, 183-187` ;
- les noms de textures viennent du `label`, qui est optionnel (on peut obtenir `var undefined`), et leur type est toujours `texture_2d<f32>` ;
- les noms d'attributs sont utilisés tels quels comme identifiants WGSL (`vertex-attributes.wgsl.eta:4`), ce qui casse avec une sémantique personnalisée.

Le fragment utilise déjà 9 uniform buffers, pour une limite par défaut de 12 (`maxUniformBuffersPerShaderStage`). La règle « un binding par uniform » atteindra bientôt cette limite, ce qui est un argument de plus pour un bloc par slot.

**Les slots `frame` et `object` ne sont pas partagés :** chaque mesh a son propre bind group `frame`, avec son layout et ses buffers de lumières (`Scene.ts:113-187, 244-250`). Le design prévoit des layouts fixes partagés par tous les matériaux. En plus, les entrées de layout n'ont pas de `minBindingSize`, et les tailles de buffers sont écrites en dur (`3 * 4`) au lieu d'utiliser `GpuType.size`.

**Le chemin Eta sera remplacé.** `ShaderWritter` et les templates sont voués à être remplacés par `WgslCodegen` (design §13). Leurs imports `?raw` ne fonctionnent qu'avec Vite. `apps/demo/src/utils3d/RenderPipeline.ts` n'est plus utilisé et peut être supprimé.

**La disposition des lumières côté CPU** (🆕) : les vec3 sont compacts (offsets 0, 12, 24, 36…), alors que WGSL les place à 0, 16, 32, 48. Les tailles WGSL seraient 64, 80 et 96 octets, et 60 octets (Point) n'est même pas un multiple de 16. Les buffers de `engine-core` ne sont donc pas envoyables tels quels. C'est cohérent avec le design si l'on considère ces buffers comme un **stockage CPU**, emballé par le backend via `PhysicalLayoutStrategy` : il faut alors l'écrire explicitement. Dans cette logique, `LightColorDataSize` et les constantes voisines (tailles d'emballage CPU) n'ont pas leur place dans l'API abstraite (`engine-backend/src/light/types.ts`) et iraient mieux dans engine-core.

### 2.3 Les fondations à conserver

Ces pièces sont de bonnes bases pour le design et méritent d'être gardées :

| Élément                                                                                   | Pourquoi le garder                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StructBuildStrategy` (`engine-backend/src/gpu/GpuStruct.ts:24-44`) et `StructBuilder`    | C'est exactement le point d'extension prévu pour `PhysicalLayoutStrategy` (uniform et storage WGSL, std140, HLSL), une fois le callback de sérialisation retiré. Le calcul des offsets est juste : un `vec3` suivi d'un `f32` place bien le `f32` à l'offset 12. |
| `uniformLayout` (`engine-webgpu/src/gpu/layouts.ts`)                                      | Correct pour les scalaires, vecteurs et matrices WGSL (vec3 alignement 16 et taille 12, mat3 48 octets, mat2 alignement 8). C'est une table toute prête pour `typeOf()`.                                                                                         |
| `uniformWriters` (`engine-webgpu/src/gpu/writers.ts`)                                     | Corrects en little-endian, et le mat3 utilise des colonnes complétées, cohérentes avec la taille de 48 octets. Ce sont les writers physiques du design.                                                                                                          |
| `MaterialBindingSlot` et `getMaterialBindingSlotOrder()` (`engine-backend/src/material/`) | Ils donnent les groupes 0/1/2 dans un ordre déterministe, avec les slots personnalisés triés : exactement ce que demande le §7.7 du design. Il reste à dédupliquer les slots personnalisés et à retirer le `as any`.                                             |
| `MeshDescription`, `MeshAttributeSemantic`, `VertexAttributeFormats`                      | Correspondent directement à `input.attribute` et à la correspondance mesh / programme (§10.2 du design).                                                                                                                                                         |
| `ShaderWritter.formatAttributeType` (dupliqué dans `Material.ts:213`)                     | C'est le début de la table de compatibilité « format de vertex → `ShaderType` ». À extraire et à dédupliquer.                                                                                                                                                    |
| `CachedValue`, `CameraAdapter`, `TransformAdapter`                                        | Prêts pour les slots `frame` et `object` et les uploads versionnés (une fois les bugs du §3 corrigés).                                                                                                                                                           |
| La décomposition Phong (`getAmbient`, `getDiffuse`, `getSpecular`, `getLighting`)         | Elle se transpose directement en macro `lighting.phong`, une fois les bugs du §2.1 corrigés.                                                                                                                                                                     |

### 2.4 Prochaines étapes recommandées pour la partie material

Ces étapes sont petites, testables, et dans l'ordre :

1. **Fiabiliser la stratégie de structs** :

   - le test `hasDynamicSize === true` ;
   - l'arrondi à 16 des tableaux et des structs en espace uniform ;
   - un `runtimeSize` aligné ;
   - une copie du blueprint dans `build()`.

   L'ajouter avec des tests Vitest qui comparent les offsets à des valeurs de référence WGSL. Ces tests tournent dans Node, sans GPU.

2. **Corriger la démo actuelle** :
   - mettre en cache le pipeline et le shader module dans `MeshRenderData` ;
   - rendre explicite le rafraîchissement de la caméra (projection comprise) ;
   - conditionner le spéculaire à N·L ;
   - faire que la texture de shininess remplace la valeur (avec un minimum de 1).
3. **Créer `@fdw/engine-shader`** avec seulement `ShaderType`, `T` et le type `ProgramLayout`. Écrire une `PhysicalLayoutStrategy` pour l'espace uniform WGSL (`ShaderType` → `GpuStruct` via la stratégie existante), et la tester.
4. **Retirer `serialize()`** de `GpuType`, `GpuArray`, `GpuStruct` et `GpuSerializer`. Déplacer le nommage des types WGSL dans une fonction `wgslTypeName(ShaderType)` d'engine-webgpu, et faire migrer temporairement les templates vers elle.
5. **Remplacer `MaterialBindingShape` et `MaterialDescription` par `ProgramLayout`.** Faire passer la démo à un bloc uniform par slot, avec des groupes `frame` (caméra, lumières) et `object` partagés et créés une seule fois. Valider sur la démo réelle.
6. **Phases 1 et 2 du design** : `GraphBuilder` avec validation et aller-retour JSON, puis un compilateur minimal (unlit) vers l'IR, puis `WgslCodegen` avec des tests par snapshot.
7. **`ProgramCache` et `PipelineCache`** (clé `programKey + layoutKey + stateKey + passKey`). Porter `loading-model`, puis écrire `lighting.phong` en macro, ce qui permet de retirer Eta.

---

## 3. engine-backend

Le code material et la stratégie de structs sont traités au §2.

| Point                                                     | Statut                                                                                                                          | Emplacement                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Normal matrix                                             | 🟢 vérifiée numériquement, composition avec le parent comprise                                                                  | `math/TransformMath.ts:35-41`                                     |
| View-projection                                           | 🟢                                                                                                                              | `camera/CameraAdapter.ts:102`                                     |
| Type `source` des textures                                | 🟢 générique (`TextureSource = never`) ; voir §1 pour `ArrayBufferView<ArrayBuffer>`                                            | `gpu/GpuTexture.ts:66-71`                                         |
| `wgpu-matrix`, types `GPU*`, `ImageBitmap`, `vite/client` | 🟢 retirés                                                                                                                      | —                                                                 |
| Format des mat3                                           | 🟡 documenté ; initialisation en `Float32Array(9)` toujours présente (code mort, `CachedValue` calcule dès la première lecture) | `primitives/types.ts:33-36`, `transform/TransformCache.ts:71, 95` |
| `CachedValue` sans `try/finally`                          | 🔴 si `updateStrategy` lève une exception, `_updating` reste vrai et tous les accès suivants lèvent « Circular dependency »     | `utils/CachedValue.ts:58-63`                                      |
| `positionBuffer` lit `options.camera`                     | 🔴 il n'est plus mis à jour si on change de caméra                                                                              | `camera/CameraAdapter.ts:54-55`                                   |
| `destroy()` absent des adaptateurs                        | 🔴 4 buffers fuient dans `CameraAdapter`, 5 dans `TransformAdapter`                                                             | —                                                                 |
| `write(0, m.buffer)` ignore `byteOffset`                  | 🔴 latent (wgpu-matrix renvoie des tableaux neufs aujourd'hui) ; `GpuBuffer.write` n'accepte que `ArrayBuffer`                  | `CameraAdapter.ts:69, 84, 99`, `gpu/GpuBuffer.ts:16-21`           |
| `Engine extends EventTarget`                              | 🔴 suppose un environnement DOM ou Node                                                                                         | `Engine.ts:13`                                                    |
| Conventions de clip space implicites                      | 🔴                                                                                                                              | `math/CameraMath.ts:28-46`                                        |
| `@preact/signals-core` non déclaré                        | 🔴 ne fonctionne que grâce au `package.json` racine                                                                             | `package.json:4`, `Engine.ts:1`                                   |
| `Surface` limitée (pas de resize ni de present)           | 🔴                                                                                                                              | `Surface.ts:3-7`                                                  |

### Nouveaux constats

- 🆕 **Majeur — `TransformAdapter` fixe la taille des mat3 à `12 * 4`** (`transform/TransformAdapter.ts:45`). Ça contredit le contrat qui vient d'être documenté (« le format est défini par la bibliothèque de maths du backend ») : un backend avec des mat3 de 9 floats écrirait 36 octets dans un buffer de 48. La taille doit venir du layout physique du backend, ou au minimum de `mat3.identity().byteLength`.
- 🆕 **Mineur — `getWorldMatrix` et `getWorldNormalMatrix` renvoient la matrice locale elle-même** quand il n'y a pas de parent (`TransformMath.ts:50, 63`). Un futur usage avec `out=` en place corromprait les deux matrices.
- 🆕 **Mineur — une échelle nulle** donne une matrice singulière à `invert`, et des `Inf`/`NaN` sont envoyés au GPU sans aucune garde.
- 🆕 **Mineur — `ColorView` duplique le code de `Vec*View`** avec les mêmes défauts (`asArray()` lève une exception si l'offset n'est pas un multiple de 4, et le getter `buffer` renvoie une `DataView`). Il n'est pas encore utilisé : les couleurs des lumières sont toujours typées `IVec3`.

### Mineurs toujours ouverts

- Les modes de wrap ont des noms de style OpenGL (`wrapModeS`, `T`, `R`) dans `gpu/GpuSampler.ts:16-18`.
- `mat2` existe sans `Mat2Api`.
- `CameraCache._camera` est public, et `transformParentProvider` est en lecture seule (impossible de changer le parent d'un objet).
- `CachedValue` contient des `any` et des `as unknown as`, et lire `.version` déclenche un recalcul.

---

## 4. engine-core

| Point                                                                                         | Statut                                                                                                                                                                          | Emplacement                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `SpotLight` hors limites                                                                      | 🟢                                                                                                                                                                              | `light/SpotLight.ts:20-25`                                                   |
| Tailles des lumières en constantes nommées                                                    | 🟢 (mais voir §2.2 sur leur emplacement et l'alignement GPU)                                                                                                                    | `light/*.ts`                                                                 |
| Seul `BaseLight` est exporté                                                                  | 🔴 (vérifié : le package exporte uniquement `BaseLight`, `Camera` et `Transform`, et le constructeur de `BaseLight` est `protected`). Il suffit d'ajouter trois `export * from` | `light/index.ts:1`                                                           |
| `Object.freeze` ne protège rien                                                               | 🔴 (vérifié : `spot.position.x = 9` écrit bien la valeur, et la version reste à 7) : les caches deviennent périmés sans erreur                                                  | 13 occurrences, par ex. `BaseLight.ts:42`, `Camera.ts:53`, `Transform.ts:44` |
| Compteurs de version des lumières                                                             | 🔴 (vérifié : ils démarrent à 1, 4 et 7)                                                                                                                                        | `BaseLight.ts:34`                                                            |
| Le setter de `projection` garde l'objet de l'appelant ; pas de `lookAt` ni de helper d'aspect | 🔴                                                                                                                                                                              | `Camera.ts:79-82`                                                            |
| Pas de graphe de scène, pas de parent sur `Transform`                                         | 🔴 (attendu : prévu par le design)                                                                                                                                              | —                                                                            |
| Valeurs par défaut du cutoff de `SpotLight` et unité non documentée                           | 🔴                                                                                                                                                                              | `SpotLight.ts:45-46`                                                         |
| Exports nommés et par défaut mélangés                                                         | 🔴                                                                                                                                                                              | `light/*.ts`                                                                 |

- 🆕 **Mineur — le compteur de version est incrémenté avant d'exister** (`BaseLight.ts:29-34`) : les setters appelés dans le constructeur font `undefined++` (qui donne `NaN`) avant que `_version = 0` soit exécuté. C'est sans conséquence aujourd'hui grâce à cette remise à zéro, mais c'est fragile. Il vaut mieux initialiser `_version` en premier et écrire les vues directement plutôt que par les setters.

---

## 5. engine-webgpu

La stratégie de structs et les shaders sont traités au §2. Sur les 25 points précédents de cette section, 3 sont corrigés, 2 partiels et 20 encore ouverts.

| Point                                           | Statut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Emplacement                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Writer mat3                                     | 🟢                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `gpu/writers.ts:147`              |
| `ArrayBuffer.isView`, factory `<ImageBitmap>`   | 🟢                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `gpu/TextureFactory.ts:15, 56`    |
| Padding des buffers                             | 🟡 la formule est correcte et la branche `mappedAtCreation` aussi. **La branche `writeBuffer` (`:145`), celle de la démo, n'est toujours pas complétée** : un `Uint16Array` de 3 indices (6 octets) provoque une erreur de validation GPU sans exception, l'écriture est perdue et le buffer reste à zéro. La branche mappée tronque silencieusement les données trop grandes (`Math.min`, `:135, 140`) alors que `writeBuffer` échoue. `Buffer.size` (`:51-52`) renvoie la taille arrondie. `Buffer.write` (`:77`) a le même problème de multiple de 4 | `gpu/BufferFactory.ts`            |
| Dépendance vers engine-core                     | 🟡 retirée du `package.json`, **toujours dans `tsconfig.lib.json:11`** (voir §1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                 |
| Dépendances non déclarées                       | 🔴 `eta`, `wgpu-matrix` (6 imports), `@preact/signals-core`. `@webgpu/types` non plus, alors que les exports pointent vers les sources. Le `package.json` racine indique encore `^0.1.64` alors que le lockfile est en 0.1.74                                                                                                                                                                                                                                                                                                                           | `package.json:3-6`                |
| Textures                                        | 🔴 voir le détail ci-dessous                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `TextureFactory.ts`, `Texture.ts` |
| Cycle de vie de `WebGpuEngine`                  | 🔴 l'état reste à `initializing` en cas d'échec, `device.lost` n'est pas géré, `destroy()` plante sans `init()` (`:56`), `pause()` et `resume()` ne font que changer l'état                                                                                                                                                                                                                                                                                                                                                                             | `WebGpuEngine.ts`                 |
| `WebGpuSurface`                                 | 🔴 pas d'init possible si le moteur est en pause (`:28`), une nouvelle vue à chaque accès (`:57-59`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                 |
| Sampler                                         | 🔴 label non transmis, casts non vérifiés, `maxAnisotropy` non validé                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `TextureFactory.ts:79-88`         |
| `vec4` ignore `w`                               | 🔴 dans `one`, `toArray` (qui alloue `Array(3)`), `fromArray`, `isFinite`, `isNaN` et `str`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `math/primitives/vec4.ts:119-157` |
| `quat.equals` avec un epsilon de 0              | 🔴                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `quat.ts:117-121`                 |
| `mat4.setScaling` divise par l'échelle courante | 🔴                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `mat4.ts:157`                     |

Le détail des textures :

- le type `3d` n'est jamais transmis à `dimension`, donc la texture est créée en 2D (`TextureFactory.ts:32-46`, `Texture.ts:48-49`) ;
- `2d-array` lève une exception (`Texture.ts:52-53`) ;
- un cubemap exige que l'appelant passe `layers: 6` explicitement ;
- seule la couche 0 est envoyée ;
- il n'y a pas de mipmaps ;
- la table d'octets par pixel ne couvre que les formats 8 bits, et l'exception est levée **après** `createTexture`, donc la texture GPU fuit.

### Nouveaux constats

- 🆕 **Majeur — `mat4.setRotation` est faux même sans échelle** (`math/primitives/mat4.ts:166-168`) : `mat * fromQuat(q * inv(R))` applique la rotation `R·q·R⁻¹` et non `q`. Il faut décomposer T et S puis reconstruire `T · fromQuat(q) · S`, ce qui règle aussi la division par zéro de `setScaling`. `getRotation` (`:140-142`) renvoie toujours un quaternion non unitaire si l'objet a une échelle.
- 🆕 **Mineur — `instanceof ImageBitmap`** (`TextureFactory.ts:42, 51`) lève une `ReferenceError` hors du DOM, par exemple dans des tests Node. Il faut protéger l'appel avec `typeof ImageBitmap !== 'undefined'`. De plus, la taille de copie vient du descripteur et non du bitmap, et `copyExternalImageToTexture` refuse les formats entiers.
- 🆕 **Mineur — `Texture.view`** (`Texture.ts:31-35`) appelle `createView` à chaque accès. Il faudrait la mettre en cache.
- 🆕 **Mineur — la table des usages de buffer est dupliquée** (`BufferFactory.ts:12-19, 29-36`), et il y manque `MAP_READ`, `MAP_WRITE` et `INDIRECT` : la relecture et les draws indirects ne sont pas exprimables.
- 🆕 **Mineur — `mat3.one()`** (`mat3.ts:109-123`) écrit 1 dans les cases de padding, et `mat3.toArray` (`:126-140`) utilise `push` au lieu d'une affectation par index.
- 🆕 **Mineur — `init()` peut être rappelé** quand le moteur est déjà prêt (`WebGpuEngine.ts:9`), ce qui fait fuir le device précédent.

---

## 6. Application demo

Les deux derniers commits n'ont modifié que `RenderPipeline.ts` dans la démo. Les points spécifiques aux matériaux sont traités au §2.1.

| Point                                                         | Statut                                                                                                                                                                                 | Emplacement                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Import de `Material`                                          | 🟢                                                                                                                                                                                     | `utils3d/RenderPipeline.ts`                 |
| Indices `Uint16`                                              | 🔴 masqué pour l'instant : la route charge `sphere.obj` (1 922 sommets), et Mustang.obj (750 846 sommets) n'est plus chargé par aucune route. Tout gros modèle déborderait sans erreur | `Mesh.ts:23`, `Scene.ts:326`                |
| Quads tronqués                                                | 🔴 seuls `face.v[0..2]` sont lus, et `tessellate` n'apparaît nulle part. Mustang.obj compte 722 883 quads et environ 2 000 faces de 5 à 64 côtés                                       | `obj-importer.ts:60-66`                     |
| `hasUVs` / `hasNormals` calculés pour tout le modèle          | 🔴 décale le stride en mode entrelacé, plante sur `vertex.n!` en mode planaire                                                                                                         | `obj-importer.ts:55-57, 110`                |
| `readLines` coupe des lignes MTL                              | 🔴 supprimer le bloc fautif ; le code après la boucle gère déjà le reste                                                                                                               | `utils.ts:71-74`                            |
| Pas de nettoyage                                              | 🔴 aucun `cancelAnimationFrame` dans la démo, et ni les surfaces, ni les buffers, ni les textures ne sont détruits. Changer de route laisse tourner l'ancienne boucle                  | `loading-model/route.tsx:219, 222`          |
| Race condition sur le moteur                                  | 🔴 `instance` est assigné avant la fin de `init()`, et `Header` comme `Layout` appellent `useEngine`. Un échec de `init()` reste en cache                                              | `globals/engine.ts:17, 29-33`               |
| `ResizeObserver` déconnecté                                   | 🔴 masqué car `Layout.tsx:45` passe une taille fixe de 1240×720                                                                                                                        | `RenderSurface.tsx:24-56`                   |
| Depth texture jamais recréée au resize                        | 🔴                                                                                                                                                                                     | `Application.ts:31`, `route.tsx:162`        |
| Chemin du MTL et `response.ok`                                | 🔴 le chemin est résolu par rapport à la page, et la réponse n'est pas vérifiée                                                                                                        | `obj-importer.ts:44`, `mtl-parser.ts:124`   |
| `StrictMode`, `.catch` manquant, `destroyEngine` sans `await` | 🔴                                                                                                                                                                                     | `main.tsx`, `Layout.tsx:37`, `engine.ts:40` |

---

## 7. Hygiène du dépôt

| Point                                                                                       | Statut                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/demo/public/Mustang.obj` (95,7 Mo) commité, sans `.gitattributes` ni Git LFS          | 🔴 Il n'est plus utilisé par aucune route. Le passer sous LFS ou le retirer ; le retirer de l'historique réécrit l'historique Git, ce qui est à décider en connaissance de cause                                                               |
| `apps/demo/tsconfig.tsbuildinfo` commité, pas de `*.tsbuildinfo` dans le `.gitignore`       | 🔴                                                                                                                                                                                                                                             |
| `three`, `@11ty/nunjucks` et `node@^24` dans le `package.json` racine                       | 🔴 `three` et `nunjucks` ne sont importés nulle part                                                                                                                                                                                           |
| Dépendances de la démo déclarées à la racine (`apps/demo/package.json` n'en déclare aucune) | 🔴                                                                                                                                                                                                                                             |
| `paths` vers `packages/ui` inexistant dans `tsconfig.base.json`                             | 🔴                                                                                                                                                                                                                                             |
| `exports` des packages pointant vers `src/*.ts` (non publiables)                            | 🔴                                                                                                                                                                                                                                             |
| `design/material-graph.md` n'est référencé nulle part                                       | 🆕 Ajouter un lien « Design proposals » dans le README. Le document propose aussi de nouveaux packages (`engine-shader`, `engine-webgl2`) absents du schéma d'architecture du README, et il est en français alors que le README est en anglais |

---

## 8. Plan d'action recommandé

**Étape 1 — Débloquer le build (moins d'une heure)**

1. Supprimer la référence à engine-core dans `engine-webgpu/tsconfig.lib.json` (ou lancer `npx nx sync`).
2. Restreindre `ArrayBufferView` à `ArrayBufferView<ArrayBuffer>` dans `GpuTexture`, `GpuBuffer` et `TextureFactory`, et retirer le cast `as BufferSource`.
3. Corriger les 5 erreurs triviales de la démo.
4. Ajouter `**/docs` aux ignores ESLint.

**Étape 2 — Le filet de sécurité** 5. Garder uniquement Vitest (supprimer le plugin et les configs Jest). 6. Écrire les premiers tests :

- padding de `BufferFactory` ;
- offsets des structs uniform WGSL (valeurs de référence) ;
- `TransformMath` et `mat4.setRotation` ;
- `CachedValue` (exception dans `updateStrategy`) ;
- tailles des lumières.

**Étape 3 — Les corrections rapides à fort impact** 7. `try/finally` dans `CachedValue`. 8. Exporter les trois lumières. 9. Padding de la branche `writeBuffer`, exception si les données dépassent la taille, `Buffer.size` égal à la taille demandée. 10. Shader Phong : texture de shininess, spéculaire conditionné à N·L, ambient par défaut. 11. Pipeline mis en cache, rafraîchissement explicite de la caméra (projection comprise).

**Étape 4 — La partie material** 12. Suivre les étapes du §2.4. Commencer par fiabiliser la stratégie de structs avec ses tests, puis créer `engine-shader` avec `ShaderType` et `ProgramLayout`.

**Étape 5 — Le reste** 13. Démo : indices uint32, triangulation OBJ, nettoyage des ressources, race condition, resize. 14. Moteur : `mat4.setRotation`, `vec4`, textures (3d, array, mipmaps), cycle de vie de `WebGpuEngine`, `destroy()` sur les adaptateurs. 15. Dépôt : déclarer les dépendances, migrer ESLint vers le format flat, décider du sort de Mustang.obj, ajouter `*.tsbuildinfo` au `.gitignore`.
