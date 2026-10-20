---
title: Outils d'édition
description: La sélection, les gizmos, les commandes et les événements de la scène, pour les applications qui modifient une scène.
sidebar:
  order: 16
---

`@fdw/engine-editing` contient les outils d'une application qui modifie
une scène : un éditeur, un modeleur, un configurateur dans une page web.
Chaque brique s'utilise seule ; `EditingTools` les réunit sur le pointeur
et le clavier. Le [tutoriel](/fdw-engine/fr/tutorials/editing/) construit
pas à pas un éditeur de scène avec elles.

| Export                                                                                              | Ce que c'est                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Viewport`, `pointerPixel`                                                                          | Une caméra et une taille en pixels : rayons, projections, taille d'un pixel   |
| `Picker`                                                                                            | Les objets sous un pixel ou dans un rectangle, par une texture d'identifiants |
| `Selection`, `selectionMode`                                                                        | Les objets sélectionnés, l'actif, le survolé                                  |
| `Outline`, `renderablesOf`                                                                          | Des contours par-dessus l'image                                               |
| `TransformGizmo`, `GizmoRenderer`                                                                   | Le gizmo de déplacement, de rotation et d'échelle, et son dessin              |
| `hitHandles`, `raySegmentDistance`, `rayCircleDistance`, `rayPlane`                                 | Les tests des poignées, sur le CPU                                            |
| `History`, `Command`, `CommandGroup`, `defineCommand`                                               | L'historique des modifications réversibles                                    |
| `TransformCommand`, `PropertyCommand`, `CreateNodeCommand`, `DeleteNodesCommand`, `ReparentCommand` | Les commandes de la scène                                                     |
| `SceneTrash`                                                                                        | Où attendent les nœuds supprimés, pour revenir                                |
| `SceneEvents`                                                                                       | Les changements d'une scène, par lots                                         |
| `EditingTools`, `toolPointer`                                                                       | Le tout sur le pointeur et le clavier                                         |

## Ce qui se modifie

Les outils déplacent des **éditables** : les nœuds d'une `Scene`, ou des
`Transform` seuls (des items dessinés sans scène). Un nœud bouge dans
l'espace de son parent ; sélectionné avec l'un de ses ancêtres, il ne
bouge qu'une fois, avec lui (`topmost`). Un nœud est **vivant** tant qu'il
est dans sa scène : ni détruit, ni dans la corbeille (`isAlive`).

## Viewport

| Membre                        | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `new Viewport(camera, w, h)`  | La caméra est relue à chaque appel                              |
| `resize(width, height)`       | La taille de la cible, en pixels                                |
| `ray(point)`                  | Le rayon qui passe par un pixel (perspective et orthographique) |
| `project(point)`              | `{ x, y, depth }` : le pixel d'un point du monde, sa profondeur |
| `worldPerPixel(point)`        | La taille d'un pixel en un point, en unités du monde            |
| `direction(point)`, `forward` | De la caméra vers un point ; là où la caméra regarde            |

Les pixels se comptent depuis le coin en haut à gauche de la cible. Le
rapport de la caméra est celui de sa projection (gardez-le égal à celui de
la cible).

## Picker

`new Picker(backend, resolve)`, ou `Picker.forScene(backend, scene,
resolve?)`. `output(graph, width, height)` donne la sortie `'object-id'`
des passes de la scène, dans une texture `r32uint` qui appartient au
picker (recréée quand la taille change). `pick(point)` et `pickRect(from,
to)` la relisent, une frame ou deux plus tard ; `resolve` donne, pour un
identifiant, l'objet sélectionné (`undefined` : non sélectionnable).

## Selection

| Membre                                    | Description                                                    |
| ----------------------------------------- | -------------------------------------------------------------- |
| `items`, `size`, `active`, `has(item)`    | Les objets sélectionnés, dans l'ordre ; l'actif est le dernier |
| `apply(items, mode)`                      | `'replace'`, `'add'`, `'remove'`, `'toggle'`                   |
| `set`, `add`, `remove`, `toggle`, `clear` | La même chose, par leur nom                                    |
| `filter(keep)`                            | Garde les objets acceptés (ceux encore dans la scène)          |
| `hovered`                                 | L'objet sous le pointeur                                       |
| `onChange`, `onHover`                     | Écouteurs ; ils renvoient une fonction qui arrête              |

`selectionMode(modifiers)` : Ctrl ou Cmd inverse, Maj ajoute, Alt retire,
sans modificateur on remplace.

## Outline

`new Outline(renderer, backend)`, puis `addPasses(graph, options)` à
chaque frame : `items`, `camera`, `target`, `format`, `size`, `color`
(RGBA, dans l'encodage de la cible ; orange par défaut), `width` (en
pixels, 2), `name` (un par contour d'une frame). Deux passes : les items
dans un masque `r8unorm` (leur alpha), puis une passe plein écran qui
mélange le trait sur la cible, là où le masque a un bord (16 lectures sur
deux cercles). Il renvoie la version de la cible écrite, pour les passes
suivantes (la cible elle-même sans items : rien n'est dessiné).

## TransformGizmo

| Option, membre                         | Description                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `mode`                                 | `'translate'`, `'rotate'`, `'scale'`                                                   |
| `space`                                | `'world'` ou `'local'` (les axes de l'objet actif) ; l'échelle est toujours locale     |
| `pivot`                                | `'center'` (des bornes de la sélection) ou `'origin'` (de chaque objet)                |
| `snap`, `snapping`                     | Les pas : `translate` (unités), `rotate` (degrés), `scale` (un facteur) ; actif ou non |
| `size`                                 | La longueur des axes à l'écran, en pixels (110)                                        |
| `history`                              | Où les glissements sont enregistrés                                                    |
| `targets`                              | Ce qu'il transforme ; le dernier est l'actif                                           |
| `visible`, `shown`                     | Caché par l'application ; affiché (visible, avec des cibles)                           |
| `hovered`, `active`, `dragging`        | La poignée sous le pointeur, celle qui est tirée                                       |
| `frame(viewport)`                      | Son origine, ses axes, sa rotation et son échelle dans le monde                        |
| `hitTest(viewport, point, tolerance?)` | La poignée sous un pixel (8 pixels de tolérance)                                       |
| `hover(viewport, point)`               | Met `hovered` à jour                                                                   |
| `begin`, `drag`, `end`, `cancel`       | Un glissement : `end()` enregistre une `TransformCommand` ; `cancel()` remet en place  |

Les poignées (`GizmoHandle`) : `x`, `y`, `z` (un axe, un anneau), `yz`,
`zx`, `xy` (un plan), `view` (le plan de l'écran ; l'anneau autour de la
vue), `uniform` (le centre de l'échelle). Leurs tailles, en unités du
gizmo (des axes de longueur 1), sont dans `GizmoShape`. Les axes vus de
bout (à moins de 14° de la vue) et les plans vus par la tranche sont
cachés.

Comment un glissement déplace les cibles :

- **Le long d'un axe** : le point de l'axe le plus proche du rayon sous le
  pointeur ; **dans un plan** : là où le rayon le traverse.
- **Autour d'un anneau** : l'angle entre les vecteurs qui vont du pivot à
  l'endroit où le rayon traverse son plan, additionné pas à pas (plus d'un
  demi-tour est gardé) ; un anneau vu par la tranche suit plutôt le
  pointeur le long de sa tangente à l'écran.
- **L'échelle** : tirer de la longueur d'un axe double ; la poignée
  uniforme suit le pointeur vers la droite et vers le haut.
- Les cibles sont écrites depuis leur état au début du glissement : pas de
  dérive, `cancel()` exact.

`GizmoRenderer(renderer, { colors })` : `items(gizmo, viewport)` pour les
items de rendu, `addPasses(graph, gizmo, viewport, { target, format, name
})` pour des passes de scène par-dessus la cible, avec leur propre
profondeur, sans éclairage, sans ombres ; il renvoie la version de la
cible écrite. Pendant un glissement, seule la poignée tirée est dessinée.

## Historique et commandes

Une `Command` a un `label`, `do()`, `undo()`, et au besoin `merge(next)`
(absorber la commande suivante) et `dispose(undone)` (libérer ce qu'elle
garde quand l'historique l'oublie).

| Membre de `History`                              | Description                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `execute(command)`                               | Fait et enregistre (dans la transaction ouverte, s'il y en a une)               |
| `record(command)`                                | Enregistre une commande déjà faite                                              |
| `begin(label)`, `commit()`, `cancel()`           | Une transaction : une entrée ; imbriquées, seule la plus extérieure en fait une |
| `transaction(label, body)`                       | Valide quand `body` rend la main, annule quand il lève une erreur               |
| `undo()`, `redo()`                               | False quand il n'y a rien à annuler ou à refaire                                |
| `canUndo`, `canRedo`, `undoLabels`, `redoLabels` | Pour les menus                                                                  |
| `clear()`, `limit`, `onChange`                   | Tout oublier ; les entrées gardées (100) ; un écouteur                          |

| Commande                                            | Fait                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `TransformCommand(label, targets, before, after)`   | Écrit des transforms locaux ; `capture(targets)` les lit                   |
| `PropertyCommand(label, { get, set }, value, key?)` | Change une valeur ; fusionne avec la suivante de même `key`                |
| `CreateNodeCommand(label, parent, options, build?)` | Crée un nœud, préparé une fois par `build` ; `node`                        |
| `DeleteNodesCommand(label, nodes)`                  | Supprime des nœuds et leurs branches                                       |
| `ReparentCommand(label, nodes, parent)`             | Déplace des nœuds sous un autre parent, en gardant leurs transforms locaux |
| `CommandGroup(label, commands)`                     | Des commandes faites dans l'ordre, annulées à rebours                      |

Les nœuds supprimés vont dans la `SceneTrash` de leur scène : une branche
cachée, hors de l'arbre, où ils gardent leur entité, leurs composants et
leurs handles. `CreateNodeCommand` annulée, `DeleteNodesCommand` faite,
l'historique les détruit quand il oublie la commande.

## SceneEvents

`new SceneEvents(scene, { delivery })` : `'microtask'` (par défaut) livre
après le code qui a fait les changements ; `'manual'` à `flush()`.
`listen(listener)` reçoit `{ created, removed, moved, modified }`, des
ensembles d'entités. Construit sur `scene.observe()` (voir le
[guide du scene graph](/fdw-engine/fr/guides/scene-graph/#observateurs)) ;
les nœuds qui vont à la corbeille sont supprimés, ceux qui en reviennent
créés (ou déplacés, dans le même lot). `dispose()` arrête.

## EditingTools

`new EditingTools({ viewport, selection, picker?, gizmo?, history?,
dragThreshold?, tolerance? })` :

- `pointerDown(pointer)` : saisit une poignée, ou commence une sélection ;
  renvoie s'il suit le pointeur (seulement le bouton principal) ;
  `pointerMove`, `pointerUp`, `pointerLeave` ;
- `rectangle` : le rectangle en cours, `onChange` pour le redessiner ;
- `keyDown(key)` : W, E, R, X, C, Ctrl+Z, Ctrl+Y, Ctrl+Maj+Z, Suppr,
  Retour arrière, Échap ; renvoie si la touche a servi ;
- `undo()`, `redo()`, `cancel()`, `deleteSelection()`.

`toolPointer(event, canvas)` fait d'un événement de pointeur ce qu'ils
lisent. `tolerance` vaut 8 pixels pour une souris, 20 pour un doigt ; un
doigt ne survole pas.
