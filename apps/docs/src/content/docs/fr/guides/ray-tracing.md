---
title: Le ray tracing
description: Les rayons tracés dans la scène — les structures d'accélération des backends (en matériel sur Vulkan, en logiciel sur WebGPU), la scène tracée, les ombres, les reflets et l'occlusion ambiante par rayons, le path tracer, et les rayons dans vos propres graphs.
sidebar:
  order: 20
---

Le moteur rastérise par défaut ; les rayons viennent en plus, comme une
option du rendu, sur les backends qui savent les tracer. La même scène, les
mêmes matériaux : seul change ce qui dessine les pixels. Les tutoriels
montrent chaque usage :
[les ombres par rayons](/fdw-engine/fr/tutorials/ray-traced-shadows/),
[les reflets et l'occlusion ambiante](/fdw-engine/fr/tutorials/ray-reflections/),
[le path tracer](/fdw-engine/fr/tutorials/path-tracing/).

## Les backends

| Backend | Rayons                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vulkan  | En matériel : `VK_KHR_acceleration_structure` et `VK_KHR_ray_query`, là où le GPU les a (RTX, RDNA2 et suivants ; lavapipe en logiciel)               |
| WebGPU  | En logiciel : un BVH construit sur le CPU, dans des storage buffers, parcouru par du code WGSL que le backend ajoute aux programmes qui tracent des rayons |
| WebGL2  | Aucun : la rastérisation seule                                                                                                                         |

La capacité `rayQuery` du backend dit s'il trace des rayons
(`backend.capabilities?.rayQuery`). Sans elle, `RayScene` et les passes de
rayons lèvent une erreur : vérifiez-la, et gardez la rastérisation (les
exemples des tutoriels le font).

## La scène tracée

`RayScene` (`@fdw/engine-raytracing`) tient ce que voient les rayons :

```ts
import { RayScene } from '@fdw/engine-raytracing';

const scene = new RayScene(backend);
// À chaque image, avant le rendu :
scene.update({ source, items });
```

- **Un niveau du bas par mesh**, construit une fois (sur le GPU en Vulkan,
  sur le CPU en WebGPU : un SAH par paniers), gardé tant que le mesh ne
  change pas.
- **Les instances**, réécrites à chaque mise à jour : chaque item de la
  source (tous, pas seulement ceux que voit la caméra : les rayons regardent
  derrière), chacun avec sa matrice monde, son matériau et son masque (les
  items transparents et ceux à `castShadow: false` ne sont pas vus par les
  rayons d'ombre).
- **Les données des impacts**, dans des storage buffers communs aux deux
  backends : les instances (leurs matrices, leur matériau, leur objet), les
  triangles et les sommets (position, normale, uv, tangente).

Les rayons ne voient pas ce que déplace le vertex shader : les meshes
skinnés, la mer, les surfaces tessellées (leurs positions viennent de
l'étape de sommets) sont laissés de côté, ou vus au repos. `filter` écarte
d'autres items.

## Les ombres par rayons

```ts
renderer.render({ …, rays: { scene, shadows: true } });
renderer.render({ …, rays: { scene, shadows: { samples: 8 } } });
```

Les matériaux tracent, pour chaque lumière qui projette des ombres, un
rayon du point vers la lumière, au lieu de lire une shadow map : des ombres
exactes, à toute distance, sans acné ni texels. Avec `samples`, plusieurs
rayons à travers la lumière (son `shadow.softness` : le rayon d'un spot, la
tangente du rayon angulaire d'un soleil) donnent des ombres douces. Les
shadow maps ne sont pas dessinées.

## Les passes de rayons

Sur un G-buffer (le point, la normale, la couleur de base de chaque pixel :
`reflectionOutputs()`, des sorties des passes de la scène) :

- **`RayOcclusion`** : l'occlusion ambiante, des rayons dans la demi-sphère
  de chaque normale, floutée le long des surfaces.
- **`RayReflections`** : la direction de la vue réfléchie par la normale,
  tracée ; les surfaces touchées éclairées avec **leurs propres
  matériaux**, par chaque lumière, avec des ombres tracées ; ajoutées à
  l'image par le terme de Fresnel, estompées avec la rugosité.

## Le path tracer

`PathTracer` dessine toute l'image par rayons : depuis la caméra, puis
rebond après rebond, en recueillant la lumière des surfaces émissives, des
lumières (un rayon d'ombre vers l'une d'elles, au hasard) et du ciel. Les
images s'additionnent tant que rien ne bouge ; un filtre à trous enlève le
bruit des premières.

```ts
const tracer = new PathTracer(renderer, scene, { bounces: 4 });
tracer.render({ camera, surface, lights });
```

Il travaille en vagues de passes de calcul : les rayons de tous les pixels
dans des buffers, tracés ensemble ; les surfaces qu'ils touchent évaluées
matériau par matériau ; puis un noyau de rebond. Un dispatch par matériau
et par rebond : le coût grandit avec le nombre de matériaux de la scène.

## Les surfaces aux points d'impact

Un matériau s'écrit une fois : le compilateur compile aussi sa surface pour
les points touchés par les rayons (`compile(graph, { target: 'hit' })`) :

- ses attributs interpolés au point d'impact (position, normale, uv,
  tangente), ses matrices d'objet celles de l'instance touchée ;
- ses textures lues à leur premier niveau (pas de dérivées), ses dérivées
  à 0 ;
- ce qu'il donne : la couleur de base et l'alpha, la normale, la rugosité
  et le métal, l'émission — les paramètres de la BSDF du modèle `pbr`
  (Lambert et GGX) qu'utilisent les passes de rayons. `phong` donne une
  rugosité du même lobe ; `unlit` est de l'émission.

Un matériau qui n'a pas de surface là (des étapes brutes) est dessiné en
gris, avec un avertissement.

## Les rayons dans vos graphs

`g.traceRay({ origin, direction, tMin, tMax, mask, mode })` trace un rayon
dans la scène de l'image (`input.engine('scene')`), dans n'importe quelle
étape. Son impact, un `vec4<u32>`, se lit avec les fonctions de `stdRays` :

| Fonction                                     | Donne                                                        |
| -------------------------------------------- | ------------------------------------------------------------ |
| `hit`                                        | Si le rayon a touché quelque chose                           |
| `hitPosition`, `hitNormal`                   | Le point touché, sa normale (interpolée), dans le monde      |
| `hitGeometricNormal`, `hitFrontFacing`       | La normale du triangle, la face touchée                      |
| `hitUv`, `hitLocalTangent`                   | Les uv, la tangente des sommets                              |
| `hitObject`, `hitMaterial`, `hitData`        | L'objet (son `id`), le matériau, le vec4 de l'utilisateur    |
| `hitBarycentrics`, `hitVertices`, `hitWorld` | Les poids des sommets, leurs indices, la matrice             |

`mode: 'any'` s'arrête au premier impact (les ombres, l'occlusion). Les
matériaux dessinés par le renderer reçoivent la scène avec `rays` ; une
passe plein écran avec `addFullscreenPass(…, { rays: scene })` ; un compute
graph par les valeurs de son dispatch (`scene.resource(name)`).

## Coûts

1280 × 720 sur une RTX 2060 SUPER, Vulkan, sans vsync :

| Démo | Rastérisé | Ombres tracées | + reflets | Path tracer |
| ---- | --------- | -------------- | --------- | ----------- |
| FPS      | 974 fps    | 577 fps        | 308 fps       | 106 fps     |
| TPS      | 82 fps     | 47 fps         | 43 fps        | 51 fps      |

En WebGPU, la traversée logicielle coûte plus, et d'autant plus que la
scène grandit : les ombres tracées conviennent aux petites scènes ; le path
tracer recueille ses images plus lentement.

## Pas encore

- L'alpha des matériaux masqués pendant la traversée (les feuilles
  projettent des ombres carrées par rayons ; le path tracer les traverse
  par des rebonds).
- La mise à jour (refit) des structures des meshes skinnés et déplacés.
- Les pipelines de ray tracing de Vulkan, DXR sur Direct3D 12, un BVH
  construit sur le GPU.
- Un débruiteur temporel (SVGF) pour une caméra qui bouge.
