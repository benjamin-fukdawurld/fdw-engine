---
title: Étendre le moteur
description: Ajouter un nœud, un modèle d’ombrage, une fonctionnalité de rendu ou un backend.
sidebar:
  order: 6
---

La plupart des extensions ne nécessitent aucune modification du moteur : un
graphe de fonction, un modèle d’ombrage ou une passe de rendu s’écrivent
dans une application. Cette page va de ces extensions jusqu’aux
modifications internes au moteur.

## Sans modifier le moteur

| Pour ajouter                      | Écrivez                                                      | Voir                                                              |
| --------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Un morceau de shader réutilisable | Un graphe de fonction, `defineFunction(graph, { id })`       | [Material graph](/fdw-engine/fr/guides/material-graph/#fonctions) |
| Un modèle d’ombrage               | Un graphe de fonction, `defineShadingModel(name, graph)`     | [Tutoriel](/fdw-engine/fr/tutorials/custom-shading-model/)        |
| Un effet de post-traitement       | Un matériau plein écran, `renderer.addFullscreenPass()`      | [Tutoriel](/fdw-engine/fr/tutorials/post-processing/)             |
| Une passe                         | `graph.addRasterPass()`, `addComputePass()`, `addCopyPass()` | [Render graph](/fdw-engine/fr/guides/render-graph/)               |
| Un calcul GPU                     | Un compute graph, `ComputeRunner`                            | [Compute](/fdw-engine/fr/guides/compute/)                         |

Une fonction ou un modèle enregistré dans un `NodeRegistry` est disponible
pour tout graphe construit avec lui ; `build()` l’intègre aux graphes qui
l’utilisent.

## Un nœud standard

Une fonction de la bibliothèque standard qui correspond à une fonction des
langages de shading (un **intrinsèque**) traverse toutes les couches :

1. **La définition**, dans `engine-shader/src/std/functions.ts` : son id,
   ses ports et leurs types (génériques ou concrets), et son op.
2. **L’op**, dans `IntrinsicOp` (`graph/NodeDefinition.ts`) et
   `IrIntrinsic` (`compiler/ir.ts`).
3. **Le constant folding**, s’il s’applique, dans `compiler/optimize.ts`.
4. **Les générateurs de code**, là où le langage la nomme différemment :
   WGSL (`WgslCodegen`), GLSL ES (`GlslEsCodegen`), HLSL (`HlslCodegen` :
   `lerp` pour `mix`, `frac` pour `fract`…).
5. **Les tests** : un test du compilateur, le code généré, et un test de
   pixels dans la suite de rendu, qui l’exécute sur chaque backend et via
   DXC.

Un nœud qui peut s’écrire avec d’autres nœuds a plutôt sa place sous forme
de **graphe de fonction** dans la bibliothèque standard
(`std/subgraphs.ts`, `std/color.ts`) : aucune modification de l’IR ni des
générateurs.

Une **macro** (`std/macros.ts`) est évaluée à la compilation : elle lit des
paramètres statiques (`context.feature()`) et renvoie les nœuds qui la
remplacent. Utilisez-en une pour les choix qui ne doivent rien coûter à
l’exécution.

## Une fonctionnalité du renderer

Le `Renderer` est bâti sur le render graph : une fonctionnalité ajoute des
passes, ou des valeurs aux uniforms de l’image.

- Les **valeurs d’image** (caméra, lumières, ombres) sont déclarées dans le
  layout du slot `frame` (`engine-shader/src/compiler/layout.ts`) et
  écrites par le renderer ; les graphes les lisent avec `g.engine()` ou
  `light.current`.
- Les **ressources du moteur** (l’atlas d’ombres et son sampler) sont liées
  dans le groupe de l’image, uniquement pour les programmes qui les
  utilisent.
- Les **variantes** des matériaux (`shadows`, `depthOnly`, `toneMapping`)
  sont des fonctionnalités définies par le renderer et lues par le
  lowering du compilateur.

Le document de conception du render graph (`design/render-graph.md`)
explique les choix derrière les ombres, la cible HDR et les vues.

## Un backend

Un backend implémente les interfaces de `@fdw/engine-backend` :

- un `Engine` (création du device, cycle de vie) et ses `Surface` ;
- les fabriques : `GpuBufferFactory`, `GpuTextureFactory`,
  `GpuSamplerFactory`, `GpuPipelineFactory` ;
- les command encoders (`GpuCommandEncoder`, passes de rendu et de
  calcul) ;
- un `PrimitivesAdapter` pour `TransformMath` et `CameraMath` (ses
  conventions d’espace de clip) ;
- une `PhysicalLayoutStrategy` (bindings et offsets des uniforms) et un
  `ShaderCodegen` (l’IR vers son langage) ;
- ses `capabilities`.

Ensuite :

1. ajoutez une fixture à `tests/rendering` et exécutez la suite dessus :
   elle couvre toutes les fonctionnalités du moteur, avec les pixels
   attendus ;
2. ajoutez ses surfaces à `apps/demo` ou `apps/demo-native` ;
3. documentez-le dans [Backends et surfaces](/fdw-engine/fr/guides/backends-and-surfaces/).

Le backend WebGL2 est le meilleur modèle pour une API éloignée de WebGPU
(pas de bind groups, pas de compute) ; le backend Vulkan pour une API
explicite (barrières, enregistrement des commandes, bibliothèque native).

## Avant de commencer

Une modification qui touche à la conception — un nouveau concept, une API,
une dépendance — commence par un document de conception. Voir
[Processus de conception](/fdw-engine/fr/contributing/design-process/).
