# P15 : la sélection, les gizmos et les commandes

Les outils d'édition du moteur ([roadmap P15](roadmap.md#p15-sélection-gizmos-et-commandes)), dans un package à part, `@fdw/engine-editing`, utilisable par n'importe quelle application : l'éditeur de jeu (P20), le modeleur (P13), un configurateur dans une page web. Le moteur avait le nécessaire pour la sélection au pixel (la sortie `'object-id'` et `pickIds` de P2b, `scene.objectId` et `scene.entityOf`), les rayons (`Ray`, `scene.raycast`), les transforms de la scène ; rien pour tirer des poignées, annuler, ni savoir ce qui change.

## 1. Les choix

| Question                       | Choix                                                                                                                                                       | Écartés, et pourquoi                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le package                     | **`@fdw/engine-editing`**, sur `engine-core`, `engine-scene`, `engine-geometry`, `engine-shader` ; pas d'`engine-input` ni de DOM                           | Dans `engine-scene` : le jeu embarquerait les gizmos ; sur `engine-input` : les outils lisent un pointeur avec ses modificateurs, plus simple à donner depuis n'importe quelle source (DOM, SDL, tests) |
| Ce qui se modifie              | **Les nœuds d'une `Scene` et les `Transform` seuls** (`Editable`)                                                                                           | Une interface abstraite de cible : une indirection de plus pour deux cas seulement                                                                                                                      |
| La sélection au pixel          | **Le buffer d'identifiants** (`Picker`, qui possède la texture)                                                                                             | `scene.raycast` : les bornes, pas les pixels ; pas de rectangle. Reste la voie au-delà de 2^24 objets                                                                                                   |
| Le contour                     | **Un masque** (passes de scène sans couleur, sortie `r8unorm` de l'alpha) **puis une passe plein écran** qui cherche un bord sur deux cercles de 8 lectures | Relire les identifiants dans le shader avec une liste d'identifiants sélectionnés : un tableau d'uniforms borné ; dessiner les objets agrandis (inverted hull) : faux sur les meshes non lisses         |
| Le test des poignées           | **Analytique sur le CPU**, dans l'espace du gizmo : rayon contre segments, carrés, cercles (polygone de 64 côtés)                                           | Le buffer d'identifiants : une ou deux frames de retard au survol et à la saisie                                                                                                                        |
| Le dessin du gizmo             | **Des passes de scène à lui** (`load: 'load'`, sa propre profondeur), des meshes faits une fois, un matériau `unlit` par poignée                            | Une passe sans profondeur : les poignées se croiseraient mal ; des lignes : pas de lignes épaisses en WebGPU                                                                                            |
| Un glissement                  | **Les cibles bougent à chaque pas**, recalculées depuis leur état de départ ; **une `TransformCommand` enregistrée à la fin** (`history.record`)            | Une commande par pas fusionnée : l'historique s'agiterait à chaque mouvement, et l'annulation d'un pas n'a pas de sens                                                                                  |
| L'échelle                      | **Toujours dans les axes des objets**                                                                                                                       | Dans les axes du monde : un objet tourné serait cisaillé, ce que son transform (position, rotation, échelle) ne représente pas                                                                          |
| Les nœuds supprimés            | **Une corbeille** (`SceneTrash`) : une seconde racine cachée, hors de l'arbre ; détruits quand l'historique oublie la commande                              | Les détruire et les recréer à l'annulation : une autre entité, d'autres handles, et les commandes plus anciennes de l'historique pointeraient sur des nœuds morts                                       |
| La sélection dans l'historique | **Non**, comme Unity et la plupart des éditeurs                                                                                                             | Oui (Blender) : chaque clic deviendrait une entrée                                                                                                                                                      |
| Les événements                 | **`scene.observe()`** dans `engine-scene` (appelé à chaque changement), **`SceneEvents`** qui les rassemble en lots                                         | Comparer les versions des transforms à chaque frame : O(n) ; ne signaler que les changements des commandes : les systèmes du jeu ne seraient pas vus                                                    |

## 2. La sélection

- **`Viewport`** : la caméra et la taille de la cible, en pixels depuis le coin en haut à gauche. Le rayon d'un pixel est calculé depuis la position, la rotation et la projection de la caméra (champ vertical, rapport de la projection ; orthographique : origine décalée), sans passer par les matrices des backends, dont les conventions de profondeur diffèrent. `worldPerPixel(point)` donne la taille d'un pixel à la profondeur d'un point : la taille constante du gizmo.
- **`Picker`** : la texture `r32uint` des identifiants, recréée quand la taille change, importée comme cible de la sortie `'object-id'` ; `pick` et `pickRect` relisent par `pickIds`. `Picker.forScene(backend, scene, resolve)` relie les identifiants aux nœuds ; `resolve` choisit ce qui se sélectionne (l'ancêtre sous la racine pour un modèle, rien pour le sol). Une relecture qui échoue (texture remplacée) rend une liste vide.
- **`Selection<T>`** : une liste ordonnée, le dernier est l'objet actif ; `apply(items, mode)` avec `replace`, `add`, `remove`, `toggle` ; `selectionMode` lit les modificateurs ; `hovered`. Écouteurs de changement et de survol.
- **`Outline`** : un matériau par nom de contour (les valeurs d'un matériau sont lues à l'exécution du graphe, après tous les appels). Le masque passe par l'alpha de la surface : les matériaux masqués gardent leur découpe. Le trait est mélangé (`blend`) par-dessus la cible, dans son encodage.

## 3. Les gizmos

Un repère : l'origine (le centre des bornes des cibles, ou l'origine de l'objet actif), les axes (ceux du monde, ou la rotation de l'objet actif ; toujours ceux de l'objet pour l'échelle), une échelle `size × worldPerPixel(origine)`. Les poignées sont décrites en unités du gizmo (axes de longueur 1, `GizmoShape`) ; le rayon est ramené dans cet espace, et la tolérance en pixels devient `tolérance / size`.

| Mode        | Poignées et test                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `translate` | Axes : segment de 0,2 à 1 ; plans : carré de 0,3 à 0,55 sur les deux axes, par l'intersection du plan ; `view` : sphère de 0,12 au centre |
| `rotate`    | Anneaux de rayon 1 autour de chaque axe ; `view` : anneau de rayon 1,2 face à la caméra                                                   |
| `scale`     | Axes, plans comme en translation ; `uniform` : le centre                                                                                  |

La poignée la plus proche dans la tolérance l'emporte, le centre en cas d'égalité. Les axes à moins de 14° de la vue et les plans vus à moins de 12° de la tranche sont cachés et ignorés.

Le glissement, depuis l'état de départ (positions et rotations monde, transforms locaux) :

- **Axe** : le paramètre du point de l'axe le plus proche du rayon ; **plan** et **`view`** : l'intersection du rayon et du plan passant par le pivot. Le pas magnétique arrondit le déplacement sur chaque axe du gizmo.
- **Anneau** : l'angle entre les vecteurs du pivot vers l'intersection du plan de l'anneau, additionné pas à pas (au-delà d'un demi-tour). Un anneau vu par la tranche (moins de 15° entre son plan et la vue) suit la tangente de l'anneau à l'écran, à l'endroit saisi : angle = déplacement le long de la tangente / rayon à l'écran. Le pas arrondit l'angle total.
- **Échelle** : facteur = 1 + déplacement le long de l'axe / longueur de l'axe dans le monde (tirer de la longueur d'un axe double) ; plan : le long de la diagonale ; uniforme : vers la droite et le haut de l'écran. Au moins 0,01.
- **Écriture** : la position et la rotation monde de chaque cible (autour du pivot, ou de sa propre origine avec `pivot: 'origin'`), ramenées dans l'espace du parent par l'inverse de sa matrice monde et sa rotation ; l'échelle locale multipliée axe par axe. Les cibles sous une autre cible sont retirées (`topmost`).
- **Fin** : `end()` enregistre une `TransformCommand` (avant, après) si les cibles ont bougé ; `cancel()` remet l'état de départ, exactement.

`GizmoRenderer` : les meshes (tubes, cônes, cubes, anneaux, carrés, sphère) faits une fois par mode et poignée, un `Transform` pour le repère et un autre tourné comme la caméra pour l'anneau `view` ; les plans translucides (`blend`, double face). Pendant un glissement, seule la poignée tirée est dessinée. `addPasses` rend la version de la cible écrite, à enchaîner.

**Tactile** : `EditingTools` donne à un doigt une tolérance de 20 pixels (8 pour la souris) et pas de survol ; seul le premier pointeur appuyé est suivi.

## 4. Les commandes

`Command` : `label`, `do()`, `undo()`, et au besoin `merge(next)` et `dispose(undone)`. `History` :

- `execute` fait et enregistre ; `record` enregistre ce qui est déjà fait (le gizmo) ;
- les transactions `begin`, `commit`, `cancel`, `transaction(label, body)`, imbriquées : seule la plus extérieure fait une entrée (`CommandGroup`, ou la commande seule si elle porte le même nom) ;
- `merge` n'est tenté qu'entre deux commandes exécutées seules, à la suite, sans annulation entre elles (`PropertyCommand` de même `key` : les pas d'un curseur) ;
- `limit` (100) : les plus anciennes sont oubliées (`dispose(false)`), les annulées aussi quand une nouvelle commande arrive (`dispose(true)`).

Commandes fournies : `TransformCommand`, `PropertyCommand`, `CreateNodeCommand` (le nœud fait une fois, `build` une fois ; refaire le ramène de la corbeille), `DeleteNodesCommand` (les plus hauts seulement), `ReparentCommand`, `defineCommand`. Les nœuds de la corbeille sont vivants (`node.alive`) mais pas « dans la scène » : `isAlive` les exclut, la sélection les oublie après une annulation.

## 5. Les événements

`Scene.observe(observer)` et `Scene.notify(entity, change)` dans `engine-scene` : `created` (`create`, `createBatch`), `removed` (`destroy`, chaque entité de la branche), `moved` (`touch` : transform local, parent, visibilité), `modified` (`attach`, `detach` donc `setMesh`, `setLight`, `setCamera` ; `name`, `layers`, `visible`, `static`, `occluder`). Sans observateur, un test de longueur de tableau ; `create` ne signale plus de `moved` (il invalide sans notifier).

`SceneEvents` rassemble en lots (après le code, par micro-tâche, ou à `flush()`) : une entité créée puis supprimée dans le lot disparaît ; supprimée, elle n'est plus déplacée ni modifiée ; créée, son `moved` n'apparaît pas. La corbeille signale `discarded` et `restored` : supprimés, puis créés (ou seulement déplacés s'ils reviennent dans le lot qui les a jetés).

## 6. La démo et les tests

- **Tutoriel « Sélection, gizmos et commandes »** (EN, FR), avec l'exemple vivant `editing` : une scène (sol, cubes, sphères, une table de cinq nœuds sélectionnée d'un bloc), l'orbite au bouton droit, une barre d'outils (modes, repère, pivot, pas, annuler, refaire, ajouter, supprimer), le contour de la sélection et du survol, le rectangle, la ligne d'état (sélection, dernière entrée, derniers événements). Captures de référence WebGPU et WebGL2, et un test Playwright : glisser l'axe x, annuler, sélectionner au rectangle, supprimer, annuler.
- **Guide « Outils d'édition »** (EN, FR) ; section « Observateurs » du guide du scene graph.
- **Tests unitaires** : historique (transactions imbriquées, annulées, limite, fusion), commandes sur une scène (corbeille, entités gardées), événements par lots, sélection, viewport (perspective, orthographique), tests des poignées, glissements (axe, pas, plan, écran, anneaux de face et par la tranche, échelle autour du centre et des origines, hiérarchie mise à l'échelle, `Transform` seuls), `EditingTools` ; observateurs de la scène.

## 7. Reportés

- Le contour des objets cachés plus pâle (lire la profondeur de la scène dans la passe de masque).
- La moitié arrière des anneaux de rotation masquée, et la boule de rotation libre (trackball).
- Les gestes à plusieurs doigts (pincer pour l'échelle) ; le tactile se limite au premier doigt.
- La sélection au rectangle par le lancer de rayons (au-delà de 2^24 objets, ou sans GPU) : un frustum construit depuis le rectangle et `scene.queryVolume`.
- Les commandes génériques des composants : avec leurs schémas (P16).
- L'ordre des frères n'est pas rétabli quand un nœud revient de la corbeille (il passe en dernier enfant, depuis P16).

## 8. État

**Faite** (19 octobre 2026), branche `FDW-P15`.
