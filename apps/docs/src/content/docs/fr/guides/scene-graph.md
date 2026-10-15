---
title: Scene graph
description: La scène, son cœur ECS, ses transformations et leur invalidation, ses index, et la façon dont le renderer la dessine.
sidebar:
  order: 9
---

`@fdw/engine-scene` donne une scène au moteur : des entités dans une
hiérarchie, avec des transformations, dessinées par le `Renderer` en tant
que source, et répondant à des requêtes spatiales. Son cœur est un **ECS**,
avec les **nœuds** comme façade.

## Deux points d'entrée

| Entrée       | Pour                                                              | Ressemble à                                 |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| **Nœuds**    | Éditeurs, CAO, BIM, jeux avec quelques centaines d'objets mobiles | `player.transform.position = { x: 2 }`      |
| **Systèmes** | Des milliers d'objets mis à jour à chaque frame                   | `data[e * stride + position] += speed * dt` |

Les deux travaillent sur les mêmes données : un nœud est une poignée sur une
entité.

## Nœuds

```ts
const scene = new Scene();
const player = scene.root
  .add({ name: 'player', position: { y: 1 } })
  .setMesh(body, skin);
const lamp = player
  .add({ position: { y: 1.5 } })
  .setLight(new SpotLight({ castShadow: true }));
const eye = player.add({ position: { y: 12, z: 6 } }).setCamera(camera);
```

| Membre                                           | Rôle                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `transform`                                      | Un `Transform`, relatif au parent                                                       |
| `worldMatrix`, `worldPosition`                   | À jour à la lecture                                                                     |
| `parent`, `children`, `add()`, `remove()`        | La hiérarchie ; `add(node)` déplace un nœud sous celui-ci                               |
| `setMesh()`, `setLight()`, `setCamera()`         | Attachent un mesh et un matériau, une lumière, une caméra                               |
| `attach(component, values)`, `has()`, `detach()` | Vos propres composants                                                                  |
| `visible`                                        | Les nœuds cachés ne sont pas dessinés, ni leurs descendants                             |
| `layers`                                         | Un masque de 32 bits : une vue ne voit que les nœuds dont les layers croisent les siens |
| `static`, `occluder`                             | Voir ci-dessous                                                                         |
| `name`, `id`, `traverse()`                       | `scene.find(name)` trouve un nœud                                                       |

Un nœud dont l'entité a été supprimée lève une erreur à l'usage :
`node.alive` l'indique.

### Beaucoup de nœuds d'un coup

Un niveau, une ville, un assemblage CAO : des milliers de nœuds semblables,
créés d'un coup. `scene.createBatch()` les crée sans nœud ni objet par
entité — les transformations viennent de tableaux plats, les composants
sont écrits colonne par colonne :

```ts
const walls = scene.createBatch({
  count: 2400,
  parent: level.entity, // the root by default
  positions, // x, y, z per wall: a Float32Array of 3 × 2400
  scales, // optional, as rotations (x, y, z, w per entity)
  mesh: cube,
  material: stone,
  static: true,
  occluder: true,
});
scene.node(walls[0]).attach(Solid); // a node when you need one
```

Elle renvoie les entités, dans l'ordre des tableaux ; `scene.node(entity)`
donne le nœud de l'une d'elles. Les autres options sont celles d'un nœud
(`name`, `layers`, `visible`, `castShadow`).

## Transformations et invalidation

Les transformations d'une scène sont des blocs de son `TransformPool`
(`scene.transforms`), indexés par entité : valeurs locales, matrice monde,
matrice des normales. `node.transform` est un `Transform` sur le bloc de son
entité, la même classe que partout ailleurs dans le moteur.

Rien n'est à mettre à jour à la main :

1. Modifier une transformation (ou déplacer un nœud, le cacher)
   **invalide** sa branche : les matrices monde en dessous sont périmées.
   Invalider dix fois le même nœud dans une frame ne coûte qu'une fois.
2. Une matrice monde est **recalculée à la lecture**, et celles de ses
   ancêtres périmés d'abord.
3. Chaque requête de la scène — le rendu, un raycast — applique d'abord les
   changements en attente (`scene.flush()`) : matrices monde, englobants,
   index spatiaux, les lumières et caméras qui suivent des nœuds.

La matrice des normales est calculée plus tard encore, uniquement pour les
objets dessinés.

## Nœuds statiques et occluders

- Un nœud **statique** ne bouge pas. La scène le calcule une fois, et
  indexe tous les nœuds statiques d'un coup dans un index qui leur est
  propre, construit de haut en bas. En déplacer un reste possible, mais a
  un coût ; la scène avertit une fois.
- Un **occluder** (un mur, un bâtiment) est un nœud qui en cache d'autres.
  `scene.occluders()` les liste. L'[occlusion culling](#occlusion-culling)
  n'en a pas besoin : tout objet opaque dessiné cache ce qui est derrière.

## La scène comme source

```ts
renderer.render({ source: scene, camera, surface, layers: 0b01 });
```

Pour chaque vue — la caméra, chaque shadow map — le renderer demande à la
scène ce qui se trouve dans son frustum. La scène répond à partir de ses
deux octrees lâches, statique et dynamique, sans tester chaque nœud. Une
requête de caméra enregistre aussi sur chaque nœud la dernière requête qui
l'a retenu (`NodeState.lastVisible`), et passe par `scene.occlusion`
lorsqu'il est défini : une étape à vous (une visibilité précalculée, des
portails), appliquée aux seules requêtes de caméra, jamais aux projeteurs
d'ombre.

## Occlusion culling

Ce que le frustum garde peut encore être caché par ce qui est devant :
depuis une rue, les premiers immeubles cachent presque tous les autres. Un
`OcclusionCulling` (de `@fdw/engine-occlusion`) donné aux passes de la scène
les retire :

```ts
const occlusion = new OcclusionCulling();
renderer.render({ source: scene, camera, surface, occlusion });
```

Après les objets opaques, des passes plein écran réduisent le depth buffer
en pyramide et y testent la boîte de chaque objet que le frustum a gardé ;
les résultats sont relus sans attendre, et les objets trouvés cachés sont
retirés une à trois frames plus tard, jusqu'à ce qu'un test les trouve de
nouveau visibles. Il fonctionne sur tous les backends (sans compute
shaders), avec toute source. Le
[tutoriel](/fdw-engine/fr/tutorials/occlusion-culling/) le montre sur une
ville.

| Option       | Défaut | Rôle                                                                                                                           |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `margin`     | 0,001  | De combien, relativement, une boîte doit être plus loin que la profondeur devant elle pour être cachée                         |
| `motion`     | 2      | Les boîtes grandissent de la distance parcourue par la caméra depuis la frame précédente, fois ceci : moins d'objets en retard |
| `maxPending` | 2      | Résultats attendus au plus : pas de nouveau test tant qu'ils le sont                                                           |

- Un par vue (caméra) : il retient ce que les tests de sa vue ont trouvé.
- `renderer.stats.get(name).occluded` compte ce qu'il a retiré ;
  `occlusion.isHidden(item)` dit ce que les derniers résultats ont trouvé
  d'un objet.
- Les projeteurs d'ombre ne sont jamais retirés ; les objets sans bornes non
  plus.
- Pas encore avec le multi-échantillonnage (`samples: 1`) : il lit la
  profondeur.
- Dans un graphe à vous, le graphe doit connaître la taille de la frame
  (`new RenderGraph({ size })`).

## Requêtes

| Requête                                      | Renvoie                                                         |
| -------------------------------------------- | --------------------------------------------------------------- |
| `scene.raycast(ray, visit, options, max)`    | Les nœuds touchés par le rayon, du plus proche au plus lointain |
| `scene.queryVolume(volume, visit, options)`  | Les nœuds qui croisent un `Volume` quelconque                   |
| `raycastEntities()`, `queryVolumeEntities()` | La même chose, avec des entités, pour les systèmes              |

Elles testent les englobants des meshes, puis le `volume` passé à
`setMesh()` s'il y en a un. `options` filtre par `layers`, et inclut les
nœuds cachés avec `hidden: true`. `visit` renvoie false pour s'arrêter.

## Le cœur ECS

La scène est construite sur un `World`, utilisable seul :

```ts
const world = scene.world;
const Velocity = world.defineComponent('velocity', {
  x: 'f32',
  y: 'f32',
  z: 'f32',
});
const Path = world.defineComponent('path', { points: 'ref', speed: 'f32' });

world.add(enemy.entity, Velocity, { x: 1 });

const moving = world.query(Velocity, not(Path));
function move(dt: number) {
  const { data } = scene.transforms;
  const { stride, position } = TransformLayout;
  for (const e of moving) {
    data[e * stride + position] += Velocity.x[e] * dt;
    scene.transforms.touch(e);
  }
}
```

- Les **entités** sont des nombres, des indices dans les colonnes. Un
  indice détruit est réutilisé plus tard ; sa génération change, ce que
  vérifient les nœuds.
- Les **composants** ont un schéma de champs typés — `f32`, `f64`, `i8`…
  `u32`, `ref` pour un objet, `['f32', 3]` pour un vecteur. Chaque champ est
  une **colonne** : un tableau typé indexé par entité (`Velocity.x[e]`). Les
  colonnes sont remplacées quand le monde grandit : lisez-les là où elles
  sont utilisées.
- Les **requêtes** (`world.query(A, B, not(C))`) restent à jour à mesure
  que des composants sont ajoutés et retirés. `entities` et `count` sont le
  moyen le plus rapide de les parcourir ; retirez des composants en les
  parcourant à rebours.
- **Écouteurs** : `world.onAdded()`, `world.onRemoved()`.
- Les **systèmes** sont de simples fonctions : le cœur n'impose aucun
  ordonnanceur. Un `Scheduler` les exécute dans l'ordre quand on le veut
  (ci-dessous).

Les composants de la scène, pour les systèmes : `Hierarchy` (parent, premier
enfant, frères), `NodeState` (drapeaux, layers, dernière visibilité, nom),
`MeshRenderer` (mesh, matériau, `noShadow`, volume, englobant monde — la
table des englobants du GPU culling à venir), `Light`, `CameraView`. Leurs
drapeaux valent 0 par défaut : `noShadow` plutôt que `castShadow`.

## L'ordonnanceur

Un `Scheduler` exécute des systèmes frame après frame, en quatre phases :
`begin` (une fois, les entrées), `fixed` (à chaque pas fixe, la logique),
`update` (une fois, par défaut : caméras, interpolation), `render` (une
fois, en dernier).

```ts
const scheduler = new Scheduler({ step: 1 / 60, maxSteps: 5 });
scheduler.add('input', () => input.update(), { phase: 'begin' });
scheduler.add('move', move, { phase: 'fixed' });
scheduler.add('gravity', gravity, { phase: 'fixed', before: ['move'] });
scheduler.add('draw', () => draw(scheduler.alpha));
scheduler.add('render', render, { phase: 'render' });
onFrame((dt) => scheduler.update(dt));
```

- **Ordre** : l'ordre d'ajout dans une phase, précisé par `before` et
  `after` (des noms de la même phase ; les noms absents sont ignorés). Un
  cycle fait lever une erreur à `add()`.
- **Pas fixe** : autant de pas que la frame en contient, `maxSteps` au
  plus ; `steps`, `time`, et `alpha` (de 0 à 1, où en est la frame entre
  les deux derniers pas, pour dessiner entre eux).
- **Contrôle** : `paused`, `timeScale` et `step()` n'agissent que sur la
  phase `fixed` (mis en pause par un pas, les pas restants de la frame sont
  abandonnés) ; `system.enabled`, `remove(name)`, `systems(phase)`.
- Un système est une fonction `(dt) => void` : l'ordonnanceur ne connaît
  pas de monde, et `FixedStep` s'utilise seul.

Voir le tutoriel [Les systèmes et le pas fixe](/fdw-engine/fr/tutorials/systems/).

## Autres scènes

`SceneNode` et `SceneGraph` décrivent une scène indépendamment de celle-ci,
et le renderer ne connaît que `RenderSource`. Une scène d'instances CAO, ou
l'ECS d'un moteur de jeu, peut être dessinée par le renderer en
implémentant `RenderSource` :

```ts
interface RenderSource {
  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    view: 'camera' | 'shadow'
  ): void;
  lights?(): Iterable<BaseLight>;
  bounds?(out: Aabb): Aabb;
}
```

Une liste d'éléments est aussi une source : `render({ items })` teste
chaque élément contre le frustum.

## Coûts

Sur 10 000 nœuds dont 1000 visibles : une requête de caméra prend environ
0,06 ms, déplacer 1000 nœuds puis faire une requête 0,65 ms, une frame du
renderer environ 1 ms (contre 18 ms sans culling). Créer 100 000 nœuds
statiques et les indexer prend environ 0,38 s avec des nœuds, 0,24 s avec
`createBatch()` ; l'essentiel de ce qui reste, ce sont les matrices monde,
les englobants et l'octree.

Les objets qui partagent un mesh et un matériau sont dessinés comme les
instances d'un seul draw (voir
[Données des objets et instanciation](/fdw-engine/fr/guides/backends-and-surfaces/#données-des-objets-et-instanciation)) :
l'étape 1 du jeu du labyrinthe, environ 3700 objets dessinés par frame avec
leurs ombres, tourne à environ 170 images par seconde sous Vulkan (environ 89
avant la table d'objets et l'instanciation) et 120 sous Dawn (42 avant la
table d'objets).
