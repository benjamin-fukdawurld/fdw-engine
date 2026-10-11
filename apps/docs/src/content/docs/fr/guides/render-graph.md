---
title: Render graph
description: Décrivez une frame comme des passes qui lisent et écrivent des ressources ; le moteur ordonne, élimine et alloue.
sidebar:
  order: 2
---

Une frame est un ensemble de **passes** — draws, calculs, copies — qui lisent
et écrivent des **ressources** — textures et buffers. `RenderGraph` les
décrit, `RenderGraphRunner` les compile et les exécute. `Renderer.render()`
est lui-même un petit graphe ; construisez le vôtre pour ajouter des passes.

## Ressources

```ts
const graph = new RenderGraph();
const surface = graph.importTexture('surface', target.getCurrentTarget());
const hdr = graph.createTexture('hdr', { format: 'rgba16float' });
const half = graph.createTexture('half', {
  format: 'rgba8unorm',
  size: { relative: 0.5 },
});
const counts = graph.createBuffer('counts', { size: 16 });
```

- Les ressources **importées** (`importTexture`, `importBuffer`) existent en
  dehors du graphe : l'image d'une surface, les buffers de la scène. En
  écrire une est un **effet de bord** : c'est la raison d'être de la frame.
- Les ressources **transitoires** (`createTexture`, `createBuffer`)
  n'existent que pendant l'exécution de la frame. Le runner les prend dans un
  pool, et les y remet après la dernière passe qui les utilise : une passe
  ultérieure de la même frame, ou la frame suivante, les réutilise.
- La taille d'une texture est absolue (`{ width, height }`) ou relative à la
  frame (`{ relative: 0.5 }`) ; par défaut, c'est la taille de la frame : la
  première texture importée, ou la `size` passée à `execute`.
- `sampleCount: 4` crée un attachment multiéchantillonné, résolu dans une
  texture avec `pass.resolveColor()`.

## Passes et versions

Une passe déclare ce qu'elle lit et écrit, et renvoie ce qu'elle produit avec
sa fonction `execute` :

```ts
const lit = graph.addRasterPass('lit', (pass) => ({
  color: pass.writeColor(hdr, {
    load: 'clear',
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  }),
  depth: pass.writeDepth(depth, { load: 'clear', clearValue: 1 }),
  execute: ({ pass: encoder, texture, size }) => {
    // encoder: a GpuRenderPassEncoder; texture(handle): the real texture.
  },
}));
```

Chaque écriture renvoie une **nouvelle version** de la ressource. Une passe
qui lit `lit.color` lit cette version : elle s'exécute après `lit`. Les
dépendances sont celles des versions, jamais celles de l'ordre de
déclaration.

| Méthode                         | Passe  | Usage                                                                           |
| ------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `writeColor(texture, { load })` | raster | Attachment de couleur ; `clear` ignore le contenu                               |
| `writeDepth(texture, { load })` | raster | Attachment de profondeur                                                        |
| `readDepth(texture)`            | raster | Test de profondeur sans écriture                                                |
| `resolveColor(texture)`         | raster | Résout le dernier attachment multiéchantillonné                                 |
| `read(handle, usage)`           | toutes | `sampled`, `storage-read`, `uniform`, `vertex`, `index`, `indirect`, `copy-src` |
| `write(handle, usage)`          | toutes | `storage-write`, `copy-dst`                                                     |
| `hasSideEffects()`              | toutes | Conserve la passe même si personne ne la lit                                    |

Trois types de passes ouvrent trois types d'encodeurs :

- `addRasterPass` : une passe de rendu, avec ses attachments
  (`context.pass`) ;
- `addComputePass` : une passe de calcul (`context.pass`, WebGPU et
  Vulkan) ;
- `addCopyPass` : l'encodeur de commandes, pour les copies
  (`context.encoder`).

Dans `execute`, `context.texture(handle)` et `context.buffer(handle)`
donnent les ressources réelles, `context.size(handle)` la taille d'une
texture.

## Le renderer dans votre graphe

Le `Renderer` ajoute ses passes à un graphe :

- `addScenePasses(graph, { source, camera, target, format })` (ou `items`
  à la place de `source`, et `lights`, `layers`) : les shadow maps, les éléments opaques et transparents, dessinés dans `target`.
  Renvoie la version de `target` qu'elles écrivent. `name` (par défaut
  `scene`) distingue plusieurs vues d'un même graphe : chaque nom a ses
  propres uniforms de frame, de sorte que deux caméras peuvent être dessinées
  dans une même frame. `linear: true` écrit des couleurs linéaires, pour une
  cible HDR.
- `addFullscreenPass(graph, name, { material, inputs, target, format })` :
  un matériau plein écran, dont les textures sont liées aux ressources du
  graphe par `inputs`.

```ts
const runner = new RenderGraphRunner(backend);
const graph = new RenderGraph();
const output = graph.importTexture('surface', surface.getCurrentTarget());
// Two views: the scene, and a picture in picture from above.
const main = renderer.addScenePasses(graph, {
  items,
  camera,
  lights,
  target: output,
  format: surface.format,
});
const inset = renderer.addScenePasses(graph, {
  name: 'top',
  items,
  camera: topCamera,
  lights,
  target: graph.createTexture('top', {
    format: 'rgba8unorm',
    size: { width: 320, height: 180 },
  }),
  format: 'rgba8unorm',
});
// … a pass drawing `inset` over `main` …
runner.execute(graph);
surface.present();
```

## Compilation

`runner.execute(graph)` compile le graphe, puis l'enregistre dans un seul
encodeur de commandes, soumis en une fois :

1. **Culling** : à partir des passes ayant des effets de bord, en remontant
   les versions qu'elles lisent. Les autres passes sont écartées, avec les
   ressources qu'elles seules utilisaient.
2. **Ordre** : topologique, selon les versions ; à dépendances égales,
   l'ordre de déclaration.
3. **Durées de vie** : la première et la dernière passe de chaque ressource
   transitoire, et l'union de ses usages (pour ses options de création).
4. **Transitions** : les changements d'usage entre les passes, convertis en
   barrières par les backends qui en ont besoin (Vulkan).

La compilation est **mise en cache selon la structure** : les passes, leurs
types, les ressources, leurs descripteurs et leurs usages. Reconstruire le
même graphe à chaque frame ne refait que les déclarations.
`runner.compilations` et `runner.created` comptent les compilations et les
textures créées, pour vérifier qu'une frame les réutilise.

## Débogage

`graph.toDot()` décrit le graphe compilé pour
[Graphviz](https://graphviz.org) : les passes conservées et écartées, les
versions des ressources entre elles.

```ts
console.log(graph.toDot()); // dot -Tsvg frame.dot > frame.svg
```
