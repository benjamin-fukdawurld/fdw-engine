# Ce qui reste à faire

Les sujets mis de côté pendant le material graph, le compute graph et le render graph, et ceux prévus pour plus tard. Chaque ligne renvoie au document qui la détaille. La phase 6 (backends natifs) passe d'abord ; ces sujets viendront ensuite, dans un ordre à choisir.

## 1. Scène : meshes, scenegraph et culling (prévu)

Le design du scenegraph, du frustum culling, de l'octree et des objets statiques est dans [scenegraph.md](scenegraph.md).

Le moteur ne connaît aujourd'hui que des `RenderItem` à plat (`{ mesh, material, transform }`), donnés à chaque frame. Il faudra :

- **Une API de scenegraph minimaliste**, utilisable aussi bien pour un jeu que pour de la CAO, du BIM ou de la visualisation : une hiérarchie de nœuds avec leurs transformations, des objets qui portent un mesh et un matériau, des bornes par nœud. Elle doit rester petite : pas de logique de jeu, pas de format de fichier imposé. Les besoins de la CAO et du BIM pèsent sur le design : très grand nombre d'objets, identifiants stables pour la sélection, hiérarchies profondes, mises à jour partielles, précision des grandes coordonnées.
- **La gestion des meshes** : chargement (glTF), formats de sommets, bornes calculées une fois (`meshBounds` existe déjà pour les ombres), partage entre objets, instancing.
- **Le frustum culling** : ne pas préparer ni dessiner les objets hors du champ, grâce aux bornes de la hiérarchie. Il servira aussi aux tuiles d'ombre (un culling par lumière).
- **Le culling sur le GPU** ensuite, avec des draws indirects ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), quand le nombre d'objets le demande.
- **L'occlusion culling**, peut-être : ne pas dessiner ce qui est caché par d'autres objets (Hi-Z construit par une passe de calcul, ou requêtes d'occlusion). Décisif pour la CAO et le BIM (bâtiments, assemblages), où l'essentiel de la scène est caché.

Fait (voir le plan du design) : la géométrie (`engine-geometry` : volumes, GJK, octree), le culling des vues dans le `Renderer`, le cœur ECS et la scène (`engine-scene`). Reste :

- **Création en lot** des entités de la scène, écrivant directement les colonnes : 100 000 nœuds statiques coûtent aujourd'hui 485 ms par la façade, dont 100 ms d'octree.
- **Le package `engine-occlusion`** : Hi-Z sur le GPU (relecture ou pilotée par le GPU, à choisir), le CPU en repli ([scenegraph §5.5](scenegraph.md#55-locclusion-culling-plus-tard)).
- **Batching statique et instancing**, à partir des entités statiques.
- **Événements de la scène** pour les éditeurs (ce qui a changé), et un BVH pour les scènes statiques de CAO et de BIM.

La vue de scène du render graph ([render-graph §10.2](render-graph.md#102-la-vue-de-scène)) en est le point d'entrée : les passes reçoivent déjà les objets visibles d'une caméra, triés.

## 2. Render graph

Détails dans [render-graph.md §13](render-graph.md#13-plan-dimplémentation).

- **RG6. Culling des lumières** (clustered forward), avec un repli pour WebGL2, qui n'a pas de calcul ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)).
- Ombres : lumières ponctuelles (six faces), cascades pour les grandes scènes (CSM), culling des objets par tuile.
- Transitions initiales des ressources importées (backends à synchronisation explicite : utile avec Vulkan).
- Coût de la clé structurelle du graphe, si les graphes grossissent.

## 3. Compute graph

Détails dans [compute-graph.md](compute-graph.md).

- Un dispatch de compute graph dans une passe du render graph : `addComputePass` ne donne que l'encodeur, il faut aujourd'hui créer le pipeline et les bind groups à la main (ce que fait `ComputeRunner` hors du graphe). Une méthode `ComputeRunner.record(pass, program, dispatch)`, ou une `addComputeGraphPass`, comme `addFullscreenPass` pour les matériaux.
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

## 6. Backends natifs : les suites de la phase 6

Détails dans [native-backends.md](native-backends.md).

- **Plateformes** : Windows (lien de l'addon avec `node.lib`, surface Win32, DXC du SDK) et macOS (Vulkan par MoltenVK, surface Metal par `SDL_Metal_CreateView` ; ou Dawn construit). Construire et tester sur ces plateformes en CI.
- **Binaires précompilés** des addons par plateforme (prebuildify ou équivalent), pour installer sans CMake ni compilateur ; application en un seul exécutable (Single Executable Applications de Node).
- **Tests sans GPU** : la suite de rendu sur lavapipe (Vulkan logiciel de Mesa) en CI.
- **N5** : Dawn sans copie (construire Dawn), Direct3D 12 avec le même HLSL (le nombre de workgroups devra venir d'une constante du moteur).
- **Vulkan, performances** (à mesurer d'abord) :
  - un anneau de transfert plutôt qu'un buffer par écriture ;
  - un `VkPipelineCache` persisté sur disque, et la précompilation des programmes (phase 7) pour éviter DXC au démarrage ;
  - moins de descriptor sets (pools par frame, descriptors dynamiques pour les uniforms par objet), puis le bindless (descriptor indexing ou descriptor buffers) ;
  - l'attente des relectures et des frames hors du thread JavaScript (fonctions threadsafe de Node-API) plutôt que par sondage ;
  - les transitions calculées par le render graph pour grouper les barrières.
- **Vulkan, fonctionnalités** : génération des mipmaps, textures de stockage, requêtes de timestamps (profilage GPU), `VK_EXT_swapchain_maintenance1` et `VK_KHR_present_wait` (latence et cadence des frames).
- **La démo native** : contrôles de caméra au clavier et à la souris, choix de la scène et du backend à chaud.

## 7. Documentation

Le site de documentation (`apps/docs`, Astro + Starlight, en anglais et en français) :

- **Publication** : construire le site en CI et le publier (GitHub Pages, sous `/fdw-engine/`, déjà configuré dans `astro.config.mjs`).
- **Vérifications en CI** : les liens internes (le plugin `starlight-links-validator`), et les exemples vivants rendus dans Chromium headless (WebGL2, et WebGPU par SwiftShader), avec une capture comparée à une référence.
- **Contenu à venir** : le chargement de modèles (l'importeur OBJ de la démo), le scenegraph et le culling quand ils existeront, l'IBL ; une page de dépannage (WebGPU absent, addon introuvable, SDK Vulkan).
- **Exemples** : un contrôle de caméra à la souris, et un bouton pour passer d'un backend à l'autre sans recharger la page.
- La référence API n'est générée qu'en anglais (commentaires des sources) : les pages françaises y renvoient.

## 8. Plus loin

- Un très grand nombre de lumières, le ray tracing, le rendu piloté par le GPU, la sortie HDR et le travail en parallèle sur le GPU : [evolutions.md](evolutions.md).
- La précompilation des programmes (phase 7 du material graph).
