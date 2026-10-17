# Le calcul en WebGL2 par rendu dans des textures

_Statut : fait (17/10/2026), avec le tutoriel « Particules sur le GPU » (EN et FR) et le guide Compute. Prolonge le [compute graph](compute-graph.md), dont il remplace la décision 3 (« WebGL2 n'a pas de calcul ») par le repli par rendu dans des textures de son §5.3._

## 1. Résumé

- Les **compute graphs s'exécutent en WebGL2**, sans changer le code de l'application : le backend émule chaque dispatch par des **dessins de points dans des textures** (le GPGPU de WebGL).
- Les **storage buffers existent en WebGL2** : chacun est doublé d'une **texture de données** `rgba32uint` (16 octets par texel), lue par `texelFetch` dans tous les programmes, matériaux compris.
- Le compilateur et l'IR ne changent pas : tout est dans le backend WebGL2 (générateur GLSL ES, buffers, pipelines, encodeur).
- Capacités de WebGL2 : `compute: true`, `storageBuffers: true`, et la nouvelle `emulatedCompute: true`. Reste refusé : le dispatch indirect.

## 2. Le problème

WebGL2 n'a ni compute shaders ni storage buffers. Jusqu'ici, un compute graph y échouait à la compilation, et les fonctionnalités qui calculent (vagues du tutoriel Compute, skinning en calcul) avaient un autre chemin ou rien. Chaque fonctionnalité de calcul devait prévoir un repli, et l'exemple du tutoriel Compute affichait une erreur en WebGL2.

## 3. But et intérêt

- **Un seul code** pour les trois backends : une simulation, un traitement d'image, un précalcul s'écrivent une fois, en compute graph.
- **Les storage buffers partout** : un matériau peut lire des données de taille variable en WebGL2 (palettes, données d'instances, résultats d'un calcul).
- Le prérequis du backlog « repli WebGL2 des storage buffers » est levé.

## 4. Coût

- Le backend WebGL2 gagne un générateur de dessins de calcul, une texture par storage buffer et leur synchronisation : environ 600 lignes, sans toucher au compilateur.
- **Performance** : plus lent que des compute shaders. Un graphe à plusieurs écritures s'exécute une fois par écriture ; les éléments plus petits qu'un texel (`f32`, `vec2`) demandent un dessin masqué par partie du texel (quatre pour les `f32`) ; chaque point passe par le rastériseur.
- **Mémoire** : un storage buffer occupe deux fois sa taille (le buffer et la texture).

## 5. Alternatives

### 5.1 Comment exécuter un dispatch

| Alternative                                      | Principe                                                                                                                  | Avantages                                                                                                     | Inconvénients                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **A. Calcul sur le CPU**                         | Le même graphe interprété en JavaScript                                                                                   | Simple, toutes les écritures possibles                                                                        | Lent pour de gros volumes ; aller-retour CPU ↔ GPU à chaque dispatch ; un interpréteur de l'IR à maintenir                        |
| **B. Un rectangle plein écran par buffer écrit** | Le fragment shader calcule le texel de son pixel                                                                          | Le plus rapide (pas de points)                                                                                | Une écriture ne peut viser que l'élément du thread : il faudrait prouver que l'indice écrit est l'indice du thread, ou le refuser |
| **C. Des points, un par thread** (retenu)        | Le vertex shader exécute le graphe et place un point sur le texel de l'élément écrit ; le fragment shader écrit sa valeur | **Les écritures à des positions quelconques** (scatter), avec la sémantique des compute shaders ; tout graphe | Plus lent que B ; un dessin par écriture                                                                                          |
| **D. Transform feedback**                        | Le vertex shader écrit dans un buffer, un sommet par thread                                                               | Pas de texture intermédiaire                                                                                  | Écriture séquentielle seulement (l'élément du thread) ; un seul programme par buffer ; limites de composantes                     |

**Décision : C.** Elle garde la sémantique des compute graphs (n'importe quel indice, `when`, plusieurs écritures dans l'ordre) sans analyse du graphe. B reste une optimisation possible pour les écritures dont l'indice est celui du thread (§9).

### 5.2 Comment ranger un storage buffer

| Alternative                                       | Avantages                                                                                                                                                           | Inconvénients                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Un format par type d'élément (`r32f`, `rgba32f`…) | Lecture directe                                                                                                                                                     | Le type n'est pas connu à la création du buffer ; un même buffer est lu sous plusieurs types                    |
| `r32ui`, un mot par texel                         | Un seul format                                                                                                                                                      | `readPixels` d'un `r32ui` passe par `RGBA_INTEGER` : 16 octets lus par mot, pas de copie directe vers le buffer |
| **`rgba32ui`, 16 octets par texel** (retenu)      | Un seul format ; les octets du buffer dans l'ordre ; **copies directes buffer ↔ texture sur le GPU** par pixel buffers (`PIXEL_PACK_BUFFER`, `PIXEL_UNPACK_BUFFER`) | Les éléments plus petits qu'un texel s'écrivent par dessins masqués                                             |

Les bits sont convertis par `uintBitsToFloat` / `floatBitsToUint` (et les conversions `int` ↔ `uint`, qui gardent les bits).

## 6. Design

### 6.1 Les storage buffers

Un `WebGl2Buffer` créé avec l'usage `storage` a :

- son buffer WebGL (arrondi à des texels entiers), pour les autres usages : sommets, uniforms, copies, `read()` ;
- une `StorageTexture` : `rgba32ui`, au plus 2048 texels par ligne (`StorageTextureWidth`), autant de lignes que nécessaire (au plus `MAX_TEXTURE_SIZE`).

Les deux copies sont **mises à jour l'une depuis l'autre à la demande**, sur le GPU : le buffer note laquelle a changé en dernier (`changed('buffer' | 'texture')`) ; `updateTexture()` copie le buffer dans la texture avant qu'un programme la lise ou l'écrive, `updateBuffer()` lit la texture dans le buffer avant un usage de buffer. Les mises à jour d'une passe de rendu sont faites avant de lier son framebuffer (elles lient ceux des textures). Un buffer écrit par un calcul peut ainsi servir de vertex buffer (le skinning en calcul fonctionne en WebGL2).

Un storage buffer ne peut pas être un index buffer (WebGL interdit de lier un `ELEMENT_ARRAY_BUFFER` aux cibles de pixels).

### 6.2 La lecture

Chaque storage buffer d'un programme est déclaré dans les deux étapes : `uniform highp usampler2D s_<nom>`, `uniform uvec3 s_<nom>Size` (largeur et hauteur de la texture, taille en octets), et les fonctions `s_<nom>Texel(t)`, `s_<nom>Load(i)` et `s_<nom>Length()`. `std.index` et `std.arrayLength` les appellent. Le pas des éléments est celui des autres backends : 4 (scalaire), 8 (`vec2`), 16 (`vec3`, `vec4`), 16 par colonne (matrices).

### 6.3 Le dispatch

`GlslEsCodegen.emitCompute` produit **un programme par écriture** (`GlslComputeDraw`) :

- le **vertex shader** calcule le thread depuis l'instance (`gl_InstanceID`) et le nombre de workgroups (`c_numWorkgroups`, un uniform) : `global-invocation-id`, `local-invocation-id`, `workgroup-id` ; il exécute le corps, puis place le point sur le texel de l'élément écrit, ou hors de la vue si `when` est faux ou l'indice hors du buffer ;
- le **fragment shader** écrit les bits du point (`flat uvec4`) ;
- un thread fait un point par texel de l'élément (le sommet `gl_VertexID` : quatre pour une `mat4`) ;
- les éléments plus petits qu'un texel sont écrits par des **dessins masqués** (`colorMask`) : quatre pour les scalaires, deux pour les `vec2` ; l'uniform `c_component` indique la partie du texel du dessin, les threads dont l'élément est ailleurs ne font pas de point.

L'encodeur fait, pour chaque écriture : les mises à jour des copies, le framebuffer de la texture écrite, puis `drawArraysInstanced(POINTS, 0, texels, threads)` par masque. Les écritures sont faites dans l'ordre, comme le demande l'IR.

### 6.4 Les capacités

```ts
interface BackendCapabilities {
  // …
  // Compute stages emulated by draws into textures (WebGL2), not compute
  // shaders: no indirect dispatch, and slower.
  readonly emulatedCompute?: boolean;
}
```

Le skinning reste par défaut dans l'étape de sommets quand le calcul est émulé (`defaultSkinningMode`) : c'est moins cher en WebGL2 ; le mode `compute` y reste disponible.

## 7. Extensions de l'API abstraite

Aucune, sauf la capacité `emulatedCompute`. Les pipelines et passes de calcul, les storage buffers et `read()` gardent leur contrat.

## 8. Plan d'implémentation

| Étape                | Contenu                                                                                                        | Fait |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ---- |
| W1. Storage buffers  | `StorageTexture`, mises à jour par pixel buffers, lecture GLSL (`texelFetch`), capacité `storageBuffers`       | oui  |
| W2. Dispatchs        | `emitCompute`, `WebGl2ComputePipeline`, passe de calcul (et sa mesure), capacités `compute`, `emulatedCompute` | oui  |
| W3. Exemples et docs | Vagues du tutoriel Compute en WebGL2, tutoriel « Particules sur le GPU », guide Compute (« En WebGL2 »)        | oui  |

## 9. Stratégie de test

| Niveau          | Quoi                                                                                                                        | Outils                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Générateur      | Lectures de chaque type d'élément, dessins d'un dispatch, masques, colonnes des matrices                                    | Vitest, snapshots               |
| Validation GLSL | Tous les programmes de la suite, calculs compris (leurs dessins), validés et liés                                           | `glslangValidator`              |
| Exécution       | La suite de rendu partagée : dispatchs relus, éléments de chaque taille, ordre des écritures CPU et GPU, skinning en calcul | Chromium headless (SwiftShader) |
| Exemples        | Captures des vagues et des particules, identiques en WebGL2 et en WebGPU                                                    | Playwright                      |

## 10. Risques et décisions

| Sujet                   | Risque                                        | Réponse                                                                                                                    |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Performance             | Des calculs lourds trop lents en WebGL2       | Capacité `emulatedCompute` pour choisir un autre chemin ; rectangle plein écran pour les écritures « au thread » si besoin |
| Dispatch indirect       | Les nombres de workgroups sont sur le GPU     | Refusé avec un message clair (il faudrait les relire)                                                                      |
| Même buffer lu et écrit | Boucle de rétroaction (texture lue et rendue) | Refusé par le compilateur dans un graphe ; erreur explicite si le même buffer est lié sous deux noms                       |
| Taille                  | `MAX_TEXTURE_SIZE` lignes de 2048 texels      | 64 Mo au minimum de WebGL2 ; erreur explicite au-delà                                                                      |

**Décisions (17/10/2026) :**

1. Les compute graphs s'exécutent en WebGL2 par **des points, un par thread et par texel** (alternative C).
2. Un storage buffer WebGL2 est **doublé d'une texture `rgba32ui`**, synchronisée à la demande sur le GPU.
3. Le compilateur ne change pas ; WebGL2 déclare `compute`, `storageBuffers` et `emulatedCompute`.
4. Pas de dispatch indirect en WebGL2.

**Suite possible** : le rectangle plein écran (alternative B) pour les écritures dont l'indice est celui du thread ; regrouper dans un même dessin (MRT) les écritures de même indice dans des buffers différents.
