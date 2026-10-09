# Compute graph

_Statut : design validé dans ses grandes lignes (08/10/2026), à implémenter. Voir aussi le [render graph](render-graph.md), qui exécute les compute graphs dans ses passes de calcul._

Ce document décrit le **compute graph** : son but, son intérêt, son coût, les alternatives, et le design retenu pour FdwEngine.

---

## Sommaire

1. [Résumé](#1-résumé)
2. [Le calcul sur GPU](#2-le-calcul-sur-gpu)
3. [But et intérêt](#3-but-et-intérêt)
4. [Coût](#4-coût)
5. [Alternatives](#5-alternatives)
6. [Design](#6-design)
7. [Extensions de l'API abstraite](#7-extensions-de-lapi-abstraite)
8. [Ce qui viendra ensuite](#8-ce-qui-viendra-ensuite)
9. [Plan d'implémentation](#9-plan-dimplémentation)
10. [Stratégie de test](#10-stratégie-de-test)
11. [Risques et décisions](#11-risques-et-décisions)

---

## 1. Résumé

- Un **compute graph** décrit un **compute shader** (un programme de calcul exécuté par le GPU) avec les nœuds du material graph : mêmes types, même bibliothèque standard, mêmes fonctions-graphes, même compilateur, même IR, mêmes générateurs.
- Il lit des uniforms, des **storage buffers** et des textures, et **écrit** dans des storage buffers et des storage textures. Les storage buffers (le chantier 4 du material graph) sont son prérequis et sa première étape.
- Il est **compilé une fois** et mis en cache, comme un matériau ; une **passe de calcul** du [render graph](render-graph.md) l'exécute à chaque frame, ou à la demande.
- Les écritures sont des **résultats** du programme, pas des instructions : le corps de l'IR reste pur, comme pour le `discard` du material graph.
- WebGL2 n'a pas de calcul : le compute graph n'y est pas disponible pour l'instant.

---

## 2. Le calcul sur GPU

### 2.1 Ce qu'est un compute shader

Un GPU exécute la **même fonction** sur des milliers de fils d'exécution en parallèle. Pour le rendu, ces fils traitent des sommets (vertex shader) ou des pixels (fragment shader), et le matériel s'occupe de la rastérisation entre les deux. Un **compute shader** utilise la même puissance de calcul sans la rastérisation : c'est une fonction lancée sur une **grille** de fils, qui lit et écrit librement dans des buffers et des textures.

- La grille est découpée en **workgroups** (par exemple 64 fils, ou 8 × 8). Le programme indique la taille d'un workgroup ; le CPU indique combien de workgroups lancer : c'est le **dispatch**.
- Chaque fil connaît sa position dans la grille (`global-invocation-id`) : le fil n° 1 000 traite le 1 000e élément d'un buffer, ou le pixel (x, y) d'une image.
- Les fils d'un même workgroup peuvent partager une petite mémoire rapide et s'attendre (barrières) ; des **opérations atomiques** permettent à des fils différents d'écrire dans un même compteur sans se gêner.

### 2.2 Ce qu'est un kernel

On appelle **kernel** la fonction exécutée par chaque fil d'un dispatch : c'est le contenu d'un compute shader. Écrire un kernel « en code natif » signifie l'écrire directement dans le langage de shader de l'API (WGSL pour WebGPU, HLSL pour Direct3D et Vulkan, MSL pour Metal), sous forme de texte, au lieu de le décrire avec des nœuds :

```wgsl
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> factor: f32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  output[id.x] = input[id.x] * factor;
}
```

Le même kernel en graphe (§6.6) est portable : le moteur le traduit pour chaque backend. En code natif, il faut l'écrire une fois par langage.

### 2.3 À quoi ça sert dans un moteur

| Usage                   | Exemple                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Culling des lumières    | répartir des milliers de lumières dans des cellules de l'écran ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)) |
| Rendu piloté par le GPU | trier et filtrer les objets visibles, préparer des draw calls indirects                                                            |
| Particules, simulation  | mettre à jour des millions de particules, de la physique simple, des tissus                                                        |
| Animation               | skinning des personnages avant le rendu                                                                                            |
| Traitement d'image      | histogramme et exposition automatique, flous séparables, génération de mipmaps                                                     |
| Ray tracing logiciel    | parcourir un BVH stocké dans des buffers ([évolutions §2](evolutions.md#2-le-ray-tracing))                                         |
| Calcul généraliste      | traitements de maillages, de nuages de points, de données scientifiques                                                            |

---

## 3. But et intérêt

| Intérêt                        | Ce que ça apporte                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portabilité**                | un kernel décrit une fois tourne sur tous les backends qui ont le calcul (WebGPU, puis Vulkan, Direct3D 12, Metal), comme les matériaux                                                                        |
| **Un seul outillage**          | types, validation, bibliothèque standard, fonctions-graphes, optimisations, IR et générateurs du material graph sont réutilisés ; les fonctions écrites pour les matériaux servent aux kernels, et inversement |
| **Cohérence**                  | les données de la scène (lumières, instances) sont décrites une fois, lues par les matériaux et par les kernels                                                                                                |
| **Sûreté**                     | le compilateur vérifie les types, les ressources, les écritures concurrentes (§6.4) avant d'envoyer quoi que ce soit au GPU                                                                                    |
| **Éditeur visuel** (plus tard) | le même éditeur que pour les matériaux                                                                                                                                                                         |
| **Ray tracing**                | les shaders de ray tracing (génération, impact, rayon perdu) ont la même nature : de nouvelles sorties du même type de graphe ([render graph §12](render-graph.md#12-compatibilité-avec-le-ray-tracing))       |

---

## 4. Coût

| Coût                                                                                                                  | Ampleur                                                                                                                         | Mitigation                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Travail sur le compilateur** : un stage de calcul, les écritures, de nouveaux builtins et opérations                | Modéré : la plupart des passes existantes s'appliquent sans changement (un seul stage, pas de varyings)                         | Étapes courtes, testées sur Dawn                                    |
| **Expressivité limitée au départ** : pas d'atomiques, de mémoire partagée, de barrières ni de boucles générales en v1 | Réel : beaucoup d'algorithmes de calcul en ont besoin (réductions, listes, tris)                                                | Ajouts prévus (§8) ; kernels en code natif plus tard si besoin (§5) |
| **Performance du code généré** : un kernel écrit à la main par un expert peut être plus rapide                        | Faible pour les kernels simples ; plus marqué pour les algorithmes fins (tris, réductions) qui dépendent de la mémoire partagée | Mesures ; code natif pour les cas critiques                         |
| **Pas de calcul en WebGL2**                                                                                           | Les fonctionnalités qui en dépendent n'y sont pas disponibles                                                                   | Capacité `compute` consultée ; replis étudiés plus tard (§5.3)      |
| **Exécution** : le coût d'un dispatch est celui du kernel ; la compilation n'a lieu qu'une fois par programme         | Comme les matériaux                                                                                                             | Cache par `programKey`, pipelines asynchrones                       |

---

## 5. Alternatives

### 5.1 Comment écrire les kernels

| Alternative                               | Principe                                                                                          | Avantages                                                                                       | Inconvénients                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A. Code natif seulement**               | des kernels écrits à la main en WGSL, HLSL, MSL                                                   | toute la puissance du langage ; reprise d'algorithmes publiés                                   | un kernel par langage et par backend ; pas de vérification par le moteur ; données de scène décrites deux fois |
| **B. Un langage et un cross-compilateur** | des kernels en WGSL, convertis par naga vers les autres langages                                  | un seul langage écrit à la main                                                                 | dépendance lourde ; code converti peu lisible ; reste du texte non vérifié par le moteur                       |
| **C. Graphes** (retenu)                   | des kernels décrits avec les nœuds du material graph                                              | portable ; vérifié ; même outillage et mêmes fonctions que les matériaux ; prêt pour un éditeur | expressivité limitée au départ (§8)                                                                            |
| **D. C + code natif plus tard**           | les graphes, avec des nœuds `native` (déjà prévus par le material graph) pour du code par langage | le meilleur des deux, au prix de la portabilité seulement là où c'est nécessaire                | à concevoir quand un besoin réel apparaît                                                                      |

**Décision : C, puis éventuellement D.** Les kernels sont d'abord des graphes, pour la portabilité ; le code natif sera étudié plus tard, si un besoin le justifie.

### 5.2 Exécution

Les compute graphs sont **compilés une fois**, mis en cache par `programKey` comme les matériaux, et **exécutés** par les passes de calcul du render graph, qui sont déclarées à chaque frame. Pour les usages hors rendu (tests, traitements ponctuels), une petite API de dispatch direct est fournie (§6.7).

### 5.3 Sans calcul : WebGL2

WebGL2 n'a ni compute shaders ni storage buffers. **Décision : le compute graph n'y est pas disponible pour l'instant** ; la capacité `compute` vaut `false`, et une passe de calcul fait échouer la compilation du render graph avec un message clair.

Deux replis pourront être étudiés plus tard :

- **Sur le CPU** : le même calcul en JavaScript, pour des données de taille modeste (le culling de quelques centaines de lumières, par exemple). Simple, mais lent pour de gros volumes, et les données doivent faire l'aller-retour entre CPU et GPU.
- **Par rendu dans des textures** (« GPGPU » classique de WebGL) : les données sont rangées dans des textures, et le calcul est un fragment shader qui dessine un rectangle couvrant une texture de sortie, un pixel par élément. C'est ainsi qu'on calculait sur GPU avant les compute shaders. Ça couvre les calculs « un élément → un résultat » (traitement d'image, simulation de particules), mais pas les écritures à des positions arbitraires ni les atomiques. Le compilateur pourrait traduire certains compute graphs en fragment shaders automatiquement.

---

## 6. Design

### 6.1 Prérequis : les storage buffers

_Fait (CG1)._ `input.storage` (tableau de taille dynamique de scalaires, vecteurs ou matrices, en lecture) est lu par `std.index` et `std.arrayLength` ; une contrainte générique `array` et le type dérivé `array-element-of` les typent, et les littéraux entiers d'un générique entier (l'index `0`) sont typés `u32`. Le layout physique donne le pas des éléments (règles du stockage WGSL : 4 pour un `f32`, 8 pour un `vec2`, 16 pour un `vec3`). WebGPU : `var<storage, read>`, binding `read-only-storage`. WebGL2 : capacité `storageBuffers: false`, la compilation et la création d'un buffer `storage` échouent avec un message clair. Un `GpuBuffer` est une valeur de matériau.

C'est le chantier 4 du material graph ([§17.4](material-graph.md#174-storage-buffers)), première étape du compute graph :

- `input.storage` lu par `std.index(buffer, index)` et `std.arrayLength(buffer)` ;
- tableaux de taille dynamique de scalaires, vecteurs et matrices (les structures viendront ensuite) ;
- ressource `storage-buffer` du `ProgramLayout`, layout physique `std430` / WGSL `storage` ;
- WebGPU : `var<storage, read>`, binding `read-only-storage` ; WebGL2 : erreur explicite ;
- utilisables aussi par les **matériaux** (lecture seule), par exemple pour des palettes ou des données d'instances.

### 6.2 Modèle

Un compute graph utilise le même modèle de données que le material graph (`MaterialGraphData`) et le même `GraphBuilder`. Ce qui change :

- **Sortie** : `output.compute`, avec le paramètre `workgroupSize` (par exemple `[64, 1, 1]` ou `[8, 8, 1]`). Le graphe a un seul stage.
- **Builtins** : `global-invocation-id`, `local-invocation-id`, `workgroup-id`, `num-workgroups`.
- **Entrées** : uniforms ; storage buffers en lecture ; textures échantillonnées avec un **niveau explicite** (`std.textureSampleLevel` : il n'y a pas de dérivées en calcul, donc pas de choix automatique du mipmap) ; storage textures en lecture (`std.textureLoad`).
- **Écritures** : nœuds `write.storage(buffer, index, value)` et `write.texture(texture, coordinates, value)`, avec une condition optionnelle (`when`), pour n'écrire que si elle est vraie (par exemple pour les fils au-delà de la fin d'un buffer).

### 6.3 Les écritures dans l'IR

Une écriture est un **effet de bord** : elle doit avoir lieu, à un endroit précis. Comme pour le `discard` du material graph ([§17.5](material-graph.md#175-le-discard-et-ses-implications)), elle n'est pas une instruction du corps, mais un **résultat** de l'entry point :

```ts
interface IrEntryPoint {
  readonly stage: 'vertex' | 'fragment' | 'compute';
  // …
  // Compute: the size of a workgroup, and the writes, in order, made after
  // the body.
  readonly workgroupSize?: readonly [number, number, number];
  readonly writes?: readonly IrWrite[];
}

interface IrWrite {
  readonly resource: string; // binding of the layout
  readonly index: ValueId; // element, or texel coordinates
  readonly value: ValueId;
  readonly condition?: ValueId;
}
```

Le corps reste du code pur : élimination du code mort, CSE et pliage des constantes s'appliquent sans changement. Les générateurs émettent les écritures après le corps, dans l'ordre déclaré.

### 6.4 Lectures et écritures concurrentes

Les fils d'un dispatch s'exécutent dans un ordre indéfini. Un kernel qui lit une ressource pendant que d'autres fils l'écrivent donne des résultats qui dépendent de cet ordre. Règles de la v1 :

- une ressource est **lue ou écrite**, pas les deux, dans un même compute graph ; le compilateur refuse le contraire ;
- deux fils qui écrivent au même endroit donnent un résultat indéfini : c'est la responsabilité du graphe (les atomiques viendront en v2, §8) ;
- entre deux dispatchs, l'ordre est garanti par le render graph (usages `storage-write` puis `storage-read`).

### 6.5 Compilation

Le compilateur réutilise ses passes : validation, macros et inlining, optimisations, layout logique. Le découpage en stages est remplacé par un seul stage de calcul, sans varyings : toutes les valeurs sont calculées « par fil ». Les nœuds réservés au fragment (`discard`, `frag-coord`, `textureSample` avec mipmap automatique) sont refusés avec un message clair. L'IR gagne l'entry point `compute`. Le générateur WGSL émet `@compute @workgroup_size(…)` ; GLSL ES 3.00 n'a pas de calcul.

### 6.6 Exemple

```ts
// Multiplies every value of a buffer by a factor.
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
  // Threads past the end of the buffer do nothing.
  when: g.call(std.less, {
    a: index,
    b: g.call(std.arrayLength, { array: input }),
  }),
});
g.compute({ workgroupSize: [64, 1, 1] });
const program = compile(g.build());

new ComputeRunner(backend).dispatch(program, {
  values: { input, output, factor: 2.5 },
  workgroups: [Math.ceil(count / 64)],
});
const result = new Float32Array(await output.read());
```

### 6.7 Exécution

- **Dans le render graph** : une passe de calcul déclare les buffers et textures lus et écrits (usages `storage-read` / `storage-write`), le programme, les valeurs de ses uniforms, et le nombre de workgroups : fixe, relatif à la taille d'une ressource, ou lu dans un buffer (dispatch indirect).
- **Hors du render graph** : `backend.dispatch(program, { bindings, workgroups })` pour les tests et les traitements ponctuels, et `buffer.read()` (asynchrone) pour relire un résultat.

---

## 7. Extensions de l'API abstraite

```ts
interface ComputePipelineDescriptor {
  readonly program: CompiledProgram; // entry point 'compute'
  readonly label?: string;
}

interface GpuPipelineFactory {
  // …
  createComputePipeline(
    descriptor: ComputePipelineDescriptor
  ): GpuComputePipeline;
  createComputePipelineAsync(
    descriptor: ComputePipelineDescriptor
  ): Promise<GpuComputePipeline>;
}

interface GpuComputePassEncoder {
  setPipeline(pipeline: GpuComputePipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  dispatchWorkgroupsIndirect(buffer: GpuBuffer, offset: number): void;
  end(): void;
}

interface GpuCommandEncoder {
  // …
  beginComputePass(label?: string): GpuComputePassEncoder;
}
```

Les buffers gagnent l'usage `storage` (déjà déclaré dans l'API) et une relecture asynchrone ; les textures, l'usage `storage`. Les capacités `compute`, `storageBuffers` et `storageTextures` sont consultées par le compilateur (refus d'un compute graph ou d'un storage buffer) et par le render graph (refus d'une passe de calcul).

---

## 8. Ce qui viendra ensuite

| Ajout                                                                                                                                   | Nécessaire pour                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Atomiques** (`atomicAdd`, `atomicMax`…)                                                                                               | construire des listes (lumières par cluster, particules vivantes), compter                                               |
| **Mémoire partagée de workgroup et barrières**                                                                                          | réductions, histogrammes (exposition automatique), tris                                                                  |
| **Boucles générales** : généraliser `loop-sum` en `fold` (accumulateur quelconque), déjà noté dans les [écarts](material-graph-gaps.md) | parcourir des listes, des BVH                                                                                            |
| **Structures** dans les storage buffers                                                                                                 | données de scène lisibles (instances, lumières)                                                                          |
| **Kernels en code natif** (nœuds `native`)                                                                                              | algorithmes critiques, reprise de code existant (§5.1, alternative D)                                                    |
| **Sorties de ray tracing** (`output.rayGeneration`, `output.closestHit`, `output.miss`)                                                 | ray tracing matériel, sur les backends natifs ([render graph §12](render-graph.md#12-compatibilité-avec-le-ray-tracing)) |
| **Replis WebGL2** (CPU, rendu dans des textures)                                                                                        | les fonctionnalités de calcul sur WebGL2 (§5.3)                                                                          |

---

## 9. Plan d'implémentation

_CG1, CG2 et CG3 faits._ CG2 inclut l'entry point `compute` de l'IR et le générateur WGSL, sans lesquels un pipeline de calcul ne pouvait pas être testé. CG3 : `output.compute` (taille de workgroup), `write.storage` (port `array` relié au storage buffer écrit, pour que le type de la valeur soit vérifié), builtins de calcul, `std.textureSampleLevel` (aussi utilisable dans les matériaux), règles du §6.4, layout réduit aux slots utilisés, `ComputeRunner` pour le dispatch direct. Restent du §6.2 : les **storage textures** (`write.texture`, `std.textureLoad`), à faire avec le render graph ou quand un besoin apparaît.

L'étape **RG1** du plan commun ([render graph §13](render-graph.md#13-plan-dimplémentation)) :

| Étape                                 | Contenu                                                                                                                                                                                                                                                | Critère de fin                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **CG1. Storage buffers** (chantier 4) | `input.storage`, `std.index`, `std.arrayLength`, layout `std430`, WGSL, binding `read-only-storage`, erreur WebGL2 ; lecture dans les matériaux                                                                                                        | Rendu d'une palette lue dans un storage buffer sur Dawn ; erreur explicite sur WebGL2              |
| **CG2. API de calcul et IR**          | Pipelines et passes de calcul, dispatch (direct et indirect), relecture de buffers ; entry point `compute` de l'IR (taille de workgroup, builtins de calcul, écritures) ; générateur WGSL `cs_main` ; implémentation WebGPU, refus explicite en WebGL2 | Une IR de calcul écrite à la main exécutée sur Dawn, résultat relu et comparé à un calcul CPU      |
| **CG3. Compute graphs**               | `output.compute`, builtins et nœuds d'écriture dans le graphe, compilation d'un graphe vers l'entry point `compute`, `textureSampleLevel`, règle lecture / écriture, API de dispatch direct (§6.7)                                                     | Le kernel de l'exemple (§6.6) et un traitement d'image exécutés sur Dawn, comparés à un calcul CPU |

Les passes de calcul du render graph (RG2) utilisent ensuite ces programmes.

---

## 10. Stratégie de test

| Niveau          | Quoi                                                                                                                | Outils            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Compilateur     | Entry point `compute`, écritures, refus des nœuds de fragment et des lectures-écritures, layout des storage buffers | Vitest, snapshots |
| Générateur WGSL | Code émis, validé par Dawn                                                                                          | Vitest, Dawn      |
| Exécution       | Résultats de dispatchs relus et comparés à une référence CPU                                                        | Dawn dans Node    |
| Capacités       | Erreurs explicites sur WebGL2                                                                                       | Chromium headless |

---

## 11. Risques et décisions

| Sujet                      | Risque                                                         | Réponse                                                                                  |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Expressivité               | Des algorithmes impossibles sans atomiques ni mémoire partagée | Ajouts prévus (§8) ; code natif en dernier recours                                       |
| Écritures concurrentes     | Résultats qui dépendent de l'ordre des fils                    | Écritures comme résultats de l'IR ; lecture-écriture d'une même ressource refusée (§6.4) |
| WebGL2                     | Pas de calcul                                                  | Non disponible pour l'instant ; replis étudiés plus tard (§5.3)                          |
| Performance du code généré | Moins efficace qu'un kernel écrit à la main                    | Mesures ; code natif pour les cas critiques                                              |

**Décisions (08/10/2026) :**

1. **Les kernels sont des graphes** ; le code natif sera étudié plus tard (alternative C, puis éventuellement D, du §5.1).
2. **Les compute graphs sont compilés une fois** et mis en cache ; seules les passes qui les exécutent sont déclarées à chaque frame.
3. **WebGL2 n'a pas de calcul** pour l'instant ; les replis CPU et par rendu dans des textures seront étudiés plus tard.
4. **Les storage buffers (chantier 4) sont la première étape** (CG1).
