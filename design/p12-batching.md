# P12 : le batching statique

Dessiner en peu d'appels les scènes statiques **hétérogènes**, où chaque objet a son mesh ([roadmap P12](roadmap.md#p12-batching-statique)). L'instancing de P1 dessine déjà en un appel les objets qui partagent mesh et matériau ; ici, il n'a rien à regrouper : un décor fait main, un niveau importé (P16) ou construit dans l'éditeur (P20), une maquette BIM ou un assemblage CAO (P13).

## 1. Aujourd'hui

Un objet statique au mesh unique coûte un draw : une entrée triée, une ligne de la table d'objets, un `setVertexBuffer`, un `setIndexBuffer`, un `drawIndexed`, pour la vue et pour chaque carte d'ombre. Mesuré avant ce travail :

- `Renderer.render`, 1000 objets aux meshes différents, 4 matériaux, CPU seul (backend factice) : **1,57 ms**, contre 0,14 ms pour un draw de 1000 instances.
- Le décor de la démo (§5), 1 600 objets, environ 1 200 draws à l'image, natif sans vsync : **169 fps sous Vulkan, 50 fps sous Dawn**. Dawn, comme le navigateur, paie chaque appel WebGPU.

## 2. Batching statique ou rendu piloté par le GPU ?

La roadmap demandait de comparer, avant d'écrire, avec le rendu piloté par le GPU ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)) : un calcul qui culle les objets et écrit les draws visibles dans un buffer indirect.

|                          | Batching statique                                                                              | Rendu piloté par le GPU                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Principe                 | Les meshes d'une cellule et d'un matériau fusionnés en un mesh dans l'espace du monde          | Tous les meshes dans un grand buffer ; un calcul culle les objets et écrit un draw indirect par objet visible                                                                                                                                               |
| Appels du CPU            | Un par lot                                                                                     | Un par pipeline et par matériau **avec `multiDrawIndirect`** ; sans lui, un `drawIndexedIndirect` par objet, autant d'appels qu'aujourd'hui                                                                                                                 |
| Vulkan                   | Oui                                                                                            | Oui : `multiDrawIndirect`, `drawIndirectCount`                                                                                                                                                                                                              |
| WebGPU                   | Oui                                                                                            | Pas de multi-draw dans la norme (une extension expérimentale de Chrome) : **aucun gain d'appels** pour des meshes différents                                                                                                                                |
| WebGL2                   | Oui                                                                                            | Pas de draws indirects ; `WEBGL_multi_draw` dessine des plages d'un même buffer en un appel, mais le culling reste sur le CPU                                                                                                                               |
| Culling                  | Par cellule (un lot entier ou rien)                                                            | Par objet, et par Hi-Z sur le GPU                                                                                                                                                                                                                           |
| Mémoire                  | La géométrie en double (CPU et GPU)                                                            | Une seule copie, sous-allouée dans un grand buffer                                                                                                                                                                                                          |
| Objets qui changent      | Le lot reconstruit (de l'ordre de la milliseconde)                                             | Rien : une ligne de la table                                                                                                                                                                                                                                |
| Sélection                | Un identifiant par sommet                                                                      | L'identifiant de la table, comme aujourd'hui                                                                                                                                                                                                                |
| Ce qu'il faut construire | La fusion, les lots dans la scène, un attribut d'identifiant lu par le compilateur : **petit** | Les draws indirects dans l'API abstraite, un allocateur de meshes dans un grand buffer, les matériaux sans changement d'état (bindless ou tables), le calcul de culling, le Hi-Z, un repli WebGL2 : **très grand**, en partie le socle du ray tracing (P10) |

**Conclusion : le batching statique maintenant, le rendu piloté par le GPU plus tard, pour Vulkan.** Le navigateur est la cible première (la documentation, les démos, l'éditeur de jeu dans Electron ensuite) : WebGPU n'y a pas de multi-draw, WebGL2 pas de draws indirects ; le rendu piloté par le GPU n'y retirerait pas les appels qui coûtent. Le batching fonctionne sur les trois backends sans rien changer à l'API abstraite. Les deux ne s'excluent pas : un lot n'est qu'un mesh, qu'un rendu piloté par le GPU dessinera comme les autres. Pour les maquettes CAO de centaines de milliers d'objets sous Vulkan, c'est le rendu piloté par le GPU qui ira plus loin ; le batching y reste une option.

## 3. Le design

### 3.1 La fusion, dans `engine-core`

`mergeMeshes(parts)` : des meshes placés par des matrices du monde → un mesh dans l'espace du monde. Les positions sont transformées par la matrice, les normales par la transposée de son inverse, les tangentes par la matrice (et leur signe retourné par un miroir) ; les autres attributs sont copiés octet par octet ; les faces d'une pièce en miroir sont remises dans le bon sens. Les attributs sont entrelacés dans un buffer ; un second buffer donne à chaque sommet l'identifiant de sa pièce (`objectId`, `uint32`). Les index sont en 16 bits quand ils peuvent l'être.

`mergeKey(mesh)` dit ce qui peut l'être et avec quoi : les mêmes attributs dans les mêmes formats, des triangles, ni skin ni buffer par instance, des positions, normales et tangentes en flottants 32 bits.

La fusion est indépendante de la scène : P13 et P16 pourront fusionner des pièces sans elle.

### 3.2 Les lots, dans `engine-scene`

`new StaticBatches(scene, options)` s'attache à la scène (`scene.batching`), comme l'occlusion culling par `scene.occlusion` :

- **Les candidats** : les renderers des nœuds statiques, visibles, dont le mesh a une `mergeKey` et dont le matériau n'est pas transparent (les transparents sont triés objet par objet), et que garde le `filter` de l'application.
- **Les groupes** : la cellule d'une grille du centre de leurs bornes (`cellSize`, 32 par défaut), le matériau, les attributs, les calques, l'ombre. Un groupe de moins de `minCount` (2) renderers n'est pas fusionné ; un groupe de plus de `maxVertices` (262 144) sommets est découpé.
- **Pas les cellules de l'octree de la scène** : la roadmap parlait d'elles, mais son octree lâche découpe ses cellules au-delà de 8 objets, et range un objet selon sa taille, à n'importe quelle profondeur. Des lots de 8 objets au plus ne gagneraient presque rien, et la forme de l'index changerait les lots. Une grille fixe donne des lots de la taille voulue, stables, et une cellule à reconstruire par objet changé ; les lots ont leur propre octree, pour le culling.
- **Les changements** : la scène prévient les lots à chaque renderer dont la branche est appliquée au flush (transformation, visibilité, drapeau statique), à chaque renderer retiré, et quand `scene.rendererChanged(entity)` est appelé (`node.setMesh` sur un renderer existant, `node.layers`). Les lots comparent la version de la matrice, le mesh et sa version, et le groupe ; ce qui a changé marque son groupe. À la fin du flush, les groupes marqués sont reconstruits.
- **Le rendu** : les renderers fusionnés reçoivent `NodeFlags.Batched` (les drapeaux passent en 16 bits) ; les requêtes de rendu les sautent et donnent leurs lots (des `WorldRenderItem` placés par l'identité). Les requêtes de l'application (rayons, volumes) les trouvent toujours, dans l'index statique : la sélection par rayon ne change pas.
- **Les identifiants** : chaque renderer d'une scène a désormais le sien, `scene.objectId(entity)` (l'entité plus un), et `scene.entityOf(id)` le retrouve. Dans un lot, ils sont par sommet.

### 3.3 Dans le compilateur

La valeur `object-id` des sorties de surface lit l'attribut `objectId` quand le mesh en a un (la feature `hasAttribute.objectId`, déjà dans la clé des variantes), la table des objets sinon. Un `u32` passe du vertex au fragment par une varying `flat`. Aucun autre changement : les trois générateurs savent déjà lire un attribut entier.

### 3.4 Les limites

- **L'espace des matériaux** : un lot est placé par l'identité. Un matériau qui calcule la position du monde par `object.world` et la position (la plupart, dont les façades de la ville) ne voit pas la différence ; un matériau qui lit la position ou la normale comme celles de l'objet, si.
- **Les niveaux de détail** : `SceneLods` change de niveau sans prévenir la scène (le drapeau `Culled`) ; ses nœuds sont à écarter par `filter`.
- **L'occlusion culling** voit un lot comme un objet, et `scene.occlusion` (le filtre de l'application) ne s'applique pas aux lots.

## 4. Les étapes

1. La fusion et ses tests ; l'identifiant par sommet dans le compilateur, testé en génération et dans la suite de rendu (Dawn, Vulkan, WebGL2, et les programmes validés par DXC et glslang).
2. Les lots dans la scène : les hooks, les groupes, la reconstruction, les tests ; un benchmark (`StaticBatches.bench.ts`).
3. La démo : le décor (`buildDecor`), dans la démo native (`decor`, `decor-no-batching`) et dans la documentation, avec le tutoriel (EN et FR) et un test de sélection dans un lot.

## 5. Résultats

_Faite_ (19 octobre 2026). Le décor de la démo : une place de 160 m, des ruines de temples (colonnes, tambours tombés), des murets de pierres, les caisses et tonneaux d'un marché, des rochers ; **1 614 objets, chacun son mesh**, 5 matériaux, 118 736 sommets.

| Le décor, natif, sans vsync         | Seuls         | Lots (cellules de 40 m) |
| ----------------------------------- | ------------- | ----------------------- |
| Appels de dessin de la vue          | environ 1 150 | **67**                  |
| Vulkan                              | 169 fps       | **833 fps**             |
| Dawn                                | 50 fps        | **305 fps**             |
| `Renderer.render`, 1000 objets, CPU | 1,57 ms       | **0,14 ms**             |

Ce qu'il coûte, sur le même décor :

| Taille des cellules | Lots | Mémoire des lots | Construction | Un objet déplacé |
| ------------------- | ---- | ---------------- | ------------ | ---------------- |
| 20 m                | 185  | 5,14 Mo          | 72 ms        | 1,1 ms           |
| 40 m                | 78   | 5,20 Mo          | 63 ms        | 0,6 ms           |
| 80 m                | 21   | 5,20 Mo          | 43 ms        | 0,8 ms           |

La géométrie des objets fait 4,73 Mo : les lots en ajoutent autant, plus 4 octets par sommet pour les identifiants, côté CPU (les `Mesh`) et côté GPU. La construction, au départ, se fait une fois ; un objet déplacé reconstruit un lot, de l'ordre de la milliseconde.

Reportés : la libération de la copie CPU des lots une fois envoyés au GPU (le `Mesh` la garde pour les renvoyer) ; la mise à jour incrémentale d'un lot (réécrire la plage d'un objet plutôt que tout le lot) ; les lots des niveaux de détail ; le rendu piloté par le GPU, pour Vulkan ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)).
