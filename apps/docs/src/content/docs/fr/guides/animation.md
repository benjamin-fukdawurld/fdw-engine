---
title: Animation
description: Squelettes, clips, poses et mélanges, animation graphs et leurs animateurs, et le skinning sur le GPU.
sidebar:
  order: 12
---

L'animation d'un personnage passe par trois packages :

- `@fdw/engine-animation`, sur le CPU, sans le GPU ni la scène : les
  squelettes, les clips, les poses, les mélanges et les masques, les
  animation graphs et l'`Animator` qui les exécute ;
- `@fdw/engine-skinning` : le skinning des meshes sur le GPU, dans une
  passe de calcul ou dans le vertex stage, et son lien avec les modèles et
  la scène ;
- `@fdw/engine-graph` : le cœur de graph que les animation graphs
  partagent avec les material graphs.

Le tutoriel [Un personnage animé](/fdw-engine/fr/tutorials/character-animation/)
les réunit.

## Squelettes et poses

Un `Skeleton` est une liste d'articulations, chacune après son parent,
avec sa pose de repos. `Skeleton.fromHierarchy(model.data)` prend les nœuds
d'un modèle en profondeur d'abord (`skeletonOf(model)` en garde un par
modèle) ; chaque articulation connaît son nœud (`skeleton.jointOf(nœud)`),
que visent les canaux des animations glTF.

Une `Pose` contient la transformation locale de chaque articulation
(relative à son parent) : trois tableaux plats, `translations`,
`rotations` (quaternions x y z w) et `scales`. Les mélanges se font
articulation par articulation :

| Fonction                                 | Résultat                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `Pose.blend(a, b, w, out, masque?)`      | a(1 − w) + bw ; les rotations par le plus court chemin                       |
| `Pose.difference(pose, référence, out)`  | Ce qui mène `référence` à `pose` : pour les couches additives                |
| `Pose.add(base, différence, w, out, m?)` | La différence ajoutée par w : translations additionnées, rotations composées |
| `pose.modelMatrices(parents)`            | La matrice de chaque articulation dans l'espace du squelette                 |

Un `BoneMask` donne un poids par articulation : `BoneMask.branches(squelette,
{ 'upperArm.R': 1, head: 0.5 })` prend les branches des articulations
nommées, chacune avec son poids.

## Les clips

Un `AnimationClip` est un ensemble de pistes (un canal d'une articulation :
translation, rotation ou échelle) et d'événements.
`AnimationClip.fromData(données, squelette)` lit une animation d'un modèle
(`clipsOf(model)` les lit toutes, par nom) ; les poids des morph targets
sont laissés de côté.

```ts
const clip = clips['Walk'].withEvents([
  { time: 0.22, name: 'step' },
  { time: 0.77, name: 'step' },
]);
clip.sample(0.5, pose); // les pistes à 0,5 s
```

Les clés suivent les interpolations de glTF : `STEP`, `LINEAR` (les
rotations sphériques) et `CUBICSPLINE` (Hermite, les tangentes mises à
l'échelle du temps entre les clés). `sample` n'écrit que les canaux qui ont
une piste : partir de la pose de repos. `additiveClip(clip, squelette)`
donne la différence avec sa première pose.

## Les animation graphs

Un animation graph est une donnée, comme un material graph : des nœuds
typés et des arêtes, sérialisés en JSON (`serializeAnimationGraph`,
`parseAnimationGraph`), validés avant de tourner
(`validateAnimationGraph`). Ses ports portent des poses, des nombres et
des booléens ; ses paramètres sont réglés par l'application.

| Nœud                | Builder                                   | Rôle                                                                |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `anim.clip`         | `g.clip(nom, { loop, speed, rate })`      | Joue un clip de l'animateur ; `rate` multiplie la vitesse           |
| `anim.parameter`    | `g.param(nom)`                            | La valeur d'un paramètre                                            |
| `anim.blend`        | `g.blend(a, b, poids)`                    | Deux poses mélangées                                                |
| `anim.blend1d`      | `g.blend1d(poses, points, valeur)`        | Un blend space : les deux poses autour de la valeur                 |
| `anim.layer`        | `g.layer(base, couche, { mask, weight })` | Une pose sur une autre, sur un masque ; `mode: 'additive'` l'ajoute |
| `anim.stateMachine` | `g.stateMachine({ states, transitions })` | Des états, une pose chacun, et des fondus entre eux                 |
| `anim.output`       | `g.output(pose)`                          | La pose du graphe                                                   |

Les paramètres sont déclarés avec leur type : `g.parameter('speed',
'number')`, `'boolean'`, ou `'trigger'`, un booléen mis par
`animator.trigger(nom)` et consommé par la transition qu'il déclenche.

Une transition va d'un état (ou de `*`, n'importe quel autre) à un autre
quand toutes ses `conditions` sont vraies (`{ parameter, op, value }`), que
son `trigger` est mis et que son `exitTime` est atteint (en cycles de
l'état : `1` attend la fin d'un clip qui ne boucle pas), avec un fondu de
`duration` secondes. Les transitions sont choisies au début d'une mise à
jour, dans leur ordre ; un état repart de zéro quand on y entre
(`resetOnEnter: false` laisse ses clips où ils étaient).

Les blend spaces sont **synchronisés** par défaut : leurs poses partagent
une phase, qui avance selon leur durée mélangée ; les pieds d'une marche et
d'une course mélangées restent en rythme. `sync: false` laisse chaque clip
à son propre temps.

## L'animateur

```ts
const animator = new Animator(graph, { skeleton, clips, masks });
animator.set('speed', 2.4).trigger('jump');
const pose = animator.update(dt);
animator.events; // les événements atteints par la mise à jour
animator.state('body'); // { state, next?, progress, time }
```

Un animateur exécute un graphe pour un personnage : le temps de ses clips,
ses paramètres, ses machines à états. Le graphe, les clips et les masques
sont partagés. Un nœud qui alimente deux entrées n'avance qu'une fois par
mise à jour.

**Les événements.** Une mise à jour atteint les événements des clips
qu'elle joue (`onEvent(écouteur)` aussi). Un mélange, un blend space et un
fondu gardent les événements de leur entrée la plus lourde : un pas, pas
un par clip mélangé. Une couche garde ceux des deux.

## Le skinning

```ts
const instance = instantiate(model, scene);
const skinning = new Skinning(backend, instance, model);
// À chaque image, après l'animation, avant le rendu :
skinning.applyPose(animator.pose).update();
renderer.render({
  source: scene,
  camera,
  surface,
  prepare: (graph) => skinning.addPass(graph),
});
```

`Skinning` donne à chaque primitive skinnée d'une instance un matériau à
elle : le graphe du matériau du modèle, le skinning ajouté. Son `update`
calcule les matrices des articulations (inverse(nœud) × articulation ×
inverse bind matrix), les envoie au GPU et met à jour les bornes des
primitives, depuis une sphère autour de chaque articulation.

| Mode      | Où                                                                                                 | Backends |
| --------- | -------------------------------------------------------------------------------------------------- | -------- |
| `compute` | Une passe de calcul écrit les sommets skinnés dans un buffer, que chaque passe lit par leur numéro | Tous     |
| `vertex`  | Le vertex stage de chaque passe skinne son sommet, depuis les matrices dans une texture            | Tous     |

Le mode est `compute` quand le backend a des compute shaders, `vertex`
ailleurs : en WebGL2, qui émule le calcul par rendu dans des textures (voir
[En WebGL2](/fdw-engine/fr/guides/compute/#en-webgl2)), le vertex stage
coûte moins. `{ mode }` choisit. En mode
`compute`, la caméra, les shadow maps et plus tard le ray tracing lisent
les mêmes sommets, skinnés une fois par image.

En mode `compute`, `skinning.addPass(graph)` ajoute une passe de calcul à
un render graph, qui enregistre les kernels de toutes les primitives :
donnez-la à `render` avec `prepare`, ou appelez-la avant `addScenePasses`
dans votre propre graphe. Elle renvoie les versions des buffers de sommets
skinnés qu'elle écrit, pour les passes qui les lisent. Hors d'un graphe,
`skinning.dispatch()` les enregistre en une seule soumission. En mode
`vertex`, les deux ne font rien.

Les meshes ont besoin de `joints` (`uint8x4` ou `uint16x4`) et de
`weights` ; leur position, leur normale et leur tangente sont skinnées.
`skinPositions(MeshSkin.of(mesh), matrices)` skinne sur le CPU, pour un
lancer de rayon contre un personnage.

## Limites

- Pas encore de morph targets, de root motion ni de cinématique inverse.
- Le skinning est linéaire : une articulation très tordue (un avant-bras
  tourné d'un demi-tour) perd un peu de volume.
- Les animation graphs n'ont pas encore d'événements de leurs états ni de
  nœuds de calcul sur les paramètres.
