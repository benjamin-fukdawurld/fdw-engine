# Ce qui reste à faire

Les sujets mis de côté pendant le material graph, le compute graph et le render graph, et ceux prévus pour plus tard. Chaque ligne renvoie au document qui la détaille. La phase 6 (backends natifs) passe d'abord ; ces sujets viendront ensuite, dans un ordre à choisir.

## 1. Scène : meshes, scenegraph et culling (prévu)

Le design du scenegraph, du frustum culling, de l'octree et des objets statiques est dans [scenegraph.md](scenegraph.md).

Le moteur ne connaît aujourd'hui que des `RenderItem` à plat (`{ mesh, material, transform }`), donnés à chaque frame. Il faudra :

- **Une API de scenegraph minimaliste**, utilisable aussi bien pour un jeu que pour de la CAO, du BIM ou de la visualisation : une hiérarchie de nœuds avec leurs transformations, des objets qui portent un mesh et un matériau, des bornes par nœud. Elle doit rester petite : pas de logique de jeu, pas de format de fichier imposé. Les besoins de la CAO et du BIM pèsent sur le design : très grand nombre d'objets, identifiants stables pour la sélection, hiérarchies profondes, mises à jour partielles, précision des grandes coordonnées.
- **La gestion des meshes** : chargement (glTF), formats de sommets, bornes calculées une fois (`meshBounds` existe déjà pour les ombres), partage entre objets, instancing.
- **Le frustum culling** : ne pas préparer ni dessiner les objets hors du champ, grâce aux bornes de la hiérarchie. Il servira aussi aux tuiles d'ombre (un culling par lumière).
- **Le culling sur le GPU** ensuite, avec des draws indirects ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), quand le nombre d'objets le demande.
- **L'occlusion culling** : ne pas dessiner ce qui est caché par d'autres objets. Décisif pour la CAO et le BIM (bâtiments, assemblages), où l'essentiel de la scène est caché. _Fait_ (P3, voir plus bas).

Fait (voir le plan du design) : la géométrie (`engine-geometry` : volumes, GJK, octree), le culling des vues dans le `Renderer`, le cœur ECS et la scène (`engine-scene`). Reste :

- **Le coût d'un déplacement de nœud** par la façade : environ 90 ns de plus par nœud depuis le pool de transforms (0,58 → 0,67 ms pour 1 000 nœuds, [scenegraph §16.4](scenegraph.md#164-résultats)). Pistes : alléger la chaîne `Transform` → pool → scène (notification), ou des écritures groupées.
- **Création en lot** des entités de la scène, écrivant directement les colonnes : _faite_ (P1, `scene.createBatch()`, `world.addMany()`). 100 000 nœuds statiques : 485 → 383 ms par la façade (objets de rendu paresseux, bornes écrites en place), 241 ms en lot ; le reste est le calcul des matrices, des bornes et de l'octree.
- **Le package `engine-occlusion`** : _fait_ (P3, [p3-occlusion.md](p3-occlusion.md)) : Hi-Z en passes plein écran, relu sans attendre, sur les trois backends. Reste : les deux phases sans retard pilotées par le GPU (draws indirects), la pyramide en une passe de calcul, le MSAA, le culling des projeteurs d'ombres.
- **Le package `engine-tessellation`** : _fait_ (P3b, [p3b-tessellation.md](p3b-tessellation.md)) : des patchs aux niveaux choisis par arête sur le CPU, générés dans le vertex shader, sur les trois backends. Reste : les draws indirects (que P3b n'a finalement pas eu à ajouter) et le choix des niveaux en calcul, les patchs triangulaires (Phong tessellation, PN triangles), les concurrent binary trees, les ombres des patchs hors de la vue.
- **Instancing** : _fait_ (P1, [p1-objects.md](p1-objects.md)).
- **Batching statique** par cellule d'octree : reporté de P1 à la phase **P12** de la [roadmap](roadmap.md#p12-batching-statique). L'instancing couvre les objets qui partagent mesh et matériau ; le batching ne sert qu'aux scènes statiques hétérogènes (CAO, BIM, décors faits main). Coûts : géométrie dupliquée, culling par cellule, sélection dans un mesh fusionné (identifiant par sommet). À comparer d'abord avec le rendu piloté par le GPU.
- **Événements de la scène** pour les éditeurs (ce qui a changé), et un BVH pour les scènes statiques de CAO et de BIM.

La vue de scène du render graph ([render-graph §10.2](render-graph.md#102-la-vue-de-scène)) en est le point d'entrée : les passes reçoivent déjà les objets visibles d'une caméra, triés.

## 2. Render graph

Détails dans [render-graph.md §13](render-graph.md#13-plan-dimplémentation).

- **RG6. Culling des lumières** (clustered forward), avec un repli pour WebGL2, qui n'a pas de calcul ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)). Avec lui, un **pool de lumières** disposé comme la structure GPU des lumières, comme le pool de transforms ([scenegraph §16](scenegraph.md#16-le-pool-de-transforms)) : des centaines de lumières envoyées d'un bloc dans un storage buffer.
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
- Outils : validation du code généré en CI (_fait, P0_ : le WGSL par Tint dans Dawn, le GLSL ES par `glslangValidator`, le HLSL par DXC ; naga écarté, voir [ci.md §3](ci.md#3-ciyml--les-vérifications)), source maps nœud ↔ ligne, limite du nombre de variantes et préchauffage.
- Transparence indépendante de l'ordre (OIT), à étudier.
- Constantes répétées dans le code généré.

## 5. Performance

- WebGPU est plus lent que WebGL2 dans Chrome sur la démo. C'est probablement lié à Chrome, et ce n'est pas une priorité. Si l'écart devient gênant, profiler d'abord les écritures de buffer et les bind groups par objet. Confirmé sur le jeu du labyrinthe (L4) : peu d'images par seconde en WebGPU dans le navigateur, alors que WebGL2 et le même backend sur Dawn natif sont rapides. Le code TypeScript est le même : c'est le coût de chaque appel dans le navigateur (passage d'un processus à l'autre) qui se multiplie par le nombre d'appels par objet. Pistes : regrouper les uniforms d'objets dans un seul buffer écrit une fois par frame (offsets dynamiques), moins de `setBindGroup`, l'instancing.
- Le coût CPU par objet du `Renderer` se voit sur le labyrinthe (étape L1 du jeu) : environ 800 objets visibles et 2900 projeteurs d'ombre par frame, 89 images par seconde sur Vulkan. Pistes : la distance d'ombre (ou des cascades), l'instancing des murs, et le coût par objet lui-même ([material-graph-v2 §2](material-graph-v2.md#2-mesures-de-performance)) : réutiliser les buffers d'uniforms CPU, alléger les vérifications des valeurs en cache.

## 6. Backends natifs : les suites de la phase 6

Détails dans [native-backends.md](native-backends.md).

- **Plateformes** : Windows (lien de l'addon avec `node.lib`, surface Win32, DXC du SDK) et macOS (Vulkan par MoltenVK, surface Metal par `SDL_Metal_CreateView` ; ou Dawn construit). Construire et tester sur ces plateformes en CI.
- **Binaires précompilés** des addons par plateforme (prebuildify ou équivalent), pour installer sans CMake ni compilateur ; application en un seul exécutable (Single Executable Applications de Node).
- **Tests sans GPU** : la suite de rendu sur lavapipe (Vulkan logiciel de Mesa) en CI. _Fait : P0_ ([ci.md §3](ci.md#3-ciyml--les-vérifications)).
- **N5** : Dawn sans copie (construire Dawn), Direct3D 12 avec le même HLSL (le nombre de workgroups devra venir d'une constante du moteur).
- **Vulkan, performances** (à mesurer d'abord) :
  - un anneau de transfert plutôt qu'un buffer par écriture ;
  - un `VkPipelineCache` persisté sur disque, et la précompilation des programmes (phase 7) pour éviter DXC au démarrage ;
  - moins de descriptor sets (pools par frame, descriptors dynamiques pour les uniforms par objet), puis le bindless (descriptor indexing ou descriptor buffers) ;
  - l'attente des relectures et des frames hors du thread JavaScript (fonctions threadsafe de Node-API) plutôt que par sondage ;
  - les transitions calculées par le render graph pour grouper les barrières.
- **Vulkan, fonctionnalités** : génération des mipmaps (_fait_ : `vkCmdBlitImage`, voir [render graph §6.1](render-graph.md#61-ressources)), textures de stockage, requêtes de timestamps (profilage GPU), `VK_EXT_swapchain_maintenance1` et `VK_KHR_present_wait` (latence et cadence des frames).
- **La démo native** : contrôles de caméra au clavier et à la souris, choix de la scène et du backend à chaud.

## 7. Documentation

Le site de documentation (`apps/docs`, Astro + Starlight, en anglais et en français) :

- **Publication** : construire le site en CI et le publier (GitHub Pages, sous `/fdw-engine/`, déjà configuré dans `astro.config.mjs`). _Fait : P0_ ([ci.md §4](ci.md#4-docsyml--la-documentation)).
- **Vérifications en CI** : les liens internes (le plugin `starlight-links-validator`), et les exemples vivants rendus dans Chromium headless (WebGL2, et WebGPU par SwiftShader), avec une capture comparée à une référence. _Fait : P0._
- **Contenu à venir** : le chargement de modèles (l'importeur OBJ de la démo), le scenegraph et le culling quand ils existeront, l'IBL ; une page de dépannage (WebGPU absent, addon introuvable, SDK Vulkan).
- **Exemples** : un contrôle de caméra à la souris, et un bouton pour passer d'un backend à l'autre sans recharger la page.
- La référence API n'est générée qu'en anglais (commentaires des sources) : les pages françaises y renvoient.

## 8. Le jeu de démonstration et l'entrée

- **Murs transparents** : rendre semi-transparents (0 < alpha < 1) les murs entre la caméra et le personnage, qui peuvent le cacher ([scenegraph §11](scenegraph.md#11-les-démos)). Un rayon ou un volume de la caméra au personnage trouve ces murs ; leur matériau passe en `blend`, avec un alpha qui revient en douceur quand ils ne cachent plus rien.
- **Gestion des entrées, manettes comprises** : _faite_ ([input.md](input.md)) — `engine-input`, `engine-input-web`, `engine-input-native`, le labyrinthe jouable à la manette. Restent hors du périmètre : les vibrations, le verrouillage du pointeur, les contextes d'actions, le texte saisi (input.md §6).

- **Un ordonnanceur de systèmes ECS** (`Scheduler` dans `engine-scene`) : des systèmes ordonnés, une boucle à pas fixe pour la logique, le rendu à la cadence de l'écran. Pour L4, les systèmes sont de simples fonctions `(world, dt) => void` de la démo, et le pas fixe un petit helper : à étudier quand une deuxième application en aura besoin, en gardant l'ECS agnostique (CAO, BIM, jeu).

## 9. Vers un middleware de création 3D

Le plan qui ordonne ces chantiers avec ceux des sections précédentes est dans [roadmap.md](roadmap.md).

L'objectif : que le moteur devienne les fondations d'un middleware de création de contenu 3D, des briques que les utilisateurs assemblent pour leurs applications (jeux, outils, CAO). Chaque brique a son design, validé avant l'implémentation.

- **Contrôleurs de caméra** : des « agents » généralistes qui déplacent une caméra de façon naturelle et configurable, pour plusieurs usages :

  - vue subjective (FPS) ;
  - troisième personne (TPS), avec un bras à ressort et des collisions ;
  - stratégie et tower defense (comme Age of Empires) ;
  - vue isométrique ;
  - orbite, panoramique et zoom vers le curseur (CAO) ;
  - vol libre.

  L'application décide comment elle relie ses entrées (les actions d'`engine-input`) aux intentions de la caméra : avancer, tourner, zoomer, orbiter. Des **contraintes** composables limitent les mouvements : un plan XZ seulement (tower defense, isométrique), des bornes, des distances et des angles minimum et maximum, les collisions. Les mouvements sont lissés (ressorts amortis), et l'on passe d'une caméra à l'autre en transition. Les `FlyCamera` et `FollowCamera` du labyrinthe en sont des ébauches.

- **Import de ressources** : un système abstrait pour charger des modèles, des images, des sons et d'autres ressources :

  - des chargeurs enregistrés par type ;
  - un chargement asynchrone, annulable, avec sa progression ;
  - un cache et des poignées partagées ;
  - les dépendances entre ressources (un glTF et ses textures) ;
  - des sources multiples : URL, fichiers, archives ;
  - le rechargement à chaud.

  Formats d'abord visés : les images (navigateur et natif) et glTF 2.0 (meshes, matériaux PBR vers le material graph, squelettes, animations). Les sons supposent un **moteur audio**, qui n'existe pas encore : WebAudio dans le navigateur, une bibliothèque native (SDL3 audio ou miniaudio).

- **Animation squelettique et animation graph** : le skinning dans le renderer, les clips (glTF), puis un graph d'animation : machines à états, mélanges (blend trees), couches, événements.
- **Graphs de comportement** (comme les blueprints d'Unreal) : de la logique écrite en graphs, avec un flux d'exécution déclenché par des événements et un flux de données. Le material graph a déjà l'infrastructure d'un graph typé (nœuds, ports, types, sérialisation) : un cœur de graph commun aux matériaux, aux animations et aux comportements est à étudier. Les comportements s'appuieraient sur les systèmes de l'ECS (voir l'ordonnanceur, §8). Un éditeur visuel viendra plus tard.
- **L'éditeur** : l'application de modélisation devient la base de l'éditeur du middleware (scènes, ressources, matériaux, animations, comportements).
- **Démos à venir** :
  1. **Un FPS minimaliste**. Il a besoin du contrôleur de caméra FPS, du verrouillage du pointeur (input §6), de collisions d'une capsule contre le décor, et de tirs par rayons.
  2. **Un jeu à la troisième personne** : le joueur combat des ennemis à l'épée dans une forêt. Il a besoin du contrôleur TPS, de l'import glTF, de l'animation squelettique et de l'animation graph, de l'instancing pour la forêt, et de volumes d'attaque.
  3. **Une application de modélisation 3D**, dans l'esprit de FreeCAD : dessiner une esquisse 2D, puis lui appliquer des opérations (extrusion, révolution autour d'un axe…). C'est le projet final. Elle a besoin d'un noyau géométrique (profils 2D, extrusion, révolution, triangulation des faces ; plus tard les booléens) **derrière une API abstraite** : l'utilisateur branche le moteur géométrique de son choix, et le projet n'a pas de grosse dépendance en dur (OpenCascade en WASM, par exemple, serait un moteur parmi d'autres, pas une dépendance du moteur), de contraintes d'esquisse, d'un arbre d'historique paramétrique, de la sélection et de gizmos, d'un système de commandes avec annuler et refaire, et d'une interface.

## 10. Plus loin

- Un très grand nombre de lumières, le ray tracing, le rendu piloté par le GPU, la sortie HDR et le travail en parallèle sur le GPU : [evolutions.md](evolutions.md).
- La précompilation des programmes (phase 7 du material graph).
