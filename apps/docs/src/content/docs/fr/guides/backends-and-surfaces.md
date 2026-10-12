---
title: Backends et surfaces
description: Engines, surfaces et backends de rendu ; comment en choisir un, et ce qui les distingue.
sidebar:
  order: 6
---

Trois objets séparent une application de l'API graphique sur laquelle elle
s'exécute.

| Objet             | Rôle                                                                                                                     | Interface (`@fdw/engine-backend`) |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **Engine**        | Le périphérique : créé par `init()`, libéré par `destroy()` ; son `state` est un signal                                  | `Engine`                          |
| **Surface**       | La destination des frames : un canvas, une fenêtre, une texture. `width`, `height`, `format`, `present()`                | `Surface`                         |
| **RenderBackend** | Ce qu'utilisent les renderers : fabriques de buffers, de textures et de pipelines, mathématiques, encodage des commandes | `RenderBackend`, `engine.backend` |

Le `Renderer`, les matériaux et le render graph ne voient que le
`RenderBackend` et la `Surface` : le code écrit pour ces interfaces
fonctionne partout.

## Les backends

| Backend | Package              | Engine               | Surfaces                                                               | Shaders                         |
| ------- | -------------------- | -------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| WebGPU  | `@fdw/engine-webgpu` | `WebGpuEngine`       | `WebGpuSurface` (canvas), `WebGpuOffscreenSurface`                     | WGSL                            |
| WebGL2  | `@fdw/engine-webgl2` | `WebGl2Engine`       | `WebGl2CanvasSurface`, `WebGl2OffscreenSurface`                        | GLSL ES 3.00                    |
| Dawn    | `@fdw/engine-native` | `createDawnEngine()` | `DawnWindowSurface`, `WebGpuOffscreenSurface`                          | WGSL                            |
| Vulkan  | `@fdw/engine-vulkan` | `VulkanEngine`       | `VulkanWindowSurface` (`@fdw/engine-native`), `VulkanOffscreenSurface` | HLSL, compilé en SPIR-V par DXC |

Tous les backends passent la même suite de tests de rendu.

```ts
const engine = new WebGpuEngine();
await engine.init();
const surface = new WebGpuSurface(canvas);
await surface.init(engine);
const backend = engine.backend!;
```

## Surfaces hors écran

Une surface hors écran rend dans une texture de taille donnée :
`new WebGpuOffscreenSurface(width, height, format?)`. Sa méthode
`readPixels()` renvoie les pixels sous forme d'octets RGBA, lignes depuis le
haut, sur tous les backends : captures d'écran, miniatures, tests.

## Capacités

`backend.capabilities` indique ce que prend en charge un backend, et le
compilateur vérifie les programmes en conséquence :

| Capacité            | Signification                                                    | WebGL2                        |
| ------------------- | ---------------------------------------------------------------- | ----------------------------- |
| `compute`           | Étapes de calcul                                                 | false                         |
| `storageBuffers`    | Storage buffers                                                  | false                         |
| `maxVaryings`       | Valeurs interpolées entre les étapes                             | selon le contexte             |
| `renderableFormats` | Formats de couleur utilisables comme attachments (`rgba16float`) | avec `EXT_color_buffer_float` |
| `objectTable`       | Les données des objets lues dans une table, par instance         | true (textures de données)    |

Un graphe qui utilise une fonctionnalité absente échoue à la compilation avec
une erreur explicite ; testez la capacité pour proposer une solution de
repli.

## Ce que les backends absorbent

Le moteur suit les conventions de WebGPU ; les autres backends s'adaptent :

- **La profondeur dans l'espace clip** va de 0 à 1. Les vertex shaders GLSL
  la ramènent à l'intervalle −1 à 1 d'OpenGL.
- **Origine du framebuffer** : les images sont lues à partir de la ligne du
  haut partout. WebGL2 retourne ses viewports ; Vulkan utilise une hauteur
  de viewport négative, de sorte que y pointe vers le haut dans l'espace
  clip.
- **Bind groups** : GLSL ES n'en a pas. Le pipeline WebGL2 attribue un point
  de binding à chaque uniform block et une unité de texture à chaque paire
  texture–sampler ; sous Vulkan, les groupes sont des descriptor sets.
- **Disposition des uniforms** : règles WGSL sous WebGPU, std140 sous WebGL2
  et Vulkan ; les programmes compilés ne connaissent que la disposition
  logique, le backend résout les offsets.
- **Enregistrement des commandes** : WebGL2 enregistre les commandes d'une
  frame et les exécute lors de `submit()`, de sorte que les écritures dans
  les buffers sont vues par chaque draw, comme en WebGPU. Vulkan les écrit
  sous forme de mots de 32 bits, rejoués en un seul appel natif.
- **Synchronisation** : WebGPU et WebGL2 sont synchronisés implicitement. La
  bibliothèque Vulkan suit la dernière utilisation de chaque texture et de
  chaque buffer, et insère les barrières.
- **Profondeur** : `depth24plus` est une profondeur flottante sur 32 bits
  sous Vulkan.

## Données des objets et instanciation

Les données de chaque objet dessiné — ses matrices monde et normale, 112
octets — forment une ligne d'une **table d'objets**, créée par
`backend.createObjectTable()`. Un objet garde sa ligne tant qu'il existe ; la
ligne n'est réécrite que lorsqu'il bouge, et les lignes écrites dans une frame
partent vers le GPU en une seule plage. Chaque passe écrit les lignes des
instances qu'elle dessine, dans son ordre, puis lie la table une seule fois.

Un draw indique `firstInstance` : son instance `i` lit la ligne
`instances[firstInstance + i]`. Les objets qui se suivent avec le même
pipeline, le même matériau et le même mesh forment **un seul draw** de
plusieurs instances — le renderer trie par pipeline, matériau, puis mesh pour
les regrouper. `renderer.stats.get('scene')` donne `drawn` (les objets) et
`drawCalls` (les draws).

| Backend | Table d'objets                                                   | Première instance                                          |
| ------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| WebGPU  | Deux storage buffers : les lignes, la ligne de chaque instance   | `instance_index` l'inclut                                  |
| Vulkan  | Deux storage buffers                                             | `SV_InstanceID` (l'`InstanceIndex` de Vulkan) l'inclut     |
| WebGL2  | Deux textures de données (RGBA32F, R32UI) lues avec `texelFetch` | Un uniform défini avant chaque draw (pas de base instance) |

Le `Renderer` a besoin de `createObjectTable` : un backend personnalisé
l'implémente (un `GpuObjectTable` : `writeRows`, `writeInstances`), ainsi que
le binding `object-table` des programmes.

## Pipelines

Les pipelines sont créés à leur première utilisation, ce qui peut bloquer
une frame pendant la compilation d'un shader.
`new Renderer(backend, { asyncPipelines: true })` les crée plutôt en
arrière-plan : un élément est ignoré tant que son pipeline n'est pas prêt, et
`await renderer.whenReady()` attend ceux en cours (un écran de chargement).
WebGL2 lie les programmes en parallèle lorsque le navigateur dispose de
`KHR_parallel_shader_compile`.
