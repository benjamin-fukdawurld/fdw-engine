---
title: Le ray tracing
description: Les rayons tracés dans la scène — les structures d'accélération des backends (en matériel sur Vulkan et Direct3D 12, en logiciel sur WebGPU), la scène tracée, les ombres, les reflets et l'occlusion ambiante par rayons, le path tracer, et les rayons dans vos propres graphs.
sidebar:
  order: 20
---

Le moteur rastérise par défaut ; les rayons viennent en plus, comme une
option du rendu, sur les backends qui savent les tracer. La même scène, les
mêmes matériaux : seul change ce qui dessine les pixels. Les tutoriels
montrent chaque usage :
[les ombres par rayons](/fdw-engine/fr/tutorials/ray-traced-shadows/),
[les reflets et l'occlusion ambiante](/fdw-engine/fr/tutorials/ray-reflections/),
[le path tracer](/fdw-engine/fr/tutorials/path-tracing/),
[la géométrie animée et générée](/fdw-engine/fr/tutorials/ray-traced-characters/).

## Les backends

| Backend     | Rayons                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulkan      | En matériel : `VK_KHR_acceleration_structure` et `VK_KHR_ray_query`, là où le GPU les a (RTX, RDNA2 et suivants ; lavapipe en logiciel) ; les pipelines de ray tracing (`VK_KHR_ray_tracing_pipeline`) en option |
| Direct3D 12 | En matériel : DXR 1.1 (les ray queries, Shader Model 6.5), là où le GPU l'a (RTX, RDNA2 et suivants) ; les pipelines de ray tracing (des state objects, `DispatchRays`) en option                                |
| WebGPU      | En logiciel : un BVH construit sur le CPU, dans des storage buffers, parcouru par du code WGSL que le backend ajoute aux programmes qui tracent des rayons                                                       |
| WebGL2      | Aucun : la rastérisation seule                                                                                                                                                                                   |

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

- **Un niveau du bas par mesh**, construit une fois (sur le GPU en Vulkan et
  Direct3D 12, sur le CPU en WebGPU : un SAH par paniers), gardé tant que le
  mesh ne change pas.
- **Les instances**, réécrites à chaque mise à jour : chaque item de la
  source (tous, pas seulement ceux que voit la caméra : les rayons regardent
  derrière), chacun avec sa matrice monde, son matériau et son masque (les
  items transparents et ceux à `castShadow: false` ne sont pas vus par les
  rayons d'ombre).
- **Les données des impacts**, dans des storage buffers communs aux deux
  backends : les instances (leurs matrices, leur matériau, leur objet), les
  triangles et les sommets (position, normale, uv, tangente).

- **Les masques d'alpha** des matériaux masqués, cuits une fois (plus bas).

Ce que le GPU déplace est suivi : les sommets d'un mesh skinné
(`Material.deformedVertices`, renseigné par le skinning en calcul)
ajustent sa structure à chaque mise à jour ; un item dont le matériau fait
sa géométrie dans le vertex stage (un terrain en patchs) est tracé avec son
`rayMesh`. Sans l'un ni l'autre, un tel item est laissé de côté (la mer de
l'océan). `filter` écarte d'autres items. Le
[tutoriel](/fdw-engine/fr/tutorials/ray-traced-characters/) montre les
deux.

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

## L'alpha des matériaux masqués

Les rayons traversent les parties coupées des matériaux masqués
(`alphaMode: 'mask'`) : les feuilles, les grillages. `RayScene` cuit
l'alpha de chaque matériau masqué sur ses uv (son programme « impact » sur
un carré, coupé à son seuil, 256 × 256 bits dans la géométrie de la
scène), à nouveau quand ses valeurs changent ; les traversées testent
contre lui les triangles candidats des instances masquées (Vulkan,
Direct3D 12 : les instances non opaques dans la boucle de la ray query, ou
un shader any-hit ; WebGPU : dans la traversée WGSL). Dans vos graphs,
`g.traceRay({ …, alphaTest: true })` (`ray.traceAlpha`) fait de même.

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

Quand la caméra ou la scène bouge, chaque pixel suit le point qu'il voyait :
l'image précédente reprojetée (le point et la normale du premier impact
gardés), son historique gardé là où il voyait la même surface, au plus
`history` images (16) tant que tout bouge ; immobiles, les images
s'additionnent sans fin.

## Les pipelines de ray tracing

Sur Vulkan et Direct3D 12, un programme de calcul qui trace des rayons peut
tourner comme le shader de génération de rayons d'un **pipeline de ray tracing**
(`createComputePipeline({ program, rayTracing: true })`, la capacité
`rayTracingPipeline`) : un fil par rayon, `TraceRay` avec un shader
closest-hit qui écrit l'impact, un shader miss, et le test de l'alpha dans
un shader any-hit. Les mêmes graphs, les mêmes résultats (un test les
compare au bit près) ; `ComputeRunner`, `PathTracer` et `RayReflections`
prennent l'option (`rayTracingPipeline: true`). Ailleurs, les ray queries.
Les surfaces des matériaux restent des dispatchs de leurs programmes
« impact » : des hit groups par matériau lieraient les ressources de tous
les matériaux à la fois.

## Dans l'éditeur

Le viewport du niveau dessine avec des rayons depuis le menu Edit ›
Rendering (ou la palette) : les ombres tracées, les reflets, le path tracer —
sur Vulkan (l'éditeur de bureau) et WebGPU (l'éditeur web) ; WebGL2 garde
la rastérisation. La sélection au pixel et les gizmos restent ceux de la
rastérisation.

## Les surfaces aux points d'impact

Un matériau s'écrit une fois : le compilateur compile aussi sa surface pour
les points touchés par les rayons (`compile(graph, { target: 'hit' })`) :

- ses attributs interpolés au point d'impact (position, normale, uv,
  tangente), ses matrices d'objet celles de l'instance touchée ;
- ses textures lues à leur premier niveau (pas de dérivées), ses dérivées
  à 0 (une normale qui ne peut alors pas être calculée est remplacée par la
  normale des sommets) ;
- les attributs que calcule son vertex stage (`g.vertexAttribute`) sont
  ceux de la géométrie tracée ;
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

| Fonction                                     | Donne                                                     |
| -------------------------------------------- | --------------------------------------------------------- |
| `hit`                                        | Si le rayon a touché quelque chose                        |
| `hitPosition`, `hitNormal`                   | Le point touché, sa normale (interpolée), dans le monde   |
| `hitGeometricNormal`, `hitFrontFacing`       | La normale du triangle, la face touchée                   |
| `hitUv`, `hitLocalTangent`                   | Les uv, la tangente des sommets                           |
| `hitObject`, `hitMaterial`, `hitData`        | L'objet (son `id`), le matériau, le vec4 de l'utilisateur |
| `hitBarycentrics`, `hitVertices`, `hitWorld` | Les poids des sommets, leurs indices, la matrice          |

`mode: 'any'` s'arrête au premier impact (les ombres, l'occlusion). Les
matériaux dessinés par le renderer reçoivent la scène avec `rays` ; une
passe plein écran avec `addFullscreenPass(…, { rays: scene })` ; un compute
graph par les valeurs de son dispatch (`scene.resource(name)`).

## Coûts

1280 × 720 sur une RTX 2060 SUPER, sans vsync (le TPS : ses personnages, son
terrain et son feuillage dans la scène des rayons) :

| Démo | Backend                          | Rastérisé | Ombres tracées | + reflets | Path tracer |
| ---- | -------------------------------- | --------- | -------------- | --------- | ----------- |
| FPS  | Vulkan                           | 1170 fps  | 576 fps        | 275 fps   | 89 fps      |
| FPS  | Vulkan, pipelines de ray tracing |           |                | 305 fps   | 90 fps      |
| FPS  | WebGPU (Dawn)                    | 560 fps   | 131 fps        | 68 fps    | 33 fps      |
| TPS  | Vulkan                           | 81 fps    | 39 fps         | 37 fps    | 27 fps      |
| TPS  | Vulkan, pipelines de ray tracing |           |                | 41 fps    | 34 fps      |
| TPS  | WebGPU (Dawn)                    | 58 fps    | 7 fps          | 5 fps     | 4 fps       |

En WebGPU, la traversée logicielle coûte plus, et d'autant plus que la
scène grandit : les ombres tracées conviennent aux petites scènes ; le path
tracer recueille ses images plus lentement. Dans la forêt du TPS, le niveau
du haut reconstruit sur le CPU à chaque image pèse aussi.

## Pas encore

- Un BVH construit sur le GPU (le niveau du haut des grandes scènes coûte
  sur le CPU à chaque image), des BVH à 4 ou 8 enfants.
- La variance dans le filtre temporel (SVGF), ReSTIR, l'échantillonnage
  des cartes d'environnement par importance.
- La mer de l'océan dans la scène des rayons.
