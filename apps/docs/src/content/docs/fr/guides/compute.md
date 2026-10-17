---
title: Compute
description: Les compute graphs, les storage buffers, les dispatches, et leurs règles.
sidebar:
  order: 3
---

Un **compute graph** s'exécute sur le GPU en dehors de tout draw : un thread
par élément de travail, regroupés en workgroups. Il s'écrit avec les nœuds
des material graphs, et écrit dans des **storage buffers**. Il s'exécute
sur tous les backends : WebGL2, qui n'a pas de compute shaders, l'exécute
par rendu dans des textures (voir [En WebGL2](#en-webgl2)).

## Un compute graph

```ts
const g = new GraphBuilder('scale');
const index = g.builtin('global-invocation-id').swizzle('x');
const input = g.storage('input', arrayType(BuiltinTypes.f32));
const output = g.storage('output', arrayType(BuiltinTypes.f32), {
  access: 'read-write',
});
g.write(output, {
  index,
  value: g.call(std.mul, {
    a: g.call(std.index, { array: input, index }),
    b: g.uniform('factor', BuiltinTypes.f32),
  }),
  when: g.call(std.less, {
    a: index,
    b: g.call(std.arrayLength, { array: input }),
  }),
});
g.compute({ workgroupSize: [64, 1, 1] });

const program = compile(g.build(), { capabilities: backend.capabilities });
```

- `g.compute({ workgroupSize })` termine le graphe : les threads d'un
  workgroup, en x, y et z (64 × 1 × 1 par défaut).
- Les builtins donnent la position du thread : `global-invocation-id`,
  `local-invocation-id`, `workgroup-id`, `num-workgroups` (`vec3<u32>`).
- `g.storage(name, arrayType(element), { access })` déclare un buffer, un
  tableau de scalaires, de vecteurs ou de matrices dont la longueur est la
  taille du buffer. `std.index` lit un élément, `std.arrayLength` donne la
  longueur.
- `g.write(array, { index, value, when })` écrit un élément d'un buffer
  déclaré `read-write` ; `when` saute l'écriture lorsqu'il est faux. Un graphe
  peut écrire plusieurs fois.

## Règles

Le compilateur refuse ce qui serait incorrect ou non portable :

- les nœuds qui nécessitent une autre étape : `std.textureSample` a besoin
  des dérivées d'un fragment shader, utilisez `std.textureSampleLevel` ;
- la lecture d'un buffer que le graphe écrit : les threads s'exécutent dans
  un ordre quelconque ;
- l'écriture dans un buffer déclaré en lecture seule ;
- sur un backend sans calcul (`capabilities.compute === false`) : une erreur
  explicite. Aucun backend du moteur n'est dans ce cas.

Un compute graph ne possède que les slots de ressources qu'il utilise.
Passez-lui ses entrées sous forme d'uniforms (un temps, une taille), définis
à chaque dispatch.

## Exécuter un graphe

`ComputeRunner` lance un programme seul, en dehors d'une frame :

```ts
const runner = new ComputeRunner(backend);
runner.dispatch(program, {
  values: { input, output, factor: 2.5 },
  workgroups: [Math.ceil(count / 64)],
});
const result = new Float32Array(await output.read());
```

- `values` : les ressources par nom — valeurs d'uniforms, textures,
  samplers, storage buffers.
- `workgroups` : `[x, y?, z?]`, ou `{ buffer, offset }`, un buffer contenant
  les trois nombres en `u32` — un dispatch **indirect**, dont la taille est
  calculée par le GPU. Le buffer doit avoir l'usage `indirect`.
- Les pipelines sont mis en cache par programme ; les bind groups et leurs
  uniform buffers par programme et par ressources : relancer avec les
  mêmes buffers les réutilise. Les moins récemment utilisés au-delà de
  `new ComputeRunner(backend, { bindGroups })` (256) sont détruits.

Les storage buffers sont créés par le backend, avec les usages dont ils ont
besoin :

```ts
const output = backend.buffers.create({
  size: count * 4,
  usage: ['storage', 'copy-src', 'copy-dst'],
});
```

`copy-src` permet `buffer.read()` ; `initialData` remplit un buffer à sa
création.

Le GPU exécute les soumissions dans l'ordre : une frame rendue après un
dispatch voit ses résultats. Un matériau lit aussi un storage buffer avec
`g.storage()`, sans l'accès en écriture — voir le
[tutoriel Compute](/fdw-engine/fr/tutorials/compute/).

## Dans un render graph

`graph.addComputePass(name, setup)` déclare une passe de calcul et ses
ressources (`storage-read`, `storage-write`, `indirect`…) : elle est
ordonnée, éliminée par le culling et synchronisée avec les autres passes.
Son `execute` reçoit un `GpuComputePassEncoder` :
`runner.record(pass, program, dispatch)` y enregistre un dispatch, avec les
caches de `dispatch`, soumis avec l'image. Plusieurs dispatches peuvent
partager la passe :

```ts
graph.addComputePass('simulation', (pass) => {
  const written = pass.write(
    graph.importBuffer('state', state),
    'storage-write',
  );
  return {
    written,
    execute: (context) =>
      runner.record(context.pass, program, {
        values: { state },
        workgroups: [Math.ceil(count / 64)],
      }),
  };
});
```

Les dispatches d'une même soumission qui lient les mêmes ressources
partagent leurs valeurs uniformes : les dernières écrites.
`renderer.render({ prepare })` ajoute des passes au graphe de l'image,
avant celles de la scène.

## Selon les backends

| Backend | Étapes de calcul                                                                   |
| ------- | ---------------------------------------------------------------------------------- |
| WebGPU  | Points d'entrée compute en WGSL                                                    |
| Vulkan  | HLSL compilé en SPIR-V ; barrières insérées avant chaque dispatch                  |
| WebGL2  | Émulées par des dessins dans des textures ; storage buffers en textures de données |

## En WebGL2

WebGL2 n'a ni compute shaders ni storage buffers. Le moteur y exécute les
mêmes graphes par **rendu dans des textures**, le GPGPU de WebGL : ses
capacités indiquent `compute: true`, `storageBuffers: true` et
`emulatedCompute: true`.

- **Storage buffers** : chacun a une copie dans une texture de données,
  `rgba32uint`, 16 octets par texel, les octets du buffer dans l'ordre. Les
  programmes lisent leurs éléments par `texelFetch`, matériaux compris.
- **Dispatches** : chaque écriture du graphe est un dessin de points dans
  la texture du buffer écrit, un point par thread (et par texel de
  l'élément : quatre pour une `mat4`). Le vertex shader exécute le graphe,
  place le point sur le texel de l'élément, ou hors de la vue quand `when`
  est faux ; le fragment shader en écrit les bits. Les éléments plus petits
  qu'un texel (`f32`, `vec2`) sont écrits par des dessins masqués, un par
  partie du texel. Les builtins viennent de l'instance dessinée et du nombre
  de workgroups.
- **Les deux copies** d'un buffer sont mises à jour l'une depuis l'autre
  sur le GPU, par des pixel buffers, seulement quand un usage le demande :
  la texture avant un dispatch ou un dessin qui la lit, le buffer avant une
  lecture de sommets, une copie ou `read()`. Un buffer écrit par un dispatch
  peut donc servir de vertex buffer.

Ce qui change :

- **Pas de dispatch indirect** : il faudrait d'abord relire les nombres ;
  `dispatchWorkgroupsIndirect` et l'usage `indirect` lèvent une erreur.
- Un même buffer ne peut pas être lié deux fois, lu et écrit, dans un
  dispatch : une erreur explicite (le compilateur refuse déjà un graphe qui
  lit le buffer qu'il écrit).
- Un buffer contient au plus `MAX_TEXTURE_SIZE` lignes de 2048 texels
  (64 Mo avec le minimum de WebGL2).
- C'est plus lent que des compute shaders : un graphe à plusieurs écritures
  s'exécute une fois par écriture, et les scalaires quatre fois. Les
  fonctionnalités qui ont un autre chemin le préfèrent : le skinning reste
  par défaut dans l'étape de sommets (`defaultSkinningMode`), mais peut être
  demandé en calcul.

Le [tutoriel Particules sur le GPU](/fdw-engine/fr/tutorials/gpu-particles/)
exécute une simulation sur les trois backends.
