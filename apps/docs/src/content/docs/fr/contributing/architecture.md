---
title: Architecture
description: Les paquets du moteur, leurs dépendances, et le chemin d’une image à travers eux.
sidebar:
  order: 1
---

## Les paquets

```
engine-scene    ──► engine-core, engine-geometry
engine-core     ──► engine-backend, engine-shader, engine-geometry
engine-webgpu   ─┐
engine-webgl2   ─┼► engine-backend ──► engine-shader
engine-vulkan   ─┘
engine-native   ──► engine-webgpu, engine-vulkan
engine-shader, engine-geometry: no dependency
```

| Paquet            | Contenu                                                                                                                  | Dépend de                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `engine-geometry` | Volumes, intersections (GJK), rayons, index spatiaux (octree)                                                            | rien                                                 |
| `engine-shader`   | Types, modèle de graphe, bibliothèque standard, validation, compilateur vers une IR                                      | rien                                                 |
| `engine-backend`  | L’API abstraite : `Engine`, `Surface`, `RenderBackend`, ressources GPU, mathématiques, layouts, `ShaderCodegen`          | `engine-shader` (types)                              |
| `engine-core`     | Objets de scène, `Transform` et son pool, `Material`, `Mesh`, `Renderer`, `RenderSource`, `RenderGraph`, `ComputeRunner` | `engine-backend`, `engine-shader`, `engine-geometry` |
| `engine-webgpu`   | Backend WebGPU, `WgslCodegen`                                                                                            | `engine-backend`                                     |
| `engine-webgl2`   | Backend WebGL2, `GlslEsCodegen`                                                                                          | `engine-backend`                                     |
| `engine-vulkan`   | Backend Vulkan (addon Node), `HlslCodegen`                                                                               | `engine-backend`                                     |
| `engine-native`   | Fenêtres natives, la boucle, surfaces de fenêtre Dawn et Vulkan (addon Node)                                             | `engine-webgpu`, `engine-vulkan`                     |
| `engine-scene`    | La scène : un noyau ECS, des nœuds, un pool de transformations, des octrees ; une `RenderSource`                         | `engine-core`, `engine-geometry`                     |
| `demo-scenes`     | Scènes et maillages partagés par les démos                                                                               | `engine-core`                                        |

Les règles :

- **engine-shader ne connaît aucun GPU.** Il produit un programme — IR et
  layout logique — et s’arrête là. Il s’exécute partout : dans les tests,
  dans les outils, dans un worker.
- **engine-core ne connaît aucun backend.** Il ne parle qu’à l’interface
  `RenderBackend`. Une fonctionnalité qui a besoin d’un backend étend
  d’abord l’API abstraite.
- **Un backend ne connaît aucune scène.** Il crée des ressources, des
  pipelines et des commandes ; il ne sait pas ce qu’est une lumière ou un
  matériau.

## Le chemin d’une image

`renderer.render({ items, camera, surface, lights })` :

1. **Culling.** Le renderer demande à sa source (une scène, ou une liste
   d’éléments) ce qui se trouve dans le frustum de la caméra, garde les
   lumières qui l’atteignent, puis redemande les objets projetant des ombres
   de chaque shadow map.
2. **Graphe.** Il construit un render graph : l’image de la surface, une
   passe d’ombres si des lumières projettent des ombres, les passes opaque et
   transparente, et la passe de tone mapping sur les backends HDR.
3. **Préparation.** Pour chaque élément, le renderer trouve son
   **programme** (compilé une fois par graphe, fonctionnalités, attributs du
   maillage) et son **pipeline** (une fois par programme, layout de
   sommets, état de rendu, formats des cibles), et met à jour les buffers
   GPU dont la version a changé : le maillage, les uniforms `object`
   (copiés depuis le bloc de la transformation dans son pool), les uniforms
   `material`. Les uniforms `frame` (caméra, temps, lumières) sont écrits une
   fois par vue.
4. **Compilation.** Le runner compile le graphe, ou le trouve dans son
   cache : ordre, élimination, durées de vie, transitions.
5. **Enregistrement.** Dans un seul command encoder, chaque passe : les
   ressources transitoires issues du pool, le pass encoder, son `execute`
   (les draws, triés par pipeline et par matériau, les transparents de
   l’arrière vers l’avant).
6. **Soumission** et `surface.present()`.

## Du graphe au shader

```
GraphBuilder ─► MaterialGraphData ─► compile() ─► CompiledProgram ─► PhysicalLayoutStrategy ─► ShaderCodegen ─► WGSL / GLSL / HLSL
   (TS API)       (JSON)            (engine-shader)   (IR + layout)      (backend: bindings)       (backend)
```

Le compilateur abaisse les sorties, développe les macros et les fonctions,
optimise, affecte chaque valeur à un étage, dispose les ressources par slot,
et émet l’IR : des instructions SSA typées, une liste par point d’entrée,
avec `loop-sum` pour seul flot de contrôle (la boucle sur les lumières). Les
backends résolvent le layout en bindings et en offsets selon leurs règles
(WGSL, std140), puis traduisent l’IR.

## Versions et caches

Les objets de scène stockent leurs valeurs dans un unique `ArrayBuffer` et
incrémentent une **version** à chaque modification ; le renderer compare
les versions pour ne mettre à jour que ce qui a changé. Les programmes sont
indexés par un hash du graphe optimisé et de ses paramètres de variante ;
les pipelines par programme et par état ; les compilations de render graph
par structure. Une image stable ne compile rien et n’alloue rien.

## Les documents de conception

`design/` contient la conception de chaque partie, en français :
`material-graph.md`, `compute-graph.md`, `render-graph.md`,
`native-backends.md`, les suites à donner dans `backlog.md` et les
orientations à plus long terme dans `evolutions.md`. Voir
[Processus de conception](/fdw-engine/fr/contributing/design-process/).
