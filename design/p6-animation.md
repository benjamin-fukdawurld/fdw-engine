# P6 : le cœur de graph, l'animation et l'animation graph

Le design de la phase P6 de la [roadmap](roadmap.md#p6-cœur-de-graph-et-animation) : un cœur de graph commun aux material graphs, aux animation graphs et aux graphs de comportement (P9) ; l'animation squelettique (les clips de glTF, l'échantillonnage, les mélanges) et le skinning sur le GPU ; l'animation graph (machines à états, blend spaces, couches et masques, événements).

Contraintes : le skinning compatible avec le ray tracing (§6 de la roadmap : les sommets animés écrits dans un buffer, lus par la rastérisation, les ombres et plus tard les BLAS) ; un repli en WebGL2, sans calcul ; des packages indépendants, l'animation sur le CPU sans le GPU ni la scène ; le reste du moteur (matériaux, ombres, culling) inchangé.

## 1. Aujourd'hui

| Ce qui existe                                                                                            | Ce qui manque                                                                |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Les squelettes et les animations lus par glTF (P5) : `SkinData`, `AnimationClipData`, `joints`/`weights` | Les jouer : échantillonner, mélanger, appliquer aux nœuds                    |
| Le material graph : nœuds, ports typés, registre, sérialisation, validation, diagnostics                 | Ce qui est général séparé de ce qui est propre aux shaders                   |
| Les compute graphs (storage buffers, `ComputeRunner`), lisibles dans un vertex stage par `std.index`     | Une passe de calcul qui déforme un mesh                                      |
| Les attributs calculés (`g.vertexAttribute`, P3b)                                                        | Lire l'attribut du mesh qu'un attribut calculé remplace : le point de départ |
| Les bornes d'un renderer tirées des positions de son mesh                                                | Des bornes données : les sommets d'un personnage bougent sur le GPU          |

## 2. Les options

### 2.1 Le cœur de graph

| Option                                        | Intérêt                                                                          | Coût                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A. Chaque type de graphe a son modèle         | Rien à extraire                                                                  | Trois fois les mêmes vérifications, trois éditeurs                                   |
| **B. Un cœur générique, chaque type l'étend** | **Un modèle, une sérialisation, une validation de structure ; l'éditeur commun** | Le material graph réécrit sur le cœur, sans changer son API                          |
| C. Le material graph généralisé tel quel      | Pas de nouveau package                                                           | Les types de shaders, les swizzles, l'inférence générique imposés aux autres graphes |

**Choix : B.** `@fdw/engine-graph` porte ce qui ne dépend pas des shaders ; le material graph y ajoute ses types (l'inférence des génériques, les swizzles, les sorties, les ressources).

### 2.2 Le skinning

| Option                                      | Principe                                                                   | Intérêt                                                                                   | Coût                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **A. Passe de calcul (WebGPU, Vulkan)**     | Les sommets skinnés une fois par image dans un buffer, lus par leur numéro | **Une fois pour toutes les passes (caméra, ombres) ; le buffer est celui des BLAS (P10)** | Un buffer par instance ; un dispatch par primitive                         |
| **B. Vertex stage (tous, repli de WebGL2)** | Chaque passe skinne son sommet, les matrices dans une texture              | **Tous les backends** ; rien en mémoire par instance que les matrices                     | Refait dans chaque passe (une par cascade d'ombre)                         |
| C. Transform feedback (WebGL2)              | Un vertex shader écrit les sommets dans un buffer                          | Le buffer de A en WebGL2                                                                  | Un troisième chemin, propre à WebGL2, qui n'a pas de ray tracing à nourrir |
| D. Sur le CPU                               | Les sommets envoyés à chaque image                                         | Simple                                                                                    | Lent dès quelques milliers de sommets ; l'envoi à chaque image             |

**Choix : A, et B en repli.** Le transform feedback n'apporterait à WebGL2 que ce qu'il n'utilisera pas (le ray tracing) ; B y suffit. Les deux chemins partagent le même mesh, la même pose et les mêmes matrices ; seul le graphe du matériau change.

**Les sommets du calcul lus par leur numéro.** Le buffer écrit par la passe n'est pas un vertex buffer du mesh : le vertex stage le lit par `std.index(skinned, vertex-index × stride)`, et en fait les attributs `position`, `normal` et `tangent` du graphe (les attributs calculés de P3b). Le `Renderer` ne change pas ; le mesh garde ses uv et ses couleurs.

### 2.3 L'exécution des animation graphs

| Option                                | Intérêt                                                             | Coût                                                                    |
| ------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **A. Interprété : un objet par nœud** | **Simple, débogable (l'état de chaque machine), assez rapide (§8)** | Un appel par nœud et par image                                          |
| B. Compilé en JavaScript              | Plus rapide                                                         | Un compilateur de plus ; à comparer en P9, où les graphs le demanderont |

**Choix : A.** 7,5 µs par personnage et par image (§8) : le coût de l'animation est ailleurs (les matrices, l'envoi).

## 3. Le cœur de graph

`@fdw/engine-graph`, sans dépendance :

- **Le modèle** : `GraphNode<P, D>` (id, type, paramètres, valeurs par défaut des entrées, label), `PortRef`, `GraphEdge`, `GraphDocument` (format, version, nom, nœuds, arêtes), `portKey`.
- **Les diagnostics** : `Diagnostic`, `formatDiagnostic`, `GraphError`.
- **Le registre** : `Registry<D>` ; `NodeRegistry` du material graph en hérite.
- **Les paramètres** : `ParamSchema`, `checkParams` (requis, valeurs, inconnus), `basicParamCheck` (`string`, `number`, `boolean`, `numbers`, `json`), `resolveParams`.
- **La structure** : `resolveNodes` (ids en double), `resolveEdges` (nœuds et ports inconnus, une arête par entrée, un contrôle propre au type : les swizzles), `checkDefaults`, `topologicalOrder`, `incomingEdges`.
- **La sérialisation** : `parseDocument` (format, version, nom, nœuds, arêtes, et les champs du type), `serializeDocument`.
- **Une validation complète** pour les graphes à ports simplement typés : `validateDocument` (types des ports, entrées non connectées sans défaut, contrôle du graphe entier). Les animation graphs l'utilisent ; le material graph garde la sienne (inférence des génériques).

Le material graph est réécrit dessus sans changer son API ni ses messages : ses 186 tests passent tels quels.

## 4. L'animation

`@fdw/engine-animation`, sur le CPU, ne dépend que du cœur de graph :

- **`Skeleton`** : des articulations, chacune après son parent, une pose de repos, le nœud d'origine de chacune. `Skeleton.fromHierarchy(model.data)` prend les nœuds d'un modèle en profondeur d'abord (la forme de `ModelData`, sans en dépendre).
- **`Pose`** : trois tableaux plats (translations, rotations, échelles), locaux au parent. `Pose.blend` (rotations par nlerp sur le plus court chemin, un masque optionnel), `Pose.difference` et `Pose.add` (les couches additives : la rotation de base, puis la différence), `modelMatrices`.
- **`AnimationClip`** : des pistes (une articulation, un canal) et des événements. `fromData` lit une animation glTF, ses canaux associés aux articulations par leur nœud ; les poids des morph targets sont laissés de côté. Interpolations de glTF : `STEP`, `LINEAR` (slerp des rotations), `CUBICSPLINE` (Hermite). `additiveClip` : la différence avec la première pose.
- **`BoneMask`** : un poids par articulation, par branches.

## 5. L'animation graph

Un graphe du cœur, au format `fdw-animation-graph` : des ports `pose`, `number` et `boolean`, des paramètres déclarés (`number`, `boolean`, `trigger`). Les nœuds : `anim.clip`, `anim.parameter`, `anim.blend`, `anim.blend1d`, `anim.layer`, `anim.stateMachine`, `anim.output`. `AnimationGraphBuilder` les construit par des poignées ; `validateAnimationGraph` ajoute aux vérifications du cœur : une sortie, les paramètres lus et comparés (existence, type), les états (uniques, initial), les transitions (états, triggers, conditions, durées), les points des blend spaces (croissants).

L'`Animator` l'exécute pour un personnage : un objet par nœud, avancé une fois par image même s'il alimente deux entrées.

- **Les machines à états** : les transitions sont choisies au début d'une mise à jour, dans leur ordre ; une transition exige ses conditions, son trigger (consommé) et son temps de sortie (en cycles de l'état depuis son entrée). Le fondu dure `duration` ; l'état d'arrivée repart de zéro (`resetOnEnter`).
- **La synchronisation** des blend spaces (par défaut) : une phase commune, qui avance de dt / (Σ wᵢ durée(i)), donnée aux entrées actives ; la marche et la course gardent les pieds en rythme.
- **Les événements** : un clip émet ceux qu'il franchit, boucles comprises (un événement à 0 est atteint en bouclant). Un mélange, un blend space et un fondu ne gardent que ceux de leur entrée la plus lourde ; une couche garde ceux des deux. Un pas, pas un par clip mélangé.
- **Les entrées inactives** (poids nul) n'avancent pas.

## 6. Le skinning

`@fdw/engine-skinning` : `Skinning(backend, instance, model, { mode })`.

1. **À la création** : pour chaque nœud du modèle qui a un skin, chaque primitive reçoit un matériau à elle, `material.withGraph(skinGraph(graphe, mode, attributs))` (le graphe skinné est construit une fois par graphe, mode et attributs) ; en mode `compute`, un buffer des sommets skinnés ; par nœud skinné, une texture `rgba32float` de 4 × articulations (mode `vertex`) ou un storage buffer (mode `compute`) des matrices. Les données du mesh (articulations, poids normalisés, sommets de repos en vec4) sont lues une fois par mesh (`MeshSkin`), ses buffers créés une fois par backend.
2. **`applyPose(pose)`** écrit les positions, rotations et échelles dans le pool de transforms de la scène.
3. **`update()`** : les matrices inverse(nœud) × articulation × inverse bind, envoyées ; les bornes. En mode `compute`, **`addPass(graph)`** ajoute au render graph de l'image une seule passe de calcul qui enregistre un dispatch par primitive (64 sommets par workgroup), soumise avec l'image (`renderer.render({ prepare })`) ; `dispatch()` fait de même hors d'un graphe, en une soumission. Les bind groups sont réutilisés d'une image à l'autre (cache de `ComputeRunner` par programme et par ressources).

**Les graphes.** Le mode `vertex` mélange les matrices (Σ wᵢ Mᵢ, 16 lectures de texels) puis transforme la position, la normale et la tangente lues par `g.meshAttribute` ; le mode `compute` lit le buffer skinné. Le noyau de calcul lit les sommets de repos, les articulations (`vec4u`), les poids et les matrices dans des storage buffers et écrit les sommets skinnés (`stride` vec4 par sommet : la position, w = 1 ; la normale ; la tangente, w son signe).

**Les bornes.** Pour chaque articulation, le rayon de ses sommets autour d'elle dans la pose de liaison (calculé une fois). À chaque image, une sphère par articulation, autour de sa position, du rayon mis à l'échelle de sa matrice. Un sommet skinné est une moyenne pondérée de points dans ces sphères : la boîte qui les contient le contient. Elle remplace celle du mesh (`node.setBounds`).

## 7. Ce qu'il a fallu ajouter au moteur

- **`g.meshAttribute(sémantique, type)`** (paramètre `mesh` d'`input.attribute`) : lit l'attribut du mesh même quand le graphe le calcule. Ce que lit toute déformation (le skinning, le vent, les morph targets à venir).
- **`GraphBuilder.extend(graphe)`** : continue un graphe construit ailleurs (ses nœuds, arêtes, paramètres et fonctions), pour qu'un outil y ajoute des nœuds.
- **`Material.withGraph(graphe, valeurs)`** : une variante d'un matériau, ses valeurs, features et états de rendu repris.
- **`Scene.setLocalBounds` / `Node.setBounds`** : des bornes données dans l'espace du nœud, à la place de celles des positions du mesh.

## 8. Mesures

L'`Animator` (`Animator.bench.ts`, Node 24) : un squelette de 18 articulations, des clips de 30 clés par seconde sur chaque articulation, le graphe du tutoriel (un blend space de trois clips, une machine à états, une couche masquée), marche et course mélangées : **7,5 µs** par mise à jour, 9,3 µs avec les matrices des articulations. Un millier de personnages tiendrait dans une image de 60 Hz sur un cœur, avant les envois au GPU.

## 9. Tests

- **`engine-graph`** : un petit type de graphe (nombres, textes) : l'ordre, les paramètres résolus, les ports, les types, les entrées sans défaut, les ids en double, les arêtes en double, les cycles, les documents mal formés, le registre.
- **`engine-shader`** : les 186 tests inchangés ; `meshAttribute` sous un attribut calculé ; `GraphBuilder.extend` (sorties gardées, ids uniques).
- **`engine-animation`** : les squelettes depuis une hiérarchie, les poses (mélange masqué par le plus court chemin, addition, matrices), les interpolations, les canaux de glTF, les clips additifs, les masques ; l'animateur : la boucle et ses événements, les clips sans boucle, le blend space (poids, synchronisation, événements du plus lourd), la machine à états (fondu, trigger consommé, temps de sortie, conditions, retour), les couches masquées et additives, un nœud partagé, les clips, masques et paramètres manquants ; la validation et la sérialisation des graphes.
- **`engine-skinning`** (faux backend) : les graphes des deux modes compilés, le noyau refusé sans calcul, les données d'un mesh, le skinning CPU, les matériaux remplacés puis rendus, les matrices relatives au nœud, les bornes, les dispatches.
- **`engine-scene`**, **`engine-core`** : les bornes données ; `Material.withGraph`.
- **Suite de rendu, trois backends** : les sommets du calcul égaux à ceux du CPU (Dawn, Vulkan) ; une bande pliée par une articulation dessinée en mode `vertex` partout (les attributs entiers de WebGL2 compris) et en mode `compute` où il existe. Ses programmes passent aussi par Tint, DXC et glslang.
- **Documentation** : le tutoriel « Un personnage animé » (EN, FR), son exemple vivant et ses captures en WebGPU (calcul) et WebGL2 (vertex stage) ; le guide « Animation ».

## 10. La suite

1. **La démo** : le personnage dans une démo jouable (P8 en fera le héros du TPS), avec le contrôleur de personnage de P4.
2. **Root motion** : le déplacement des hanches pris au clip pour déplacer le personnage.
3. **Les morph targets** (les canaux `weights` de glTF), dans la même passe de calcul.
4. **Les événements des états** (entrée, sortie) et des nœuds de calcul sur les paramètres ; la compilation en JavaScript, comparée en P9 ([p9-behavior.md](p9-behavior.md) §8 : environ 18 fois plus rapide que l'interpréteur pour un graph de comportement ; l'`Animator`, dont le coût est dans les poses, n'en a pas besoin pour l'instant).
5. **Le skinning par quaternions doubles**, contre la perte de volume des articulations tordues.
6. **Le ray tracing** (P10) : le buffer skinné comme vertex buffer des BLAS (l'usage `vertex` à ajouter), leur mise à jour à chaque image.
7. **Les éditeurs** (P13) sur le cœur de graph : material graphs et animation graphs.

## 11. Décisions

À valider :

1. **Un cœur de graph séparé** (`engine-graph`), le material graph réécrit dessus sans changer son API (§2.1).
2. **Le skinning en calcul, le vertex stage en repli** ; pas de transform feedback (§2.2).
3. **Les sommets du calcul lus par leur numéro** par le vertex stage, sans changer le `Renderer` (§2.2).
4. **Les animation graphs interprétés** (§2.3).
5. **La règle des événements** : un mélange garde ceux de son entrée la plus lourde, une couche ceux des deux (§5).
6. **Des bornes par sphères autour des articulations**, calculées sur le CPU (§6).

## 12. État

**Faite** (16 octobre 2026) : `engine-graph` et le material graph réécrit dessus ; `engine-animation` (`Skeleton`, `Pose`, `AnimationClip`, `BoneMask`, `AnimationGraphBuilder`, `Animator`) ; `engine-skinning` (`Skinning`, `skinGraph`, `skinningKernel`, `MeshSkin`, `skinPositions`) ; `g.meshAttribute`, `GraphBuilder.extend`, `Material.withGraph`, `Node.setBounds`. Le modèle `character.glb` (généré par `tools/docs/make-character.mjs`), le tutoriel « Un personnage animé » (EN, FR) avec son exemple vivant et ses captures, le guide « Animation », le cœur de graph dans le guide du material graph. Reste la suite du §10.
