# P3b : la tessellation par patchs instanciés

Le design de la phase P3b de la [roadmap](roadmap.md#p3b-tessellation) : du displacement adaptatif et un terrain, sans tessellation matérielle. Il compare les alternatives annoncées par la roadmap et tranche entre le chemin prévu (calcul et draws indirects en WebGPU et Vulkan, rendu dans une texture en WebGL2) et un chemin unique.

Contraintes : un seul chemin pour les trois backends ; rien que WebGL2 ne puisse tenir ; pas de fissure ; pas de sommet généré par frame ; le reste du moteur (matériaux, ombres, sorties de scène) inchangé.

## 1. Aujourd'hui

| Ce qui existe                                                                         | Ce qui manque                                                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Le displacement mapping de P2b (`stdMacros.displacement`), sur un mesh déjà subdivisé | Un vertex stage qui ne lit pas ses sommets dans un mesh                                                        |
| `std.textureLoad` dans tous les stages (P3), les textures `rgba32float`               | Un draw sans vertex buffer dont le nombre de sommets change à chaque frame                                     |
| Le builtin `vertex-index` sur les trois backends                                      | Les draws indirects                                                                                            |
| L'instanciation des objets par la table des objets                                    | Une instanciation libre : l'index d'instance est celui de la ligne de l'objet (`instances[firstInstance + i]`) |

## 2. Les options

| Option                                   | Principe                                                                                                                                  | Intérêt                                                                                    | Coût                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Tessellation matérielle                  | Hull et domain shaders                                                                                                                    | Le GPU fait tout                                                                           | Ni WebGPU, ni WebGL2, ni Metal sous cette forme : écartée par la roadmap                        |
| Subdivision sur le CPU au chargement     | Un mesh fin                                                                                                                               | Rien à ajouter                                                                             | Pas adaptatif : la densité est partout celle du plus proche                                     |
| **A. Patchs instanciés, niveaux du CPU** | Des gabarits 1 à 64 ; le CPU choisit les niveaux par arête ; un draw génère les sommets depuis leur numéro                                | **Un seul chemin, WebGL2 compris** ; exact (pas de choix par groupe) ; un draw par surface | Le choix sur le CPU, 0,4 ms pour 4096 patchs (§6)                                               |
| B. Patchs instanciés, niveaux du GPU     | Une passe de calcul range les patchs par gabarit et écrit des draws indirects ; en WebGL2, un choix par groupe et une texture de facteurs | Rien sur le CPU                                                                            | Deux chemins (draws indirects absents de WebGL2) ; draws indirects à ajouter aux trois backends |
| C. Concurrent binary trees (Dupuy, 2020) | Une subdivision adaptative entièrement sur le GPU                                                                                         | Sans fissure par construction, très fine                                                   | Calcul obligatoire : pas de WebGL2 ; la suite pour les grands terrains                          |

**Choix : A.** Comme pour l'occlusion culling (P3), un seul chemin testé une fois vaut mieux que deux : le choix des niveaux coûte peu sur le CPU (il ne touche que les arêtes, pas les sommets), il est exact partout, et WebGL2 n'a besoin de rien d'autre. B devient une optimisation de WebGPU et Vulkan, quand les draws indirects existeront (§8) ; l'évaluation dans le vertex shader reste la même.

## 3. Le mécanisme

1. **Les gabarits** : un patch quadrilatère subdivisé en 2^n × 2^n quads, n de 0 à 6. Rien n'est stocké : un sommet connaît sa place dans son gabarit par son numéro (6 sommets par quad, deux triangles (0,0) (0,1) (1,1) et (0,0) (1,1) (1,0)).
2. **Le choix des niveaux** (`LevelSelection`), à chaque frame : les arêtes sont dédupliquées à la construction (une arête, deux patchs). Chaque arête reçoit le niveau qui donne des triangles d'environ `edgePixels` pixels à l'écran, vue depuis son point le plus proche de la caméra ; chaque patch, le niveau le plus fin de ses quatre arêtes. Les patchs dont la boîte, agrandie du déplacement maximal, est hors du frustum sont retirés.
3. **Le draw** : les patchs dessinés, triés par niveau, sont écrits dans une texture `rgba32float` (un texel : le patch, et le pas de la grille de chaque arête, 2^(niveau du patch − niveau de l'arête), deux par canal). Des uniforms donnent le premier sommet et le premier patch de chaque niveau. Un seul draw non indexé, sans vertex buffer, de Σ 6 · 4^n sommets.
4. **L'évaluation** (`patchVertex`), dans le vertex shader : le niveau du sommet (le nombre de débuts de niveau qu'il atteint, par `step` sur deux vec4), son patch, son quad et son coin par des divisions entières ; les points d'une arête ramenés sur la grille de son niveau (arrondi vers le bas, les coins ne bougent pas) ; les 8 texels du patch (`std.textureLoad`) : positions, normales et uv des coins ; l'interpolation bilinéaire ; le déplacement le long de la normale (`std.textureSampleLevel`) ; la normale de la surface déplacée par le produit vectoriel des tangentes, corrigées des pentes de la carte de hauteur (différences centrées, 4 lectures).

**Pas de fissure.** Les deux patchs d'une arête lui donnent le même niveau, et sur le plus fin les points de l'arête vont sur la grille de ce niveau : les deux côtés ont les mêmes points. Pour qu'ils aient les mêmes positions au bit près, l'interpolation est écrite a(1 − w) + bw, exactement a en 0 et b en 1, et les paramètres sont des rationnels dyadiques exacts ; deux voisins qui parcourent l'arête dans le même sens (`patchGrid`) donnent les mêmes valeurs.

**Pourquoi pas l'instanciation matérielle.** L'index d'instance appartient à la table des objets : l'instance i d'un draw lit la ligne `instances[firstInstance + i]`. Un attribut par instance pour les patchs demanderait un second mécanisme dans le `Renderer`. Le numéro de sommet suffit : les sommets d'un niveau sont consécutifs, la division par 6 · 4^n donne le patch.

## 4. L'API

```ts
const patches = patchGrid({ width, depth, columns, rows }); // ou new Patches([...quads])
const g = new GraphBuilder('terrain');
const vertex = patchVertex(g, { displacement: { texture, sampler, scale, bias, texel } });
// vertex.position, normal, uv, height, level ; les attributs position, normal et uv du graphe
const surface = new PatchSurface(backend, { patches, material, edgePixels, minLevel, maxLevel, displacement, cull, matrix });
surface.update(camera, { width, height }); // une fois par frame
renderer.render({ items: [surface], ... });
surface.stats; // { drawn, patches, triangles, levels }
```

- `PatchSurface` est un `WorldRenderItem` : son mesh n'a pas de vertex buffer, ses bornes sont agrandies du déplacement. Un matériau par surface : il porte ses textures et ses uniforms.
- Le package ne dépend que d'`engine-core`, `engine-shader`, `engine-backend` et `engine-geometry`.

## 5. Ce qu'il a fallu ajouter au moteur

- **Les attributs calculés** (`output.attribute`, `g.vertexAttribute(sémantique, valeur)`) : toutes les lectures d'un attribut (`input.attribute` du graphe, du vertex stage de la surface, des macros) lisent la valeur, calculée dans le vertex stage ; `hasAttribute.<sémantique>` est vrai. Une passe du compilateur après les macros ; refus d'un attribut calculé deux fois ou depuis lui-même. C'est le « mode patch » du material graph prévu par la roadmap, en plus général : tout sommet généré dans le shader s'en sert.
- **`Mesh.setVertexCount`** : le nombre de sommets d'un mesh non indexé change sans rien téléverser ; `Mesh.description` devient un accesseur.

Les draws indirects n'ont pas été nécessaires (§8).

## 6. Mesures

Le terrain de la démo (`terrain`), 32 × 32 patchs sur 1024 m, carte de hauteur 256², 120 m de relief, 1280 × 720, Vulkan, RTX 2060 SUPER, sans vsync :

|                    | Adaptatif | Tous au niveau le plus fin (5) |
| ------------------ | --------- | ------------------------------ |
| Patchs dans la vue | 465       | 468                            |
| Triangles          | 397 000   | 3 834 000                      |
| Images par seconde | 1141      | 664                            |

Le choix des niveaux (`PatchSurface.bench.ts`, 64 × 64 patchs, Node 24) : 0,41 ms par frame, 0,63 ms avec le retrait des patchs hors de la vue.

Le niveau 6 partout dépasserait les 2^24 sommets que le shader lit exactement (le numéro de sommet passe par un f32) : la surface baisse alors ses niveaux.

## 7. Tests

- **Compilateur** : les attributs calculés remplacent ceux de la surface, du graphe et des macros ; `hasAttribute` ; les étapes brutes ; les refus (deux fois, depuis lui-même, avec un plein écran).
- **`engine-tessellation`** (faux backend) : les arêtes partagées, les niveaux selon la distance et la matrice, l'orthographique, les bornes min et max, le retrait par le frustum et le déplacement ; les draws triés par niveau et leurs pas, les débuts des niveaux, un seul draw sans vertex buffer, les bornes, la croissance de la texture, la compilation sans attribut.
- **Suite de rendu, trois backends** : les uv d'une grille de patchs à leur place ; un terrain rugueux à plusieurs niveaux vu en biais, sans un pixel de fond (sans le ramènement des arêtes, une vingtaine de trous) ; la normale d'une rampe déplacée.
- **Documentation** : le tutoriel « Tessellation » (EN, FR), son exemple vivant et ses captures en WebGPU et WebGL2.

## 8. La suite

1. **Les draws indirects** (`drawIndirect` dans `GpuRenderPassEncoder`) et le choix des niveaux en calcul en WebGPU et Vulkan (option B), si le CPU devient le poste principal (des dizaines de milliers de patchs) ; WebGL2 garde A. Les draws indirects serviront aussi aux deux phases sans retard de l'occlusion culling.
2. **D'autres surfaces** : la Phong tessellation et les PN triangles sur des meshes quelconques (patchs triangulaires), les patchs de Bézier.
3. **Les concurrent binary trees** pour les grands terrains en WebGPU et Vulkan, sur la même évaluation.
4. **Les ombres** : des niveaux choisis aussi pour la lumière, ou une marge autour du frustum de la caméra pour les projeteurs hors de la vue.
5. **Le ray tracing** (P10) : écrire les sommets tessellés dans un buffer pour les BLAS.

## 9. Décisions

À valider :

1. **Un seul chemin, les niveaux choisis sur le CPU (A)**, plutôt que le calcul et les draws indirects en WebGPU et Vulkan et un rendu dans une texture en WebGL2 (§2).
2. **Les sommets générés depuis leur numéro**, pas par l'instanciation matérielle, qui appartient à la table des objets (§3).
3. **Les attributs calculés** comme mécanisme général du material graph, plutôt qu'un mode patch dédié (§5).
4. **Une sélection par frame**, celle de la caméra, pour toutes les vues et les ombres ; les patchs retirés ne projettent pas d'ombre (`cull: false`) (§8).

## 10. État

**Faite** (14 octobre 2026) : `engine-tessellation` (`Patches`, `patchGrid`, `LevelSelection`, `patchVertex`, `PatchSurface`), les attributs calculés du material graph, `Mesh.setVertexCount`. La démo `terrain` (web : `/terrain` ; natif : `terrain`, `terrain-uniform`), touches L (les niveaux) et T (tous au niveau le plus fin). Le tutoriel « Tessellation » (EN, FR) avec son exemple vivant et ses captures ; le guide du material graph (les attributs calculés) ; le lien depuis « Détails de surface ». Reste la suite du §8.
