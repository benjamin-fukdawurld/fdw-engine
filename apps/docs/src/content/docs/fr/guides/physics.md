---
title: La physique
description: L'API physique abstraite, sa liaison à la scène et au pas fixe, la vue de débogage, Rapier, et comment brancher un autre moteur physique.
sidebar:
  order: 13
---

Le moteur n'écrit pas sa propre physique. Il définit ce qu'il demande à un
moteur physique, et en branche un derrière :

- `@fdw/engine-physics` : l'**API abstraite** (mondes, corps, colliders,
  formes, articulations, requêtes, événements, contrôleurs de personnage),
  sa **liaison à la scène** (`ScenePhysics` : les corps comme composants,
  la simulation dans le pas fixe) et la **vue de débogage**. Il ne dépend
  d'aucun moteur physique.
- `@fdw/engine-physics-rapier` : l'API sur [Rapier](https://rapier.rs),
  compilé en WebAssembly : le même module dans le navigateur et dans Node
  (les démos natives).

Le tutoriel [La physique](/fdw-engine/fr/tutorials/physics/) les réunit.

## L'API

| Interface          | Ce que c'est                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `PhysicsEngine`    | Une implémentation : `name`, `createWorld({ gravity })`                                    |
| `PhysicsWorld`     | Les corps, articulations et personnages ; `step(dt)`, `events`, `contacts()`, les requêtes |
| `PhysicsBody`      | `type`, la pose, les vitesses, impulsions et forces, `mass`, `sleeping`, ses colliders     |
| `PhysicsCollider`  | Une forme sur un corps : `sensor`, `friction`, `restitution`, sa pose dans le monde        |
| `PhysicsJoint`     | Deux corps articulés : `fixed`, `ball`, `hinge`, `slider` ; limites et moteur              |
| `PhysicsCharacter` | Un corps cinématique déplacé par `move()` : glisse, monte marches et pentes, reste au sol  |

Les unités sont le mètre, le kilogramme et la seconde ; y pointe vers le
haut. Les vecteurs sont des `{ x, y, z }`, les rotations des quaternions
`{ x, y, z, w }`.

### Les corps

```ts
const body = world.createBody({
  type: 'dynamic', // 'static' | 'dynamic' | 'kinematic'
  position: { x: 0, y: 3, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocity: { x: 1 },
  gravityScale: 1,
  linearDamping: 0,
  ccd: false, // détection continue des collisions, pour les petits et rapides
  canSleep: true,
  lockRotations: false,
  colliders: [{ shape: Shapes.sphere(0.5) }],
});
```

| Membre                                | Usage                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `readPose(out, offset)`               | La pose en 7 flottants (position, rotation), sans allocation : boucles chaudes           |
| `position`, `rotation`                | La pose, en objets                                                                       |
| `setPose(position, rotation)`         | Une téléportation : sans vitesse, sans poussée                                           |
| `moveTo(position, rotation)`          | Cinématique : où l'amène le pas suivant, en poussant les corps dynamiques                |
| `linearVelocity`, `angularVelocity`   | Lues et écrites                                                                          |
| `applyImpulse(impulse, point?)`       | Une variation de quantité de mouvement (N·s), en un point du monde ou au centre de masse |
| `applyForce(force, point?)`           | Une force (N) pendant le pas suivant                                                     |
| `applyTorqueImpulse(impulse)`         | Une variation de moment cinétique                                                        |
| `mass`, `sleeping`, `wakeUp()`        | Un corps au repos s'endort : il ne coûte rien jusqu'à ce qu'on le réveille               |
| `addCollider(desc)`, `removeCollider` | Les colliders après la création                                                          |

### Colliders et formes

```ts
{
  shape: Shapes.capsule(0.5, 0.3),
  position: { y: 0.8 }, // relative au corps
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  density: 1, // kg/m³ : la masse d'un corps dynamique
  material: { friction: 0.5, restitution: 0, frictionCombine: 'average' },
  groups: 0b0010, // dans le groupe 2
  mask: 0b1101, // entre en collision avec les groupes 1, 3, 4
  sensor: false,
  events: false, // signale ses contacts dans world.events
}
```

| Forme                                      | Remarques                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `Shapes.sphere(radius)`                    |                                                                                 |
| `Shapes.box(hx, hy?, hz?)`                 | Demi-dimensions ; une valeur : un cube                                          |
| `Shapes.capsule(halfHeight, radius)`       | Selon y ; haute de `2 × (halfHeight + radius)`                                  |
| `Shapes.cylinder(halfHeight, radius)`      | Selon y                                                                         |
| `Shapes.convex(points, indices?)`          | L'enveloppe des points ; avec des indices, points et triangles sont l'enveloppe |
| `Shapes.mesh(vertices, indices)`           | Des triangles creux : pour les corps statiques (un niveau)                      |
| `Shapes.heightfield(rows, columns, h, sz)` | `rows × columns` hauteurs, ligne après ligne ; lignes selon z, colonnes selon x |

Les formes sont des données simples : la vue de débogage les dessine, un
autre moteur les traduit. Elles ne sont pas mises à l'échelle par les
nœuds.

Deux colliders entrent en collision quand chacun est dans le `mask` de
l'autre (16 groupes ; par défaut, dans le groupe 1 et en collision avec
tous). Les coefficients de deux colliders en contact se combinent selon
leurs règles (`average`, `min`, `max`, `multiply`).

### Les articulations

```ts
world.createJoint({
  type: 'hinge', // 'fixed' | 'ball' | 'hinge' | 'slider'
  bodyA: frame,
  bodyB: door,
  anchorA: { x: 0.5 }, // dans l'espace de chaque corps
  anchorB: { x: -0.5 },
  axis: { x: 0, y: 1, z: 0 }, // hinge et slider
  limits: [0, Math.PI / 2], // en radians, ou en mètres pour un slider
  motor: { velocity: 1 }, // ou { target, stiffness, damping } : un ressort
  collide: false,
});
```

Une articulation `fixed` soude les corps tels qu'ils sont à sa création.
Retirer un corps retire ses articulations.

### Les requêtes

| Requête                                              | Résultat                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `raycast(origin, direction, maxDistance, filter?)`   | Le premier impact : collider, corps, distance, point, normale     |
| `raycastAll(origin, direction, max, visit, filter?)` | Tous les impacts, sans ordre ; `visit` renvoie false pour arrêter |
| `shapeCast(shape, position, rotation, dir, max, f?)` | Où une forme en mouvement touche en premier                       |
| `overlap(shape, position, rotation, visit, filter?)` | Les colliders dans une forme                                      |

Les directions sont normalisées. Un `QueryFilter` garde certains
colliders : `mask` (groupes), `exclude` (un corps : celui qui demande),
`skip` (des types de corps), `sensors` (vus ou non, non par défaut),
`predicate`. Les requêtes voient le monde du **dernier pas** : un corps
créé ou déplacé depuis est vu après le suivant.

### Les événements

Après chaque pas, `world.events` liste les paires de colliders qui ont
commencé (`begin`) ou cessé (`end`) de se toucher : celles des capteurs
(`sensor: true` : une entrée, une sortie), et celles des colliders avec
`events: true`. `world.contacts(visit)` donne les points des contacts
actuels, avec leurs normales et profondeurs : pour les vues de débogage.

### Les contrôleurs de personnage

```ts
const character = world.createCharacter({
  shape: Shapes.capsule(0.5, 0.3),
  position: { y: 1 },
  offset: 0.02, // l'écart gardé aux surfaces
  maxSlope: Math.PI / 4,
  stepHeight: 0.3,
  snapToGround: 0.3,
  pushBodies: true,
});

const { movement, grounded, collisions } = character.move({ x, y, z });
```

`move` prend le déplacement de ce pas, gravité comprise, et renvoie ce qui
en a été fait ; le corps y arrive au pas suivant. Un déplacement par pas.

## La scène et le pas fixe

`ScenePhysics` fait des corps des composants des entités d'une
[scène](/fdw-engine/fr/guides/scene-graph/) :

```ts
const physics = new ScenePhysics(scene, world);
physics.add(node, { type: 'dynamic', colliders: [{ shape }] });
physics.addCharacter(node, { shape: Shapes.capsule(0.5, 0.3) });
physics.install(scheduler); // systèmes physics (fixed) et physics:sync (update)
```

Le corps est créé à la pose du nœud dans le monde. Qui déplace qui dépend
de `follow` :

| `follow` | Par défaut pour | À chaque pas                                               |
| -------- | --------------- | ---------------------------------------------------------- |
| `body`   | `dynamic`       | Le nœud suit le corps, dessiné entre les deux derniers pas |
| `node`   | `kinematic`     | Le corps est amené au nœud (`moveTo`) : animez le nœud     |
| `none`   | `static`        | Rien                                                       |

- Un nœud qui suit son corps est **sous la racine** : sa transformation
  locale est sa pose dans le monde.
- Le composant `physics.Body` garde les poses des deux derniers pas ; les
  nœuds sont écrits entre les deux selon `alpha`
  (`physics.interpolate = false` la coupe). Un corps au repos n'écrit plus
  son nœud.
- `physics.teleport(node, position, rotation)` déplace un corps et son
  nœud sans dessiner le chemin entre les deux.
- `bodyOf(node)`, `characterOf(node)`, `entityOf(corps ou collider)`,
  `nodeOf(corps ou collider)` : d'un côté à l'autre — les impacts des
  requêtes et les événements donnent des colliders.
- Retirer un nœud retire son corps ; `physics.remove(node)` le corps seul ;
  `physics.destroy()` tous les corps de la scène.

## La vue de débogage

`PhysicsDebugView(scene, world, options)` dessine le monde en lignes, par
un nœud de la scène : les formes (colorées selon l'état de leur corps), les
points de contact et leurs normales, les articulations, et les rayons
donnés à `debug.ray(origin, direction, maxDistance, hit)` pendant
`rayLife` secondes. `update(dt)` une fois par image ; `enabled` la coupe.
Les options choisissent ce qui est dessiné (`shapes`, `contacts`,
`joints`) et les couleurs.

Les lignes viennent de `drawWorld(world, lines)`, écrit contre l'API
abstraite, dans des `DebugLines` (positions et couleurs) : un outil peut
les dessiner à sa façon. La vue les dessine comme un mesh de
`topology: 'line-list'` (un champ de `MeshDescription`, sur les trois
backends), sans éclairage ni ombre.

## Rapier

```ts
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
const engine = await createRapierPhysics();
```

`createRapierPhysics()` charge le module WebAssembly une fois (il est
intégré au package : aucun fichier à servir), dans le navigateur comme dans
Node. Les objets de Rapier restent accessibles (`world.raw`, `body.raw`,
`joint.raw`, `character.raw`) pour ce que l'API ne couvre pas encore.

Sur une même machine, Rapier est déterministe : les mêmes pas donnent le
même monde. 1000 boîtes tombant en tas coûtent environ 3 ms par pas
pendant leur chute, toutes éveillées et en collision, et 1 ms en moyenne
sur dix secondes, à mesure qu'elles s'immobilisent ; `ScenePhysics` ajoute
environ 0,6 ms pour leurs nœuds (Node 24, un thread).

## Un autre moteur

Une implémentation est un `PhysicsEngine` dont `createWorld` renvoie un
`PhysicsWorld` : ses corps, colliders, articulations et personnages
implémentent les interfaces ci-dessus. `ScenePhysics`, la vue de débogage
et le code d'un jeu marchent alors sans changement. À surveiller :

- `readPose` écrit 7 flottants et n'alloue rien : la liaison l'appelle pour
  chaque corps en mouvement à chaque pas.
- `applyForce` dure un pas : un moteur qui garde ses forces les remet à
  zéro après `step`.
- `events` est la liste du dernier pas ; `contacts` sert au débogage et
  peut être lent.
- Les formes sont des données simples, traduites à la création d'un
  collider.
