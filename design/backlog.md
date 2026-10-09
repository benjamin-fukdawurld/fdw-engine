# Ce qui reste à faire

Les sujets mis de côté pendant le material graph, le compute graph et le render graph, et ceux prévus pour plus tard. Chaque ligne renvoie au document qui la détaille. La phase 6 (backends natifs) passe d'abord ; ces sujets viendront ensuite, dans un ordre à choisir.

## 1. Scène : meshes, scenegraph et culling (prévu)

Le moteur ne connaît aujourd'hui que des `RenderItem` à plat (`{ mesh, material, transform }`), donnés à chaque frame. Il faudra :

- **Une API de scenegraph minimaliste**, utilisable aussi bien pour un jeu que pour de la CAO, du BIM ou de la visualisation : une hiérarchie de nœuds avec leurs transformations, des objets qui portent un mesh et un matériau, des bornes par nœud. Elle doit rester petite : pas de logique de jeu, pas de format de fichier imposé. Les besoins de la CAO et du BIM pèsent sur le design : très grand nombre d'objets, identifiants stables pour la sélection, hiérarchies profondes, mises à jour partielles, précision des grandes coordonnées.
- **La gestion des meshes** : chargement (glTF), formats de sommets, bornes calculées une fois (`meshBounds` existe déjà pour les ombres), partage entre objets, instancing.
- **Le frustum culling** : ne pas préparer ni dessiner les objets hors du champ, grâce aux bornes de la hiérarchie. Il servira aussi aux tuiles d'ombre (un culling par lumière).
- **L'occlusion culling**, peut-être : ne pas dessiner ce qui est caché par d'autres objets (Hi-Z construit par une passe de calcul, ou requêtes d'occlusion). Décisif pour la CAO et le BIM (bâtiments, assemblages), où l'essentiel de la scène est caché.

La vue de scène du render graph ([render-graph §10.2](render-graph.md#102-la-vue-de-scène)) en est le point d'entrée : les passes reçoivent déjà les objets visibles d'une caméra, triés.

## 2. Render graph

Détails dans [render-graph.md §13](render-graph.md#13-plan-dimplémentation).

- **RG6. Culling des lumières** (clustered forward), avec un repli pour WebGL2, qui n'a pas de calcul ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)).
- Ombres : lumières ponctuelles (six faces), cascades pour les grandes scènes (CSM), culling des objets par tuile.
- Transitions initiales des ressources importées (backends à synchronisation explicite : utile avec Vulkan).
- Coût de la clé structurelle du graphe, si les graphes grossissent.

## 3. Compute graph

Détails dans [compute-graph.md](compute-graph.md).

- Storage textures (écriture d'images par les kernels).
- Repli WebGL2 des storage buffers (texture de données lue par `texelFetch`).

## 4. Material graph

Détails dans [material-graph-gaps.md](material-graph-gaps.md) et [material-graph-v2.md](material-graph-v2.md).

- **Éclairage par environnement (IBL)** : cubemap, irradiance, specular préfiltré, table BRDF. C'est l'écart le plus visible.
- Fonctions : entrées génériques, puis de vraies fonctions dans le code généré.
- `f16` de bout en bout, `frag-coord` en WebGL2, structures dans les storage buffers.
- Outils : validation du code généré en CI (naga, `glslangValidator`, DXC), source maps nœud ↔ ligne, limite du nombre de variantes et préchauffage.
- Transparence indépendante de l'ordre (OIT), à étudier.
- Constantes répétées dans le code généré.

## 5. Performance

- WebGPU est plus lent que WebGL2 dans Chrome sur la démo. C'est probablement lié à Chrome, et ce n'est pas une priorité. Si l'écart devient gênant, profiler d'abord les écritures de buffer et les bind groups par objet.
- Le coût CPU par objet du `Renderer` ([material-graph-v2 §2](material-graph-v2.md#2-mesures-de-performance)) : réutiliser les buffers d'uniforms CPU, alléger les vérifications des valeurs en cache.

## 6. Plus loin

- Un très grand nombre de lumières et le ray tracing : [evolutions.md](evolutions.md).
- La précompilation des programmes (phase 7 du material graph).
