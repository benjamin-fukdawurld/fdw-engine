# P3 : l'occlusion culling

Le design de la phase P3 de la [roadmap](roadmap.md#p3-occlusion-culling) : ne pas dessiner ce que les objets opaques cachent. Il reprend la comparaison des techniques du [scenegraph §5.5](scenegraph.md#55-locclusion-culling-plus-tard) et tranche le choix laissé ouvert : relecture par le CPU ou rendu piloté par le GPU.

Contraintes : le GPU autant que possible, sur les trois backends ; rien que WebGL2 ne puisse tenir ; aucune image changée (ce qui est caché ne se voit pas) ; pas de surcoût pour qui ne l'active pas.

## 1. Aujourd'hui

| Ce qui existe                                                                                           | Ce qui manque                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Le frustum culling du `Renderer` et de la scène (octrees)                                               | Les draws indirects (`drawIndirect`) dans l'API abstraite : prévus avec P3b                                                      |
| Le drapeau `occluder`, `NodeState.lastVisible`, la table des bornes, `scene.occlusion` (scenegraph §10) | Les textures de stockage, le calcul en WebGL2                                                                                    |
| Les passes plein écran, `readTexture` d'une région sur les trois backends (P2b)                         | Lire la profondeur dans un shader (réservé aux shadow maps), lire un texel sans sampler (`r32float` n'est pas filtrable partout) |
| `addMipmapPass` (une moyenne)                                                                           | Une réduction max ; le rendu dans un niveau de mip                                                                               |

## 2. Les options

| Option                                                          | Principe                                                                                                                                    | Intérêt                                                                                                                                                                    | Coût                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **A. Hi-Z en passes plein écran, relecture**                    | La pyramide et le test des boîtes en passes de rendu (un texel par boîte) ; le résultat relu sans attendre, appliqué 1 à 3 frames plus tard | **Les trois backends, un seul chemin** (WebGL2 compris, sans calcul) ; s'insère dans le renderer actuel ; le gain CPU est entier (les objets cachés ne sont plus préparés) | Ce qui devient visible peut apparaître une ou deux frames en retard                                                                 |
| B. Hi-Z en calcul, piloté par le GPU (deux phases)              | Phase 1 : ce qui était visible ; pyramide ; phase 2 : le reste testé, les visibles écrits dans des draws indirects                          | Aucun retard ; le CPU ne touche plus les objets                                                                                                                            | Draws indirects et textures de stockage à ajouter aux trois backends ; WebGL2 n'a ni l'un ni l'autre : il faudrait un second chemin |
| C. Requêtes d'occlusion (CHC++)                                 | Les boîtes dessinées, le GPU compte les pixels                                                                                              | Portable                                                                                                                                                                   | Une requête par objet ou groupe, le même retard que A, plus de draws                                                                |
| D. Rastérisation logicielle des occultants (le repli CPU prévu) | Les gros occultants rastérisés sur le CPU, les boîtes testées                                                                               | Aucun retard                                                                                                                                                               | Du CPU (WASM, SIMD), des occultants à fabriquer : précisément ce qu'on veut économiser                                              |

**Choix : A.** La roadmap prévoyait un repli CPU pour WebGL2, faute de calcul ; mais le Hi-Z n'a pas besoin de calcul : des passes plein écran le construisent et le testent aussi bien, et le résultat se relit par `readTexture`, qui existe partout depuis P2b. Un seul chemin, testé une fois, sur tous les backends. Le rendu piloté par le GPU (B) reste l'étape suivante (§8), quand les draws indirects existeront (P3b) : il retirera le retard en WebGPU et en Vulkan, et gardera A en WebGL2.

## 3. Le mécanisme

Après les objets opaques d'une vue, le `Renderer` laisse l'occlusion culling ajouter ses passes, puis des passes plein écran :

1. **La pyramide** : le premier niveau lit le depth buffer (`std.textureLoadDepth`), garde la profondeur la plus lointaine de 2 × 2 pixels et la convertit en distance le long de l'axe de la caméra (par l'inverse de la projection : la profondeur du buffer n'est pas linéaire, la comparaison doit l'être pour une marge relative). Chaque niveau suivant prend le maximum de 2 × 2 texels du précédent (`std.textureLoad`, `r32float`), jusqu'à un texel. Un niveau a la moitié de la taille du précédent, arrondie au-dessus : un texel du niveau `k` couvre exactement 2^(k+1) pixels de côté (le dernier d'une rangée impaire, moins), sans reste. Chaque niveau est une texture du graphe : le graphe ne sait pas rendre dans un niveau de mip.
2. **Le test** : une texture `r8unorm` de 256 texels de large, un texel par boîte ; les boîtes (min, max dans le monde) dans une texture `rgba32float` écrite à chaque frame. Le fragment projette les 8 coins : un rectangle de pixels et la distance du point le plus proche. Le niveau le plus fin où le rectangle tient dans 2 × 2 texels donne la profondeur la plus lointaine devant (4 lectures) ; tous les niveaux sont lus et le bon est choisi sans branche. Caché si le point le plus proche est plus loin que cette profondeur × (1 + `margin`) ; visible si la boîte traverse le plan proche.
3. **La relecture** : une passe de copie sans commande, à effet de bord, programme `readTexture` après la soumission de la frame. Au plus `maxPending` (2) résultats attendus : au-delà, pas de nouveau test.

**L'historique, par objet** (une `WeakMap` des items) : depuis quand il est donné par la caméra sans interruption, et le dernier résultat appliqué. Un résultat ne vaut que s'il est plus récent que le retour de l'objet dans le champ : un objet qui sort du champ puis revient est dessiné jusqu'à son prochain test. Les objets cachés sont testés à chaque frame, comme les autres : leur retour est trouvé dès que la relecture arrive.

**Le retard.** Ce qui est caché ne se voit pas : l'image ne change pas. Ce que le mouvement découvre peut arriver une ou deux frames tard. Les boîtes sont agrandies de la distance parcourue par la caméra depuis la frame précédente, fois `motion` (2) : les objets sur le point d'apparaître sont trouvés visibles un peu plus tôt. Ce n'est pas une garantie (la parallaxe d'un objet lointain derrière un occultant proche peut dépasser la marge), seulement une atténuation ; B la donnera.

## 4. L'API

```ts
const occlusion = new OcclusionCulling({ margin, motion, maxPending });
renderer.render({ source, camera, surface, occlusion });
renderer.stats.get('scene').occluded;
occlusion.isHidden(item);
occlusion.stats; // { tested, hidden, latency }
```

- Le contrat est dans `engine-core` (`OcclusionCuller` : `begin`, `visible(item, bounds)`, `addPasses(graph, context)`), l'implémentation dans `engine-occlusion`, qui ne dépend que d'`engine-core`, `engine-shader`, `engine-backend` et `engine-geometry` (pas de la scène : toute source convient).
- Le `Renderer` demande `visible` pour chaque objet que la source donne à la caméra, **avant** les récepteurs d'ombres : un objet caché ne compte pas dans la région que couvrent les ombres. Les projeteurs d'ombres ne sont jamais retirés.
- Les passes des transparents (`include: 'transparent'`) ne font que lire les résultats ; seule la passe des opaques teste.
- `scene.occlusion` (scenegraph §10) reste une étape à la main de l'application (visibilité précalculée, portails) ; le culling du `Renderer` ne passe pas par elle.
- Le drapeau `occluder` n'est pas utilisé : avec la relecture, tout objet opaque dessiné occulte. Il servira à B (dessiner d'abord les occultants).

## 5. Ce qu'il a fallu ajouter au moteur

- **`std.textureLoad`, `std.textureLoadDepth`** : un texel par ses coordonnées entières (lignes depuis le haut), à un niveau, sans sampler, dans tous les stages. Une opération `texture-load` dans l'IR ; WGSL `textureLoad`, HLSL `Load(int3)`, GLSL `texelFetch` avec les lignes retournées (les textures sont stockées de bas en haut). En WebGL2, une texture lue ainsi a un sampler combiné sans sampler : le backend lie un sampler objet `NEAREST` sans comparaison, qui la rend complète (`r32float` n'est pas filtrable) et lit la profondeur des textures de profondeur. Une contrainte de type `float-texture-2d` (filtrable ou non). C'est la lecture de la profondeur dans les shaders que P2b avait laissée de côté.
- **`new RenderGraph({ size })`, `graph.pixelSize(handle)`** : la taille de la frame connue à la déclaration, pour dimensionner la pyramide ; `Renderer.render()` la donne.
- **`Renderer`** : l'option `occlusion`, `ViewStats.occluded`, le refus du multi-échantillonnage avec l'occlusion.
- **Un gain du `Renderer` au passage** : la clé d'une variante de passe était recalculée (une chaîne) pour chaque objet ; les variantes sont maintenant des objets partagés par la passe, leur clé calculée une fois. Le labyrinthe et toute scène dense en profitent, ombres comprises (§6).

## 6. Mesures

La ville de la démo (`city`), 5184 immeubles statiques, vue d'une rue en 1920 × 1080, Vulkan, RTX 2060 SUPER : environ 4000 immeubles dans le frustum, 3600 cachés.

|                                 | Sans occlusion | Avec                              |
| ------------------------------- | -------------- | --------------------------------- |
| Objets dessinés                 | 3995           | 399                               |
| CPU par frame, sans ombres      | 6,7 ms         | **1,7 ms**                        |
| GPU par frame, sans ombres      | 0,47 ms        | 0,53 ms (dont 0,17 ms de culling) |
| CPU par frame, ombres du soleil | 11,2 ms        | **7,0 ms**                        |
| GPU par frame, ombres du soleil | 1,15 ms        | **0,53 ms**                       |

La démo native (sans vsync, 1280 × 720, sans la vue du culling, la caméra qui descend l'avenue), en images par seconde, sans puis avec l'occlusion : sans ombres, 162 → 437 ; avec les ombres du soleil, 80 → 91 avant l'optimisation des variantes (§5), 109 → 138 après. Le bench CPU (`OcclusionCulling.bench.ts`, faux backend, 1000 objets dont 900 cachés) : 1,03 → 0,41 ms.

Ce que disent ces mesures :

- Le gain est d'abord **CPU** : le coût par objet du `Renderer` (préparation, tri, ligne d'instance) disparaît pour les objets cachés.
- Le coût des passes est **fixe**, environ 0,2 ms de GPU en 1080p, dont une bonne part en coûts fixes de 11 petites passes : rentable dès quelques centaines d'objets cachés. Une passe de calcul unique (§8) le réduirait.
- Avec les ombres, la passe d'ombre devient le poste principal : ses projeteurs (5184, toute la ville dans le volume du soleil) ne sont pas concernés. Les cascades de P2 et un culling des projeteurs par les récepteurs visibles sont la suite logique.

## 7. Tests

- **Compilateur et générateurs** : `textureLoad` et `textureLoadDepth` dans les trois langages (snapshots, DXC et spirv-val, glslang), le refus d'une texture cube.
- **`Renderer`** (faux backend) : les objets retirés et comptés, l'ordre des appels, les passes des transparents qui ne testent pas, le refus du MSAA, la taille de la frame de `render()`.
- **`engine-occlusion`** (faux backend) : les passes déclarées, l'historique (caché à la frame suivante, de nouveau visible, retour dans le champ), le plafond des résultats attendus, la croissance des boîtes par le mouvement, l'erreur sans taille de frame, la compilation des graphes de 1 à 12 niveaux.
- **Suite de rendu, trois backends** : `textureLoad` d'un `r32float` et de la profondeur, lignes depuis le haut ; un mur, un objet caché derrière, un objet visible en perspective : l'objet caché est retiré, le mur ne se cache pas lui-même, l'image est la même, l'objet revient quand le mur part.
- **Documentation** : le tutoriel « Occlusion culling » (EN, FR), son exemple vivant et ses captures en WebGPU et WebGL2.

## 8. La suite

1. **Deux phases sans retard, pilotées par le GPU** (option B), en WebGPU et Vulkan, une fois les draws indirects ajoutés (P3b) : les objets visibles à la frame précédente dessinés d'abord (les `occluder` en tête), la pyramide, puis le reste testé en calcul et dessiné par des draws indirects compactés. WebGL2 garde A.
2. **La pyramide en une passe de calcul** avec des textures de stockage, en WebGPU et Vulkan : moins de coûts fixes que 11 passes.
3. **Le multi-échantillonnage** : la profondeur résolue (le max des échantillons) avant la pyramide.
4. **Les ombres** : le culling des projeteurs dont l'ombre ne peut tomber sur rien de visible, avec les cascades de P2.
5. **Un BVH** pour les scènes statiques de CAO et de BIM, et le test par groupes (un nœud du BVH caché, tous ses objets le sont).

## 9. Décisions

À valider :

1. **Hi-Z en passes plein écran et relecture (A)**, un seul chemin pour les trois backends, plutôt qu'un repli CPU en WebGL2 ; le rendu piloté par le GPU (B) après P3b, en WebGPU et Vulkan (§2).
2. **Le retard accepté** : ce que le mouvement découvre peut apparaître une ou deux frames tard, atténué par `motion` (§3).
3. **Le contrat dans `engine-core`**, l'option `occlusion` du `Renderer`, plutôt que `scene.occlusion` : toute source, et l'accès aux passes et à la profondeur (§4).
4. **Pas de MSAA avec l'occlusion** pour l'instant (erreur claire) (§8).

## 10. État

**Faite** (14 octobre 2026) : `engine-occlusion` (`OcclusionCulling`), `std.textureLoad` et `std.textureLoadDepth` sur les trois backends, `RenderGraph({ size })` et `pixelSize`, l'option `occlusion` et `ViewStats.occluded` du `Renderer`, l'optimisation des variantes de passe. La démo `city` (web : `/city` ; natif : `city`, `city-no-occlusion`), avec la vue du culling en incrustation (`CullingView`) et la touche O. Le tutoriel « Occlusion culling » (EN, FR) avec son exemple vivant et ses captures ; les guides du scene graph, du render graph et du material graph. Reste la suite du §8.
