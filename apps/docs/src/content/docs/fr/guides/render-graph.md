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
  frame (`{ relative: 0.5 }`) ; par défaut, c'est la taille de la frame :
  celle donnée à la création du graphe, sinon la première texture importée,
  ou la `size` passée à `execute`.
- `sampleCount: 4` crée un attachment multiéchantillonné, résolu dans une
  texture avec `pass.resolveColor()`.
- `mipLevelCount` donne des niveaux de détail à une texture (`'full'` :
  jusqu'à 1×1, pour la taille qu'elle reçoit).
  `graph.addMipmapPass(name, texture)` les calcule à partir du premier niveau
  et renvoie la version à échantillonner (un flou, un bloom, une moyenne).

### La taille de la frame

Certaines passes ont besoin de la taille de leurs textures dès qu'elles sont
déclarées : l'[occlusion culling](/fdw-engine/fr/tutorials/occlusion-culling/)
dimensionne sa pyramide de profondeur avec. Créez le graphe avec la taille
de la frame ; `graph.pixelSize(handle)` donne alors la taille en pixels de
toute texture, relatives comprises (undefined quand le graphe ne la connaît
pas). `Renderer.render()` le fait avec la taille de la surface.

```ts
const current = surface.getCurrentTarget();
const graph = new RenderGraph({
  size: { width: current.width, height: current.height },
});
graph.pixelSize(half); // { width: current.width / 2, … }, arrondi
```

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
- `addCopyPass` : l'encodeur de commandes, pour les copies et les mipmaps
  (`context.encoder`).

Dans `execute`, `context.texture(handle)` et `context.buffer(handle)`
donnent les ressources réelles, `context.size(handle)` la taille d'une
texture.

## Le renderer dans votre graphe

Le `Renderer` ajoute ses passes à un graphe :

- `addScenePasses(graph, { source, camera, target, format })` (ou `items`
  à la place de `source`, et `lights`, `layers`) : les shadow maps, les éléments opaques et transparents, dessinés dans `target`.
  Renvoie `{ color, depth, outputs }` : les versions qu'elles écrivent (la
  couleur de `target`, la profondeur, les sorties ci-dessous). `name` (par défaut
  `scene`) distingue plusieurs vues d'un même graphe : chaque nom a ses
  propres uniforms de frame, de sorte que deux caméras peuvent être dessinées
  dans une même frame. `linear: true` écrit des couleurs linéaires, pour une
  cible HDR. `inputs` lie des textures du graphe aux textures de même nom des
  matériaux (l'image d'un miroir). Quand des lumières projettent des ombres,
  `shadows` est la version de leur atlas d'ombres.
- `addFullscreenPass(graph, name, { material, inputs, target, format })` :
  un matériau plein écran, dont les textures sont liées aux ressources du
  graphe par `inputs`. Il lit la caméra et les lumières des dernières passes
  de scène ajoutées (une passe d'éclairage différé), et leurs shadow maps
  avec `shadows: scene.shadows`. Avec `targets`, il écrit aussi les cibles de couleur
  supplémentaires du matériau (`g.target`), par nom, et renvoie
  `{ color, targets }` :

  ```ts
  const pass = renderer.addFullscreenPass(graph, 'split', {
    material, // g.fullscreen({ color }); g.target('mask', mask, 1)
    target: graph.createTexture('color', { format: 'rgba8unorm' }),
    format: 'rgba8unorm',
    targets: {
      mask: {
        target: graph.createTexture('mask', { format: 'r8unorm' }),
        format: 'r8unorm',
      },
    },
  });
  pass.targets.mask; // la version écrite, à lire dans les passes suivantes
  ```

  Le nombre de cibles est limité par `capabilities.maxColorAttachments` (4
  au moins, 8 sur la plupart des GPU), et leurs octets par pixel par
  `maxColorAttachmentBytesPerSample` en WebGPU (32). WebGL2 mélange toutes
  ses cibles flottantes de la même façon (`independentBlend` est faux).

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

## Sorties de la scène

En plus de leur couleur, les passes de la scène écrivent les **sorties**
demandées, chacune dans sa texture (cibles multiples), autant que le backend
le permet, nommées comme vous voulez :

```ts
const scene = renderer.addScenePasses(graph, {
  items,
  camera,
  target: graph.createTexture('color', { format: 'rgba8unorm' }),
  format: 'rgba8unorm',
  outputs: {
    normal: { format: 'rgba16float', value: 'view-normal' },
    id: { format: 'r32uint', value: 'object-id' },
    properties: { format: 'rgba8unorm', value: packProperties },
    velocity: { format: 'rg16float', value: 'material', default: [0, 0] },
  },
});
scene.outputs.normal; // une version à lire dans les passes suivantes
```

Ce que contient une sortie :

- **Une valeur de la surface ou du moteur** : `view-normal`,
  `world-normal`, `view-depth`, `world-position`, `object-id`, `uv`, ou une
  entrée de la surface (`base-color`, `alpha`, `emissive`, `roughness`,
  `metallic`, `occlusion`…, sa valeur par défaut si le modèle d'éclairage ne
  l'a pas). Convertie au format (les composantes manquantes valent 0, et 1
  pour la 4e).
- **Une fonction-graphe à vous** (`defineFunction`), la même pour tous les
  matériaux : ses entrées portent le nom de ces valeurs (`viewNormal`,
  `baseColor`, `objectId`…) et sa sortie est écrite. Pour ranger plusieurs
  valeurs dans une cible, les encoder, calculer ce que le moteur ne connaît
  pas.
- **`'material'`** : chaque matériau l'écrit avec `g.output(name, value)` ;
  les autres écrivent `default`.

Les fonctions et les matériaux donnent des valeurs du type du format :
`vec2f` pour `rg16float`, `u32` pour `r32uint`, `vec4f` pour `rgba8unorm`.

- **Sans `target`**, les passes n'écrivent que leurs sorties, sans les
  modèles d'éclairage : un G-buffer pour le rendu différé (`size` donne la
  taille des textures, celle de la frame par défaut).
- **Identifiants** : donnez un `id` (de 1 à 2^24) aux éléments ;
  `object-id` l'écrit pour leurs pixels, 0 ailleurs. `pickIds` relit
  ceux d'une région d'une texture `r32uint` (voir la
  [sélection au pixel](/fdw-engine/fr/tutorials/picking/)). Au-delà de 2^24
  objets, sélectionnez par lancer de rayons (`scene.raycast`) plutôt
  qu'avec un buffer d'identifiants.
- **Les transparents ne mélangent que leur couleur** : ils n'écrivent
  aucune sortie, et ne peuvent pas être sélectionnés par `object-id`.
- `samples` règle le multi-échantillonnage d'un appel (celui du renderer
  par défaut). Les sorties de formats entiers ne sont pas
  multi-échantillonnées : dessinez-les dans un appel avec `samples: 1`.
- `depth` donne une profondeur écrite par des passes précédentes, et
  `include: 'opaque' | 'transparent'` les éléments dessinés : un G-buffer
  des opaques, puis les transparents sur l'image composée.
- `faces: 'back'` dessine les faces arrière des éléments à une face au
  lieu de leurs faces avant : la profondeur du côté éloigné des objets,
  leur épaisseur (voir [Reflets](/fdw-engine/fr/tutorials/reflections/)).

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

### Temps GPU des passes

Avec l'option `timing`, le runner mesure la durée GPU de chaque passe de
rendu et de calcul :

```ts
const runner = new RenderGraphRunner(backend, { timing: true });
// Every frame:
runner.execute(graph);
for (const [pass, milliseconds] of runner.passTimes) {
  console.log(pass, milliseconds.toFixed(3));
}
```

- Le GPU répond avec quelques frames de retard : `passTimes` donne la
  dernière frame mesurée, et est vide au début. Il n'attend jamais le GPU.
- Deux passes du même nom s'additionnent.
- Là où le GPU ne peut pas mesurer, `passTimes` reste vide : WebGPU
  nécessite la feature `timestamp-query` (demandée par `WebGpuEngine`
  lorsque l'adaptateur la possède), WebGL2 l'extension
  `EXT_disjoint_timer_query_webgl2` ; Vulkan mesure lorsque sa queue écrit
  des timestamps.
- Un backend fournit les mesures via `createPassTimer(capacity)` : une
  passe à laquelle on donne `timing: { timer, index }` est mesurée dans cet
  emplacement.
