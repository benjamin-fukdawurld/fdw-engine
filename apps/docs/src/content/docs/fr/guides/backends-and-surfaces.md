---
title: Backends et surfaces
description: Engines, surfaces et backends de rendu ; comment en choisir un, et ce qui les distingue.
sidebar:
  order: 6
---

Trois objets séparent une application de l'API graphique sur laquelle elle
s'exécute.

| Objet             | Rôle                                                                                                                     | Interface (`@fdw/engine-backend`) |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **Engine**        | Le périphérique : créé par `init()`, libéré par `destroy()` ; son `state` est un signal                                  | `Engine`                          |
| **Surface**       | La destination des frames : un canvas, une fenêtre, une texture. `width`, `height`, `format`, `present()`                | `Surface`                         |
| **RenderBackend** | Ce qu'utilisent les renderers : fabriques de buffers, de textures et de pipelines, mathématiques, encodage des commandes | `RenderBackend`, `engine.backend` |

Le `Renderer`, les matériaux et le render graph ne voient que le
`RenderBackend` et la `Surface` : le code écrit pour ces interfaces
fonctionne partout.

## Les backends

| Backend | Package              | Engine               | Surfaces                                                               | Shaders                         |
| ------- | -------------------- | -------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| WebGPU  | `@fdw/engine-webgpu` | `WebGpuEngine`       | `WebGpuSurface` (canvas), `WebGpuOffscreenSurface`                     | WGSL                            |
| WebGL2  | `@fdw/engine-webgl2` | `WebGl2Engine`       | `WebGl2CanvasSurface`, `WebGl2OffscreenSurface`                        | GLSL ES 3.00                    |
| Dawn    | `@fdw/engine-native` | `createDawnEngine()` | `DawnWindowSurface`, `WebGpuOffscreenSurface`                          | WGSL                            |
| Vulkan  | `@fdw/engine-vulkan` | `VulkanEngine`       | `VulkanWindowSurface` (`@fdw/engine-native`), `VulkanOffscreenSurface` | HLSL, compilé en SPIR-V par DXC |

Tous les backends passent la même suite de tests de rendu.

```ts
const engine = new WebGpuEngine();
await engine.init();
const surface = new WebGpuSurface(canvas);
await surface.init(engine);
const backend = engine.backend!;
```

## Surfaces hors écran

Une surface hors écran rend dans une texture de taille donnée :
`new WebGpuOffscreenSurface(width, height, format?)`. Sa méthode
`readPixels()` renvoie les pixels sous forme d'octets RGBA, lignes depuis le
haut, sur tous les backends : captures d'écran, miniatures, tests.

## Relire des textures

`backend.textures.readTexture(texture, region?)` relit une région d'une
texture de couleur (toute la texture par défaut), sans attendre le GPU : sa
promesse est résolue une ou deux frames plus tard, avec le contenu qu'ont
laissé les frames soumises avant. Les pixels viennent rangée par rangée
depuis le haut, sans remplissage, dans le layout du format (4 octets par
pixel pour `r32uint`).

```ts
const data = await backend.textures.readTexture(texture, {
  x: 10,
  y: 20,
  width: 4,
  height: 4,
});
```

La texture doit avoir l'usage `copy-src` (absent de l'usage par défaut) et
un seul échantillon ; les textures de profondeur ne se relisent pas. Une
région qui sort de la texture lève une erreur. WebGPU copie dans un buffer
mappé, WebGL2 lit dans un pixel buffer sondé par une fence, Vulkan copie
dans un buffer de l'hôte. `pickIds` repose dessus : voir la
[sélection au pixel](/fdw-engine/fr/tutorials/picking/).

## Capacités

`backend.capabilities` indique ce que prend en charge un backend, et le
compilateur vérifie les programmes en conséquence :

| Capacité                           | Signification                                                    | WebGL2                                         |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `compute`                          | Étapes de calcul                                                 | true (émulées)                                 |
| `emulatedCompute`                  | Calcul émulé par des dessins dans des textures                   | true                                           |
| `storageBuffers`                   | Storage buffers                                                  | true (textures de données)                     |
| `maxVaryings`                      | Valeurs interpolées entre les étapes                             | selon le contexte                              |
| `renderableFormats`                | Formats de couleur utilisables comme attachments (`rgba16float`) | avec `EXT_color_buffer_float`                  |
| `objectTable`                      | Les données des objets lues dans une table, par instance         | true (textures de données)                     |
| `maxAnisotropy`                    | L'anisotropie la plus haute des samplers                         | avec `EXT_texture_filter_anisotropic`, sinon 1 |
| `maxColorAttachments`              | Cibles de couleur d'une passe                                    | `MAX_DRAW_BUFFERS` (au moins 4)                |
| `maxColorAttachmentBytesPerSample` | Octets par pixel des cibles de couleur (WebGPU)                  | —                                              |
| `independentBlend`                 | Cibles d'un pipeline avec des mélanges différents                | false                                          |
| `indirectDraw`                     | Des draws dont le GPU écrit les arguments                        | —                                              |
| `multiDrawIndirect`                | Plusieurs draws indirects en une commande                        | —                                              |
| `drawIndirectCount`                | Leur nombre écrit par le GPU                                     | —                                              |

Un graphe qui utilise une fonctionnalité absente échoue à la compilation avec
une erreur explicite ; testez la capacité pour proposer une solution de
repli.

## Mipmaps et filtrage anisotrope

Une texture créée avec `mipLevelCount` a des niveaux de détail, chacun de la
moitié de la taille du précédent ; `fullMipLevelCount(dimensions)` donne la
chaîne complète, jusqu'à 1×1. Les données écrites remplissent le premier
niveau, et le backend calcule les autres à partir de lui, sur le GPU :

```ts
const map = backend.textures.createTexture({
  type: '2d',
  format: 'rgba8unorm-srgb',
  dimensions: { width: 512, height: 512 },
  mipLevelCount: fullMipLevelCount({ width: 512, height: 512 }),
  source: pixels,
});
```

Après un rendu dans une telle texture, `encoder.generateMipmaps(texture)`
recalcule ses niveaux (dans un render graph : `addMipmapPass`). Les textures
sRGB sont moyennées en couleurs linéaires. Les niveaux sont réservés aux
textures 2d, 2d-array et cube de formats de couleur, non
multiéchantillonnées : les autres textures refusent `mipLevelCount > 1`.

`std.textureSample` choisit le niveau d'après la taille du pixel sur la
texture ; `std.textureSampleLevel` lit un niveau donné. Ce dernier est
disponible dans toutes les étapes : passez-lui un uv par `std.perFragment`,
sinon il échantillonne aux sommets et interpole les couleurs.

Le **filtrage anisotrope** garde une texture nette sur une surface vue en
incidence rasante (un sol, une route) : le sampler prend jusqu'à
`maxAnisotropy` échantillons dans la direction où la texture est étirée.

```ts
const sampler = backend.textures.createSampler({ maxAnisotropy: 8 });
// Ou pour tous les samplers créés ensuite sans maxAnisotropy :
const engine = new WebGpuEngine({ maxAnisotropy: 8 });
backend.textures.defaultMaxAnisotropy = 8;
```

- Il demande les trois filtres `linear` (ceux par défaut) : une anisotropie
  demandée avec un filtre `nearest` lève une erreur, comme l'exige WebGPU.
  La valeur par défaut ne s'applique qu'aux samplers qui peuvent s'en
  servir, hors samplers de comparaison.
- Les valeurs au-delà de `capabilities.maxAnisotropy` y sont ramenées (16
  sur la plupart des GPU, 1 quand l'appareil n'a pas de filtrage
  anisotrope).
- Il va avec les mipmaps : sans niveaux, une texture réduite scintille quelle
  que soit l'anisotropie.

Chaque backend calcule les niveaux à sa façon : `generateMipmap` en WebGL2,
une passe de rendu par niveau en WebGPU, `vkCmdBlitImage` en Vulkan.

## Ce que les backends absorbent

Le moteur suit les conventions de WebGPU ; les autres backends s'adaptent :

- **La profondeur dans l'espace clip** va de 0 à 1. Les vertex shaders GLSL
  la ramènent à l'intervalle −1 à 1 d'OpenGL.
- **Origine du framebuffer** : les images sont lues à partir de la ligne du
  haut partout. WebGL2 retourne ses viewports ; Vulkan utilise une hauteur
  de viewport négative, de sorte que y pointe vers le haut dans l'espace
  clip.
- **Bind groups** : GLSL ES n'en a pas. Le pipeline WebGL2 attribue un point
  de binding à chaque uniform block et une unité de texture à chaque paire
  texture–sampler ; sous Vulkan, les groupes sont des descriptor sets.
- **Disposition des uniforms** : règles WGSL sous WebGPU, std140 sous WebGL2
  et Vulkan ; les programmes compilés ne connaissent que la disposition
  logique, le backend résout les offsets.
- **Enregistrement des commandes** : WebGL2 enregistre les commandes d'une
  frame et les exécute lors de `submit()`, de sorte que les écritures dans
  les buffers sont vues par chaque draw, comme en WebGPU. Vulkan les écrit
  sous forme de mots de 32 bits, rejoués en un seul appel natif.
- **Synchronisation** : WebGPU et WebGL2 sont synchronisés implicitement. La
  bibliothèque Vulkan suit la dernière utilisation de chaque texture et de
  chaque buffer, et insère les barrières.
- **Profondeur** : `depth24plus` est une profondeur flottante sur 32 bits
  sous Vulkan.

## Données des objets et instanciation

Les données de chaque objet dessiné — ses matrices monde et normale, 112
octets — forment une ligne d'une **table d'objets**, créée par
`backend.createObjectTable()`. Un objet garde sa ligne tant qu'il existe ; la
ligne n'est réécrite que lorsqu'il bouge, et les lignes écrites dans une frame
partent vers le GPU en une seule plage. Chaque passe écrit les lignes des
instances qu'elle dessine, dans son ordre, puis lie la table une seule fois.

Un draw indique `firstInstance` : son instance `i` lit la ligne
`instances[firstInstance + i]`. Les objets qui se suivent avec le même
pipeline, le même matériau et le même mesh forment **un seul draw** de
plusieurs instances — le renderer trie par pipeline, matériau, puis mesh pour
les regrouper. `renderer.stats.get('scene')` donne `drawn` (les objets) et
`drawCalls` (les draws).

| Backend | Table d'objets                                                   | Première instance                                          |
| ------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| WebGPU  | Deux storage buffers : les lignes, la ligne de chaque instance   | `instance_index` l'inclut                                  |
| Vulkan  | Deux storage buffers                                             | `SV_InstanceID` (l'`InstanceIndex` de Vulkan) l'inclut     |
| WebGL2  | Deux textures de données (RGBA32F, R32UI) lues avec `texelFetch` | Un uniform défini avant chaque draw (pas de base instance) |

Le `Renderer` a besoin de `createObjectTable` : un backend personnalisé
l'implémente (un `GpuObjectTable` : `writeRows`, `writeInstances`), ainsi que
le binding `object-table` des programmes.

## Le culling sur le GPU

Avec `gpuCulling: true`, les passes de scène laissent au GPU le test de
chaque objet contre le frustum :

```ts
renderer.render({ items, camera, surface, gpuCulling: true });
```

Le CPU regroupe toujours les objets en draws (par pipeline, matériau et
mesh), mais n'écrit plus leurs instances : une passe de calcul teste la boîte
de chacun, écrit les lignes de ceux qui sont dans le champ dans les instances
de la table, dans leur ordre, et les arguments de chaque draw (le nombre
d'instances, la première). Les passes dessinent ensuite par
`drawIndexedIndirect` et `drawIndirect`, un par draw comme avant. L'image
est la même.

- Les listes d'objets ne sont plus testées sur le CPU ; une source (une
  scène) culle toujours ce qu'elle contient avec son octree. Les
  statistiques de la vue comptent les objets donnés au GPU.
- Là où le backend a `indirectDraw` et des compute shaders : Vulkan,
  Direct3D 12, WebGPU avec `indirect-first-instance`. Ignoré en WebGL2.
- Les draws lisent leurs arguments dans un buffer d'usage `indirect` :
  `pass.drawIndirect(buffer, offset)` (4 u32 : sommets, instances, premier
  sommet, première instance) et `pass.drawIndexedIndirect(buffer, offset)`
  (5 u32 : indices, instances, premier indice, sommet de base, première
  instance). Une passe de calcul peut écrire les instances de la table dans
  `table.instanceBuffer`.

Le culling sur le GPU entraîne le reste de ce que le GPU peut choisir
lui-même :

- **L'occlusion culling sans retard** : avec un `OcclusionCulling`, les
  objets visibles à la frame précédente sont dessinés d'abord, puis les
  autres testés contre la pyramide de profondeur de ce qu'ils ont dessiné,
  dans la même frame (voir le
  [tutoriel de l'occlusion culling](/fdw-engine/fr/tutorials/occlusion-culling/#sans-retard-sur-le-gpu)).
- **Les clusters de lumières** sont remplis par des passes de calcul,
  jusqu'à 1024 lumières ponctuelles et spots dans le champ
  (`MaxGpuClusterLights` ; le CPU au-delà) : les mêmes listes que sur le
  CPU, dans le même ordre.
- **Les niveaux d'une surface tessellée** : `levels: 'gpu'` de
  `PatchSurface` (voir le
  [tutoriel de la tessellation](/fdw-engine/fr/tutorials/tessellation/#les-niveaux-sur-le-gpu)).

### Une scène gardée sur le GPU

Avec le culling sur le GPU, le CPU prépare encore chaque objet que la
scène donne pour la caméra. Une `GpuScene` garde ses objets sur le GPU :
leurs boîtes, leurs lignes dans la table des objets et leurs lots (un par
mesh et matériau) restent dans des buffers du GPU d'une frame à l'autre,
et le GPU les teste tous à chaque frame. Le CPU prépare un lot par mesh et
matériau, et n'écrit que ce qui change.

```ts
const city = new GpuScene();
for (const building of buildings) city.add(building);
city.add(bus, { dynamic: true }); // réécrit à chaque frame
// À chaque frame :
renderer.render({ gpuScene: city, camera, surface, gpuCulling: true });
// Un objet statique a bougé :
crane.transform.position = { x: 3 };
city.touch(crane);
```

Sur 99 225 immeubles, le CPU d'une frame passe de 125 ms (cullés sur le
GPU, préparés un par un) à 1 ms, quel que soit leur nombre.

- Les objets statiques ne sont réécrits qu'après `touch` ; les objets
  `dynamic`, à chaque frame. Ajouter ou retirer des objets les range tous
  à nouveau.
- Les objets transparents sont dessinés comme d'habitude (triés à chaque
  frame), et les shadow maps interrogent les objets sur le CPU.
- Les layers des vues ne s'appliquent pas ; une `GpuScene` est dessinée par
  un seul renderer. Elle se donne avec une `source` et des `items`.
- Là où le backend ne culle pas sur le GPU (WebGL2), ses objets sont
  dessinés comme une liste.

### Des meshes qui partagent leurs buffers

Les meshes d'une `MeshArena` de même format partagent un vertex buffer et
un index buffer : le renderer place chacun à un sommet de base et un
premier indice à lui (le premier emplacement libre ; les buffers doublent
quand ils sont pleins, leur contenu recopié par le GPU) et les dessine de
là, en indirect.

```ts
const arena = new MeshArena({ label: 'buildings' });
const tower = new Mesh({ description, vertices, indices, arena });
const house = new Mesh({ description, vertices, indices, arena });
renderer.render({ source: city, camera, surface, gpuCulling: true });
```

Cullés sur le GPU, les draws consécutifs de meshes d'une arène qui
partagent un pipeline et un matériau deviennent **un draw multiple**
(`multiDrawIndexedIndirect`, 1024 draws au plus). Avec `drawIndirectCount`,
le GPU tasse les draws qui ont gardé des instances et écrit leur nombre :
les draws vides ne sont même pas lancés. Sans arène, ou en WebGL2, rien ne
change.

- `pass.multiDrawIndirect(buffer, offset, maxCount, count?)` et
  `pass.multiDrawIndexedIndirect(…)` : `maxCount` draws, à 20 octets
  d'intervalle (les arguments de `drawIndirect` puis un u32 inutilisé ;
  ceux de `drawIndexedIndirect`), ou les `count.buffer[count.offset]`
  premiers. Vulkan (`multiDrawIndirect`, `drawIndirectCount`) et
  Direct3D 12 (`ExecuteIndirect`, 2048 draws au plus, le nombre dans un
  autre buffer que les arguments) nativement ; WebGPU par un draw chacun,
  sans nombre.
- `mesh.setGpuVertexCount({ buffer, offset })` : le nombre de sommets d'un
  mesh sans indices écrit par le GPU (une passe de calcul de la frame) ; le
  renderer le recopie dans les arguments de son draw.

## Les données des meshes

Un `Mesh` garde ses données côté CPU ; le renderer les envoie au premier
dessin du mesh, et de nouveau après `setVertices` ou `setIndices`.

- **Les mises à jour partielles** : `mesh.updateVertices(buffer, byteOffset, data)`
  réécrit une partie d'un buffer de sommets (décalage et taille multiples
  de 4) : les renderers n'écrivent que ces octets dans le buffer qu'ils
  ont. Un renderer en retard de plus de 64 mises à jour renvoie tout le
  mesh.
- **Sur le GPU seulement** : un mesh créé avec `regenerate` (une fonction
  qui refait ses données, telles qu'elles sont alors) rend sa copie CPU
  une fois qu'un renderer l'a envoyé (`mesh.released`) ; lire `vertices`
  ou `indices` la refait. `mergeMeshes(parts, { source })` crée ainsi son
  mesh fusionné : les [lots statiques](/fdw-engine/fr/tutorials/static-batching/)
  ne gardent leur géométrie que sur le GPU.

## Pipelines

Les pipelines sont créés à leur première utilisation, ce qui peut bloquer
une frame pendant la compilation d'un shader.
`new Renderer(backend, { asyncPipelines: true })` les crée plutôt en
arrière-plan : un élément est ignoré tant que son pipeline n'est pas prêt, et
`await renderer.whenReady()` attend ceux en cours (un écran de chargement).
WebGL2 lie les programmes en parallèle lorsque le navigateur dispose de
`KHR_parallel_shader_compile`.
