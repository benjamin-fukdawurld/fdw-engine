# Plan de développement

Du moteur actuel à l'éditeur du middleware de création 3D. Ce plan ordonne les chantiers du [backlog](backlog.md) (y compris ceux laissés de côté jusqu'ici) et les nouveaux (caméras, ressources, animation, audio, comportements, démos, outils d'édition, eau et fluides, éditeur). Il sera revu à la fin de chaque phase.

## 1. Principes

- **Un design validé avant chaque brique**, avec les alternatives comparées (intérêt, coût). Ce plan fixe l'ordre, pas les solutions.
- **La performance et l'UX d'abord.** Une phase n'ajoute pas de contenu sur un socle qui ne tient pas la charge : les chantiers de performance passent avant les démos qui en ont besoin.
- **Chaque phase se termine par quelque chose de visible** : une démo jouable ou une étape de démo, ses pages de documentation (EN, FR), ses tests, et ses mesures quand la phase touche à la performance.
- **Des briques indépendantes et multi-domaines** : chaque package ne dépend que du nécessaire, et sert le jeu, la CAO, le BIM et les outils.
- **Compatible avec le ray tracing** : l'éditeur rendra en rastérisation, les jeux et le rendu final pourront rendre en ray tracing. Chaque phase respecte les contraintes du §6, pour que le ray tracing (P10) s'ajoute sans refonte.
- **Pas de grosse dépendance en dur** : quand une brique s'appuie sur une bibliothèque lourde (un noyau géométrique, un moteur physique, un moteur audio), le moteur définit une API abstraite et l'utilisateur branche l'implémentation de son choix. Le moteur fournit une implémentation de base.

## 2. Vue d'ensemble

| Phase | Contenu                                             | Livrable                                                            | Taille      |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| P0    | Socle : CI, publication de la doc, mesures          | La CI verte sur chaque changement, la doc en ligne                  | Petite      |
| P1    | Performance : coût par objet, appels, instancing    | Le labyrinthe et la forêt bien plus rapides, WebGPU compris         | Moyenne     |
| P2    | Lumières et ombres à grande échelle, IBL            | Une démo de centaines de lumières                                   | Grande      |
| P2b   | Cibles multiples, rendu différé, détails de surface | Une scène avec SSAO et sélection au pixel ; les exemples            | Grande      |
| P3    | Occlusion culling                                   | Une ville ou un bâtiment, l'essentiel caché                         | Moyenne     |
| P3b   | Tessellation par patchs instanciés                  | Du displacement adaptatif, un terrain, sans tessellation matérielle | Moyenne     |
| P4    | Caméras, entrées, ordonnanceur ECS                  | **Démo FPS minimaliste**                                            | Moyenne     |
| P5    | Ressources : images, glTF                           | Des modèles chargés dans les démos                                  | Grande      |
| P6    | Cœur de graph commun, animation et animation graph  | Un personnage animé, ses états                                      | Grande      |
| P7    | Audio                                               | Des sons dans les démos, spatialisés                                | Moyenne     |
| P7b   | Physique : une API abstraite, un moteur intégré     | Des corps qui tombent et s'empilent, web et natif                   | Grande      |
| P8    | Le jeu à la troisième personne                      | **Démo TPS : l'épée dans la forêt**                                 | Moyenne     |
| P9    | Graphs de comportement                              | L'IA des ennemis du TPS en graphs                                   | Grande      |
| P12   | Batching statique                                   | Moins de draws pour les scènes statiques hétérogènes                | Moyenne     |
| P14   | Shaders procéduraux                                 | Des matériaux et un terrain sans texture : bruits, motifs           | Moyenne     |
| P15   | Sélection, gizmos, commandes                        | Déplacer, tourner, mettre à l'échelle des objets ; annuler, refaire | Moyenne     |
| P16   | Scènes et niveaux : import et export modulaires     | Le niveau du TPS enregistré, rechargé, échangé en glTF              | Grande      |
| P17   | La mer et les vagues                                | Une mer animée, des objets qui flottent                             | Grande      |
| P18   | L'éditeur : Electron et web                         | La base de l'éditeur : React, dock panels, plugins ; natif et web   | Grande      |
| P19   | L'éditeur de graphs                                 | Matériaux, animations, comportements édités et débogués à la souris | Grande      |
| P20   | L'éditeur de jeu                                    | **Un petit jeu fait dans l'éditeur**                                | Très grande |
| P21   | Les fluides                                         | De l'eau et de la fumée simulées                                    | Grande      |
| P10   | Ray tracing : hybride, puis path tracer             | Les démos en ray tracing : Vulkan, WGSL logiciel en WebGPU          | Grande      |
| P11   | Plateformes et distribution                         | Windows, macOS, binaires précompilés                                | Moyenne     |
| P13   | Le modeleur CAO, dans l'éditeur                     | **L'application de modélisation**                                   | Très grande |

Les numéros sont des identifiants stables : le tableau donne l'ordre prévu, qui suit les dépendances (§4). Certaines phases peuvent se chevaucher : les phases de rendu (P14, P17, P21) sont indépendantes de celles de l'éditeur (P15, P16, P18 à P20) et peuvent s'intercaler, et P11 peut avancer en fond.

**Revu le 18 octobre 2026, après P9.** Le ray tracing (P10), les plateformes (P11) et le modeleur CAO (P13) passent après l'éditeur de jeu : sans outil pour faire des scènes, le ray tracing n'aurait que les démos à montrer ; Linux suffit tant que rien n'est distribué ; le modeleur gagne à reprendre les fondations de l'éditeur de jeu (sélection, gizmos, commandes, sérialisation, application, éditeurs de graphs) plutôt qu'à les poser lui-même. Le batching statique (P12) devient la prochaine phase.

**Revu le 30 octobre 2026, après P2.** L'éditeur de jeu (P20) et le modeleur CAO (P13) restent repoussés. L'ordre des prochains chantiers :

1. **P11, Windows d'abord** : le développement se fait maintenant sous Windows, mais la CI ne tourne que sous Linux et le viewport natif de l'éditeur ne connaît que X11. Un job Windows en CI (les addons, la suite de rendu sur Direct3D 12 par WARP et sur Vulkan), le viewport de l'éditeur dans une fenêtre `WS_CHILD` transparente aux entrées, les addons précompilés, le démarrage (cache de pipelines, précompilation) ; macOS et Wayland ensuite.
2. **La consolidation** : un nouvel audit du code ([audit.md](../audit.md) date du 2 octobre, avant presque toutes les phases), et la stabilité des tests : chercher pourquoi les tests de rendu, de fumée, de graph et de layout demandent des timeouts toujours plus longs, plutôt que de les allonger encore.
3. **Les restes du rendu** : les ombres des lumières ponctuelles ([p2-lights §9](p2-lights.md#9-reportés)), la démo de P2b (occlusion ambiante, sélection au pixel, rendu différé).
4. **Les draws indirects et le rendu piloté par le GPU** ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), en Vulkan et Direct3D 12 : ils débloquent les deux phases sans retard de l'occlusion (P3), le choix des niveaux de tessellation en calcul (P3b) et le culling des lumières sur le GPU (P2).
5. **Le gameplay** : le root motion, la recherche de chemin, le contrôleur de personnage contre les volumes de la scène, les ragdolls ; utiles ensuite à l'éditeur de jeu.

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

_Faite_ (27 octobre 2026), sauf les ombres des lumières ponctuelles et le culling sur le GPU (reportés) : design et mesures dans [p2-lights.md](p2-lights.md). Le pool de lumières dans un storage buffer, sans limite (`MaxLights` a disparu) ; les clusters (16 × 9 × 24) remplis sur le CPU pour tous les backends (0,8 ms pour 1 000 lumières), lus par `light.sum` depuis la position du point ; l'environnement (`Environment` : un panorama, un cube ou un ciel en graph), préfiltré sur le GPU dans un atlas octaédrique (6 niveaux de rugosité, l'irradiance, la table BRDF), dans `pbr` et `phong` ; le path tracer tire ses lumières dans le même format et voit l'environnement.

- **Nombre de lumières dynamique** (RG6) : un culling des lumières en clusters (clustered forward) par une passe de calcul, et un **pool de lumières** disposé comme leur structure GPU, comme le pool de transforms. Il remplace la limite de 16 lumières (`MaxLights`). WebGL2, qui n'a pas de calcul, aura un repli : le culling sur le CPU, et les lumières dans une texture de données ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)).
- **Prérequis** : les compute graphs dans le render graph (`addComputeGraphPass`), et le repli WebGL2 des storage buffers ([backlog §3](backlog.md#3-compute-graph)) — fait : storage buffers et calcul émulés par rendu dans des textures ([cg-webgl2.md](cg-webgl2.md)), le culling des lumières peut y être le même calcul.
- **Ombres** : les lumières ponctuelles (six faces), les cascades (CSM) pour les grandes scènes, le culling des projeteurs par tuile. — _Les cascades faites avec P8_ (17 octobre 2026), pour une lumière directionnelle par image, avec un brouillard ([p8-tps.md](p8-tps.md) §3.1, §3.5).
- **Éclairage par environnement (IBL)** : cubemap, irradiance, spéculaire préfiltré, table BRDF. C'est l'écart de qualité le plus visible aujourd'hui.

### P2b. Cibles de rendu multiples, rendu différé et détails de surface

_Étapes 1 à 7 faites_ (13 octobre 2026), avec leurs tutoriels ; reste la démo. Insérée après P2 sans renuméroter les phases suivantes. Design : [p2b-targets.md](p2b-targets.md). Le principe : **le moteur ne fixe aucune liste de cibles**. L'utilisateur choisit ce que ses passes écrivent (couleur, normales, identifiants, toute sortie de la surface) et compose les textures obtenues comme il veut dans le render graph ; le rendu différé n'est qu'une façon de les composer, jamais imposée.

- **Les cibles de rendu multiples (MRT) sur tous les backends.** L'API (`colorAttachments`, `targets` des pipelines) et les encodeurs WebGPU et Vulkan acceptent déjà plusieurs attachments ; **WebGL2 les refuse** aujourd'hui (« renders to one color target ») alors que WebGL2 les supporte : `drawBuffers` et un framebuffer à plusieurs attachments, la résolution du multi-échantillonnage attachment par attachment (`readBuffer` et `blitFramebuffer`). À traiter : une sortie par attachment dans le material graph et les trois générateurs, la limite du nombre d'attachments en capacité (`maxColorAttachments` : 8 en WebGPU, au moins 4 en WebGL2), le mélange par attachment (WebGL2 n'a qu'un état de mélange sans `OES_draw_buffers_indexed`), et `pass.writeColor` répété dans le render graph.
- **Des sorties de surface au choix.** `addScenePasses` reçoit les cibles voulues, chacune avec son format et la valeur écrite, prise dans la surface du matériau ou dans le moteur. Le graphe du matériau ne change pas : c'est la cible de compilation `gbuffer` prévue au [render graph §8](render-graph.md#8-les-matériaux-dans-les-passes), généralisée à une liste de sorties choisie par l'utilisateur.
  - **Les normales** : la normale par pixel (après normal mapping), dans l'espace de la vue, dans une cible `rgba16float` ou encodée en octaèdre dans `rg16float`. Avec la profondeur, elle sert à l'**occlusion ambiante** (SSAO, en passe plein écran, ou en calcul en WebGPU et Vulkan), à des contours, aux reflets en espace écran.
  - **Les identifiants** : l'utilisateur donne un identifiant (u32) à chaque mesh dessiné ; une cible `r32uint` reçoit, pour chaque pixel, l'identifiant de l'objet qui y est visible (0 : aucun). L'identifiant vient de la table des objets (P1), donc l'instancing le garde ; les matériaux masqués respectent leur `discard`. La relecture d'un pixel ou d'un rectangle est asynchrone, sans bloquer la frame. C'est la base de la **sélection** des outils d'édition (P15) : clic, rectangle, survol des objets.
- **Le rendu différé, pour qui le veut.** Une passe écrit les cibles choisies (le G-buffer), des passes plein écran écrites en material graph calculent l'éclairage en les lisant, les transparents restent dessinés en forward par-dessus. Avec le pool de lumières et le culling en clusters de P2, il permet beaucoup de lumières. À documenter : son coût en bande passante, et son incompatibilité pratique avec le MSAA.
- **Les détails de surface**, en fonctions de la bibliothèque standard, documentés et chacun avec un exemple :
  - **normal mapping** : dans l'espace tangent, avec les tangentes des meshes (calculées par le moteur, ou lues dans glTF en P5) ; à défaut, un repère tangent calculé à partir des dérivées d'écran ;
  - **bump mapping** : une carte de hauteur qui perturbe la normale par ses dérivées d'écran (des nœuds `dpdx` / `dpdy` à ajouter) ;
  - **parallax mapping** : le décalage des uv selon la vue, puis le parallax occlusion mapping, qui demande une boucle à pas dans le material graph (la généralisation de `loop-sum` en `fold`, aux [écarts](material-graph-gaps.md)) ;
  - **displacement mapping** : le déplacement des sommets d'un mesh subdivisé par une texture lue dans le vertex stage (`textureSampleLevel`), avec les normales recalculées ; ni WebGPU ni WebGL2 n'ont de tessellation.
- **Des exemples dans la documentation** (EN et FR, rendus et comparés en CI) : la **transparence** (tri, objets double face, `blend` et `mask`, l'ordre de dessin et ses limites) et la **réflexion** (cubemap d'environnement avec l'IBL de P2, reflet plan par rendu dans une texture avec la caméra symétrique, reflets en espace écran avec les cibles de normales et de profondeur) ; ceux des cibles multiples, de l'occlusion ambiante, de la sélection, du rendu différé et des quatre techniques de détail.

Ordre suggéré : les MRT en WebGL2 et les sorties de surface (normales, identifiants), puis la SSAO et la sélection, le rendu différé, les détails de surface ; les exemples suivent chaque brique. Les MRT, les normales et les identifiants ne dépendent pas de P2 et peuvent commencer avant.

Démo : une scène avec occlusion ambiante et sélection au pixel, éclairée en rendu différé ou en forward au choix.

### P3. Occlusion culling

_Faite_ (14 octobre 2026), avec son tutoriel : le design, les mesures et la suite sont dans [p3-occlusion.md](p3-occlusion.md). Le Hi-Z en passes plein écran (pyramide, test d'un texel par boîte), relu sans attendre, sur les trois backends : un seul chemin, WebGL2 compris, sans repli CPU. La ville de la démo (5184 immeubles, 3600 cachés depuis la rue, 1080p, Vulkan) : 6,7 → 1,7 ms de CPU par frame. Reportés : les deux phases sans retard pilotées par le GPU (après les draws indirects de P3b), le MSAA, le culling des projeteurs d'ombres, le BVH.

- **Le package `engine-occlusion`** : le Hi-Z sur le GPU en deux phases (dessiner d'abord ce qui était visible, construire la pyramide de profondeur, tester le reste), et le CPU en repli pour WebGL2 ([scenegraph §5.5](scenegraph.md#55-locclusion-culling-plus-tard)). Le choix entre une relecture CPU et un rendu piloté par le GPU se fera dans son design.
- **Prérequis** : les textures de stockage (compute graph et Vulkan), la génération des mipmaps (_faite_ : `addMipmapPass` ; la pyramide Hi-Z demandera une réduction min/max par une passe de calcul plutôt qu'une moyenne).
- **Ensuite, selon les mesures** : le culling sur le GPU avec des draws indirects ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), et un BVH pour les scènes statiques de CAO et de BIM.

Démo : une scène dense où l'essentiel est caché (une ville, un bâtiment, un assemblage), avec la vue du culling comme dans le labyrinthe.

### P3b. Tessellation

_Faite_ (14 octobre 2026), avec son tutoriel : le design, les mesures et la suite sont dans [p3b-tessellation.md](p3b-tessellation.md). Un seul chemin pour les trois backends, WebGL2 compris : les niveaux choisis par arête sur le CPU (0,4 ms pour 4096 patchs), les sommets générés depuis leur numéro en un draw par surface, sans fissure ; les attributs calculés du material graph (`g.vertexAttribute`) comme mode patch. Le terrain de la démo (1280 × 720, Vulkan) : 400 000 triangles adaptatifs contre 3,8 millions au niveau le plus fin, 1140 contre 660 images par seconde. Reportés : les draws indirects et le choix des niveaux en calcul (WebGPU, Vulkan), les patchs triangulaires (Phong tessellation, PN triangles), les concurrent binary trees, les ombres hors de la vue.

Le plan d'origine :

Insérée après P3 sans renuméroter. Ni WebGPU ni WebGL2 n'ont de tessellation matérielle (hull et domain shaders) ; Metal ne l'a pas sous cette forme, et les moteurs récents la remplacent par du calcul. Le moteur aura **un seul chemin pour tous les backends**, sans la tessellation matérielle de Vulkan : le même rendu partout, une seule chose à tester. Un design (`design/tessellation.md`) comparera d'abord les alternatives : tessellation matérielle, subdivision sur le CPU au chargement, patchs instanciés, concurrent binary trees.

**Le principe retenu : des patchs instanciés.** Aucun sommet n'est généré à chaque frame ; le choix du niveau est séparé de l'évaluation.

1. **Des gabarits**, calculés une fois sur le CPU : un patch (triangle ou quad) subdivisé à 1, 2, 4… 64, en coordonnées locales seulement (barycentriques ou uv du patch).
2. **Le choix du niveau**, à chaque frame, par patch et par arête (taille à l'écran, distance, courbure), avec le culling des patchs hors du frustum :
   - **WebGPU et Vulkan** : une passe de calcul qui range les patchs par gabarit (compaction) et écrit les arguments de **draws indirects** ;
   - **WebGL2** : sans calcul ni draw indirect, le nombre d'instances d'un draw est fixé par le CPU. Le CPU choisit le gabarit **par groupe de patchs**, de façon conservatrice (le niveau maximal possible d'après les bornes du groupe) ; une passe de **rendu dans une texture** (un pixel par patch ou par arête) calcule les facteurs exacts, que le vertex shader lit par `texelFetch` et applique en ramenant les sommets en trop sur la grille du niveau réel. Pas de relecture, pas de fissure ; le surcoût est l'écart de niveaux dans un groupe. Écartés : la relecture asynchrone des niveaux (une ou deux frames de retard : des sauts de niveau et des patchs manquants au bord de l'écran) et le dessin systématique au niveau maximal.
3. **L'évaluation dans le vertex shader**, qui tient le rôle du domain shader : il lit les points de contrôle du patch, évalue la surface (interpolation, Phong tessellation, PN triangles, Bézier), déplace le sommet par `textureSampleLevel` (le displacement mapping de P2b) et recalcule la normale.

**Les difficultés à traiter dans le design :**

- **Les fissures** : des facteurs par arête, calculés depuis le milieu de l'arête pour que deux patchs voisins s'accordent, et les sommets d'une arête ramenés sur la grille du niveau le plus grossier. C'est le même mécanisme que le repli WebGL2.
- **Les ombres** : les shadow maps voient la même géométrie, avec les niveaux choisis pour la caméra principale, pas recalculés par lumière.
- **Les bornes** : élargies du déplacement maximal, pour le culling des objets et des patchs.
- **Les backends** : le choix par groupe de WebGL2 est plus grossier ; le rendu reste cohérent, pas identique au pixel : la suite de rendu partagée compare avec une tolérance, ou à niveau fixé.

**À ajouter au moteur :** les draws indirects (`drawIndirect`, `drawIndexedIndirect`) dans `GpuRenderPassEncoder` (le culling sur le GPU de P3 en a aussi besoin) ; un mode « patch » du material graph, où le vertex stage reçoit les coordonnées dans le patch et les points de contrôle au lieu d'attributs de sommet ; la lecture des points de contrôle dans le vertex stage (storage buffers, textures de données en WebGL2).

**Ensuite** : pour les terrains en WebGPU et Vulkan, les concurrent binary trees (Dupuy, 2020), une subdivision adaptative entièrement sur le GPU, sans fissure par construction, sur la même évaluation dans le vertex shader.

Démos et exemples : le displacement mapping de P2b rendu adaptatif, un terrain (utile au TPS de P8).

### P4. Caméras, entrées, ordonnanceur — démo FPS

- **Contrôleurs de caméra** ([backlog §9](backlog.md#9-vers-un-middleware-de-création-3d)) — _premiers opérateurs faits_ (14 octobre 2026), avec leur tutoriel : `@fdw/engine-camera`, orbite et vol libre ou marche, au clavier, à la souris et à la manette, liaisons réaffectables ([p4-camera-operators.md](p4-camera-operators.md)). Le reste : TPS (bras à ressort, collisions) — _fait avec P8_ (17 octobre 2026) : `ThirdPersonOperator`, les collisions par une sonde de l'application ([p8-tps.md](p8-tps.md) §3.3) —, stratégie et isométrique (plan XZ), le zoom vers le curseur ; des contraintes composables, des ressorts amortis, des transitions entre caméras.
- **Entrées** — _fait_ (14 octobre 2026), avec son tutoriel « Contrôles à la première personne » : le verrouillage du pointeur (déplacements relatifs), les contextes d'actions (menu, jeu), les vibrations ([p4-input.md](p4-input.md)).
- **L'ordonnanceur de systèmes ECS** — _fait_ (14 octobre 2026), avec son tutoriel « Les systèmes et le pas fixe » : `Scheduler` dans `engine-scene`, quatre phases, des systèmes ordonnés par contraintes, la boucle à pas fixe et l'interpolation intégrées ([p4-scheduler.md](p4-scheduler.md)).
- **Un contrôleur de personnage** : une capsule qui marche, saute, glisse le long des murs et monte les marches, contre les volumes de la scène. Une API abstraite pour brancher un moteur physique plus tard (P7b). — _L'API faite avec P7b_ (16 octobre 2026) : `PhysicsCharacter`, implémenté sur Rapier ([p7b-physics.md](p7b-physics.md)) ; la version contre les volumes de la scène reste à écrire.
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

_Faite_ (16 octobre 2026), avec son tutoriel « Un personnage animé » et le guide « Animation » : le design et ce qui a été fait sont dans [p6-animation.md](p6-animation.md). `engine-graph` (le cœur, le material graph réécrit dessus), `engine-animation` (squelettes, clips, poses, mélanges, masques, l'animation graph et son `Animator`), `engine-skinning` (en calcul en WebGPU et Vulkan, dans le vertex stage en WebGL2). Reportés : la démo jouable du personnage (avec P8 : faite), le root motion, les morph targets.

- **Un cœur de graph commun** : extraire du material graph ce qui est général (nœuds, ports typés, sérialisation, validation), pour les matériaux, les animations, les comportements (P9) et, plus tard, leurs éditeurs.
- **L'animation squelettique** : le skinning dans une passe de calcul, dont les sommets servent au rendu, aux ombres et plus tard au ray tracing (§6) — en WebGL2, sans calcul, le repli est le transform feedback ou le vertex shader —, les clips de glTF, l'échantillonnage et les mélanges.
- **L'animation graph** : machines à états, mélanges (blend trees), couches et masques, événements (un pas, un coup d'épée).

### P7. Audio

_Faite_ (17 octobre 2026), avec son tutoriel « L'audio » et le guide « L'audio » : le design, les mesures et ce qui a été fait sont dans [p7-audio.md](p7-audio.md). `engine-audio` (l'API abstraite, les effets courts `SoundEffect`, la musique `MusicPlayer` en fondu enchaîné, `SceneAudio` : l'auditeur qui suit la caméra, les voix qui suivent leurs nœuds ; les chargeurs du système de ressources), `engine-audio-web` (WebAudio ; les musiques en flux par des éléments média), `engine-audio-native` (miniaudio dans l'addon de `engine-native` : WAV, FLAC, MP3, Ogg Vorbis décodés sur le pool de libuv, les flux décodés à la lecture). La démo : les sons du FPS, faits par le code, sur le web et en natif. Reportés : la réverbération et les filtres, l'occlusion du son, un nombre de voix global à priorités.

Le plan d'origine :

- **Un moteur audio abstrait** et deux implémentations : WebAudio dans le navigateur, SDL3 audio (ou miniaudio) en natif, comme pour les entrées.
- Sons ponctuels et continus, mixage par bus, spatialisation (la position de l'écouteur suit la caméra), streaming des musiques.
- Les sons chargés par le système de ressources (P5).

### P7b. Physique

_Faite_ (16 octobre 2026), avec son tutoriel « La physique » et le guide « La physique » : le design, les mesures et ce qui a été fait sont dans [p7b-physics.md](p7b-physics.md). `engine-physics` (l'API abstraite, `ScenePhysics` : les corps comme composants, la simulation dans la phase `fixed`, les nœuds interpolés ; la vue de débogage en lignes), `engine-physics-rapier` (Rapier en WebAssembly, le même module dans le navigateur et dans Node : 3,2 ms par pas pour 1000 boîtes en chute, toutes éveillées) ; `MeshDescription.topology` (les lignes, sur les trois backends). La démo : la scène `physics`, sur le web et en natif (Dawn, Vulkan). Reportés : le contrôleur de personnage contre les volumes de la scène, les ragdolls, les véhicules, les corps mous, le déterminisme multi-plateforme.

Le plan d'origine :

Insérée après P7 sans renuméroter. Le moteur n'écrit pas sa propre physique : il définit **une API abstraite** que l'utilisateur implémente pour brancher le moteur physique de son choix, comme le noyau géométrique de P13, et en intègre un pour ses démos, sans en faire une dépendance du cœur.

- **L'API abstraite** : un monde physique, des corps (statiques, dynamiques, cinématiques), des formes de collision (sphère, boîte, capsule, convexe, mesh, heightmap), des matériaux physiques (friction, restitution), des contraintes (articulations), des requêtes (rayons, balayages de formes, chevauchements) et des événements de contact et de volumes déclencheurs. Les corps sont des composants ECS ; la simulation est un système du pas fixe de l'ordonnanceur (P4), les transforms des corps dynamiques recopiés dans la scène et interpolés entre deux pas.
- **Le contrôleur de personnage** de P4 passe sur cette API : sa version contre les volumes de la scène devient une implémentation parmi d'autres.
- **Un moteur intégré pour les démos**, dans un package à part : dans le navigateur (WebAssembly) et en natif. **Le même moteur pour les deux** si l'un convient, sinon deux moteurs derrière la même API. Un design comparera d'abord les candidats : Rapier (Rust, compilé en WebAssembly, utilisable aussi en natif), Jolt Physics (C++, JoltPhysics.js en WebAssembly, un addon en natif), PhysX (C++, physx-js-webidl), Bullet / ammo.js ; sur leur taille, leurs performances en WebAssembly et en natif, leur déterminisme, leur licence et le coût de leurs liaisons. Le natif peut se contenter de la version WebAssembly si l'écart de performance avec un addon ne le justifie pas.
- **Le débogage** : l'affichage des formes de collision, des contacts et des requêtes.
- **Plus tard** : les ragdolls sur les squelettes de P6, les véhicules, les corps mous.

Démo : des objets qui tombent, s'empilent et se renversent, des tirs par rayons, la même scène dans le navigateur et en natif ; le tutoriel (EN et FR) avec un exemple vivant.

### P8. Démo TPS : l'épée dans la forêt

_Faite_ (17 octobre 2026), avec ses tutoriels « Les ombres en cascades et le brouillard », « Les niveaux de détail », « La caméra à la troisième personne » et la page « Un jeu à la troisième personne » : le design, les mesures et ce qui a été fait sont dans [p8-tps.md](p8-tps.md). Au moteur : les ombres en cascades et le brouillard (`engine-core`, `engine-shader`), les faces arrière éclairées, la scène et des items dans un même rendu, l'instancing des passes d'ombre (3 669 draws par image dans la forêt, 207 après) ; les niveaux de détail (`SceneLods`, `findLodGroups` dans `engine-scene`) ; `ThirdPersonOperator` (`engine-camera`). Les outils `tools/assets` préparent des assets CC0 (Poly Haven, Quaternius) : le sapin de 4 millions de triangles en trois niveaux faits de cartes d'aiguilles, les clips du rôdeur recopiés par nom d'os, l'épée placée par la pose de la main. La démo : la scène `tps` (2 460 sapins, un rôdeur, des vagues d'orcs puis un démon, des coups par volumes, une IA en systèmes ECS, des sons faits par le code), sur le web et en natif (environ 90 images par seconde sur Vulkan, 62 sur Dawn). Reportés : le coût des requêtes de la scène (cinq parcours d'octree par image), les groupes de collision des personnages, le root motion, la recherche de chemin, la liaison des clips par nom au chargement.

Le plan d'origine :

Elle réunit les phases précédentes : la forêt instanciée (P1), les ombres en cascades (P2), l'occlusion par les arbres et le relief (P3), la caméra TPS et le contrôleur de personnage (P4), les modèles (P5), l'animation graph (P6), les sons (P7), la physique (P7b). En plus : des volumes d'attaque et de dégâts, une IA d'ennemis écrite en systèmes ECS. Un terrain (heightmap) sera sans doute à ajouter.

### P9. Graphs de comportement

_Faite_ (18 octobre 2026), avec son tutoriel « Les graphs de comportement » et son guide : le design, les mesures et ce qui a été fait sont dans [p9-behavior.md](p9-behavior.md). `engine-behavior` : le modèle des blueprints (événements, flux d'exécution, valeurs à la demande, variables par instance, 40 nœuds et ceux de l'application), le graph exécuté comme un système (`BehaviorSystem`, une instance par entité), compilé en JavaScript ou interprété sur les mêmes instances — 0,10 contre 1,8 µs par instance et par pas pour l'IA du TPS —, le débogueur sur l'interpréteur (points d'arrêt, pas à pas, états des nœuds, trace) ; au cœur de graph, les connexions par port et le flux de contrôle qui peut boucler. L'IA des ennemis du TPS est un graph : la décision dans le graph, le pilotage et les coups en actions du jeu, au même coût (0,2 ms par image). Reportés : l'éditeur (P19), les fonctions et macros, les événements pour toutes les instances, les nœuds qui durent.

Le plan d'origine :

- Sur le cœur de graph de P6 : un flux d'exécution déclenché par des événements et un flux de données, comme les blueprints d'Unreal.
- Leur exécution : interprétés, ou compilés en JavaScript (à comparer), et intégrés à l'ordonnanceur ECS (un graph est un système).
- Le débogage : l'état des nœuds pendant l'exécution, des points d'arrêt.
- Validation : l'IA des ennemis du TPS réécrite en graphs.

### P12. Batching statique

_Faite_ (19 octobre 2026), avec son tutoriel « Le batching statique » et ses guides : la comparaison avec le rendu piloté par le GPU, le design et les mesures sont dans [p12-batching.md](p12-batching.md). Le rendu piloté par le GPU ne retirerait pas les appels dans le navigateur (ni multi-draw en WebGPU, ni draws indirects en WebGL2) : le batching d'abord, le GPU plus tard pour Vulkan. `mergeMeshes` (`engine-core`) fusionne des meshes dans l'espace du monde, avec un identifiant d'objet par sommet que lit la sortie `object-id` ; `StaticBatches` (`engine-scene`) fusionne les renderers statiques d'une cellule d'une grille et d'un matériau, reconstruit un lot quand un de ses objets change, et laisse les objets aux requêtes de l'application. Le décor de la démo (1 614 objets, chacun son mesh) : de 1 150 à 67 draws, de 169 à 833 fps sous Vulkan, de 50 à 305 fps sous Dawn, pour une seconde copie de la géométrie sur le GPU (5,2 Mo ; la copie CPU est rendue après l'envoi) et 63 ms de construction ; un objet déplacé dans sa cellule réécrit ses sommets sur place (0,035 ms), sans reconstruire son lot. Reportés : les lots des niveaux de détail.

Le plan d'origine :

Reporté de P1 : l'instancing dessine déjà en un appel les objets qui partagent mesh et matériau (les murs du labyrinthe, une forêt d'arbres identiques). Le batching statique ne sert qu'aux scènes statiques **hétérogènes**, où chaque objet a son mesh : un décor fait main, un niveau importé (P16) ou construit dans l'éditeur de jeu (P20), plus tard une maquette BIM ou un assemblage CAO (P13).

- Fusionner les meshes statiques d'une cellule de l'octree et d'un même matériau en un mesh dans l'espace du monde, reconstruit quand un objet de la cellule change.
- Ce qu'il coûte : la géométrie dupliquée en mémoire, un culling par cellule plutôt que par objet, et la sélection d'un objet dans un mesh fusionné (un identifiant d'objet par sommet).
- À comparer, avant de l'écrire, avec le rendu piloté par le GPU (culling et draws indirects, [évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)), qui pourrait le rendre inutile.

Démo : un décor hétérogène (des centaines de meshes différents), avec ses mesures avant et après.

### P14. Shaders procéduraux

_Faite_ (19 octobre 2026), avec ses tutoriels « Les matériaux procéduraux » et « Un terrain procédural » et son guide : le design, les mesures et ce qui a été fait sont dans [p14-procedural.md](p14-procedural.md). Au material graph : les opérateurs entiers (les produits de `u32` bouclent partout) et la boucle `fold`, qui porte un état, dont le nombre de tours peut être un uniform, imbriquable ; les bruits en fonctions de la bibliothèque standard, en 2D, 3D et 4D, sur des hachages PCG identiques sur les trois backends (valeur, gradient, simplex, Worley avec distances et identifiants de cellule), leurs sommes (fbm, ridged, turbulence, octaves déroulées ou en boucle, effacées sous le pixel) et la déformation du domaine ; les motifs (damier et bandes filtrés, briques, tuiles) ; le placement (positions de l'objet et du monde, mapping triplanaire d'une fonction ou d'une texture). `bakeTexture` (`engine-core`) cuit un graph dans une texture avec ses niveaux ; `@fdw/engine-noise` refait les mêmes bruits en TypeScript, égaux au GPU au bit près pour les hachages, à 2·10⁻⁵ près pour les valeurs, sur Dawn, Vulkan et WebGL2. Le compilateur indexe ses arêtes : un fbm de 5 octaves de Perlin 3D se compile en 86 ms au lieu de 402. Démos : la galerie (bois, marbre, roche, lave animée, briques, tuiles, roche cuite en triplanaire), le terrain du TPS (reliefs par `engine-noise`, sol varié par des bruits, roche cuite en triplanaire sur les pentes), un terrain procédural dont le CPU pose les rochers là où le GPU peint la mousse. Reportés : de vraies fonctions dans le code généré, les dérivées analytiques des bruits, la cuisson par un calcul.

Le plan d'origine :

Des matériaux calculés plutôt que lus dans des textures : sans uv, sans répétition visible, à résolution infinie, animables. Le material graph a le nécessaire (fonctions de la bibliothèque standard, trois générateurs, dérivées d'écran de P2b) mais aucun bruit ni motif aujourd'hui.

- **Les bruits**, en fonctions de la bibliothèque standard, en 2D, 3D et 4D (le temps) : un hachage entier (PCG ou équivalent) identique sur les trois backends, le bruit de valeur, le bruit de gradient (Perlin), le simplex, le bruit cellulaire (Worley, Voronoï : distances et identifiants de cellule) ; leurs sommes (fBm, ridged, turbulence) et la déformation du domaine (domain warping). Les octaves en boucle fixe, ou par la boucle `fold` des [écarts](material-graph-gaps.md).
- **Les motifs** : damier, briques, tuiles, bandes, et des matériaux composés (bois, marbre, roche) en exemples.
- **Le placement** : le mapping triplanaire (terrains, objets sans uv), les coordonnées objet ou monde.
- **L'aliasing** : le filtrage des motifs par leurs dérivées d'écran (damier filtré), l'atténuation des octaves trop fines pour le pixel.
- **La cuisson** : un graph coûteux rendu une fois dans une texture (passe plein écran ou calcul), avec ses mipmaps ; les mêmes bruits en TypeScript, pour les hauteurs d'un terrain côté CPU (la physique, le placement d'objets), comparés au GPU dans les tests.

Démo : le terrain du TPS texturé par des bruits et le mapping triplanaire, et une galerie de matériaux procéduraux ; les tutoriels (EN et FR) avec des exemples vivants.

### P15. Sélection, gizmos et commandes

_Faite_ (19 octobre 2026), avec son tutoriel « Sélection, gizmos et commandes » et son guide « Outils d'édition » : le design et ce qui a été fait sont dans [p15-editing.md](p15-editing.md). Le package `@fdw/engine-editing` : le `Viewport` (rayons, projections, taille d'un pixel), le `Picker` (clic et rectangle par le buffer d'identifiants, nœuds résolus par l'application), la `Selection` (multi-sélection, objet actif, survol) et son contour (masque puis passe plein écran) ; le `TransformGizmo` (axes, plans, écran, uniforme ; monde ou local ; pivot au centre ou aux origines ; pas magnétique ; taille constante ; testé analytiquement sur le CPU ; souris et doigt) et son `GizmoRenderer` (passes à lui) ; l'`History` (transactions imbriquées, fusion, limite) et les commandes (transforms, propriétés, création, suppression par une corbeille qui garde les entités, reparentage), un glissement de gizmo étant une seule entrée ; `SceneEvents` sur le nouveau `scene.observe()` d'`engine-scene`. `EditingTools` réunit le tout sur le pointeur et le clavier. Reportés : le contour atténué des parties cachées, la moitié arrière des anneaux, les gestes à plusieurs doigts, le rectangle par lancer de rayons, les commandes génériques des composants (avec les schémas de P16).

Le plan d'origine :

Les outils d'édition du moteur, dans un package à part, utilisables par n'importe quelle application (l'éditeur de jeu, le modeleur, un configurateur dans une page web). Ils étaient la première étape de l'ancien P13.

- **La sélection** : le clic et le rectangle par le buffer d'identifiants de P2b, la multi-sélection, le contour des objets sélectionnés ; le survol.
- **Les gizmos de déplacement, de rotation et de mise à l'échelle** : par axe, par plan, uniforme ou dans le plan de l'écran ; en repère local ou monde ; un pivot (centre de la sélection, origine de l'objet) ; le pas magnétique (snapping) ; une taille constante à l'écran, dessinés par-dessus la scène dans une passe à eux. Le survol et la saisie testés analytiquement sur le CPU (rayon contre axes, anneaux, plans), sans attendre la relecture du buffer d'identifiants. Souris, et tactile ensuite.
- **Les commandes** : chaque modification est une commande réversible, groupées en transactions (un glissement de gizmo est une seule entrée) ; l'historique avec annuler et refaire.
- **Les événements de la scène** : ce qui a changé (créé, supprimé, déplacé, modifié), pour les panneaux de l'éditeur et l'enregistrement.

Démo : sélectionner et transformer les objets d'une scène dans un exemple vivant de la doc, avec annuler et refaire ; les tutoriels (EN et FR).

### P16. Scènes et niveaux : import et export modulaires

_Faite_ (20 octobre 2026), avec ses tutoriels « Enregistrer et charger une scène » et « Écrire un importeur » et son guide « Scènes et formats » : le design et ce qui a été fait sont dans [p16-scenes.md](p16-scenes.md). Le package `@fdw/engine-scene-io` : `SceneData`, `captureScene` et `instantiateScene`, les codecs des composants (ceux de la scène et des niveaux de détail ; `physicsCodec`, `soundEmitterCodec`, `behaviorCodec` dans leurs packages ; le codec automatique des composants de nombres `persist: true`), les lots, les instances de modèles et de scènes avec leurs surcharges par chemin (les préfabriqués), le format `fdw-scene` (JSON et binaire, chargé par le store, migrations). `defineComponent` gagne `defaults`, `version`, `persist` ; le store `identify`, `normalize`, `resolve` ; `defineTexture`, les matériaux en graph comme données, les graphs comme ressources avec leurs migrations, la `CatalogSource`, les limites du `ZipReader`. Les enfants d'un nœud sont dans l'ordre de leur ajout. `engine-gltf` lit et écrit les scènes (`KHR_lights_punctual`, `KHR_physics_rigid_bodies`, `KHR_implicit_shapes`, `EXT_mesh_gpu_instancing`, `FDW_scene` pour le reste, sans perte), validé par le validateur de Khronos. Le niveau du TPS est un fichier, construit par un outil, chargé par le jeu, rejoué à l'identique (test), exporté en glTF. Reportés : le projet et la tenue du catalogue (P20), les surcharges des instances imbriquées, le package de jeu (P11), les animators en composants.

Le plan d'origine :

Enregistrer et recharger un niveau entier, pas seulement ses modèles : les nœuds, les meshes et les matériaux, mais aussi les lumières, les caméras, les corps et leurs formes de collision (P7b), les sons (P7), les animation graphs (P6) et les graphs de comportement (P9). Les ressources restent référencées par leur URI (P5).

- **Les schémas des composants** : chaque composant ECS décrit ses champs (types, valeurs par défaut, version). Ils servent l'enregistrement, l'inspecteur de l'éditeur (P20) et les commandes (P15) ; les composants de l'utilisateur se décrivent de la même façon.
- **Des importeurs et des exporteurs modulaires**, enregistrés comme les chargeurs de P5 : une interface pour lire ou écrire une scène, et des codecs par composant, pour qu'un utilisateur ajoute son format ou ses composants sans toucher au moteur. Les migrations entre versions d'un format.
- **Les formats fournis** : le format du moteur (JSON, les buffers à part), et glTF en import comme en export (KHR_lights_punctual, KHR_physics_rigid_bodies et KHR_implicit_shapes pour les corps et les formes, une extension du moteur pour les graphs).
- **Les préfabriqués** (une scène instanciée dans une autre, avec ses surcharges) : à décider dans le design, ici ou avec l'éditeur.
- Le chargement asynchrone, annulable, avec sa progression, par le système de ressources.

Démo : le niveau du TPS enregistré, rechargé et rejoué à l'identique, puis exporté en glTF et ouvert dans un autre outil ; un tutoriel sur l'écriture d'un importeur.

### P17. La mer et les vagues

_Faite_ (21 octobre 2026), avec ses tutoriels « La mer et ses vagues » et « Des objets qui flottent » et son guide « L'océan » : le design, les mesures et ce qui a été fait sont dans [p17-ocean.md](p17-ocean.md). Le package `@fdw/engine-ocean` : le spectre de Tessendorf (JONSWAP ou Phillips, trois cascades de 233, 37,7 et 6,3 m) tiré une fois sur le CPU, puis les huit champs de la mer (hauteur, mouvement horizontal, leurs dérivées) par des FFT inverses en compute graphs, rangés deux par deux dans quatre champs complexes, sur les trois backends (WebGL2 par rendu dans des textures), égaux à la FFT du CPU à 0,2 % près ; les sommes de vagues de Gerstner, exactes sur le CPU ; une grille d'anneaux (clipmap) qui suit la caméra par pas de sa plus grande cellule, sans fissure entre les anneaux ; le matériau de l'eau (Fresnel sur l'environnement, GGX du soleil, la scène vue à travers l'eau, déviée et absorbée selon la profondeur d'eau, le soleil à travers les crêtes, l'écume du jacobien et du rivage, les vagues trop fines pour le pixel rendues en rugosité) ; l'`OceanRenderer` (la scène et sa profondeur, le ciel, puis la mer) ; `Buoyancy`, Archimède en des points des corps de `engine-physics`, la hauteur de l'eau relue du GPU avec une image de retard. Corrigé en chemin : les couples des forces en un point, jamais remis à zéro par `engine-physics-rapier` ; le calcul émulé de WebGL2 en un seul dessin non instancié (60 fois plus rapide sur SwiftShader). La côte de `demo-scenes` (web `/coast`, natif `coast`) : 3,3 ms par image avec le spectre, 1,9 ms avec Gerstner (Vulkan) ; le spectre seul 0,16 ms. Reportés : la vue sous l'eau, les sillages, l'écume qui dure, les vagues des hauts-fonds, les reflets en espace écran.

Le plan d'origine :

Une mer animée sur les trois backends, éclairée de façon physique, et qui interagit avec la physique.

- **Les vagues** : des sommes de vagues de Gerstner d'abord (tous les backends, évaluables sur le CPU), puis le spectre océanique de Tessendorf (Phillips ou JONSWAP) par FFT : en calcul en WebGPU et Vulkan, en passes de rendu dans des textures en WebGL2 ([cg-webgl2.md](cg-webgl2.md)) ; plusieurs tuiles à des échelles différentes contre la répétition.
- **La surface** : une grille adaptative autour de la caméra, par la tessellation de P3b ou des anneaux de niveaux (clipmap), déplacée dans le vertex shader.
- **Le rendu** : la réflexion de Fresnel (IBL, reflet en espace écran), la réfraction et l'absorption selon la profondeur de l'eau (la cible de profondeur de P2b), une diffusion sous la surface approchée, l'écume (le jacobien de la FFT, le bord de côte).
- **La flottaison** : la hauteur de l'eau demandée par la physique (P7b) ; analytique pour Gerstner, relue sans attendre (une image de retard) pour la FFT.
- **Plus tard** : la vue sous l'eau, les sillages.

Démo : une côte, une mer qui s'agite, des caisses et une barque qui flottent ; les tutoriels (EN et FR).

### P18. L'éditeur : Electron et web

_Faite_ (24 octobre 2026) sous Linux, avec la section « L'éditeur » de la documentation (EN et FR) : son introduction, les tutoriels « Éditer un niveau » et « Écrire un plugin », la page « Le viewport natif », l'éditeur web vivant dans les pages. Les étapes 1 à 5 et 7 à 13 sont faites ; **l'étape 6 (Windows, macOS) et Wayland natif passent à P11**, avec la distribution de l'éditeur ; la suite (« Ensuite ») reste à faire, en fond ou avec P20. Le détail est dans [apps/editor/README.md](../apps/editor/README.md), [apps/editor-web/README.md](../apps/editor-web/README.md), [packages/editor-ui/README.md](../packages/editor-ui/README.md), [packages/editor-plugin-sample/README.md](../packages/editor-plugin-sample/README.md) et [packages/editor-plugin-isolate/README.md](../packages/editor-plugin-isolate/README.md).

- **Le viewport natif (étapes 1 à 3)** : le moteur tourne dans un processus utilitaire d'Electron (`apps/editor/src/engine`), qui reçoit le XID de la fenêtre : l'addon de l'éditeur y crée une fenêtre X11 enfant, transparente aux entrées, et `engine-vulkan` présente dedans avec sa propre swapchain (FIFO), sans copie. La page et le moteur se parlent par un `MessagePort` donné aux deux à chaque chargement : les bornes de la zone en pixels physiques, la scène, les entrées. Les entrées sont lues sur l'élément de la page par `WebInputSource`, puis rejouées dans le moteur (`RemoteInputSource`). Toutes les scènes de `demo-native` se choisissent à chaud : physique, mer, le jeu à la troisième personne avec ses modèles et ses sons. Elles tournent à 60 images par seconde (synchronisation verticale, RTX 2060), sans message de la couche de validation.
- **Les interactions (étape 4)** : la surface transparente aux entrées (le choix tranché aux étapes 1 à 3), vérifiée de bout en bout : l'éditeur lancé par Playwright dans Xvfb, sur lavapipe, les entrées données par le serveur X (XTest, `apps/editor/tests/xprobe.c`, qui lit aussi les pixels de l'écran) à travers la fenêtre enfant. Testés : le niveau dessiné dans la zone, à sa taille ; un clic sur un objet le sélectionne, les touches arrivent aux raccourcis une fois le viewport cliqué ; un glissé du bouton droit tourne la caméra, aussi hors du viewport (le pointeur capturé) ; le viewport suit la fenêtre redimensionnée ; pas d'images tant que la fenêtre est cachée ; la palette au-dessus du viewport, par un trou ; un rechargement de la page ; Dawn. Dans le job natif de la CI (`editor` porte le tag `gpu`). Non testés en CI : le verrouillage du pointeur (il faut un geste de l'utilisateur), la minimisation et le focus de la fenêtre (Xvfb n'a pas de gestionnaire de fenêtres), à revoir à l'écran.
- **Les performances (étape 5)** : mesurées par `apps/editor/scripts/measure.mjs` (RTX 2060 SUPER, X11, viewport en 1280 × 720, médiane de trois mesures) contre la même scène dans une fenêtre de `demo-native`. Le moteur coûte dans l'éditeur ce qu'il coûte seul (7,8 % d'un cœur contre 7,3 % sur `shadows`, 75 % contre 85 % sur `tps`) ; l'interface 5 à 6 % d'un cœur ; les trous rien de mesurable (la palette au-dessus du viewport garde 60 images par seconde ; un groupe flottant reste à mesurer, l'étape 10 l'avait vu ralentir) ; le repli sur Dawn 14 % d'un cœur de plus (la relecture et la copie). Le chemin direct est celui de Vulkan, sans copie. La status bar donne le temps CPU d'une image (celui du processus sur le bureau : la swapchain attend l'écran dans l'image) et le temps GPU des passes du niveau (timestamps) ; au passage, le `RenderGraphRunner` lit ses mesures à chaque image (le timer de Vulkan n'en prenait plus tant qu'on ne les lisait pas).
- **L'interface partagée (étape 7)** : le package `@fdw/editor-ui` contient le shell (`EditorShell`), le protocole du moteur (`@fdw/editor-ui/protocol`), le viewport d'un moteur hors de la page (`RemoteViewport`) et les composants shadcn/ui sur Tailwind 4 (thème sombre, taille `xs` pour les barres ; selects natifs, dont la liste passe au-dessus du viewport natif). L'interface `EditorHost` donne le moteur, le viewport, les fichiers (`open`, `save`), la persistance (des documents JSON par clé) et la page des popouts ; son implémentation Electron passe par le processus principal (dialogues, `userData/storage`, `setWindowOpenHandler` limité à `popout.html`). Le shell y garde son layout. Le côté moteur est `EditorEngine` (`@fdw/editor-ui/engine`, sans React) : le processus utilitaire ne fait plus que lui donner sa plateforme (Vulkan, la fenêtre X11, la surface, le rythme des frames), que la version web donnera à l'étape 9. Testés : le shell avec un hôte factice, `EditorEngine` avec une plateforme factice. Les plugins de l'hôte sont repoussés à l'étape 12, avec leur manifeste.

- **Le choix du backend sur le bureau (étape 8)** : `FDW_BACKEND` lu par le processus principal ; Vulkan par défaut, Dawn en repli (Vulkan qui ne démarre pas, ou une valeur inconnue), choisis par `startBackend` (`@fdw/editor-ui/engine`, que l'éditeur web reprendra). Dawn ne peut pas tourner dans un processus d'Electron, dont le V8 refuse les `ArrayBuffer` externes de `dawn.node` : il tourne dans un processus Node à part (`FDW_NODE`), auquel le processus du moteur relaie la page ; ses images sont copiées dans la fenêtre enfant par MIT-SHM, à 60 images par seconde au plus. Le backend actif et la raison du repli sont dans le message `ready` et la status bar ; la context key `engine.backend` attend l'étape 11. Toutes les scènes tournent sur les deux backends.
- **L'éditeur web (étape 9)** : `apps/editor-web` (Vite) donne au shell son `EditorHost` : le moteur dans la page, l'`EditorEngine` derrière un `MessageChannel` (le même protocole) ; les documents dans IndexedDB, les fichiers par la File System Access API (sinon un import et un téléchargement). Le moteur crée l'élément du viewport et y met son canvas ; `CanvasViewport` le place dans la zone, dont les bornes dimensionnent le canvas : il survit à un remontage, avec son contexte. Les scènes lisent un `WebInputSource` sur cet élément, sans relais (l'entrée `input` de la plateforme d'`EditorEngine`). `FDW_BACKEND` est lu par Vite ; WebGPU par défaut, WebGL2 en repli, chacun sur un canvas à lui (un canvas qui a eu un contexte WebGPU ne donne plus de contexte WebGL2). Les scènes de l'éditeur de bureau, par les mêmes noms, tournent à 60 images par seconde sur les deux backends (RTX 2060). Testé dans Chromium sans GPU (WebGPU et WebGL2 sur SwiftShader, le repli, IndexedDB), dans le job natif de la CI.

- **Le squelette façon QMainWindow (étape 10)** : un `GridviewReact` de dockview 8 avec la zone centrale et trois docks (gauche, droite, bas), chacun un `DockviewReact` ; la menu bar (le `Menubar` de shadcn : View, Scene), des toolbars sur les quatre côtés, la status bar. Les panneaux en dur jusqu'à l'étape 12 : le viewport, un accueil, l'outliner, l'inspecteur, la console (les messages du moteur). Le document de layout (les docks, les toolbars et leur côté, la status bar, le `toJSON` de la grille et de chaque zone) est écrit par l'hôte une fois les changements posés, et restauré ; sinon le layout par défaut. Vérifiés : le viewport reste monté derrière un onglet et avec les docks cachés (rendu `always`), caché par `visibility` : sa visibilité est lue à chaque frame, et une zone vide arrête le rendu ; le thème de dockview sur les variables de shadcn. Les menus et les groupes flottants au-dessus du viewport natif : une région de forme (les rectangles envoyés par la page, retirés de la fenêtre par `ShapeBounding`), vue à l'écran sur Vulkan : le rendu ralentit un peu quand un groupe flottant passe au-dessus (la présentation découpée par la région, à mesurer à l'étape 5) ; Dawn reste à voir. Testés : le shell dans jsdom, le calcul des trous, le canvas à travers les docks et les onglets dans Chromium.

- **L'état et les services (étape 11)** : dans `@fdw/editor-ui` (`src/state`), un runtime fait par le shell une fois le layout lu (l'état du moteur suivi dès le départ) : un registre de services (identifiants typés, création paresseuse, portées avec leurs services visibles, `dispose()` du dernier au premier) ; deux stores `@xstate/store`, l'éditeur (le chrome, la sélection, l'état des plugins) et le moteur (ses messages, jamais gardé) ; la machine du cœur (XState 5) en parallèle : le focus de la fenêtre, le mode, deux emplacements d'outils (`primary`, `secondary`). Les outils et les modes des plugins sont des acteurs enfants créés depuis leurs registres, par des gardes et des actions nommées que le runtime implémente ; Échap termine les outils, le focus d'une vue (la zone cliquée ou focalisée) et la perte de la fenêtre passent par le cœur avant les outils. Les context keys (`editor.focusedView`, `editor.mode`, `tool.primary`, `scene.hasSelection`, `engine.backend`…) et un évaluateur de `when` à la VS Code. Le snapshot de la machine est gardé avec le layout : XState ne persistant pas un enfant en ligne, chaque outil l'est à part, avec son identifiant, et un outil absent se replie sur `idle`. Vérifiées d'abord, les API de la version installée ([editor-state.md §1](editor-state.md#1-les-choix)). Testés sans React, et dans le shell ; la status bar montre le mode et les outils. Le routage des entrées par emplacement attend les outils du viewport (étape 13).

- **Les plugins (étape 12)** : dans `@fdw/editor-ui` (`src/plugins`), le manifeste vérifié à l'enregistrement (son `engine`, une plage de la version de l'API), ses contributions déclarées avant le chargement du code : les commandes, les vues, les menus (la menu bar, les sous-menus, les groupes), les toolbars, la status bar, les raccourcis, les outils et les modes (qui sont aussi des commandes). L'activation paresseuse : le code chargé et `activate(ctx)` appelé au premier événement (une vue montrée, une commande lancée, un outil activé, `onStartup`) ; ceux des outils du snapshot gardé chargés avant le runtime, pour que la machine les restaure. `ctx` : une portée de services, les enregistrements (chacun vérifié contre le manifeste et rendu par `dispose()`), l'état du plugin gardé avec le layout. Le shell n'a plus d'interface en dur : le viewport, l'arbre de la scène, l'inspecteur, la console, le menu View, les docks et la status bar sont des plugins built-in ; la palette de commandes (cmdk, Ctrl+Shift+P), Échap qui termine les outils, la liste des plugins (désactiver, réactiver). Le plugin d'exemple `@fdw/editor-plugin-sample` (un chunk à part) : un panneau, un outil dans l'emplacement `primary` ; un layout et un snapshot qui le référencent se rechargent avec lui (l'outil actif, son état) et sans lui (le panneau « plugin manquant », l'outil sur `idle`). Les questions ouvertes tranchées pour l'instant ([editor-ui.md §8](editor-ui.md#8-les-questions-ouvertes)) : des plugins de confiance, le layout par utilisateur, pas de partie « moteur ». Testés sans React, dans le shell (jsdom) et dans Chromium (l'éditeur web) ; vus à l'écran dans Electron sur Vulkan.

- **Le lien avec P15 et P16 (étape 13)** : le niveau édité vit dans le moteur (`LevelDocument`, `@fdw/editor-ui/engine`) : la `Scene`, l'`History` et la `Selection` de P15 ; montré par la scène `level` du viewport, la première (`LevelView` : picker, contour de la sélection et du survol, gizmo, caméra en orbite). Un nouveau niveau est celui d'exemple (fait de meshes et de matériaux en code) ; un fichier de l'utilisateur est ouvert par l'hôte : une scène du moteur (`.scene.json`, ses buffers dedans) ou du glTF (`.glb`) ; il est écrit par le moteur et enregistré par l'hôte, en scène du moteur ou exporté en `.glb`. La page en tient la projection (`createLevelStore`) : l'arbre entier à l'ouverture, puis les différences groupées par lot de `SceneEvents` ; la sélection, les propriétés du nœud actif, l'historique. Elle le modifie par les commandes de P15 (`level.command` : annuler, refaire, supprimer, ajouter, éditer une propriété, reparenter, sélectionner, cadrer). Le plugin built-in `fdw.level` : les menus File et Edit, la toolbar, les raccourcis (Ctrl+S, Ctrl+Z, Suppr, F, Q, W, E, R, X, C) ; les outils Move, Rotate et Scale dans l'emplacement `primary`, qui route le bouton principal du viewport (l'outil d'un autre plugin le prend) ; l'arbre de la scène (sélection, visibilité, glisser pour reparenter) et l'inspecteur (nom, visibilité, transform, composants) alimentés par la projection. Le rectangle de sélection, dessiné par la page, fait de quatre trous du viewport natif. Dawn reçoit les octets des niveaux en base64 (l'IPC de Node en JSON). Testés : le document sans React, le shell (jsdom), l'éditeur web dans Chromium (le picking relu sur WebGPU) ; vus à l'écran dans Electron sur Vulkan. Reportés : les références d'un niveau de l'utilisateur à d'autres fichiers (il faut un dossier, ou le projet de P20), la sélection gardée (avec le projet), un inspecteur par type de composant (les schémas de P20), des outils du viewport apportés par un plugin, l'ordre des frères rétabli quand un nœud revient de la corbeille (P15).

- **La documentation et la démo** : la section « L'éditeur » (EN et FR, `apps/docs/src/content/docs/editor`) : le lancer sur le bureau et sur le web, le choix du backend, de quoi il est fait ; le tutoriel « Éditer un niveau » (le layout, la caméra, la sélection, les outils, l'inspecteur, l'historique, les fichiers) ; le tutoriel « Écrire un plugin », sur le plugin `@fdw/editor-plugin-isolate` (le manifeste, l'activation, la projection du niveau, les commandes, une context key, un panneau, la status bar, les tests) ; « Le viewport natif » (les processus, les entrées, les trous, le repli, les mesures). L'éditeur web y est vivant : construit dans le site (`editor-web:build-docs`, sous `/fdw-engine/editor-app/`), montré dans des iframes (`Editor.astro`, `?embed` : rien de gardé), avec sa page à lui. Testés dans Chromium (WebGPU et WebGL2 sur SwiftShader) : les éditeurs des pages dessinent, le plugin du tutoriel isole la sélection, leurs images de référence. La démo est cet éditeur : sur le bureau (Vulkan) et dans le navigateur (WebGPU), le niveau de P16 dans son viewport, entre ses panneaux, les outils de P15 ; le plugin d'exemple et celui du tutoriel y ajoutent leurs panneaux, leurs outils et leurs commandes. Au passage : le premier panneau ouvert d'une zone reste actif dans un nouveau layout, la console a le rôle `log`.

Reporté : l'étape 6 et Wayland natif (P11), la suite (« Ensuite »).

**Revu le 23 octobre 2026** : l'éditeur aura aussi une version web, avec la même interface ; le backend se choisit par une variable d'environnement. Le socle de l'interface (étapes 7 à 13) suit les designs [editor-ui.md](editor-ui.md) et [editor-state.md](editor-state.md).

La base de l'éditeur, en React, sur deux hôtes qui partagent la même interface (`@fdw/editor-ui`) :

- **L'application de bureau** (Electron, `apps/editor`) : **le moteur garde son rendu natif** (Vulkan, ou Dawn en repli) dans une surface native posée dans la zone centrale de la fenêtre ; la WebView ne sert qu'à l'interface (panneaux, menus, inspecteur).
- **La version web** (`apps/editor-web`) : le moteur dans la page, rendu dans un `<canvas>` (WebGPU, ou WebGL2 en repli).

Le backend est choisi par `FDW_BACKEND` : `vulkan` ou `dawn` sur le bureau, `webgpu` ou `webgl2` sur le web ; sans la variable, Vulkan et WebGPU ; si le backend ne démarre pas, Dawn et WebGL2 ([editor-ui.md §4](editor-ui.md#4-le-choix-du-backend)).

**Le contrat du viewport** : React réserve une zone de la page et la mesure (`ResizeObserver`) ; la couche native y place sa surface, gère le DPI, et recrée la swapchain et les cibles de rendu quand la taille change. Selon le système :

| Système        | Surface native                                                                                       | État                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Linux, X11     | Une fenêtre X11 enfant de celle d'Electron, une surface Vulkan (`VK_KHR_xlib_surface` ou `xcb`)      | Le prototype ; sous XWayland aussi (`--ozone-platform=x11`) |
| Linux, Wayland | Une sous-surface (`wl_subsurface`) : demande la `wl_surface` d'Electron, que son handle ne donne pas | À étudier, après X11                                        |
| Windows        | Une fenêtre `WS_CHILD` dans le `HWND` d'Electron, une surface Vulkan Win32                           | Après la validation du contrat                              |
| macOS          | Une `NSView` avec un `CAMetalLayer` dans la vue d'Electron (MoltenVK, ou Dawn sur Metal)             | Electron le permet ; après la validation du contrat         |

**Les étapes du viewport natif :**

1. **Un prototype Linux** : Electron, React et un addon C++ qui crée une surface native dans la zone centrale de la fenêtre et y affiche une scène Vulkan minimale.
2. **Le viewport dans la zone HTML** : la surface placée dans la zone réservée par React, avec des panneaux latéraux. C'est le principal risque technique.
3. **La synchronisation du layout et du rendu** : les dimensions mesurées par React transmises à la couche native, qui gère la position, le DPI et la recréation des ressources de rendu.
4. **Les interactions** (_faite_ ; la surface transparente aux entrées, testée de bout en bout dans Xvfb) : la souris, le clavier, le focus, la capture de la souris pour la navigation 3D, le redimensionnement, la minimisation et la restauration de la fenêtre. À trancher : la surface native transparente aux entrées (une région d'entrée vide sous X11, `HTTRANSPARENT` sous Windows, `hitTest:` qui rend `nil` sous macOS), les événements arrivant alors à l'élément de la page, où `engine-input-web` et le verrouillage du pointeur de Chromium servent tels quels ; ou la surface qui reçoit les entrées, lues par `engine-input-native`, au prix du focus partagé avec la WebView.
5. **Les performances** (_faite_ ; le chemin direct est celui de Vulkan) : le coût CPU et GPU mesuré ; un chemin de rendu direct, sans transfert systématique des pixels par la mémoire du CPU.
6. **Les autres plateformes** (_passée à P11_, avec Wayland) : une fois le contrat du viewport validé, Windows et macOS, indispensables même si le développement commence sous Linux.

**Le socle de l'éditeur** (designs : [editor-ui.md](editor-ui.md), [editor-state.md](editor-state.md)). Chaque étape tourne dans les deux hôtes dès qu'il existe, avec ses tests :

7. **L'interface partagée** (_faite_ ; les plugins de l'hôte passent à l'étape 12) : le package `@fdw/editor-ui` (React, Tailwind, shadcn/ui), le shell actuel et le protocole du moteur (`shared/protocol.ts`) déplacés dedans ; l'interface `EditorHost` (moteur, viewport, fichiers, persistance, popouts, plugins) et son implémentation Electron. Le côté moteur (`src/engine`) devient un module qui ne dépend pas du processus utilitaire. L'éditeur de bureau marche comme avant.
8. **Le choix du backend sur le bureau** (_faite_ ; Dawn dans un processus Node à part) : `FDW_BACKEND` lu par le processus principal, transmis au moteur ; Vulkan par défaut, Dawn en repli, présenté par copie dans la fenêtre enfant (`XShmPutImage` dans l'addon de l'éditeur) ; le backend actif et la raison d'un repli dans le message `ready`, affichés dans la status bar.
9. **L'éditeur web** (_faite_ ; les entrées lues sur l'élément du viewport, sans relais) : `apps/editor-web` (Vite), son `EditorHost` : le moteur dans la page derrière un `MessageChannel` (le même protocole), un canvas dans la zone du viewport ; `FDW_BACKEND` lu par Vite, WebGPU par défaut, WebGL2 en repli à l'exécution ; les scènes de la démo choisies comme dans l'éditeur de bureau. En CI dans Chromium (WebGPU par SwiftShader, WebGL2).
10. **Le squelette façon QMainWindow** (_faite_ ; les trous des menus par une région de forme) : un `GridviewReact` avec la zone centrale (`DockviewReact`), les docks, la menu bar, la status bar et les toolbars sur les quatre côtés ; le layout enregistré et restauré par l'hôte. Vérifiés tôt : le viewport toujours monté (onglets, groupes, docks repliés), les menus et les flottants au-dessus du viewport natif (région de forme ou viewport figé), le thème de dockview sur celui de shadcn.
11. **L'état et les services** (_faite_ ; deux emplacements, les outils persistés par le runtime) : le registre de services (identifiants typés, portées, `dispose()`) ; les stores de l'éditeur (`@xstate/store`) ; la machine du cœur (focus, mode, emplacements d'outils) ; les context keys et l'évaluateur de `when`. D'abord, vérifier les API de la version installée de XState.
12. **Les plugins** (_faite_ ; des plugins de confiance, dans le bundle de l'application) : le manifeste, les registres (commandes, vues, menus, toolbars, status bar, raccourcis), l'activation paresseuse, `activate(ctx)` ; la palette de commandes. Les panneaux de l'éditeur deviennent des plugins built-in : le viewport, l'arbre de la scène, l'inspecteur, la console. Un plugin d'exemple qui ajoute un panneau et un outil (une sous-machine dans un emplacement) ; un layout et un snapshot qui le référencent, rechargés sans lui.
13. **Le lien avec P15 et P16** (_faite_ ; la projection par lots de `SceneEvents`, l'annulation par les commandes de P15 seules) : ouvrir et enregistrer un niveau (P16) par l'hôte ; la sélection, les gizmos, annuler et refaire de P15, par les commandes ; l'arbre de la scène et l'inspecteur alimentés par la projection du document que le moteur envoie.

Les étapes 7 à 9 passent avant la suite de l'étape 4 et les étapes 5 et 6 : elles posent l'architecture que le reste de l'éditeur suppose. Les questions ouvertes des deux designs (plugins tiers fiables ou non, layout par projet ou par utilisateur, partie « moteur » des plugins) sont tranchées pour les étapes 12 et 13, à revoir avec les plugins tiers et le projet (P20).

**Les points de vigilance :**

- **L'intégration native** : `getNativeWindowHandle()` donne la fenêtre d'Electron, mais ce handle ne suffit pas à intégrer une surface enfant à la composition HTML ; c'est l'objet des étapes 2 et 3.
- **Linux** : X11 (et XWayland) et Wayland testés séparément, en commençant par le chemin le plus simple sur la configuration de développement.
- **La composition** : le rendu hors écran dans une texture partagée avec Chromium (le module `sharedTexture` d'Electron) est écarté au départ : plus complexe, inutile si une surface native intégrée fonctionne. Il reste le recours si l'intégration échoue sur un système.
- **Pas d'interface transparente sur la 3D** au départ (pas de panneaux en `backdrop-filter: blur` par-dessus le rendu) : des panneaux classiques autour du viewport simplifient la composition et les performances. Les menus et les infobulles qui débordent sur la zone du viewport sont à vérifier.
- **Le processus du moteur** : la surface enfant dépend du handle de la fenêtre, connu du processus principal ; le moteur ne doit pas bloquer son thread d'interface (un thread à lui dans le processus principal, ou un processus utilitaire qui reçoit le handle, ce que permettent X11 et Win32 mais pas une `NSView`).

**Ensuite** : le rechargement à chaud, les popouts, les plugins tiers (chargés depuis le disque ou une URL, React et `@fdw/editor-ui` donnés par une import map ; sandbox et permissions), la désactivation des plugins gardée, le moteur web dans un worker (`OffscreenCanvas`), des composants partagés avec la doc pour que chaque panneau ait aussi son exemple vivant ; la distribution, Linux d'abord, l'addon précompilé pour Electron rejoignant P11, la version web publiée avec la doc.

**La documentation de l'éditeur** : une section à elle dans la doc (EN et FR), une fois l'éditeur assez mûr (au plus tôt après l'étape 13) : le lancer sur le bureau et sur le web, le choix du backend, l'interface, l'écriture d'un plugin, avec des tutoriels et des exemples vivants (l'éditeur web dans la page).

Démo : l'éditeur, sur le bureau (Vulkan) et dans le navigateur (WebGPU), ouvre un niveau de P16 dans son viewport, entre ses panneaux, et le montre avec les outils de P15 ; un plugin d'exemple y ajoute un panneau et un outil.

### P19. L'éditeur de graphs

_Faite_ (24 octobre 2026), avec ses tutoriels « Éditer un matériau », « Animer dans l'éditeur » et « Déboguer un comportement » (section « L'éditeur », EN et FR, éditeurs vivants) : le design et les choix sont dans [p19-graph-editor.md](p19-graph-editor.md). Un canevas maison en React (`@fdw/graph-editor` : nœuds en HTML, fils en SVG, géométrie calculée par `engine-graph`, comparé à React Flow, Rete.js et LiteGraph), trois plugins de l'éditeur (`@fdw/editor-plugin-material-graph`, `-animation-graph`, `-behavior-graph`), et la partie « moteur » des plugins (`EngineExtension`, messages `extension`) : le document vit dans le moteur (`@fdw/engine-graph-editing` : `GraphSession`, son `History` de P15, les trois sortes de graphs, `GraphWorkspace`), la page en tient la projection. `engine-graph` gagne le layout dans les documents (`autoLayout` pour les graphs faits en code) et les éditions pures ; les connexions refusées par la validation de la sorte. Les scènes donnent leurs graphs (`Scene.graphs`) : remplacés à chaque modification valide (`Material.withGraph`, `Animator.setGraph`, `BehaviorSystem.setGraph`). Matériaux : aperçu rendu par le moteur et relu, code du backend et source maps nœud ↔ ligne (lues dans `// #id`, les nœuds des macros rapportés à la macro par `WorkingGraph.origins`). Animations : vue des machines à états, états et poids pendant la lecture (`Animator.inspect`), paramètres forcés. Comportements : débogueur de P9 à la souris (F9, F5, F10, la scène gelée à l'arrêt), fonctions et macros (dépliées avant l'exécution, `expandFunctions`). Démo : la galerie procédurale et le TPS (l'IA, le héros, les ennemis) édités dans l'éditeur web et de bureau. Reportés : plusieurs graphs d'une sorte à la fois, les matériaux du niveau enregistrés après édition (P20), les points d'arrêt conditionnels, une mini-carte.

Le plan d'origine :

Un éditeur de programmation visuelle sur le cœur de graph de P6, le même pour les matériaux, les animations et les comportements. Il est un composant web : il vit dans l'application de P18 et dans les exemples vivants de la doc.

- **L'édition** : les nœuds et leurs ports typés, les connexions refusées quand les types ne s'accordent pas (la validation du cœur de graph), la recherche de nœuds, les commentaires et les groupes, copier et coller, annuler et refaire par les commandes de P15. Le design comparera une écriture maison et les bibliothèques existantes (Rete.js, LiteGraph, React Flow), sur leur taille et leur dépendance à un framework.
- **Les material graphs** : l'aperçu en direct, recompilé à chaque modification, les erreurs sur les nœuds, les source maps nœud ↔ ligne (§5).
- **Les animation graphs** : les machines à états, l'état et les poids courants pendant la lecture.
- **Les graphs de comportement** : le débogueur de P9 à la souris : les états des nœuds et la trace sur les fils, les points d'arrêt, le pas à pas ; puis les fonctions et les macros (un graph appelé par un autre).

Démo : un matériau procédural (P14) et l'IA du TPS modifiés et débogués dans l'éditeur ; les tutoriels (EN et FR).

### P20. L'éditeur de jeu

Un petit éditeur de jeu dans l'application de P18, qui réunit P15, P16 et P19. Il précède le ray tracing et le modeleur CAO, qu'il accueillera.

- **Les panneaux** : l'arbre de la scène, l'inspecteur (généré par les schémas des composants de P16), le navigateur de ressources (P5), la vue avec les gizmos (P15), les éditeurs de graphs (P19), la console.
- **La mise en place d'un niveau** : poser des modèles, des lumières, des caméras, des volumes ; éditer les formes de collision avec la vue de débogage de P7b ; peindre ou sculpter le terrain, plus tard.
- **Jouer dans l'éditeur** : lancer le jeu sur la scène en cours (l'ordonnanceur, la physique, les comportements), le mettre en pause, l'arrêter et retrouver la scène d'avant.
- **La publication** : le jeu construit pour le web (une page autonome), et en natif.

Démo : **un petit jeu fait entièrement dans l'éditeur**, par exemple un niveau du TPS reconstruit, joué dans l'éditeur puis publié sur le web.

### P21. Les fluides

_Faite_ (25 octobre 2026), avec ses tutoriels « L'eau sur un sol », « La fumée et le feu » et « Un liquide de particules » et son guide « Les fluides » (EN et FR, six exemples vivants) : le design, les choix et les mesures sont dans [p21-fluids.md](p21-fluids.md). Le package `@fdw/engine-fluids`, en compute graphs sur les trois backends, chaque pas jumelé sur le CPU et comparé au GPU par la suite de rendu : **l'eau sur un sol** (`ShallowWater`, les tuyaux virtuels : bassins, rivières sur un relief, sources, éclaboussures, l'eau conservée ; dessinée par le matériau de la mer de P17, `WaterSurface`), **la fumée et le feu** (`SmokeGrid`, stable fluids sur une grille décalée, en 3D ou dans un plan : émetteurs qui vacillent ou soufflent, obstacles, confinement de la vorticité ; une marche dans le volume en plein écran, `SmokeRenderer`), **un liquide de particules** (`ParticleFluid`, position-based fluids, les voisins par un tri bitonique sur le GPU sans atomiques ; rendu en espace écran, `ParticleFluidRenderer`). Les corps de la physique poussent les trois fluides (`FluidBodies`) ; l'eau et le liquide les portent par la `Buoyancy` de P17, qui gagne la vitesse de l'eau (les courants) ; l'`OceanRenderer` dessine toute eau sur le matériau de la mer. Démos : un bassin où l'on jette des objets, de la fumée qui contourne un obstacle, une cuve où un barrage se rompt (web et natif). Reportés : les sillages (Saint-Venant complet), la pression du liquide sur les corps, l'écume et les embruns, MacCormack, les fluides dans l'éditeur (P20).

Le plan d'origine :

Des simulations de fluides basées sur la physique, en passes de calcul (et de rendu dans des textures en WebGL2). Le design comparera les méthodes sur leur coût, leur rendu et leur repli WebGL2 :

- **Les champs de hauteur** (shallow water) : bassins, rivières, ondes ; peu coûteux, sur tous les backends ; une extension naturelle de la surface de P17.
- **Les grilles eulériennes** (stable fluids) : la fumée, le feu, en 2D puis en 3D ; des passes plein écran, adaptées à WebGL2. Le rendu par marche dans le volume.
- **Les particules** (SPH, position-based fluids) : l'eau qui coule et éclabousse, en WebGPU et Vulkan (la recherche des voisins demande le calcul) ; le rendu de la surface en espace écran (profondeur des particules, lissage, normales).
- **Le couplage avec la physique** (P7b) : les corps poussent le fluide, le fluide fait flotter les corps.

Démo : un bassin où l'on jette des objets, de la fumée qui contourne un obstacle ; les tutoriels (EN et FR).

### P10. Ray tracing

_Faite_ (25 octobre 2026), avec ses tutoriels « Les ombres par rayons », « Les reflets et l'occlusion ambiante par rayons » et « Le path tracing » et son guide « Le ray tracing » (EN et FR, trois exemples vivants) : le design, les choix et les mesures sont dans [p10-raytracing.md](p10-raytracing.md). Les structures d'accélération dans l'API abstraite (`createBottomLevel`, `createTopLevel`, `buildTopLevel`), **matérielles en Vulkan** (`VK_KHR_acceleration_structure`, `VK_KHR_ray_query`, sur le GPU comme sur lavapipe) et **logicielles en WebGPU** (un BVH à SAH construit sur le CPU, parcouru en WGSL) ; le nœud `ray.trace` et les fonctions des impacts (`ray.hit*`) dans les graphs, la cible « impact » du compilateur (la surface d'un matériau aux points touchés). Le package `@fdw/engine-raytracing` : la scène tracée (`RayScene`), **l'hybride** (les ombres tracées dans les matériaux, dures ou douces ; l'occlusion ambiante `RayOcclusion` ; les reflets `RayReflections`, les surfaces touchées éclairées avec leurs propres matériaux) et **le path tracer** (`PathTracer`, en vagues de passes de calcul, l'accumulation et un filtre à trous). Démos : le FPS (ses dalles polies) et le TPS en quatre rendus, du menu ou de `--rays` en natif. La suite (26 octobre 2026) : l'alpha des matériaux masqués pendant la traversée (des masques cuits), les meshes skinnés (structures ajustées sur le GPU) et les terrains en patchs (un mesh des rayons) dans la scène tracée, le débruitage d'une caméra qui bouge (un historique reprojeté), les pipelines de ray tracing de Vulkan, l'aperçu en ray tracing dans l'éditeur, avec le tutoriel « Les rayons sur la géométrie animée et générée ». DXR (27 octobre 2026) : les rayons sur Direct3D 12, en ray queries (DXR 1.1) et en pipelines de ray tracing.

Le plan d'origine (_repoussée le 18 octobre 2026 après l'éditeur de jeu, P20_) :

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

_Repoussée (18 octobre 2026)_ : Linux suffit tant que rien n'est distribué. Elle reviendra quand l'application de P18 le sera ; elle peut toujours avancer en fond.

_Reprise (30 octobre 2026), Windows d'abord_ : [p11-windows.md](p11-windows.md).

- **Windows et macOS** : addons, surfaces (Win32, Metal par MoltenVK), DXC ; construits et testés en CI. Le viewport natif de l'éditeur (l'étape 6 de P18) : une fenêtre `WS_CHILD` transparente aux entrées (`HTTRANSPARENT`) sous Windows, une `NSView` avec une `CAMetalLayer` sous macOS (le moteur dans un thread du processus principal : une `NSView` ne se partage pas entre processus) ; ses tests de bout en bout sur chaque système.
- **Wayland natif** pour l'éditeur : une sous-surface (`wl_subsurface`) de celle d'Electron, à la place de XWayland.
- **Binaires précompilés** des addons, pour installer sans CMake ni compilateur ; une application en un seul exécutable.
- **Le démarrage** : un cache de pipelines persisté, la précompilation des programmes (phase 7 du material graph).
- **N5** : Direct3D 12 — _fait_ (24 octobre 2026) : `@fdw/engine-d3d12`, le même `HlslCodegen` compilé en DXIL, la suite de rendu partagée et la démo native sur Direct3D 12 ([native-backends.md](native-backends.md), §10). Reste Dawn sans copie, si besoin.

### P13. Le modeleur CAO

_Repoussée (18 octobre 2026) après l'éditeur de jeu (P20)_ : ses fondations (la sélection, les gizmos, les commandes, la sérialisation, l'interface, les éditeurs de graphs) sont devenues P15, P16, P18, P19 et P20. Il reste ce qui est propre à la CAO, dans l'application de P18, à côté de l'éditeur de jeu. Chaque étape a son design.

1. **La précision des grandes coordonnées** (rendu relatif à la caméra), décisive pour la CAO et le BIM.
2. **Le noyau géométrique abstrait** : l'API que les moteurs géométriques implémentent (profils, solides, opérations, triangulation pour l'affichage). Le moteur fournit une implémentation de base : profils 2D, extrusion, révolution, triangulation des faces. Un noyau complet (OpenCascade, par exemple) peut se brancher derrière l'API, sans être une dépendance du projet.
3. **Les esquisses** : le dessin 2D sur un plan (segments, arcs, cercles), les contraintes (coïncidence, parallélisme, distances, angles) et leur solveur.
4. **Les opérations et l'arbre paramétrique** : extrusion, révolution autour d'un axe, puis d'autres (balayage, lissage, booléens selon le noyau). Un historique qu'on modifie et qui se recalcule.
5. **L'éditeur du middleware** : le modeleur et l'éditeur de jeu réunis, les pièces modélisées posées dans les niveaux.

## 4. Les dépendances

- **P1** avant **P8** : la forêt demande l'instancing et un coût par objet réduit.
- **P2** dépend des compute graphs dans le render graph ; **P3** des textures de stockage et des mipmaps.
- **P2b** : le rendu différé et les exemples de reflets après **P2** (pool de lumières, clusters, IBL) ; les MRT, les normales et les identifiants peuvent commencer avant. Les tangentes de glTF viendront avec **P5**.
- **P4** avant **P8** (caméra TPS, contrôleur de personnage) et avant **P13** (orbite CAO).
- **P5** avant **P6** (squelettes et clips de glTF), **P7** (sons chargés) et **P8**.
- **P4** (ordonnanceur à pas fixe, contrôleur de personnage) avant **P7b** ; **P7b** avant **P8** (le contrôleur de personnage et les volumes d'attaque sur l'API physique). Elle est indépendante de P5, P6 et P7, sauf pour les ragdolls (P6).
- **P6** (cœur de graph) avant **P9** et avant l'éditeur de graphs (**P19**).
- **P10** après **P20** (des scènes à tracer, faites dans l'éditeur) ; ses prérequis sont posés dès P1 (§6).
- **P3b** après **P2** (compute graphs dans le render graph) et le displacement mapping de **P2b** ; faite sans draws indirects : ils restent à ajouter pour les deux phases sans retard de **P3** (sa suite) et le choix des niveaux en calcul. Avant **P8** si la forêt a un terrain : le terrain existe (`buildTerrain` des demo-scenes).
- **P12** avant **P20** et **P13** : les décors faits main et les scènes de CAO et de BIM.
- **P14** avant **P17** (les bruits des vagues et de l'écume) et avant la démo de **P19** ; indépendante de l'éditeur.
- **P15** (sélection par le buffer d'identifiants de P2b, commandes) avant **P19** (annuler et refaire dans les graphs) et **P20**.
- **P16** sur **P5** (ressources), **P6** et **P9** (graphs en JSON), **P7b** (formes de collision) ; avant **P20**. Ses schémas de composants servent aussi les commandes de **P15**.
- **P17** après **P14** ; elle reprend la tessellation de **P3b**, la cible de profondeur de **P2b** et la physique de **P7b** (flottaison).
- **P18** avant **P20** ; **P19** est un composant web qui peut commencer avant, dans la doc.
- **P20** réunit **P15**, **P16**, **P18** et **P19**.
- **P21** après **P17** (le rendu de l'eau partagé) ; elle s'appuie sur les compute graphs et leur repli WebGL2.
- **P13** après **P20** : elle reprend son application et ses outils.

## 5. Plus tard, hors du plan

À reprendre quand un besoin les fera passer devant. La raison de chaque mise à l'écart :

| Chantier                                                                                                  | Pourquoi plus tard                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sortie HDR et couleurs étendues ([évolutions §4](evolutions.md#4-la-sortie-hdr-et-les-couleurs-étendues)) | Écrans HDR et navigateurs inégaux (canvas étendu surtout dans Chrome) ; aucune démo n'en dépend ; le tone mapping actuel suffit                  |
| Travail en parallèle sur le GPU ([évolutions §5](evolutions.md#5-le-travail-en-parallèle-sur-le-gpu))     | WebGPU n'a qu'une file ; le gain n'existe qu'une fois le GPU saturé par des passes de calcul (après P2, P3, à mesurer)                           |
| Transparence indépendante de l'ordre (OIT)                                                                | Peu d'objets transparents jusqu'ici, le tri suffit ; coûteuse en mémoire et en bande passante. À revoir pour le verre en CAO et en BIM (P13)     |
| Material graph : fonctions génériques, vraies fonctions dans le code généré                               | Ne compte que pour de gros graphs (taille du code, temps de compilation) ; à revoir avec l'éditeur de graphs (P19)                               |
| Material graph : `f16` de bout en bout                                                                    | Un gain surtout sur mobile, et une capacité inégale selon les GPU                                                                                |
| Material graph : `frag-coord` en WebGL2                                                                   | Aucun besoin jusqu'ici                                                                                                                           |
| Material graph : structures dans les storage buffers                                                      | Pas encore utile ; le pool de lumières (P2) ou le ray tracing (P10) pourraient le faire remonter ; les fluides (P21) s'en sont passés (des vec4) |
| Material graph : source maps nœud ↔ ligne                                                                 | Un confort de débogage, à faire avec l'éditeur de graphs (P19)                                                                                   |
| Material graph : limite et préchauffage des variantes                                                     | Lié au temps de démarrage : à traiter avec la précompilation (P11)                                                                               |
| Render graph : coût de la clé structurelle                                                                | Invisible aux tailles actuelles : à mesurer quand les graphes grossiront                                                                         |
| Vulkan : barrières groupées par le render graph                                                           | Une optimisation à justifier par le profilage (P0)                                                                                               |
| Vulkan : attente des frames hors du thread JavaScript                                                     | Un gain CPU faible tant que le sondage ne se voit pas dans les mesures                                                                           |
| Vulkan : `VK_EXT_swapchain_maintenance1`, `VK_KHR_present_wait`                                           | Du réglage fin de la latence et de la cadence des frames, après les gros chantiers                                                               |
| Documentation : changer de backend sans recharger la page                                                 | Un confort ; recharger suffit                                                                                                                    |

## 6. Rester compatible avec le ray tracing

Les contraintes déjà posées ([évolutions §6](evolutions.md#6-contraintes-de-compatibilité-pour-les-prochaines-étapes)) : un render graph qui accueille d'autres techniques que « un draw par objet », la séparation surface et éclairage, l'accès aux lumières par `light.current` / `light.sum` seulement, des capacités de backend consultées. Ce qu'elles impliquent pour les phases du plan :

- **P1** : les données des objets dans des tables indexées par identifiant (transforms, matériaux) plutôt que liées objet par objet. C'est aussi ce qui réduit les appels : le même travail sert les deux. Les buffers de géométrie créés avec les usages qu'un BLAS demandera.
- **P2** : le pool de lumières dans un storage buffer : le ray tracing y tirera ses lumières. L'IBL en textures que les rayons pourront lire.
- **P2b** : les cibles de normales et de profondeur serviront au débruitage de l'hybride et du path tracer ; les sorties de surface passent par la séparation surface et éclairage, comme la cible `bsdf`.
- **P3** : la scène tient des identifiants stables et des tables de la scène sur le GPU : la TLAS se construira à partir d'elles.
- **P5** : les meshes chargés restent des buffers GPU accessibles (storage), pas seulement des vertex buffers ; les textures prêtes pour le bindless.
- **P3b** : les rayons ne voient pas la géométrie évaluée dans le vertex shader. Le calcul des niveaux doit pouvoir écrire aussi les sommets tessellés dans un buffer, pour les BLAS (à un niveau fixé ou choisi pour la caméra), comme le skinning en calcul de P6.
- **P6** : **le skinning dans une passe de calcul**, qui écrit les sommets animés dans un buffer, plutôt que dans le vertex shader : la rastérisation, les ombres et la mise à jour des BLAS lisent alors les mêmes sommets.
- **P14** : les bruits et les motifs sont des fonctions de surface : la cible BSDF du path tracer les compile comme le reste.
- **P17**, **P21** : comme pour P3b, la mer déplacée dans le vertex shader est invisible des rayons : ses sommets doivent pouvoir être écrits dans un buffer pour les BLAS. Les particules et les surfaces des fluides restent dans des storage buffers.
- **P20**, **P13** : l'éditeur rend en rastérisation, avec la même scène et les mêmes matériaux ; une vue en ray tracing y devient un aperçu, pas un second moteur.
