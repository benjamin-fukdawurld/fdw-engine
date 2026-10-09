# Évolutions envisagées et compatibilité

Fonctionnalités du moteur non planifiées, notées pour que les prochaines étapes (render graph, compute graph, backends natifs, nœuds d'éclairage) restent compatibles avec elles autant que possible. Les références « § » sans lien renvoient à [material-graph.md](material-graph.md).

Les fonctionnalités suivantes ne sont pas planifiées. Elles sont notées pour que les prochaines étapes (render graph, compute graph, backends natifs, nœuds d'éclairage) restent compatibles avec elles autant que possible.

## 1. Un très grand nombre de lumières

Aujourd'hui, ajouter une lumière ne régénère pas le shader (`lightCount` est un uniform, la boucle est dynamique), mais deux limites existent :

- **Stockage** : 16 lumières au plus, dans des tableaux de taille fixe du bloc `frame` (WebGL2 ne garantit que 16 Ko de bloc uniform).
- **Performance** : chaque fragment évalue toutes les lumières. Le coût par pixel croît avec le nombre total de lumières, même lointaines.

Proposition, par étapes indépendantes :

1. **Portée des lumières et culling par objet sur CPU.** Une portée finie par lumière (l'atténuation `1/(c + l·d + q·d²)` ne s'annule jamais) ; le renderer ne passe à chaque objet que les lumières qui touchent sa sphère englobante.
2. **Stockage de taille variable** : storage buffer en WebGPU, texture de données (RGBA32F, lue par `texelFetch`) en WebGL2, selon `BackendCapabilities.storageBuffers`. Nouvelle opération de lecture indexée dans l'IR, traduite par chaque backend.
3. **Clustered forward shading (Forward+)** : le volume de vue est découpé en clusters (par exemple 16 × 9 × 24, profondeur logarithmique). Une passe de culling calcule la liste des lumières de chaque cluster ; le fragment ne boucle que sur la liste du sien. Le coût par pixel dépend du nombre de lumières qui le touchent, pas du nombre total. Les lumières directionnelles restent dans une liste globale.
4. **Culling en compute shader** sur WebGPU, comme première passe du compute graph. Le culling sur CPU reste le chemin de WebGL2.

**Compatibilité** : `light.current` et `light.sum` gardent leur sémantique (« les lumières qui éclairent ce fragment ») ; seule la traduction de `loop-sum` change (itération sur la liste du cluster, avec une indirection d'index). Les graphes et les shading models n'ont pas à changer. Les ombres restent une limite à part : seules quelques lumières en projettent.

## 2. Le ray tracing

Un rendu par ray tracing parcourt les pixels et lance des rayons dans toute la scène, là où la rastérisation dessine les objets un par un. Il demande :

- **toute la scène sur le GPU à la fois**, dans des structures d'accélération (BVH) ;
- **tous les matériaux accessibles à la fois** : au point d'impact, le shader évalue le matériau de l'objet touché, quel qu'il soit ;
- **un éclairage non local** : ombres, reflets et lumière indirecte par de nouveaux rayons.

| Partie du moteur                                                                    | Réutilisable                                               | À faire évoluer                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scène (`engine-core`) : meshs, transforms, caméras, lumières, valeurs des matériaux | Telle quelle                                               | —                                                                                                                                                                                     |
| Surface du material graph (`baseColor`, `normal`, `emissive`…)                      | Telle quelle : elle décrit ce qu'est le matériau           | —                                                                                                                                                                                     |
| Types, IR, générateurs                                                              | Le principe : un shader d'impact est du code linéaire typé | Nouvelles opérations (lancer un rayon), mip explicite (pas de dérivées d'écran dans les shaders d'impact)                                                                             |
| Shading models                                                                      | —                                                          | Une cible **BSDF** (évaluation, tirage d'une direction, densité) au lieu d'une couleur finale calculée par la boucle de lumières                                                      |
| Stages et fréquences                                                                | —                                                          | Pas de découpage vertex / fragment : les attributs sont interpolés au point d'impact (coordonnées barycentriques)                                                                     |
| Slots `frame` / `material` / `object`                                               | —                                                          | Tables indexées par l'identifiant de l'objet touché ; accès **bindless** aux textures                                                                                                 |
| `RenderBackend`                                                                     | Buffers, textures, samplers                                | Structures d'accélération (construction, mise à jour) ; pipelines ray tracing ou ray queries                                                                                          |
| `Renderer`                                                                          | —                                                          | Rastérisation pure (un draw par objet, tri des transparents, depth buffer) : le ray tracing serait une autre technique de rendu, orchestrée par le render graph                       |
| Backends                                                                            | —                                                          | WebGPU n'a pas de ray tracing standard. Vulkan (`VK_KHR_ray_tracing_pipeline`, `VK_KHR_ray_query`), DirectX 12 (DXR), Metal ; générateurs GLSL avec extensions ray tracing, HLSL, MSL |

Trois niveaux d'ambition :

| Approche                 | Principe                                                                                                                              | Changement architectural                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Hybride**              | La rastérisation reste ; des rayons lancés depuis le fragment shader (ray queries) pour les ombres, les reflets, l'occlusion ambiante | Modéré : une ressource « structure d'accélération », un nœud `rayQuery`, une capacité du backend              |
| **Ray tracing logiciel** | BVH dans des storage buffers, parcouru en compute shader, possible en WebGPU                                                          | Moyen : storage buffers et compute graph, déjà prévus                                                         |
| **Path tracer complet**  | Toute l'image par rayons et rebonds                                                                                                   | Important : une seconde technique de rendu à côté de la rastérisation (BSDF, bindless, pipelines ray tracing) |

Le chemin le plus réaliste est l'hybride, sur le backend Vulkan, après la phase 6.

## 3. Contraintes de compatibilité pour les prochaines étapes

Pour garder ces évolutions possibles sans refonte :

1. **Render graph** : il doit accueillir d'autres passes que « un draw par objet » : passes compute (culling des lumières, ray tracing logiciel), passes ray tracing, plein écran. Le `Renderer` actuel devient une technique parmi d'autres.
2. **Séparation surface / éclairage** : le matériau décrit sa surface ; l'éclairage est inséré par le compilateur derrière `output.surface`. Les futurs nœuds de modèles d'éclairage (§16, question 2) doivent rester remplaçables, pour pouvoir compiler la même surface vers une cible BSDF.
3. **Accès aux lumières par `light.current` / `light.sum` uniquement** : aucun graphe ne doit dépendre de la disposition des tableaux de lumières, pour pouvoir passer aux storage buffers et aux clusters.
4. **Ressources indexées (bindless)** : textures en tableaux, matériaux dans des buffers indexés. Utiles au clustered forward, à la réduction des draw calls et au ray tracing, à prévoir dans l'API abstraite comme capacité du backend.
5. **Capacités des backends** : chaque fonctionnalité optionnelle (storage buffers, compute, ray queries, bindless, `f16`) est une capacité consultée à la compilation et au rendu, avec un repli ou une erreur explicite.
