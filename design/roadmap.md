# Plan de développement

Du moteur actuel à l'éditeur du middleware de création 3D. Ce plan ordonne les chantiers du [backlog](backlog.md) (y compris ceux laissés de côté jusqu'ici) et les nouveaux (caméras, ressources, animation, audio, comportements, démos, éditeur). Il sera revu à la fin de chaque phase.

## 1. Principes

- **Un design validé avant chaque brique**, avec les alternatives comparées (intérêt, coût). Ce plan fixe l'ordre, pas les solutions.
- **La performance et l'UX d'abord.** Une phase n'ajoute pas de contenu sur un socle qui ne tient pas la charge : les chantiers de performance passent avant les démos qui en ont besoin.
- **Chaque phase se termine par quelque chose de visible** : une démo jouable ou une étape de démo, ses pages de documentation (EN, FR), ses tests, et ses mesures quand la phase touche à la performance.
- **Des briques indépendantes et multi-domaines** : chaque package ne dépend que du nécessaire, et sert le jeu, la CAO, le BIM et les outils.
- **Compatible avec le ray tracing** : l'éditeur rendra en rastérisation, les jeux et le rendu final pourront rendre en ray tracing. Chaque phase respecte les contraintes du §6, pour que le ray tracing (P10) s'ajoute sans refonte.
- **Pas de grosse dépendance en dur** : quand une brique s'appuie sur une bibliothèque lourde (un noyau géométrique, un moteur physique, un moteur audio), le moteur définit une API abstraite et l'utilisateur branche l'implémentation de son choix. Le moteur fournit une implémentation de base.

## 2. Vue d'ensemble

| Phase | Contenu                                            | Livrable                                                        | Taille      |
| ----- | -------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| P0    | Socle : CI, publication de la doc, mesures         | La CI verte sur chaque changement, la doc en ligne              | Petite      |
| P1    | Performance : coût par objet, appels, instancing   | Le labyrinthe et la forêt bien plus rapides, WebGPU compris     | Moyenne     |
| P2    | Lumières et ombres à grande échelle, IBL           | Une démo de centaines de lumières                               | Grande      |
| P3    | Occlusion culling                                  | Une ville ou un bâtiment, l'essentiel caché                     | Moyenne     |
| P4    | Caméras, entrées, ordonnanceur ECS                 | **Démo FPS minimaliste**                                        | Moyenne     |
| P5    | Ressources : images, glTF                          | Des modèles chargés dans les démos                              | Grande      |
| P6    | Cœur de graph commun, animation et animation graph | Un personnage animé, ses états                                  | Grande      |
| P7    | Audio                                              | Des sons dans les démos, spatialisés                            | Moyenne     |
| P8    | Le jeu à la troisième personne                     | **Démo TPS : l'épée dans la forêt**                             | Moyenne     |
| P9    | Graphs de comportement                             | L'IA des ennemis du TPS en graphs                               | Grande      |
| P10   | Ray tracing : hybride, puis path tracer            | Les démos en ray tracing : Vulkan, WGSL logiciel en WebGPU      | Grande      |
| P11   | Plateformes et distribution                        | Windows, macOS, binaires précompilés                            | Moyenne     |
| P12   | Batching statique                                  | Moins de draws pour les scènes statiques hétérogènes (CAO, BIM) | Moyenne     |
| P13   | L'éditeur : la modélisation, puis le middleware    | **L'application de modélisation, base de l'éditeur**            | Très grande |

Les phases sont dans l'ordre de leurs dépendances (§4). Certaines peuvent se chevaucher : P11 peut avancer en fond dès P1, et P7 est indépendante de P5 et P6, sauf pour le chargement des sons.

## 3. Les phases

### P0. Socle

_Faite_ (branches `FDW-P0` et `FDW-P0-2`) : le design et ce qui a été fait sont dans [ci.md](ci.md).

Avant d'optimiser et d'ajouter des briques, que chaque changement soit vérifié automatiquement.

- **Un flux de travail par pull request** : plus de commit direct sur `main`, une CI verte exigée pour fusionner.
- **CI** : typecheck, lint et tests de tous les projets ; la suite de rendu sur lavapipe (Vulkan logiciel) et dans Chromium headless (WebGL2, et WebGPU par SwiftShader).
- **Documentation** : construction et publication (GitHub Pages), vérification des liens, captures des exemples vivants comparées à des références.
- **Outils du material graph** : validation du code généré en CI (le WGSL par Tint dans Dawn, le GLSL ES par glslang, le HLSL par DXC).
- **Mesures** : des benchmarks de référence suivis dans le temps (renderer, scène, labyrinthe), et les requêtes de timestamps GPU (Vulkan, WebGPU) pour profiler les passes.

### P1. Performance du rendu

_Faite_ : le design et les mesures sont dans [p1-objects.md](p1-objects.md). Les données d'objet dans une table indexée par instance (storage buffers, textures de données en WebGL2), l'instancing des objets qui partagent mesh et matériau, la création en lot (`scene.createBatch()`). Labyrinthe, étape 1 : de 89 à environ 171 fps sur Vulkan, de 42 à environ 122 fps sur Dawn. Reportés : le batching statique (P12) ; le coût d'un déplacement de nœud ([backlog §1](backlog.md#1-scène--meshes-scenegraph-et-culling-prévu)) ; la distance d'ombre, remplacée par les cascades de P2.

Le constat : environ 89 images par seconde sur l'étape 1 du labyrinthe (3700 draws), WebGPU lent dans le navigateur à cause du nombre d'appels par objet.

- **Le coût par objet du `Renderer`** : réutiliser les buffers d'uniforms CPU, alléger les vérifications des valeurs en cache ([material-graph-v2 §2](material-graph-v2.md#2-mesures-de-performance)).
- **Moins d'appels** : les uniforms des objets regroupés dans un seul buffer écrit une fois par frame (offsets dynamiques ou storage buffer indexé), moins de `setBindGroup` ; côté Vulkan, un anneau de transfert et des descriptors dynamiques. C'est le levier principal de WebGPU dans le navigateur.
- **Instancing** : les objets qui partagent mesh et matériau dessinés en un appel. Le batching statique est devenu P12.
- **La scène** : la création en lot (100 000 nœuds en 485 ms aujourd'hui), le coût d'un déplacement de nœud (environ 90 ns de plus depuis le pool de transforms).
- **Les ombres** : une distance d'ombre, en attendant les cascades (P2).

Critères : les mesures de P0 avant et après ; le labyrinthe et la forêt en WebGPU dans le navigateur au niveau de WebGL2.

### P2. Lumières et ombres à grande échelle

- **Nombre de lumières dynamique** (RG6) : un culling des lumières en clusters (clustered forward) par une passe de calcul, et un **pool de lumières** disposé comme leur structure GPU, comme le pool de transforms. Il remplace la limite de 16 lumières (`MaxLights`). WebGL2, qui n'a pas de calcul, aura un repli : le culling sur le CPU, et les lumières dans une texture de données ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)).
- **Prérequis** : les compute graphs dans le render graph (`addComputeGraphPass`), et le repli WebGL2 des storage buffers ([backlog §3](backlog.md#3-compute-graph)).
- **Ombres** : les lumières ponctuelles (six faces), les cascades (CSM) pour les grandes scènes, le culling des projeteurs par tuile.
- **Éclairage par environnement (IBL)** : cubemap, irradiance, spéculaire préfiltré, table BRDF. C'est l'écart de qualité le plus visible aujourd'hui.

### P3. Occlusion culling

- **Le package `engine-occlusion`** : le Hi-Z sur le GPU en deux phases (dessiner d'abord ce qui était visible, construire la pyramide de profondeur, tester le reste), et le CPU en repli pour WebGL2 ([scenegraph §5.5](scenegraph.md#55-locclusion-culling-plus-tard)). Le choix entre une relecture CPU et un rendu piloté par le GPU se fera dans son design.
- **Prérequis** : les textures de stockage (compute graph et Vulkan), la génération des mipmaps (_faite_ : `addMipmapPass` ; la pyramide Hi-Z demandera une réduction min/max par une passe de calcul plutôt qu'une moyenne).
- **Ensuite, selon les mesures** : le culling sur le GPU avec des draws indirects ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), et un BVH pour les scènes statiques de CAO et de BIM.

Démo : une scène dense où l'essentiel est caché (une ville, un bâtiment, un assemblage), avec la vue du culling comme dans le labyrinthe.

### P4. Caméras, entrées, ordonnanceur — démo FPS

- **Contrôleurs de caméra** ([backlog §9](backlog.md#9-vers-un-middleware-de-création-3d)) : FPS, TPS (bras à ressort, collisions), stratégie et isométrique (plan XZ), orbite CAO (pivot, panoramique, zoom vers le curseur), vol libre ; des intentions reliées par l'application à ses actions, des contraintes composables, des ressorts amortis, des transitions entre caméras.
- **Entrées** : le verrouillage du pointeur (déplacements relatifs), les contextes d'actions (menu, jeu), les vibrations ([input §6](input.md#6-hors-du-périmètre-prévu-par-lapi)).
- **L'ordonnanceur de systèmes ECS** : des systèmes ordonnés, la boucle à pas fixe intégrée.
- **Un contrôleur de personnage** : une capsule qui marche, saute, glisse le long des murs et monte les marches, contre les volumes de la scène. Une API abstraite pour brancher un moteur physique plus tard.
- **Restes du labyrinthe** : les murs transparents entre la caméra et le personnage (avec la caméra TPS), et la démo native (choix de la scène et du backend à chaud).

**Démo FPS minimaliste** : un niveau, des cibles ou des ennemis simples, le tir par rayons, la caméra FPS, souris et manette.

### P5. Ressources

- **Le système abstrait** : des chargeurs enregistrés par type, un chargement asynchrone, annulable, avec sa progression, un cache et des poignées partagées, les dépendances entre ressources, des sources multiples (URL, fichiers, archives), le rechargement à chaud.
- **Images** : décodage dans le navigateur et en natif, puis les textures compressées (KTX2, Basis). La génération des mipmaps et le filtrage anisotrope existent déjà (`mipLevelCount`, `maxAnisotropy`).
- **glTF 2.0** : meshes, matériaux PBR traduits en material graph, hiérarchie de nœuds ; les squelettes et les animations sont lus ici, et utilisés en P6.
- **Les formats de sommets** : tangentes, plusieurs jeux d'UV, couleurs ; le partage des meshes.
- **L'importeur OBJ** de la démo, repris comme un chargeur parmi d'autres.

Démo : la forêt avec des modèles chargés ; la page « Charger des modèles » de la doc.

### P6. Cœur de graph et animation

- **Un cœur de graph commun** : extraire du material graph ce qui est général (nœuds, ports typés, sérialisation, validation), pour les matériaux, les animations, les comportements (P9) et, plus tard, leurs éditeurs.
- **L'animation squelettique** : le skinning dans une passe de calcul, dont les sommets servent au rendu, aux ombres et plus tard au ray tracing (§6) — en WebGL2, sans calcul, le repli est le transform feedback ou le vertex shader —, les clips de glTF, l'échantillonnage et les mélanges.
- **L'animation graph** : machines à états, mélanges (blend trees), couches et masques, événements (un pas, un coup d'épée).

### P7. Audio

- **Un moteur audio abstrait** et deux implémentations : WebAudio dans le navigateur, SDL3 audio (ou miniaudio) en natif, comme pour les entrées.
- Sons ponctuels et continus, mixage par bus, spatialisation (la position de l'écouteur suit la caméra), streaming des musiques.
- Les sons chargés par le système de ressources (P5).

### P8. Démo TPS : l'épée dans la forêt

Elle réunit les phases précédentes : la forêt instanciée (P1), les ombres en cascades (P2), l'occlusion par les arbres et le relief (P3), la caméra TPS et le contrôleur de personnage (P4), les modèles (P5), l'animation graph (P6), les sons (P7). En plus : des volumes d'attaque et de dégâts, une IA d'ennemis écrite en systèmes ECS. Un terrain (heightmap) sera sans doute à ajouter.

### P9. Graphs de comportement

- Sur le cœur de graph de P6 : un flux d'exécution déclenché par des événements et un flux de données, comme les blueprints d'Unreal.
- Leur exécution : interprétés, ou compilés en JavaScript (à comparer), et intégrés à l'ordonnanceur ECS (un graph est un système).
- Le débogage : l'état des nœuds pendant l'exécution, des points d'arrêt.
- Validation : l'IA des ennemis du TPS réécrite en graphs.

### P10. Ray tracing

L'éditeur reste en rastérisation ; les jeux et le rendu final peuvent passer au ray tracing, **au choix de l'utilisateur** : une option du rendu, désactivable, la rastérisation restant toujours disponible.

| Backend                   | Ray tracing                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulkan (natif)            | Matériel : `VK_KHR_ray_query`, `VK_KHR_ray_tracing_pipeline` ; plus tard DirectX 12 (DXR)                                                                                                                                                                                                                                             |
| WebGPU (navigateur, Dawn) | **Logiciel, en WGSL** : les rayons, les intersections, les rebonds, les réflexions et éventuellement l'éclairage global dans des passes de calcul, accélérés par un BVH dans des storage buffers. Sans API dédiée, compatible avec le modèle de calcul de WebGPU ; les performances dépendent beaucoup de la scène et de l'algorithme |
| WebGL2                    | Aucun (pas de calcul) : la rastérisation seule                                                                                                                                                                                                                                                                                        |

Le ray tracing logiciel est le repli de WebGPU, pas un second moteur : la même technique de rendu dans le render graph, les mêmes surfaces de matériaux compilées vers la cible BSDF, seule la traversée change — les structures d'accélération du GPU en Vulkan, un BVH construit par le moteur (sur le CPU, puis en calcul) et parcouru en WGSL ailleurs. Le BVH logiciel peut aussi servir aux requêtes de la scène et à la sélection dans l'éditeur.

1. **Les fondations** : les structures d'accélération dans `RenderBackend` (BLAS par mesh, TLAS par scène, construites et mises à jour depuis les tables de la scène), matérielles en Vulkan, un BVH logiciel en WebGPU ; le bindless (capacité du backend), les capacités consultées à la compilation.
2. **L'hybride** : la rastérisation garde la visibilité primaire ; des rayons lancés depuis les shaders (ray queries) pour les ombres, les reflets et l'occlusion ambiante. Un nœud `rayQuery` dans le material graph.
3. **Le path tracer** : une seconde technique de rendu dans le render graph, toute l'image par rayons et rebonds, avec un débruitage. Le material graph compile la même surface vers une cible BSDF (évaluation, tirage, densité).

Démos : le TPS et le FPS avec des ombres et des reflets tracés, puis une vue en path tracing, en natif comme dans le navigateur (WebGPU) ; l'éditeur peut l'offrir en aperçu.

### P11. Plateformes et distribution

Peut avancer en fond dès P1.

- **Windows et macOS** : addons, surfaces (Win32, Metal par MoltenVK), DXC ; construits et testés en CI.
- **Binaires précompilés** des addons, pour installer sans CMake ni compilateur ; une application en un seul exécutable.
- **Le démarrage** : un cache de pipelines persisté, la précompilation des programmes (phase 7 du material graph).
- **N5** : Dawn sans copie, Direct3D 12.

### P12. Batching statique

Reporté de P1 : l'instancing dessine déjà en un appel les objets qui partagent mesh et matériau (les murs du labyrinthe, une forêt d'arbres identiques). Le batching statique ne sert qu'aux scènes statiques **hétérogènes**, où chaque objet a son mesh : une maquette BIM, un assemblage CAO, un décor fait main — ce qu'ouvrira l'éditeur.

- Fusionner les meshes statiques d'une cellule de l'octree et d'un même matériau en un mesh dans l'espace du monde, reconstruit quand un objet de la cellule change.
- Ce qu'il coûte : la géométrie dupliquée en mémoire, un culling par cellule plutôt que par objet, et la sélection d'un objet dans un mesh fusionné (un identifiant d'objet par sommet).
- À comparer, avant de l'écrire, avec le rendu piloté par le GPU (culling et draws indirects, [évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), qui pourrait le rendre inutile.

### P13. L'éditeur

L'application de modélisation, puis l'éditeur du middleware. Elle est découpée en étapes, chacune avec son design.

1. **Les fondations d'un éditeur** :
   - la sélection (picking par un buffer d'identifiants sur le GPU) ;
   - les gizmos de transformation ;
   - les événements de la scène (ce qui a changé) ;
   - un système de commandes avec annuler et refaire ;
   - la sérialisation des scènes ;
   - la précision des grandes coordonnées (rendu relatif à la caméra), décisive pour la CAO et le BIM.
2. **L'interface** : le choix de sa technologie (web, ou native, ou les deux), ses panneaux (arbre de scène, propriétés, ressources).
3. **Le noyau géométrique abstrait** : l'API que les moteurs géométriques implémentent (profils, solides, opérations, triangulation pour l'affichage). Le moteur fournit une implémentation de base : profils 2D, extrusion, révolution, triangulation des faces. Un noyau complet (OpenCascade, par exemple) peut se brancher derrière l'API, sans être une dépendance du projet.
4. **Les esquisses** : le dessin 2D sur un plan (segments, arcs, cercles), les contraintes (coïncidence, parallélisme, distances, angles) et leur solveur.
5. **Les opérations et l'arbre paramétrique** : extrusion, révolution autour d'un axe, puis d'autres (balayage, lissage, booléens selon le noyau). Un historique qu'on modifie et qui se recalcule.
6. **L'éditeur du middleware** : les scènes, les ressources, les éditeurs de graphs (matériaux, animations, comportements) sur le cœur de graph commun.

## 4. Les dépendances

- **P1** avant **P8** : la forêt demande l'instancing et un coût par objet réduit.
- **P2** dépend des compute graphs dans le render graph ; **P3** des textures de stockage et des mipmaps.
- **P4** avant **P8** (caméra TPS, contrôleur de personnage) et avant **P13** (orbite CAO).
- **P5** avant **P6** (squelettes et clips de glTF), **P7** (sons chargés) et **P8**.
- **P6** (cœur de graph) avant **P9** et avant les éditeurs de graphs de **P13**.
- **P10** après **P8** (des scènes à tracer) ; ses prérequis sont posés dès P1 (§6).
- **P12** avant **P13** : les scènes de CAO et de BIM qu'ouvre l'éditeur.
- **P13** s'appuie sur presque tout : la sélection et le culling (P1, P3), la caméra CAO (P4), les ressources (P5), les graphs (P6, P9).

## 5. Plus tard, hors du plan

À reprendre quand un besoin les fera passer devant. La raison de chaque mise à l'écart :

| Chantier                                                                                                  | Pourquoi plus tard                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Sortie HDR et couleurs étendues ([évolutions §4](evolutions.md#4-la-sortie-hdr-et-les-couleurs-étendues)) | Écrans HDR et navigateurs inégaux (canvas étendu surtout dans Chrome) ; aucune démo n'en dépend ; le tone mapping actuel suffit              |
| Travail en parallèle sur le GPU ([évolutions §5](evolutions.md#5-le-travail-en-parallèle-sur-le-gpu))     | WebGPU n'a qu'une file ; le gain n'existe qu'une fois le GPU saturé par des passes de calcul (après P2, P3, à mesurer)                       |
| Transparence indépendante de l'ordre (OIT)                                                                | Peu d'objets transparents jusqu'ici, le tri suffit ; coûteuse en mémoire et en bande passante. À revoir pour le verre en CAO et en BIM (P13) |
| Material graph : fonctions génériques, vraies fonctions dans le code généré                               | Ne compte que pour de gros graphs (taille du code, temps de compilation) ; à revoir avec les éditeurs de graphs (P13)                        |
| Material graph : `f16` de bout en bout                                                                    | Un gain surtout sur mobile, et une capacité inégale selon les GPU                                                                            |
| Material graph : `frag-coord` en WebGL2                                                                   | Aucun besoin jusqu'ici                                                                                                                       |
| Material graph : structures dans les storage buffers                                                      | Pas encore utile ; le pool de lumières (P2) ou le ray tracing (P10) pourraient le faire remonter                                             |
| Material graph : source maps nœud ↔ ligne                                                                 | Un confort de débogage, à faire avec les éditeurs de graphs (P13)                                                                            |
| Material graph : limite et préchauffage des variantes                                                     | Lié au temps de démarrage : à traiter avec la précompilation (P11)                                                                           |
| Render graph : coût de la clé structurelle                                                                | Invisible aux tailles actuelles : à mesurer quand les graphes grossiront                                                                     |
| Vulkan : barrières groupées par le render graph                                                           | Une optimisation à justifier par le profilage (P0)                                                                                           |
| Vulkan : attente des frames hors du thread JavaScript                                                     | Un gain CPU faible tant que le sondage ne se voit pas dans les mesures                                                                       |
| Vulkan : `VK_EXT_swapchain_maintenance1`, `VK_KHR_present_wait`                                           | Du réglage fin de la latence et de la cadence des frames, après les gros chantiers                                                           |
| Documentation : changer de backend sans recharger la page                                                 | Un confort ; recharger suffit                                                                                                                |

## 6. Rester compatible avec le ray tracing

Les contraintes déjà posées ([évolutions §6](evolutions.md#6-contraintes-de-compatibilité-pour-les-prochaines-étapes)) : un render graph qui accueille d'autres techniques que « un draw par objet », la séparation surface et éclairage, l'accès aux lumières par `light.current` / `light.sum` seulement, des capacités de backend consultées. Ce qu'elles impliquent pour les phases du plan :

- **P1** : les données des objets dans des tables indexées par identifiant (transforms, matériaux) plutôt que liées objet par objet. C'est aussi ce qui réduit les appels : le même travail sert les deux. Les buffers de géométrie créés avec les usages qu'un BLAS demandera.
- **P2** : le pool de lumières dans un storage buffer : le ray tracing y tirera ses lumières. L'IBL en textures que les rayons pourront lire.
- **P3** : la scène tient des identifiants stables et des tables de la scène sur le GPU : la TLAS se construira à partir d'elles.
- **P5** : les meshes chargés restent des buffers GPU accessibles (storage), pas seulement des vertex buffers ; les textures prêtes pour le bindless.
- **P6** : **le skinning dans une passe de calcul**, qui écrit les sommets animés dans un buffer, plutôt que dans le vertex shader : la rastérisation, les ombres et la mise à jour des BLAS lisent alors les mêmes sommets.
- **P13** : l'éditeur rend en rastérisation, avec la même scène et les mêmes matériaux ; une vue en ray tracing y devient un aperçu, pas un second moteur.
