# Proposition : material graph et pipeline de rendu multi-backend

_Statut : phases 1 à 5 implémentées, boucle sur les lumières comprise (07/10/2026). Écarts restants : [écarts](material-graph-gaps.md)_

Ce document propose une architecture et un plan d'implémentation pour :

1. un **material graph** : un graphe orienté acyclique (DAG) de nœuds typés qui décrit un matériau sans référence à un langage de shader ;
2. un **compilateur** qui transforme ce graphe en programme de shader et en description de layout, pour n'importe quel backend (WebGPU, WebGL, OpenGL, Vulkan, Metal, DirectX) ;
3. un **pipeline de rendu** qui construit et met en cache les pipelines GPU, et auquel il ne reste plus qu'à fournir les valeurs d'entrée et le mesh pour dessiner.

---

## Sommaire

1. [Résumé](#1-résumé)
2. [Objectifs et non-objectifs](#2-objectifs-et-non-objectifs)
3. [Vue d'ensemble](#3-vue-densemble)
4. [Répartition dans les packages](#4-répartition-dans-les-packages)
5. [Système de types](#5-système-de-types)
6. [Le graphe](#6-le-graphe)
7. [Le compilateur](#7-le-compilateur)
8. [La représentation intermédiaire (IR)](#8-la-représentation-intermédiaire-ir)
9. [Génération de code par backend](#9-génération-de-code-par-backend)
10. [Le pipeline de rendu](#10-le-pipeline-de-rendu)
11. [Le runtime : matériaux, bind groups et rendu](#11-le-runtime--matériaux-bind-groups-et-rendu)
12. [Exemple de bout en bout](#12-exemple-de-bout-en-bout)
13. [Intégration avec l'existant](#13-intégration-avec-lexistant)
14. [Plan d'implémentation](#14-plan-dimplémentation)
15. [Stratégie de test](#15-stratégie-de-test)
16. [Risques et questions ouvertes](#16-risques-et-questions-ouvertes)
17. [Chantiers avant la phase 6](#17-chantiers-avant-la-phase-6)
18. [Bilan du material graph](#18-bilan-du-material-graph)

Documents associés : [écarts restants](material-graph-gaps.md), [améliorations pour la v2](material-graph-v2.md), [évolutions envisagées](evolutions.md).

---

---

## 1. Résumé

- Un matériau est décrit par un **`MaterialGraph`** : des nœuds (entrées, constantes, fonctions, macros, sorties) reliés par des arêtes entre **ports typés**. Le graphe est sérialisable en JSON.
- Le graphe est compilé en une **IR** (représentation intermédiaire) indépendante du langage : une liste d'instructions typées, sans flot de contrôle. C'est le point clé de l'architecture : un DAG n'a ni boucle ni branche, donc l'IR est du code linéaire, et écrire un générateur de code pour un nouveau langage est simple.
- Le compilateur produit aussi un **`ProgramLayout`** logique : les attributs de vertex requis, et les ressources (uniforms, storage, textures, samplers) regroupées par fréquence de mise à jour (`frame`, `material`, `object`, les slots qui existent déjà dans `engine-backend`).
- Chaque backend fournit un **générateur de code** (IR → WGSL, GLSL, MSL, HLSL ou SPIR-V) et une **factory de pipelines** qui implémente une API abstraite calquée sur le modèle WebGPU, le plus petit dénominateur commun moderne entre Vulkan, Metal et D3D12.
- Les programmes et les pipelines sont **mis en cache par clé structurelle** : la clé dépend de la topologie du graphe, des paramètres statiques, du layout de vertex et du render state, jamais des valeurs des uniforms. Modifier une couleur ne recompile donc rien.
- Au runtime, un **`Material`** associe un graphe compilé à des valeurs (versionnées avec `CachedValue`). Le **`Renderer`** reçoit des `RenderItem` `{ mesh, material, transform }` : il résout les pipelines, met à jour les buffers qui ont changé et émet les draw calls.

---

## 2. Objectifs et non-objectifs

### Objectifs

- Décrire un matériau **une seule fois** et le rendre sur tous les backends.
- Des **entrées typées** : attributs de vertex, uniforms, storage buffers, textures et samplers, avec une vérification de type à la construction du graphe.
- Plusieurs **catégories de nœuds** : constantes, fonctions (intrinsèques, sous-graphes, code natif), macros évaluées à la compilation, sorties.
- La gestion des **variantes** (permutations) par paramètres statiques : normal map présente ou non, couleur de vertex disponible, skinning, etc.
- Un **compilateur déterministe** : le même graphe produit toujours le même code et les mêmes bindings, ce qui permet le cache et le partage des layouts.
- Un **code généré lisible**, avec des noms dérivés des nœuds, pour faciliter le débogage.
- Une **API de rendu minimale** côté utilisateur : un matériau, un mesh, des valeurs, et on dessine.

### Non-objectifs (pour la première version)

- Un éditeur visuel de graphes. Le format JSON est conçu pour en permettre un plus tard.
- Les compute shaders et le render graph (frame graph multi-passes). L'architecture les laisse possibles, mais ils ne sont pas couverts ici (voir §16).
- Les boucles dynamiques arbitraires dans le graphe. Seules des constructions dédiées sont prévues, comme la boucle sur les lumières (§6.6).

---

## 3. Vue d'ensemble

```
             ┌────────────────────────┐
             │   MaterialGraph (DAG)  │  ← construit en TS ou chargé depuis du JSON
             └───────────┬────────────┘
                         │ + paramètres statiques (features)
                         │ + capacités du backend
                         ▼
             ┌────────────────────────┐
             │      Compilateur       │  validation → macros → typage →
             │   (agnostique, pur TS) │  optimisations → fréquences/stages →
             └───────────┬────────────┘  ressources → IR
                         ▼
        ┌─────────────────────────────────────┐
        │ CompiledProgram                     │
        │  • ShaderModuleIR (vertex+fragment) │
        │  • ProgramLayout (logique)          │
        │  • VertexInputRequirement[]         │
        │  • programKey                       │
        └───────────┬─────────────────────────┘
                    │
       ┌────────────┼──────────────┬──────────────┬─────────────┐
       ▼            ▼              ▼              ▼             ▼
  WgslCodegen  GlslEsCodegen  Glsl450Codegen  MslCodegen   HlslCodegen    ← un par backend
       │            │              │              │             │
       ▼            ▼              ▼              ▼             ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │ GpuPipelineFactory (par backend) + PipelineCache                 │
  │  programme + layout physique + MeshDescription + render state    │
  │  → GpuRenderPipeline                                             │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │ Renderer : RenderItem { mesh, material, transform }              │
  │  → bind groups frame / material / object → draw                  │
  └──────────────────────────────────────────────────────────────────┘
```

Deux notions sont séparées tout au long du document :

| Notion       | Description                                                                                         | Dépend du backend ? |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------- |
| **Logique**  | Types de shader, graphe, IR, `ProgramLayout` (quelles ressources, de quel type, à quelle fréquence) | Non                 |
| **Physique** | Offsets et alignements en mémoire, numéros de binding, code source généré, objets GPU               | Oui                 |

---

## 4. Répartition dans les packages

Je propose un nouveau package **`@fdw/engine-shader`**, en pur TypeScript et sans aucune dépendance GPU. Il contient le système de types, le modèle de graphe, la bibliothèque de nœuds standard, le compilateur et l'IR.

```
@fdw/engine-shader     types de shader, graphe, nœuds standard, compilateur, IR
        ▲
        │
@fdw/engine-backend    interfaces : ShaderCodegen, GpuPipelineFactory,
        ▲              GpuBindGroup*, GpuCommandEncoder, layout physique
        │
   ┌────┴─────────────┬──────────────────┐
@fdw/engine-core   @fdw/engine-webgpu   @fdw/engine-webgl2 …
Material, Renderer  WgslCodegen,         GlslEsCodegen,
(API utilisateur)   pipelines WebGPU     pipelines WebGL2
```

Pourquoi un package séparé :

- le compilateur est volumineux et se teste entièrement sans GPU ;
- il peut tourner hors du runtime : dans un outil en ligne de commande pour précompiler les shaders, dans un éditeur, ou dans un worker ;
- engine-core et les backends en dépendent tous les deux, sans créer de dépendance entre eux.

Ce que chaque package expose :

| Package          | Contenu                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine-shader`  | `ShaderType`, `MaterialGraph`, `GraphBuilder`, `NodeDefinition`, la bibliothèque `std`, `compile()`, `ShaderModuleIR`, `ProgramLayout`                                                       |
| `engine-backend` | `ShaderCodegen`, `PhysicalLayoutStrategy`, `GpuShaderProgram`, `GpuRenderPipeline`, `GpuBindGroupLayout`, `GpuBindGroup`, `GpuCommandEncoder`, `GpuRenderPassEncoder`, `BackendCapabilities` |
| `engine-core`    | `Material`, `RenderState`, `Renderer`, `RenderItem` (et à terme Scene, Mesh)                                                                                                                 |
| `engine-webgpu`  | `WgslCodegen`, `WebGpuPipelineFactory`, `WebGpuCommandEncoder`…                                                                                                                              |

---

## 5. Système de types

### 5.1 Types logiques

Le système de types décrit **ce que manipule le shader**, pas sa représentation en mémoire. Il est distinct de `GpuType`, qui existe déjà dans engine-backend et qui décrit la disposition en mémoire propre à chaque backend (§7.7).

```ts
export type ScalarKind = 'f32' | 'f16' | 'i32' | 'u32' | 'bool';

export type TextureDimension =
  | '1d'
  | '2d'
  | '2d-array'
  | '3d'
  | 'cube'
  | 'cube-array';
export type TextureSampleType =
  | 'float'
  | 'unfilterable-float'
  | 'depth'
  | 'sint'
  | 'uint';

export type ShaderType =
  | { kind: 'scalar'; scalar: ScalarKind }
  | { kind: 'vector'; size: 2 | 3 | 4; scalar: ScalarKind }
  | {
      kind: 'matrix';
      columns: 2 | 3 | 4;
      rows: 2 | 3 | 4;
      scalar: 'f32' | 'f16';
    }
  | { kind: 'array'; element: ShaderType; length?: number } // length absente = taille à l'exécution (storage)
  | {
      kind: 'struct';
      name: string;
      fields: readonly { name: string; type: ShaderType }[];
    }
  | {
      kind: 'texture';
      dimension: TextureDimension;
      sampleType: TextureSampleType;
      multisampled?: boolean;
    }
  | { kind: 'sampler'; comparison: boolean };
```

Des raccourcis rendent la construction lisible :

```ts
export const BuiltinTypes = {
  f32: scalar('f32'),
  i32: scalar('i32'),
  u32: scalar('u32'),
  bool: scalar('bool'),
  vec2f: vec(2, 'f32'),
  vec3f: vec(3, 'f32'),
  vec4f: vec(4, 'f32'),
  vec2i: vec(2, 'i32'),
  vec4u: vec(4, 'u32'),
  mat3f: mat(3, 3),
  mat4f: mat(4, 4),
  texture2d: texture('2d', 'float'),
  textureCube: texture('cube', 'float'),
  depthTexture2d: texture('2d', 'depth'),
  sampler: sampler(false),
  comparisonSampler: sampler(true),
} as const;
```

### 5.2 Types génériques et contraintes

Beaucoup de fonctions sont génériques : `add`, `mix` ou `normalize` acceptent plusieurs types. Les signatures utilisent des **variables de type** avec des contraintes :

```ts
export type TypeConstraint =
  | 'any'
  | 'numeric' // scalaires et vecteurs, sauf bool
  | 'float' // f32 ou f16, scalaires et vecteurs
  | 'float-vector'
  | 'integer';

export type PortType =
  | ShaderType
  | { kind: 'generic'; name: string; constraint: TypeConstraint } // T
  | { kind: 'element-of'; of: string } // scalaire de T
  | { kind: 'vector-of'; of: string; size: 2 | 3 | 4 }; // vecN du scalaire de T
```

Exemples de signatures :

```
add<T: numeric>(a: T, b: T) -> T
mix<T: float>(a: T, b: T, t: T | element-of<T>) -> T
dot<T: float-vector>(a: T, b: T) -> element-of<T>
textureSample(t: texture2d, s: sampler, uv: vec2f) -> vec4f
```

### 5.3 Règles de conversion

Je recommande une politique **stricte** :

- **Implicite** : uniquement la diffusion d'un scalaire vers un vecteur (`f32 → vec3f` en répétant la valeur), parce qu'elle est universelle et sans ambiguïté.
- **Explicite** : toutes les autres conversions passent par des nœuds dédiés (`convert`, `construct`, `swizzle`).

Une conversion implicite large (`vec4 → vec3` par troncature, `i32 → f32`) est pratique dans un éditeur, mais elle masque des erreurs et se comporte différemment selon les langages. Un éditeur visuel pourra insérer automatiquement les nœuds de conversion, en les montrant à l'utilisateur.

Les arêtes peuvent porter un **swizzle** (`.xyz`, `.rg`, `.x`), ce qui évite de multiplier les nœuds `split` et `extract`.

---

## 6. Le graphe

### 6.1 Modèle de données

Le graphe est une donnée pure, sérialisable telle quelle :

```ts
export type NodeId = string;

export interface GraphNode {
  readonly id: NodeId;
  readonly type: string; // id de NodeDefinition : 'std.mul', 'input.uniform'…
  readonly params: Readonly<Record<string, StaticValue>>; // paramètres de compilation
  readonly defaults?: Readonly<Record<string, ConstantValue>>; // valeurs des ports non connectés
  readonly label?: string; // utilisé pour nommer les variables générées
}

export interface PortRef {
  readonly node: NodeId;
  readonly port: string;
}

export interface GraphEdge {
  readonly from: PortRef; // sortie
  readonly to: PortRef; // entrée
  readonly swizzle?: string; // 'xyz', 'x', 'rg'…
}

export interface MaterialGraphData {
  readonly format: 'fdw-material-graph';
  readonly version: 1;
  readonly name: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly parameters?: readonly GraphParameterDeclaration[]; // paramètres statiques exposés (features)
}
```

Règles structurelles :

- une **entrée** reçoit au plus une arête ; une **sortie** peut alimenter plusieurs entrées ;
- une entrée non connectée prend sa valeur par défaut (`defaults`, sinon la valeur par défaut du port), comme dans Blender ;
- le graphe doit être **acyclique** : c'est vérifié par un tri topologique à la validation.

### 6.2 Définitions de nœuds

Chaque type de nœud est décrit par une `NodeDefinition`, enregistrée dans un `NodeRegistry`. La bibliothèque standard en fournit un ensemble, et l'utilisateur peut en ajouter.

```ts
export type NodeCategory =
  | 'input'
  | 'constant'
  | 'function'
  | 'macro'
  | 'output';

export interface PortSchema {
  readonly name: string;
  readonly type: PortType;
  readonly default?: ConstantValue; // pour les entrées
  readonly optional?: boolean;
}

export interface NodeDefinition<P extends StaticParams = StaticParams> {
  readonly id: string; // 'std.mul'
  readonly category: NodeCategory;
  readonly params?: ParamSchema<P>; // paramètres de compilation (statiques)
  inputs(params: P): readonly PortSchema[]; // les ports peuvent dépendre des paramètres
  outputs(params: P): readonly PortSchema[];
  readonly stage?: 'vertex' | 'fragment'; // restriction de stage, si elle existe
}
```

Les ports dépendent des paramètres, ce qui permet par exemple à un nœud `input.uniform` d'avoir une sortie dont le type est fixé par le paramètre `type`.

### 6.3 Les catégories de nœuds

#### Entrées (`input.*`)

| Nœud              | Paramètres                                                                                            | Sortie               | Correspondance                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| `input.attribute` | `semantic` (`position`, `normal`, `uv`, `color`, `tangent`, `joints`, `weights` ou nom libre), `type` | valeur de l'attribut | `MeshAttributeSemantic` d'engine-backend                              |
| `input.uniform`   | `name`, `type`, `slot` (`frame`, `material`, `object`)                                                | valeur               | un membre du bloc uniform du slot                                     |
| `input.storage`   | `name`, `type` (struct ou tableau), `slot`, `access` (`read`, `read-write`)                           | référence au buffer  | un storage buffer                                                     |
| `input.texture`   | `name`, `dimension`, `sampleType`, `slot`                                                             | texture              | une texture                                                           |
| `input.sampler`   | `name`, `comparison`, `slot`                                                                          | sampler              | un sampler                                                            |
| `input.builtin`   | `builtin` (`vertex-index`, `instance-index`, `frag-coord`, `front-facing`)                            | valeur               | les builtins de chaque langage                                        |
| `input.engine`    | `value` (`camera.viewProjection`, `camera.position`, `object.world`, `object.normalMatrix`, `time`…)  | valeur               | les uniforms fournis par le moteur dans les slots `frame` et `object` |

`input.engine` est important : l'utilisateur ne déclare jamais lui-même les matrices de caméra ou de transform. Le moteur fournit un **contrat fixe pour les slots `frame` et `object`**, partagé par tous les matériaux, ce qui permet de réutiliser les mêmes bind groups pour tous les draws (§11.2).

#### Constantes (`const.*`)

| Nœud                   | Exemple                               |
| ---------------------- | ------------------------------------- |
| `const.value`          | `{ type: vec3f, value: [1, 0.5, 0] }` |
| `const.pi`, `const.e`… | constantes nommées                    |

Les constantes participent au **constant folding** (§7.5). Un `const.value` modifié change le code généré, donc la clé du programme. Si une valeur doit varier sans recompilation, il faut un `input.uniform`.

#### Fonctions (`fn.*`, `std.*`)

Un nœud fonction a une signature (ports typés, éventuellement génériques) et une **implémentation** parmi trois formes :

```ts
export type FunctionImplementation =
  // correspond à une opération de l'IR que chaque générateur sait traduire
  | { kind: 'intrinsic'; op: IntrinsicOp }
  // défini par un sous-graphe ; émis comme une vraie fonction du langage cible
  | { kind: 'graph'; graph: MaterialGraphData }
  // code natif fourni par langage ; échappatoire pour ce que le graphe ne sait pas exprimer
  | { kind: 'native'; sources: Partial<Record<ShaderLanguage, string>> };
```

- **Intrinsèques** : arithmétique, `dot`, `cross`, `normalize`, `mix`, `clamp`, `pow`, `textureSample`, `select`… Ce sont des opérations de l'IR, traduites directement par chaque générateur.
- **Sous-graphes** : une fonction définie par un graphe, réutilisable (par exemple `fresnelSchlick`). Elle est émise comme une fonction du langage cible, ce qui garde le code lisible et compact quand elle est appelée plusieurs fois.
- **Code natif** : pour les cas limites. Le compilateur refuse la compilation pour un backend dont le langage n'a pas d'implémentation, avec une erreur claire. Il vaut mieux limiter son usage, puisqu'il casse la portabilité.

#### Macros (`macro.*`)

Une macro est **évaluée à la compilation** : elle reçoit ses paramètres statiques et ses entrées, et elle **génère des nœuds** qui la remplacent dans le graphe. Après l'expansion, il ne reste aucune macro.

```ts
export interface MacroDefinition<P extends StaticParams = StaticParams>
  extends NodeDefinition<P> {
  readonly category: 'macro';
  expand(context: MacroContext<P>): Readonly<Record<string, PortRef>>; // sorties → ports générés
}

export interface MacroContext<P> {
  readonly params: P; // paramètres statiques résolus
  readonly inputs: Readonly<Record<string, PortRef | undefined>>;
  readonly builder: GraphBuilder; // pour créer les nœuds de remplacement
  readonly capabilities: BackendCapabilities; // permet d'adapter l'expansion au backend
  readonly features: Readonly<Record<string, StaticValue>>;
}
```

La différence entre fonction et macro :

|                                     | Fonction                                 | Macro                                                                |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Moment                              | Exécution (GPU)                          | Compilation (CPU)                                                    |
| Résultat                            | Un appel de fonction dans le code généré | Des nœuds insérés à la place du nœud                                 |
| Peut changer la structure du graphe | Non                                      | Oui                                                                  |
| Usage typique                       | Calcul réutilisable                      | Variantes, déroulage de boucles, adaptation aux capacités du backend |

Exemples de macros de la bibliothèque standard :

- `macro.staticSwitch` : choisit une entrée parmi deux selon un paramètre statique (`normalMap: true | false`). Seule la branche choisie est compilée.
- `macro.repeat` : déroule N fois un sous-graphe (par exemple un flou à N échantillons).
- `macro.normalMapping` : branche le calcul TBN si `tangent` est disponible dans le mesh, sinon utilise une approximation par dérivées.
- `macro.vertexColorOrDefault` : utilise l'attribut `color` si le mesh l'a, sinon du blanc.

### 6.4 Les sorties et les modèles d'éclairage

L'utilisateur ne branche pas directement des `@location` de fragment. Il remplit un **nœud de surface**, et un **modèle d'éclairage** transforme cette surface en couleur finale.

```
       ┌──────────────────────────┐
       │ output.surface           │
       │  baseColor   : vec3f     │
       │  alpha       : f32       │
       │  normal      : vec3f     │  (espace monde ; par défaut la normale interpolée)
       │  emissive    : vec3f     │
       │  specular    : vec3f     │  ← propres au modèle Phong
       │  shininess   : f32       │
       │  roughness   : f32       │  ← propres au modèle PBR
       │  metallic    : f32       │
       │  positionOffset : vec3f  │  (stage vertex : déplacement du sommet)
       └──────────────────────────┘
          param : shadingModel = 'unlit' | 'phong' | 'pbr'
```

Le modèle d'éclairage est lui-même une **macro** de la bibliothèque standard (`lighting.phong`, `lighting.pbr`, `lighting.unlit`). Le compilateur l'insère derrière `output.surface`. Il lit les lumières dans le slot `frame` et produit la couleur finale. Le Phong des templates Eta actuels devient ainsi `lighting.phong`.

La partie vertex standard (objet → monde → clip, transformation des normales, passage des varyings) est produite par le compilateur à partir d'un **squelette de stage**. Le graphe de l'utilisateur ne touche que ce qui le concerne (surface, déplacement des sommets).

Pour les cas avancés (post-processing, plein écran, debug), des sorties brutes `output.vertex` (`clipPosition` plus des varyings libres) et `output.fragment` (`color[0..n]`, `depth`) permettent un contrôle complet, sans squelette.

### 6.5 Paramètres statiques et variantes

Un paramètre statique est une valeur connue à la compilation. Il peut venir de trois sources :

| Source      | Exemple                                      | Qui le fixe                                 |
| ----------- | -------------------------------------------- | ------------------------------------------- |
| Le matériau | `normalMap: true`, `alphaMode: 'mask'`       | l'utilisateur, à la création du `Material`  |
| Le mesh     | `hasAttribute.color`, `hasAttribute.tangent` | dérivé automatiquement de `MeshDescription` |
| Le contexte | `skinning`, `instancing`, `shadowPass`       | le renderer                                 |

L'ensemble des paramètres statiques effectivement **lus** pendant la compilation forme la **clé de variante**. Le compilateur enregistre quels paramètres ont été consultés, ce qui évite de créer des variantes inutiles : si aucun nœud ne lit `hasAttribute.color`, deux meshs qui diffèrent seulement par la couleur de vertex partagent le même programme.

### 6.6 Les boucles

Un DAG n'a pas de boucles, et c'est voulu : le code généré reste linéaire, ce qui simplifie fortement les générateurs et évite les pièges de l'analyse d'uniformité de WGSL (§16). Il y a deux mécanismes pour les besoins réels :

- **déroulage à la compilation** (`macro.repeat`) quand le nombre d'itérations est statique ;
- **constructions dédiées dans l'IR** pour les rares boucles dynamiques nécessaires, au premier rang desquelles la boucle sur les lumières (`lightLoop`) dont le nombre est fixé à l'exécution. Ces constructions sont fournies par le moteur, pas exprimées par l'utilisateur dans le graphe.

**Implémentation de la boucle sur les lumières.** Le graphe reste un DAG. La boucle s'exprime avec deux nœuds fournis par le moteur (`stdLights`) :

- `light.current` : « la lumière en cours », avec ses sorties `position` (w = 0 pour une lumière directionnelle), `ambient`, `diffuse`, `specular`, `attenuation`, `spotDirection` et `spotCone` ;
- `light.sum(value)` : la somme de `value` sur les lumières de la frame.

Les nœuds qui dépendent de `light.current`, par un chemin qui ne traverse pas de `light.sum`, forment le **corps de la boucle**. Les autres nœuds dont dépend la somme (normale, direction de vue, couleurs du matériau…) sont calculés **une seule fois, avant la boucle**. Le compilateur refuse une valeur par lumière qui atteindrait une sortie sans passer par un `light.sum`. `light.current` est de fréquence fragment : la boucle n'existe que dans le fragment shader.

Dans l'IR, la boucle est l'instruction `loop-sum` : la somme, pour un index de 0 à `count - 1`, de la valeur calculée par son corps. C'est le seul flot de contrôle de l'IR, et il est structuré : le corps est lui-même du code linéaire, qui lit les valeurs définies avant la boucle, et ses propres valeurs ne sont pas visibles après. Les générateurs le traduisent par une variable accumulateur et une boucle `for`. Le nombre de lumières vient d'un uniform : la boucle est en flot de contrôle uniforme, et `textureSample` reste permis dans son corps.

Les lumières sont des tableaux de `vec4` du bloc `frame` (`lightPositions`, `lightAmbients`…, `MaxLights` = 16 éléments), plus `lightCount`. Des tableaux de `vec4` plutôt qu'un tableau de structures : leur layout est identique en WGSL et en std140 (pas de 16 octets), et le système de types n'a pas besoin de structures. Les spots ont leur cône (cosinus des angles intérieur et extérieur) ; les autres lumières ont un cône qui couvre toutes les directions.

### 6.7 L'API de construction

Une API fluide et typée en TypeScript, qui produit un `MaterialGraphData` :

```ts
const g = new GraphBuilder('textured-phong');

const uv = g.attribute('uv', BuiltinTypes.vec2f);
const diffuse = g.texture('diffuseMap', { dimension: '2d', slot: 'material' });
const smp = g.sampler('diffuseSampler', { slot: 'material' });
const tint = g.uniform('tint', BuiltinTypes.vec4f, {
  slot: 'material',
  default: [1, 1, 1, 1],
});

const texel = g.call(std.textureSample, { texture: diffuse, sampler: smp, uv });
const color = g.call(std.mul, { a: texel, b: tint });

g.surface({
  shadingModel: 'phong',
  baseColor: color.swizzle('rgb'),
  alpha: color.swizzle('a'),
  shininess: g.constant(BuiltinTypes.f32, 32),
});

const graph: MaterialGraphData = g.build(); // valide la structure et les types connus
```

Les erreurs de type sont détectées dès `g.call()` quand les types sont connus, sinon à `build()`. Les messages indiquent le nœud et le port fautifs (« `std.mul` #7 : le port `b` attend `vec4f`, reçu `vec3f` »).

---

## 7. Le compilateur

### 7.1 Entrée et sortie

```ts
export interface CompileOptions {
  readonly registry: NodeRegistry;
  readonly features: Readonly<Record<string, StaticValue>>; // paramètres statiques résolus
  readonly vertexAttributes: readonly MeshAttributeSemantic[]; // ce que le mesh fournit
  readonly capabilities: BackendCapabilities; // limites et fonctionnalités du backend
}

export interface CompiledProgram {
  readonly programKey: string; // hash structurel + variante
  readonly variantKey: Readonly<Record<string, StaticValue>>; // paramètres effectivement lus
  readonly module: ShaderModuleIR;
  readonly layout: ProgramLayout;
  readonly vertexInputs: readonly VertexInputRequirement[];
  readonly diagnostics: readonly Diagnostic[];
}

export function compile(
  graph: MaterialGraphData,
  options: CompileOptions
): CompiledProgram;
```

Le compilateur est une **fonction pure** : les mêmes entrées donnent toujours la même sortie. C'est ce qui rend le cache fiable et les tests par snapshot possibles.

### 7.2 Les passes

```
 1. Validation structurelle   ports existants, une seule arête par entrée, acyclicité
 2. Expansion des macros      jusqu'à point fixe ; enregistre les paramètres lus
 3. Insertion du squelette    modèle d'éclairage, partie vertex standard
 4. Inférence de types        unification des génériques, vérification des contraintes
 5. Optimisations             élimination du code mort, constant folding, CSE
 6. Analyse de fréquence      constante / uniform / vertex / fragment → découpage en stages
 7. Allocation des ressources regroupement par slot, ordre de binding déterministe
 8. Génération de l'IR        entry points vertex et fragment, varyings, fonctions
```

### 7.3 Validation et expansion des macros

- **Acyclicité** : tri topologique (algorithme de Kahn). En cas de cycle, l'erreur liste les nœuds impliqués.
- **Expansion** : les macros sont développées dans l'ordre topologique. Une macro peut produire d'autres macros, d'où l'itération jusqu'à un point fixe, avec une profondeur maximale pour éviter les expansions infinies.
- L'expansion **trace les paramètres statiques consultés**, pour construire la clé de variante (§6.5).

### 7.4 Inférence de types

Pour chaque nœud générique, le compilateur **unifie** les variables de type à partir des types des arêtes entrantes, comme une résolution de génériques :

1. il parcourt le graphe dans l'ordre topologique ;
2. pour chaque nœud, il lie chaque variable de type (`T`) au type de la première entrée connectée qui la porte ;
3. il vérifie que les autres entrées sont compatibles, éventuellement par diffusion scalaire → vecteur ;
4. il vérifie la contrainte (`numeric`, `float`…) ;
5. il calcule les types de sortie (`element-of<T>`, etc.).

Le résultat est un graphe où **chaque port a un type concret**.

### 7.5 Optimisations

Elles sont peu nombreuses et simples, parce que les compilateurs des drivers optimisent de toute façon. Leur but est surtout de **stabiliser la clé du programme** et de **garder le code lisible** :

- **Élimination du code mort** : un parcours en arrière depuis les sorties ; tout ce qui n'y contribue pas est supprimé, y compris les ressources inutilisées. Un uniform non utilisé ne doit pas apparaître dans le layout.
- **Constant folding** : `mul(const 2, const 3)` devient `const 6`.
- **Élimination des sous-expressions communes (CSE)** par hash-consing : deux nœuds de même type, mêmes paramètres et mêmes entrées sont fusionnés.

### 7.6 Analyse de fréquence et découpage en stages

Chaque valeur reçoit une **fréquence** de calcul, ordonnée ainsi :

```
constant  <  uniform (par draw)  <  vertex (par sommet)  <  fragment (par pixel)
```

Règles :

- la fréquence d'un nœud est le **maximum** des fréquences de ses entrées ;
- `input.attribute` est à la fréquence `vertex` ;
- les nœuds qui ne sont valides qu'en fragment (dérivées, `textureSample` avec LOD implicite, `frag-coord`, `front-facing`) forcent la fréquence `fragment` ;
- les nœuds qui alimentent des sorties de stage vertex (`positionOffset`) doivent être au plus à la fréquence `vertex`, sinon c'est une erreur.

Le découpage :

- une valeur de fréquence `vertex` utilisée par un nœud `fragment` traverse la frontière : le compilateur crée un **varying**, avec une interpolation `flat` pour les entiers ;
- par défaut, le calcul est placé **au plus tôt** (en vertex quand c'est possible), ce qui réduit le travail par pixel. Un nœud `std.perFragment` force le calcul par pixel quand l'interpolation linéaire serait fausse, par exemple pour normaliser une normale après interpolation ;
- le nombre de varyings est vérifié par rapport aux limites du backend (`capabilities.maxVaryings`).

Plus tard, les valeurs de fréquence `uniform` pourront être calculées **sur le CPU** et envoyées comme uniforms, une optimisation classique des moteurs.

### 7.7 Allocation des ressources

Le compilateur collecte les nœuds `input.uniform`, `input.storage`, `input.texture` et `input.sampler` qui ont survécu à l'élimination du code mort, puis :

1. il les **regroupe par slot**, dans l'ordre donné par `getMaterialBindingSlotOrder()` (qui existe déjà dans engine-backend) : `frame` = groupe 0, `material` = groupe 1, `object` = groupe 2, puis les slots personnalisés ;
2. dans chaque slot, il **rassemble tous les uniforms dans un seul bloc** (`MaterialUniforms`), trié par nom pour être stable, puis place les storage buffers, textures et samplers, aussi triés par nom ;
3. il produit un `ProgramLayout` **logique** : les noms, les types et l'ordre, mais aucun offset.

```ts
export interface ProgramLayout {
  readonly groups: readonly {
    readonly slot: MaterialBindingSlot;
    readonly bindings: readonly LogicalBinding[];
  }[];
}

export type LogicalBinding =
  | {
      kind: 'uniform-block';
      name: string;
      members: readonly { name: string; type: ShaderType }[];
    }
  | {
      kind: 'storage';
      name: string;
      type: ShaderType;
      access: 'read' | 'read-write';
    }
  | {
      kind: 'texture';
      name: string;
      type: Extract<ShaderType, { kind: 'texture' }>;
    }
  | { kind: 'sampler'; name: string; comparison: boolean };
```

Les **offsets en mémoire** sont calculés ensuite par le backend, parce que les règles diffèrent d'un langage à l'autre (WGSL uniform, std140, packing des cbuffers HLSL, Metal). C'est le rôle de `PhysicalLayoutStrategy`, qui réutilise directement les `StructBuildStrategy` et `PrimitiveApi` existants :

```ts
// engine-backend
export interface PhysicalLayoutStrategy {
  // ShaderType logique → GpuType avec taille et alignement réels
  typeOf(
    type: ShaderType,
    addressSpace: 'uniform' | 'storage'
  ): GpuType<unknown> | GpuStruct<unknown>;
  // ProgramLayout logique → numéros de binding concrets, offsets, tailles de buffers
  resolve(layout: ProgramLayout): PhysicalProgramLayout;
}
```

---

## 8. La représentation intermédiaire (IR)

### 8.1 Forme

L'IR est une liste d'**instructions typées en forme SSA** (chaque valeur est définie une seule fois). Comme le graphe n'a pas de flot de contrôle, chaque entry point est une **séquence linéaire** d'instructions.

```ts
export type ValueId = number;

export interface IrInstruction {
  readonly id: ValueId;
  readonly type: ShaderType;
  readonly op: IrOp;
  readonly args: readonly ValueId[];
  readonly name?: string; // dérivé du label du nœud, pour la lisibilité
  readonly sourceNode?: NodeId; // pour le débogage (commentaires, source maps)
}

export type IrOp =
  | { kind: 'constant'; value: ConstantValue }
  | { kind: 'load-input'; input: string } // attribut ou varying
  | { kind: 'load-builtin'; builtin: Builtin }
  | { kind: 'load-resource'; binding: string; member?: string }
  | {
      kind: 'binary';
      operator: '+' | '-' | '*' | '/' | '%' | '==' | '<' | '&&' /* … */;
    }
  | { kind: 'unary'; operator: '-' | '!' }
  | { kind: 'intrinsic'; name: IntrinsicOp } // dot, normalize, mix, clamp…
  | {
      kind: 'sample';
      variant: 'implicit-lod' | 'level' | 'bias' | 'grad' | 'compare';
    }
  | { kind: 'construct' } // vec3f(a, b, c), struct
  | { kind: 'swizzle'; components: string }
  | { kind: 'convert'; to: ShaderType }
  | { kind: 'select' } // select(cond, a, b), sans branche
  | { kind: 'call'; function: string } // fonction définie par un sous-graphe
  | { kind: 'native'; function: string } // fonction en code natif
  | { kind: 'light-loop'; body: string }; // construction dédiée (§6.6)

export interface IrEntryPoint {
  readonly stage: 'vertex' | 'fragment';
  readonly inputs: readonly IrStageVariable[]; // attributs (vertex) ou varyings (fragment)
  readonly outputs: readonly IrStageVariable[]; // varyings (vertex) ou cibles de couleur (fragment)
  readonly body: readonly IrInstruction[];
  readonly results: Readonly<Record<string, ValueId>>; // sortie → valeur
}

export interface ShaderModuleIR {
  readonly structs: readonly Extract<ShaderType, { kind: 'struct' }>[];
  readonly functions: readonly IrFunction[];
  readonly entryPoints: readonly IrEntryPoint[];
}
```

### 8.2 Pourquoi une IR plutôt que générer directement depuis le graphe

- Les générateurs de code n'ont pas à connaître les macros, les génériques, les fréquences ni les modèles d'éclairage : ils traduisent des instructions déjà typées et ordonnées.
- L'IR est **sérialisable** : on peut la mettre en cache, l'envoyer à un worker, ou la précompiler dans un outil de build.
- Elle donne une frontière nette pour les tests : les tests du compilateur portent sur l'IR, ceux des générateurs sur le code émis à partir d'une IR fixe.

---

## 9. Génération de code par backend

### 9.1 L'interface

```ts
// engine-backend
export type ShaderLanguage =
  | 'wgsl'
  | 'glsl-es-300'
  | 'glsl-450'
  | 'msl'
  | 'hlsl'
  | 'spirv';

export interface ShaderCodegen {
  readonly language: ShaderLanguage;
  emit(module: ShaderModuleIR, layout: PhysicalProgramLayout): ShaderSources;
}

export type ShaderSources =
  | {
      kind: 'text';
      vertex: string;
      fragment: string;
      entryPoints?: { vertex: string; fragment: string };
    }
  | {
      kind: 'text-single-module';
      code: string;
      entryPoints: { vertex: string; fragment: string };
    } // WGSL, MSL, HLSL
  | { kind: 'binary'; vertex: Uint32Array; fragment: Uint32Array }; // SPIR-V
```

Un générateur est essentiellement un `switch` sur `IrOp` qui produit une ligne par instruction (`let v12: vec3<f32> = normalize(v11);`), plus la déclaration des ressources et des entry points. Sans flot de contrôle, un générateur complet tient en quelques centaines de lignes.

### 9.2 Les différences à absorber

| Aspect                                | WGSL (WebGPU)           | GLSL ES 3.0 (WebGL2)                                                 | GLSL 450 (Vulkan)                                                                                                                                     | MSL (Metal)                                         | HLSL (D3D12)                                   |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Binding des ressources                | `@group(g) @binding(b)` | blocs uniform + unités de texture, pas de groupes                    | `layout(set = g, binding = b)`                                                                                                                        | `[[buffer(n)]]`, `[[texture(n)]]`, `[[sampler(n)]]` | `register(bN, spaceG)`                         |
| Texture et sampler                    | séparés                 | **combinés** (`sampler2D`)                                           | séparés ou combinés                                                                                                                                   | séparés                                             | séparés                                        |
| Storage buffers                       | §5.1                    | `input.storage` existe, la compilation renvoie « not supported yet » | Chantier 4 (§17) : WebGPU, erreur explicite sur WebGL2. **Ensuite** : repli WebGL2 par texture de données (RGBA32F lue par `texelFetch`) ; structures |
| Entry points                          | plusieurs par module    | un programme = deux sources                                          | une source par stage                                                                                                                                  | plusieurs par module                                | plusieurs par module                           |
| Profondeur du clip space              | [0, 1]                  | **[-1, 1]**                                                          | [0, 1]                                                                                                                                                | [0, 1]                                              | [0, 1]                                         |
| Axe Y du NDC                          | vers le haut            | vers le haut                                                         | **vers le bas**                                                                                                                                       | vers le haut                                        | vers le haut                                   |
| Origine des textures / du framebuffer | haut gauche             | **bas gauche**                                                       | haut gauche                                                                                                                                           | haut gauche                                         | haut gauche                                    |
| Matrices                              | colonnes                | colonnes                                                             | colonnes                                                                                                                                              | colonnes                                            | **lignes par défaut** (émettre `column_major`) |
| Précision                             | —                       | **qualificateurs obligatoires**                                      | —                                                                                                                                                     | `half`                                              | `min16float`                                   |

Comment le compilateur et les générateurs les absorbent :

- **Groupes de binding** : les générateurs pour WebGL2 et Metal **aplatissent** les groupes en indices linéaires (blocs uniform numérotés, unités de texture) dans `PhysicalLayoutStrategy.resolve()`. Le reste du moteur continue à raisonner en slots.
- **Textures et samplers combinés** : l'IR les garde séparés. Le générateur GLSL ES crée un `sampler2D` par paire (texture, sampler) **effectivement utilisée** ensemble, et le layout physique indique au runtime quelle paire lier à quelle unité de texture.
- **Storage buffers sur WebGL2** : c'est une capacité absente. `BackendCapabilities.storageBuffers = false` permet aux macros de prévoir une alternative (données dans une texture), sinon la compilation échoue avec un message clair.
- **Conventions de clip space** : le backend expose sa convention (`capabilities.clipSpace = { depth: '0..1' | '-1..1', yUp: boolean }`) et `CameraMath` applique une **matrice de correction** à la projection. Le graphe et le code généré n'ont pas à s'en soucier. Ça règle aussi un point ouvert de l'audit (§3.1).
- **Origine des textures** : en WebGL, on retourne l'image au moment de l'upload pour les textures chargées, et on corrige les UV dans le générateur pour les render targets.
- **Matrices HLSL** : le générateur émet `column_major` (ou `#pragma pack_matrix(column_major)`), pour garder une seule convention dans tout le moteur.

### 9.3 Stratégie de génération : émetteurs directs ou cross-compilation

| Option                                 | Principe                                                                                                                           | Avantages                                                                     | Inconvénients                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A. Émetteurs directs**               | un générateur par langage depuis l'IR                                                                                              | aucune dépendance, code lisible, contrôle total, s'exécute dans le navigateur | N générateurs à maintenir                                                      |
| **B. Un émetteur + cross-compilateur** | WGSL généré, puis converti par [naga](https://github.com/gfx-rs/wgpu/tree/trunk/naga) (WASM ou natif) en SPIR-V, MSL, HLSL ou GLSL | un seul générateur, conversions éprouvées                                     | dépendance lourde, code produit moins lisible, coût du WASM dans le navigateur |
| **C. SPIR-V directement**              | générer du binaire SPIR-V, puis SPIRV-Cross pour les autres langages                                                               | standard de l'industrie                                                       | génération binaire complexe, débogage difficile                                |

**Recommandation : l'option A**, au moins pour WGSL et GLSL ES, les deux cibles web, où il faut compiler à l'exécution et rester léger. L'absence de flot de contrôle dans l'IR rend chaque générateur petit. Pour les backends natifs, les deux voies restent ouvertes : des générateurs directs MSL et HLSL (tout aussi simples), ou naga dans la chaîne native si l'on préfère s'appuyer sur un outil éprouvé. L'architecture ne change pas, car `ShaderCodegen` est l'unique point d'extension.

---

## 10. Le pipeline de rendu

### 10.1 Description abstraite

L'API abstraite des pipelines est **calquée sur le modèle WebGPU**. C'est le choix de wgpu et Dawn : ce modèle correspond presque directement à Vulkan, Metal et D3D12, et WebGL peut l'émuler avec un cache d'état.

```ts
// engine-backend
export interface RenderPipelineDescriptor {
  readonly label?: string;
  readonly program: CompiledProgram;
  readonly layout: PhysicalProgramLayout;
  readonly vertex: MeshDescription; // existe déjà dans engine-backend
  readonly primitive: {
    readonly topology:
      | 'triangle-list'
      | 'triangle-strip'
      | 'line-list'
      | 'point-list';
    readonly cullMode: 'none' | 'front' | 'back';
    readonly frontFace: 'ccw' | 'cw';
  };
  readonly depthStencil?: {
    readonly format: GpuTextureFormat;
    readonly depthWrite: boolean;
    readonly depthCompare: CompareFunction;
  };
  readonly targets: readonly {
    readonly format: GpuTextureFormat;
    readonly blend?: BlendState;
  }[];
  readonly sampleCount: number;
}

export interface GpuPipelineFactory {
  readonly codegen: ShaderCodegen;
  readonly layoutStrategy: PhysicalLayoutStrategy;
  readonly capabilities: BackendCapabilities;
  createRenderPipeline(descriptor: RenderPipelineDescriptor): GpuRenderPipeline;
  createRenderPipelineAsync(
    descriptor: RenderPipelineDescriptor
  ): Promise<GpuRenderPipeline>;
  createBindGroupLayout(group: PhysicalBindGroupLayout): GpuBindGroupLayout;
  createBindGroup(
    layout: GpuBindGroupLayout,
    entries: readonly GpuBindGroupEntry[]
  ): GpuBindGroup;
}
```

Correspondance avec chaque backend :

| Abstraction          | WebGPU               | Vulkan                  | Metal                                             | D3D12                       | WebGL2                      |
| -------------------- | -------------------- | ----------------------- | ------------------------------------------------- | --------------------------- | --------------------------- |
| `GpuRenderPipeline`  | `GPURenderPipeline`  | `VkPipeline`            | `MTLRenderPipelineState` + `MTLDepthStencilState` | PSO                         | programme + état mémorisé   |
| `GpuBindGroupLayout` | `GPUBindGroupLayout` | `VkDescriptorSetLayout` | (argument buffer)                                 | partie de la root signature | table de correspondance     |
| `GpuBindGroup`       | `GPUBindGroup`       | `VkDescriptorSet`       | argument buffer ou liaisons directes              | descriptor table            | liaisons appliquées au draw |

### 10.2 Correspondance entre le mesh et le programme

Le compilateur produit les `VertexInputRequirement` (sémantique, type attendu). Le mesh fournit une `MeshDescription`. La factory les fait correspondre :

1. pour chaque attribut requis, elle cherche l'attribut du mesh **de même sémantique** ;
2. elle vérifie la compatibilité du format avec le type attendu (`unorm8x4` → `vec4f` : oui ; `float32x2` → `vec3f` : non) ;
3. elle attribue les `location` dans un ordre déterministe ;
4. si un attribut requis manque, c'est une erreur. En pratique, ça n'arrive pas, parce que les attributs disponibles sont passés au compilateur comme paramètres statiques (`hasAttribute.*`) et que les macros prévoient une valeur par défaut.

### 10.3 Clés et caches

```
programKey  = hash( structure du graphe après expansion, variantKey, language )
layoutKey   = hash( vertex layout de la MeshDescription )
stateKey    = hash( RenderState du matériau : blend, cull, depth )
passKey     = hash( formats des cibles, format de profondeur, sampleCount )

pipelineKey = programKey + layoutKey + stateKey + passKey
```

Deux caches, chacun avec une politique LRU :

- **`ProgramCache`** : `programKey` → `CompiledProgram` et module de shader compilé. La compilation du graphe est faite **une fois par variante**, quel que soit le nombre de matériaux qui l'utilisent.
- **`PipelineCache`** : `pipelineKey` → `GpuRenderPipeline`.

Points importants :

- la clé ne contient **jamais les valeurs** des uniforms ni l'identité des textures : changer une couleur ou une texture ne recompile rien ;
- la compilation est **asynchrone** (`createRenderPipelineAsync` en WebGPU, cache de pipelines sur Vulkan). Pendant la compilation, le renderer peut ignorer l'objet ou utiliser un matériau de repli, pour éviter les saccades ;
- l'ordre déterministe des bindings fait que **tous les programmes partagent les mêmes layouts pour les slots `frame` et `object`** : ces bind groups sont créés une seule fois.

### 10.4 Enregistrement des commandes

Une abstraction minimale, également calquée sur WebGPU :

```ts
// engine-backend
export interface GpuCommandEncoder {
  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder;
  finish(): GpuCommandBuffer;
}

export interface GpuRenderPassEncoder {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(
    index: number,
    group: GpuBindGroup,
    dynamicOffsets?: readonly number[]
  ): void;
  setVertexBuffer(slot: number, buffer: GpuBuffer, offset?: number): void;
  setIndexBuffer(buffer: GpuBuffer, format: IndexFormat, offset?: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number
  ): void;
  end(): void;
}

export interface GpuQueue {
  submit(commands: readonly GpuCommandBuffer[]): void;
}
```

Le `RenderPassDescriptor` reçoit ses attachments de la `Surface`, ce qui suppose que `Surface` expose `acquireFrame()` et `present()` (manque relevé dans l'audit, §3.4).

---

## 11. Le runtime : matériaux, bind groups et rendu

### 11.1 Le matériau

Dans engine-core, un `Material` associe un graphe, des paramètres statiques, un render state et des valeurs d'entrée :

```ts
// engine-core
export interface RenderState {
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly doubleSided: boolean;
  readonly depthWrite?: boolean;
}

export class Material {
  constructor(options: {
    graph: MaterialGraphData;
    features?: Readonly<Record<string, StaticValue>>; // normalMap: true…
    renderState?: Partial<RenderState>;
    values?: Readonly<Record<string, MaterialValue>>; // tint: [1, 0.5, 0.5, 1], diffuseMap: texture…
  });

  setValue(name: string, value: MaterialValue): this; // incrémente la version, ne recompile pas
  setFeature(name: string, value: StaticValue): this; // change la variante : nouveau programme
  readonly version: number; // valeurs
  readonly structureVersion: number; // graphe, features, render state
}
```

Ce découpage reprend le principe de la classe `Material` actuelle : un **`shapeKey`** (devenu `programKey` et `stateKey`) qui ne change qu'avec la structure, et des valeurs versionnées qui se mettent à jour sans recompilation.

Côté backend, un **`MaterialBinding`** (un par couple matériau et programme) possède :

- le **buffer uniform du slot `material`**, écrit avec le `GpuStruct` produit par `PhysicalLayoutStrategy`. Il est réécrit seulement quand `material.version` change, grâce à `CachedValue` ;
- le **bind group du groupe 1**, recréé seulement quand une texture ou un sampler change.

### 11.2 Fréquences de mise à jour

| Groupe | Slot       | Contenu                                                             | Mis à jour                 | Lié                             |
| ------ | ---------- | ------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| 0      | `frame`    | caméra (view, projection, position), lumières, temps                | une fois par frame         | une fois par passe              |
| 1      | `material` | uniforms, textures et samplers du matériau                          | quand les valeurs changent | à chaque changement de matériau |
| 2      | `object`   | matrice monde, normal matrix (déjà fournies par `TransformAdapter`) | quand le transform change  | à chaque objet                  |

Plus tard, on pourra regrouper les données `object` de tous les objets dans **un seul grand buffer avec des offsets dynamiques** : un seul bind group au lieu d'un par objet. L'interface `setBindGroup(index, group, dynamicOffsets)` le permet déjà.

### 11.3 Le renderer

```ts
// engine-core
export interface RenderItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly transform: Transform;
}

export interface Renderer {
  render(
    items: Iterable<RenderItem>,
    camera: Camera,
    lights: readonly Light[],
    surface: Surface
  ): void;
}
```

Le déroulement d'une frame :

1. mettre à jour le buffer `frame` (caméra, lumières) ;
2. pour chaque `RenderItem`, résoudre le programme et le pipeline (en cache), puis mettre à jour les buffers `material` et `object` s'ils ont changé de version ;
3. **trier** les éléments : opaques par `pipelineKey` puis par matériau, pour limiter les changements d'état ; transparents du plus loin au plus proche ;
4. enregistrer la passe : groupe 0 une fois, `setPipeline` et le groupe 1 quand ils changent, le groupe 2 et le draw pour chaque objet ;
5. soumettre, puis présenter la surface.

Pour l'utilisateur, tout se réduit à :

```ts
const material = new Material({
  graph,
  values: { tint: [1, 0.8, 0.8, 1], diffuseMap: texture },
});
renderer.render([{ mesh, material, transform }], camera, lights, surface);
```

---

## 12. Exemple de bout en bout

### 12.1 Le graphe

Le graphe `textured-phong` de §6.7, avec un tint uniform, une texture diffuse et un modèle Phong.

### 12.2 Après compilation

**Fréquences** : `uv` est à la fréquence vertex et `textureSample` (LOD implicite) force le fragment. `uv` devient donc un varying. `tint` est à la fréquence uniform et `shininess` est constant (32, après folding).

**`ProgramLayout` logique** :

```
group frame    : uniform-block FrameUniforms { viewProjection: mat4f, cameraPosition: vec3f, lights… }
group material : uniform-block MaterialUniforms { tint: vec4f }
                 texture diffuseMap: texture_2d<float>
                 sampler diffuseSampler
group object   : uniform-block ObjectUniforms { world: mat4f, normalMatrix: mat3f }
vertex inputs  : position: vec3f, normal: vec3f, uv: vec2f
```

### 12.3 Code généré en WGSL (extrait)

```wgsl
// Generated from material graph "textured-phong" — variant: {}
struct MaterialUniforms {
  tint: vec4<f32>,
};
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var diffuseMap: texture_2d<f32>;
@group(1) @binding(2) var diffuseSampler: sampler;

@fragment
fn fs_main(in: Varyings) -> @location(0) vec4<f32> {
  let texel: vec4<f32> = textureSample(diffuseMap, diffuseSampler, in.uv); // node #4 std.textureSample
  let color: vec4<f32> = texel * material.tint;                            // node #5 std.mul
  let surface = Surface(color.rgb, color.a, normalize(in.normal), 32.0);
  return vec4<f32>(lightingPhong(surface, in.worldPosition), surface.alpha);
}
```

### 12.4 Le même programme en GLSL ES 3.0 (extrait)

```glsl
#version 300 es
precision highp float;
// Generated from material graph "textured-phong" — variant: {}
layout(std140) uniform MaterialUniforms { vec4 tint; } material;   // bloc uniform n° 1
uniform sampler2D diffuseMap_diffuseSampler;                       // paire texture+sampler → unité 0

in vec2 v_uv; in vec3 v_normal; in vec3 v_worldPosition;
out vec4 fragColor;

void main() {
  vec4 texel = texture(diffuseMap_diffuseSampler, v_uv);           // node #4 std.textureSample
  vec4 color = texel * material.tint;                              // node #5 std.mul
  Surface surface = Surface(color.rgb, color.a, normalize(v_normal), 32.0);
  fragColor = vec4(lightingPhong(surface, v_worldPosition), surface.alpha);
}
```

Le graphe, l'IR et le layout logique sont identiques. Seuls le générateur et le layout physique diffèrent : groupes aplatis, texture et sampler combinés, qualificateur de précision.

---

## 13. Intégration avec l'existant

| Élément existant                                                                               | Devenir                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `MaterialBindingSlot`, `getMaterialBindingSlotOrder()` (engine-backend)                        | **Réutilisés** : ils définissent les groupes et leur ordre                                             |
| `MeshDescription`, `MeshAttributeSemantic` (engine-backend)                                    | **Réutilisés** : sémantiques des nœuds `input.attribute` et correspondance des vertex layouts          |
| `GpuType`, `GpuStruct`, `StructBuildStrategy`, `PrimitiveApi` (engine-backend / engine-webgpu) | **Réutilisés** par `PhysicalLayoutStrategy` pour calculer les offsets                                  |
| `CachedValue`, `SnapshotValue` (engine-backend)                                                | **Réutilisés** pour les mises à jour versionnées des buffers et les caches                             |
| `CameraAdapter`, `TransformAdapter`                                                            | **Réutilisés** pour les slots `frame` et `object`                                                      |
| Concept de `shapeKey` de l'ancien `Material`                                                   | **Repris** sous la forme `programKey` / `stateKey`                                                     |
| `ShaderWritter` et les templates Eta                                                           | **Remplacés** par `WgslCodegen`. Le Phong des templates devient la macro `lighting.phong`              |
| `GpuSerializer.serialize(): string` (engine-backend)                                           | **Supprimé** de l'API abstraite : la génération de code passe aux générateurs (point de l'audit, §3.1) |
| `apps/demo/src/utils3d` (Scene, Material, RenderPipeline, Mesh)                                | **Remplacés** par `Material`, `Renderer` et les pipelines du moteur                                    |

---

## 14. Plan d'implémentation

Chaque phase a un livrable vérifiable. L'ordre est choisi pour valider l'abstraction le plus tôt possible avec un deuxième backend (phase 5).

| Phase                               | Contenu                                                                                                                                                                                                                                   | Critère de fin                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **1. Types et graphe**              | Package `engine-shader` : `ShaderType`, `PortType`, `MaterialGraphData`, `GraphBuilder`, `NodeRegistry`, validation (acyclicité, ports), format JSON                                                                                      | Tests unitaires de validation et d'aller-retour JSON                                                                            |
| **2. Compilateur et WGSL**          | Inférence de types, élimination du code mort, folding, CSE, analyse de fréquence, allocation des ressources, IR, `WgslCodegen`. Bibliothèque `std` minimale (arithmétique, vecteurs, `textureSample`), `output.surface`, `lighting.unlit` | Tests par snapshot du WGSL, validation du WGSL par naga en CI, une route de la démo en unlit texturé                            |
| **3. Pipelines et renderer WebGPU** | `RenderPipelineDescriptor`, `GpuPipelineFactory`, command encoder, `ProgramCache`, `PipelineCache`, `Material`, `Renderer`                                                                                                                | La route `loading-model` réécrite avec `Material` et `Renderer`, sans aucun appel direct à WebGPU                               |
| **4. Macros et variantes**          | `macro.staticSwitch`, `macro.repeat`, `lighting.phong`, `normalMapping`, attributs optionnels, clé de variante, compilation asynchrone                                                                                                    | Le Phong actuel reproduit à l'identique ; deux meshs avec et sans couleur de vertex partagent ou non le programme selon l'usage |
| **5. WebGL2**                       | `GlslEsCodegen`, aplatissement des groupes, combinaison texture+sampler, capacités, backend `engine-webgl2`                                                                                                                               | Les mêmes routes de démo rendues en WebGL2 avec les mêmes graphes                                                               |
| **6. Natif**                        | WebGPU natif sur Dawn (fenêtre native), puis Vulkan avec HLSL (`HlslCodegen` → SPIR-V par DXC), Metal (MSL) et DirectX 12 (le même `HlslCodegen` → DXIL). Abstraction du fenêtrage, conventions de clip space. Détails au §14.1           | Une scène de la démo rendue dans une fenêtre native, d'abord avec WebGPU (Dawn), puis avec Vulkan                               |
| **7. Outils** (facultatif)          | Précompilation hors ligne, cache persistant, éditeur visuel                                                                                                                                                                               | —                                                                                                                               |

La phase 5 est la plus importante pour la vision du projet : c'est le premier test réel de l'abstraction. WebGL2 diffère de WebGPU sur presque tous les points du §9.2. S'il passe sans changer le graphe ni l'IR, l'architecture tiendra pour les backends natifs.

---

### 14.1 Précisions sur la phase 6

**WebGPU natif, sur Dawn, en premier.** Dawn est l'implémentation de WebGPU de Chrome ; elle s'utilise hors du navigateur (le package `webgpu` de Node, déjà employé par les tests de rendu) et cible Vulkan, Metal et Direct3D 12. Le backend `engine-webgpu` est réutilisé presque entièrement (WGSL, pipelines, layouts) : `WebGpuEngine` accepte déjà son point d'entrée par l'option `gpu`. Ce qui manque est une **surface de fenêtre native** (SDL, ou la fenêtre du runtime) et un runtime hors navigateur (Node avec des bindings Dawn et SDL, ou Deno qui expose WebGPU et des surfaces de fenêtre). C'est le moyen le moins coûteux de sortir `Surface` du navigateur et de valider l'abstraction du fenêtrage, avant d'écrire un backend Vulkan.

**Vulkan avec HLSL.** Plutôt que GLSL 450, le backend Vulkan utilise **HLSL**, compilé en SPIR-V par **DXC** (`dxc -spirv`) :

- un seul générateur, `HlslCodegen`, sert Vulkan (HLSL → SPIR-V) et DirectX 12 (HLSL → DXIL) ;
- HLSL est le langage de DXR, et DXC compile aussi les shaders de ray tracing vers SPIR-V (`SPV_KHR_ray_tracing`) : un seul langage pour la voie ray tracing du [évolutions §2](evolutions.md), sur Vulkan comme sur Direct3D 12 ;
- les bindings Vulkan s'expriment par les attributs `[[vk::binding(b, set)]]`, ceux de Direct3D 12 par `register(tN, spaceM)` : le `PhysicalLayoutStrategy` de chaque backend choisit ;
- les matrices sont émises en `column_major` (`#pragma pack_matrix(column_major)`), pour garder une seule convention dans le moteur ;
- l'axe Y du clip space de Vulkan pointe vers le bas : correction par un viewport de hauteur négative (`VK_KHR_maintenance1`, standard depuis Vulkan 1.1) plutôt que dans les shaders ;
- DXC est une dépendance : binaire natif, ou build WebAssembly pour compiler dans le runtime JavaScript. Les programmes peuvent aussi être précompilés (phase 7).

`Glsl450Codegen` n'est donc plus nécessaire ; il reste possible si un besoin apparaît (OpenGL 4.5 par exemple).

**Question ouverte** : le langage de l'hôte natif. Le moteur est en TypeScript ; un backend Vulkan demande des bindings Vulkan pour le runtime JavaScript (à écrire ou à choisir), ou un hôte natif (C++, Rust) piloté par le moteur. À trancher au début de la phase 6, après le backend WebGPU natif.

---

## 15. Stratégie de test

| Niveau           | Quoi                                                                                              | Outils                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Types            | Unification des génériques, contraintes, diffusion scalaire                                       | Vitest                                                                                             |
| Graphe           | Validation, détection de cycles, aller-retour JSON, messages d'erreur                             | Vitest                                                                                             |
| Compilateur      | Élimination du code mort, folding, CSE, fréquences, varyings, ordre des bindings, clé de variante | Vitest, snapshots de l'IR                                                                          |
| Générateurs      | Code émis pour une IR fixe                                                                        | Snapshots par langage                                                                              |
| Validité du code | Le code généré compile réellement                                                                 | naga ou tint (WGSL), `glslangValidator` (GLSL), `dxc` (HLSL), `xcrun metal` (MSL, sur macOS) en CI |
| Layout physique  | Offsets et tailles conformes aux règles WGSL, std140, HLSL                                        | Vitest, comparés aux valeurs de référence (et à la réflexion de naga)                              |
| Rendu            | Images de référence                                                                               | Chrome headless avec WebGPU, comparaison d'images (plus tard)                                      |

Le compilateur étant une fonction pure sans GPU, la grande majorité des tests tourne dans Node, en quelques secondes.

---

## 16. Risques et questions ouvertes

| Sujet                       | Risque                                                                                | Proposition                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Explosion des variantes** | Chaque paramètre statique double potentiellement le nombre de programmes              | Ne compter que les paramètres effectivement lus (§6.5), compilation asynchrone, cache, et une limite configurable avec avertissement |
| **Uniformité en WGSL**      | WGSL interdit `textureSample` (et les dérivées) dans un flot de contrôle non uniforme | Le DAG n'a pas de branches : les conditions deviennent des `select()`. Dans `lightLoop`, utiliser `textureSampleLevel`               |
| **Limites de WebGL2**       | Pas de storage buffers, blocs uniform limités (16 Ko garantis), peu de varyings       | `BackendCapabilities` consultées à la compilation, macros avec repli, erreurs explicites                                             |
| **Packing des uniforms**    | Règles différentes entre WGSL, std140, HLSL et Metal                                  | Centralisées dans `PhysicalLayoutStrategy`, testées contre des valeurs de référence                                                  |
| **Débogage**                | Le code généré est difficile à relier au graphe                                       | Noms dérivés des labels, commentaires `// node #id type`, et plus tard des source maps nœud ↔ ligne                                  |
| **Code natif**              | Les nœuds `native` cassent la portabilité                                             | Les limiter, et refuser la compilation si un langage cible manque                                                                    |
| **Temps de compilation**    | Saccades à la première apparition d'un matériau                                       | Compilation asynchrone, matériau de repli, préchauffage des variantes connues                                                        |
| **Coercions implicites**    | Pratiques mais sources d'erreurs                                                      | Politique stricte (§5.3), avec insertion assistée par l'éditeur                                                                      |

Questions à trancher, avec les réponses provisoires retenues :

1. **Où placer la frontière entre le moteur et l'utilisateur pour la partie vertex ?** Ma proposition : un squelette fourni par le moteur, avec `positionOffset` pour le déplacement, et `output.vertex` pour le contrôle complet. C'est ce qui est implémenté.
   _Réponse provisoire :_ un **système de graphes pour décrire les meshs** est à étudier. Le but est que les meshs soient, eux aussi, indépendants de la technologie sous-jacente. Le moteur doit se prêter aussi bien aux workflows de type chargement de scène → rendu qu'aux workflows de modélisation ou de génération procédurale.
2. **Les modèles d'éclairage** : faut-il les exposer comme macros remplaçables par l'utilisateur (shading models personnalisés), ou les garder internes au moteur dans un premier temps ?
   _Réponse provisoire :_ les modèles d'éclairage deviennent des **nœuds** (Phong, PBR metallic/roughness, specular/glossiness…). Le moteur fournit les modèles les plus courants, et l'utilisateur peut écrire son propre modèle avec le graphe.
3. **`f16`** : à prendre en charge dès le départ, ou plus tard ? Il est optionnel en WebGPU (`shader-f16`), absent de WebGL2 (sauf précision `mediump`) et natif sur Metal et D3D12.
   _Réponse provisoire :_ `f16` est pris en charge **de bout en bout autant que possible**, dès que la technologie sous-jacente le permet (capacités du backend, avec un repli explicite sinon).
4. **Compute et render graph** : le même compilateur pourrait produire des compute shaders (une sortie `output.compute`), et un render graph pourrait orchestrer plusieurs passes (ombres, post-processing). Ce sont deux extensions naturelles, à concevoir après la phase 5.
   _Réponse provisoire :_ le **render graph** et le **compute graph** sont les prochaines étapes, une fois le material graph terminé et jugé satisfaisant.

---

## 17. Chantiers avant la phase 6

Avant la phase 6 (backends natifs), le material graph est complété, pour pouvoir être jugé satisfaisant et passer ensuite au render graph et au compute graph (§16, question 4). Quatre chantiers, dans cet ordre (validé) : chacun sert le suivant.

| Chantier                                | Contenu                                                                            | Prérequis de                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1. `alphaMode: 'mask'`                  | Surfaces découpées par un seuil d'alpha                                            | —                                                                   |
| 2. Fonctions `subgraph`                 | Une fonction écrite comme un graphe, utilisée comme un nœud                        | Modèles d'éclairage personnalisés                                   |
| 3. Modèles d'éclairage comme nœuds, PBR | Modèles fournis par le moteur ou écrits par l'utilisateur ; PBR metallic/roughness | —                                                                   |
| 4. Storage buffers                      | Grands tableaux de données lus par les shaders                                     | Compute graph, lumières illimitées ([évolutions §1](evolutions.md)) |

Démarche commune à chaque chantier : design dans ce document (avec validation quand il y a une décision à prendre), compilateur et tests unitaires, générateurs WGSL et GLSL, runtime, tests de rendu sur les deux backends (référence CPU pour l'éclairage), démo et documentation, point d'étape avant le chantier suivant.

### 17.1 `alphaMode: 'mask'`

_Fait._ Le `Renderer` passe `alphaMode` comme feature ; `output.fragment` a une entrée optionnelle `discard` (aussi utilisable par les graphes bruts). Les comparaisons (`std.less`, `std.greater`…, composante par composante, type de résultat `bool-of<T>`) ont été ajoutées pour exprimer la condition ; l'IR les représente par l'opération `compare`.

- **Render state** : `alphaMode: 'mask'` ; les objets masqués sont triés avec les opaques et écrivent la profondeur.
- **Seuil** : `alphaCutoff`, uniform du matériau (0.5 par défaut) : le changer ne recompile rien.
- **Compilateur** : le `Renderer` passe `alphaMode` comme feature ; la lowering de `output.surface` la lit (une variante seulement pour les matériaux masqués) et produit la condition `alpha < alphaCutoff`.
- **IR** : la condition n'est pas une instruction mais une sortie du fragment, à côté de la couleur : `results.discard`, une valeur booléenne. Le corps reste du code pur, sans effet de bord ; les générateurs émettent le test juste avant de rendre la couleur (`if (c) { discard; }`), après tous les échantillonnages de textures. Voir §17.5.
- **Tests** : quad texturé avec un alpha en damier ; les pixels sous le seuil gardent la couleur de fond, sur les deux backends.

### 17.2 Fonctions `subgraph`

_Fait._ `defineFunction(graph, { id })` fait d'un graphe de fonction un type de nœud ; `GraphBuilder.functionInput()` / `functionOutput()` le construisent. L'inlining a lieu dans la boucle d'expansion des macros : une fonction peut contenir des macros, et une macro (un modèle d'éclairage) peut appeler une fonction. `build()` embarque les fonctions appelées dans la section `functions` du graphe, que `compile()` enregistre. Écart : les entrées ont des **types concrets**, pas encore de génériques ([écarts](material-graph-gaps.md)).

- **Interface** : nœuds `function.input` (nom, type, générique possible) et `function.output` dans le graphe de la fonction ; `FunctionImplementation { kind: 'graph' }` existe déjà.
- **Compilation par inlining** (décidé) : avant l'expansion des macros, chaque appel est remplacé par une copie du graphe de la fonction (ids préfixés, labels conservés pour le code généré). Les optimisations, la CSE, le découpage en stages et la boucle sur les lumières s'appliquent sans changement. Les appels récursifs sont refusés.
- **Sérialisation** : fonctions référencées par id dans le registre ; un graphe JSON peut embarquer les siennes dans une section `functions`.
- **Tests** : inlining, récursion refusée, types génériques, aller-retour JSON, rendu identique à celui du même graphe écrit à la main.
- **Ensuite** ([écarts](material-graph-gaps.md)) : de vraies fonctions dans le code généré, pour limiter la taille du code quand une fonction est appelée souvent.

### 17.3 Modèles d'éclairage comme nœuds, PBR

_Fait._ Les ports d'un nœud peuvent dépendre du registre (`PortContext`) : ceux de `output.surface` sont les entrées du nœud `lighting.<modèle>`, sauf `worldPosition`, plus `positionOffset`. Unlit, Phong et PBR sont des fonctions-graphes, construites au premier usage du registre standard ; un modèle personnalisé s'enregistre avec `defineShadingModel(name, graph)` et peut remplacer un modèle standard. Quand le modèle a une entrée `normal` non connectée, la lowering y branche la normale interpolée du mesh. Le PBR suit glTF (metallic/roughness, Cook-Torrance : GGX, Smith-Schlick, Fresnel de Schlick) ; la couleur diffuse d'une lumière est sa radiance, à un facteur π près pour qu'un diffus pur reçoive `baseColor × N·L` comme avec Phong.

- **Modèle d'éclairage** : une fonction-graphe (§17.2) qui reçoit les entrées de la surface et la position, et rend une couleur, avec `light.current` / `light.sum` pour les lumières. Unlit et Phong sont réécrits sous cette forme. Un modèle est enregistré sous un nom et choisi par `g.surface({ shadingModel })`. La séparation surface / éclairage est conservée ([évolutions §3](evolutions.md)).
- **PBR metallic/roughness** (celui de glTF) : Cook-Torrance (distribution GGX, géométrie de Smith, Fresnel de Schlick) ; entrées `baseColor`, `metallic`, `roughness`, `normal`, `emissive`, `occlusion` ; terme ambiant simple.
- **Éclairage par environnement (IBL)** : hors de ce chantier, **à implémenter ensuite** ([écarts](material-graph-gaps.md)).
- **Gestion des couleurs et tone mapping** : workflow linéaire et tone mapping dans les shaders (option B, §17.6).
- **Tests** : référence CPU du PBR comparée pixel par pixel sur les deux backends, pour plusieurs `roughness` et `metallic` ; modèle personnalisé enregistré par un test ; démo d'une grille de sphères `roughness` × `metallic`.

### 17.4 Storage buffers

- **Graphe** : `input.storage`, lu par `std.index(buffer, index)` ; longueur par `std.arrayLength`.
- **Types** : tableaux de taille dynamique de scalaires, vecteurs et matrices ; les structures viendront ensuite.
- **Layout** : ressource `storage-buffer` du `ProgramLayout` ; layout physique `std430` / WGSL `storage`.
- **IR** : `index` existe ; ajout de `array-length`.
- **WebGPU** : `var<storage, read>`, binding `read-only-storage`.
- **WebGL2** : capacité `storageBuffers: false`, la compilation échoue avec un message clair. **Repli par texture de données à faire ensuite** ([écarts](material-graph-gaps.md)).
- **Tests** : layout `std430`, génération WGSL, rendu d'une palette lue dans un storage buffer sur Dawn, erreur explicite sur WebGL2.

### 17.5 Le discard et ses implications

`discard` abandonne le fragment : ni couleur ni profondeur ne sont écrites. C'est le seul moyen de découper une surface sans transparence. Trois contraintes en découlent.

1. **L'IR reste pure.** Jusqu'ici, aucune instruction n'a d'effet de bord : l'élimination du code mort, la CSE et le placement dans les stages peuvent supprimer, fusionner ou déplacer n'importe quelle instruction. Un `discard` doit au contraire toujours être exécuté, et à un endroit précis. D'où le choix d'en faire une **sortie** du fragment (une condition, comme la couleur est une valeur) plutôt qu'une instruction : les passes existantes n'ont rien à savoir, et c'est le générateur qui place le test.
2. **Les dérivées et les mipmaps.** `textureSample` choisit le niveau de mipmap à partir des différences entre pixels voisins, calculées par groupes de 2 × 2 pixels. En GLSL ES, un fragment abandonné n'exécute plus rien, et les dérivées de ses voisins deviennent indéfinies ; WGSL l'interdit par son analyse d'uniformité (un `textureSample` ne doit pas dépendre d'un branchement non uniforme). Placer le test **après tous les échantillonnages**, juste avant d'écrire la couleur, évite le problème dans les deux langages.
3. **Les performances.** Un GPU teste normalement la profondeur avant d'exécuter le fragment shader (early depth test), et évite ainsi de calculer les pixels cachés. Un shader qui peut abandonner ses fragments désactive en partie cette optimisation sur beaucoup de GPU. C'est pourquoi le `discard` n'est émis que dans la variante des matériaux `mask` : les autres programmes n'en paient pas le coût.

Plus tard, avec le multi-échantillonnage : l'_alpha to coverage_ donne des bords plus doux que le seuil, sans `discard`.

### 17.6 Gestion des couleurs et tone mapping

_Fait (option B)._ Les textures de couleur utilisent un format `-srgb`, décodé par le GPU. Les features `toneMapping` (`none`, `reinhard`, `aces`, `neutral`) et `outputEncoding` (`srgb`) ajoutent, derrière le modèle d'éclairage, l'exposition (uniform `exposure` du bloc `frame`), le tone mapping et l'encodage ; le `Renderer` les fixe par son option `output` (par défaut : pas de tone mapping, encodage sRGB). L'encodage se fait dans le shader plutôt que par un format de cible `-srgb`, pour un comportement identique sur tous les backends et formats de surface : comme le tone mapping, il précède le mélange des transparents, ce que l'option C corrigera.

**Le problème.** Les écrans attendent des valeurs **encodées en sRGB** : une valeur de 0.5 dans l'image s'affiche avec environ 22 % de la luminosité maximale, pas 50 %. Les images (PNG, JPEG) sont stockées dans ce même encodage. Or les calculs d'éclairage (additionner des lumières, multiplier par N·L) ne sont justes que sur des valeurs **linéaires**, proportionnelles à l'énergie lumineuse.

Aujourd'hui, le moteur calcule directement sur les valeurs encodées et écrit le résultat sans conversion. Les deux erreurs se compensent en partie, ce qui « a l'air correct », mais :

- deux lumières de même intensité éclairent bien plus que le double d'une seule ;
- les dégradés d'éclairage sont trop durs, la zone d'ombre trop sombre ;
- le mélange des objets transparents et le filtrage des textures (mipmaps) assombrissent les couleurs ;
- un PBR, calibré sur des valeurs physiques, donne des matériaux faux (métaux et rugosité notamment), et l'IBL est impossible.

**Le workflow linéaire** :

1. **Décoder les entrées** : les textures de couleur sont créées en format `-srgb` (`rgba8unorm-srgb`), le GPU les décode gratuitement à la lecture, filtrage compris. Les textures de **données** (normal maps, rugosité, métal) restent linéaires : chaque texture déclare son espace (`colorSpace: 'srgb' | 'linear'`). Les couleurs des uniforms sont linéaires, comme dans glTF ; un helper convertit les couleurs choisies dans une interface (sélecteur, CSS), qui sont en sRGB.
2. **Calculer en linéaire** : rien à changer dans les graphes.
3. **Encoder la sortie** : vers une cible `-srgb` (encodage gratuit par le GPU) ou, si le format de la surface ne le permet pas (le framebuffer par défaut de WebGL2), par une conversion à la fin du shader.

**Le tone mapping.** En linéaire, l'éclairage dépasse souvent 1 : lumières fortes, reflets spéculaires, somme de plusieurs lumières. Écrêter à 1 brûle les zones claires et décale les teintes (un rouge saturé vire au jaune puis au blanc). Le tone mapping compresse la plage [0, ∞) vers [0, 1] de façon progressive, précédé d'une **exposition** (un multiplicateur, comme sur un appareil photo). Opérateurs courants :

| Opérateur           | Caractère                                                                |
| ------------------- | ------------------------------------------------------------------------ |
| Reinhard            | Simple ; désature les zones claires                                      |
| ACES (filmique)     | Contrasté, rendu « cinéma », standard du jeu vidéo                       |
| Khronos PBR Neutral | Récent ; conserve les couleurs des matériaux (visualisation de produits) |
| Aucun               | Écrêtage ; utile pour les tests et les rendus techniques                 |

Le tone mapping est une propriété de l'**image** (caméra, scène), pas du matériau : tous les objets d'une frame doivent utiliser le même. Il est donc choisi par le `Renderer` (option de rendu), et non par un nœud du graphe de chaque matériau.

**Où l'appliquer.** Idéalement dans une passe de post-traitement, après avoir rendu la scène dans une cible HDR (`rgba16float`) : c'est le rôle du render graph. Avant lui, il peut être appliqué à la fin du shader de chaque matériau ; c'est exact pour les objets opaques, légèrement faux pour les transparents (ils se mélangent après le tone mapping).

**Options** :

| Option                                                | Contenu                                                                                                                                                               | Conséquences                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A. Statu quo                                          | Calculs sur valeurs encodées                                                                                                                                          | Aucun travail ; PBR et IBL faux                                                                                                |
| B. Linéaire maintenant, tone mapping dans les shaders | Espaces des textures, encodage de la sortie ; opérateur et exposition choisis par le `Renderer` (feature pour l'opérateur, uniform du bloc `frame` pour l'exposition) | PBR juste ; les démos changent d'apparence ; le tone mapping passera dans une passe du render graph sans changer les matériaux |
| C. Cible HDR et passe de post-traitement              | Comme B, avec une vraie passe de tone mapping                                                                                                                         | Transparents exacts ; demande le render graph                                                                                  |

**Décision** : option **B** avec le chantier 3. L'option **C** (cible HDR et passe de tone mapping) est **à faire avec le render graph** ([écarts](material-graph-gaps.md)).

---

## 18. Bilan du material graph

_Au 08/10/2026, après les phases 1 à 5 et les chantiers 1 à 3 du §17._

### 18.1 Ce qui est livré

| Domaine               | Contenu                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graphe                | Types (scalaires, vecteurs, matrices, textures, samplers, tableaux pour le moteur), génériques et contraintes, `bool-of<T>`, swizzles, validation, `GraphBuilder` typé, format JSON avec fonctions embarquées                     |
| Bibliothèque standard | Arithmétique, vecteurs, interpolation, comparaisons, textures, transformations ; macros (`staticSwitch`, `optionalAttribute`, `repeat`, `normalMapping`) ; lumières (`light.current`, `light.sum`) ; couleur (sRGB, tone mapping) |
| Fonctions             | Fonctions-graphes inlinées, appels imbriqués, récursion refusée                                                                                                                                                                   |
| Modèles d'éclairage   | Unlit, Phong, PBR metallic/roughness (glTF), modèles personnalisés ou remplaçants                                                                                                                                                 |
| Compilateur           | Lowering de la surface (masque, sortie couleur), macros et inlining, élimination du code mort, folding, CSE, fréquences et stages, varyings, layout logique, IR SSA avec `loop-sum` et `discard`, `programKey` et `variantKey`    |
| Backends              | WebGPU (WGSL), WebGL2 (GLSL ES 3.00, std140) : mêmes graphes, même IR                                                                                                                                                             |
| Runtime               | `Material` (opaque, masqué, transparent), `Renderer` (caches de programmes et de pipelines, bind groups partagés, tri, transparents double face, pipelines asynchrones, 16 lumières, tone mapping et encodage sRGB)               |
| Tests                 | 274 tests, dont 39 tests de rendu au pixel sur Dawn et WebGL2 (Chromium headless), avec des références CPU pour Phong et le PBR                                                                                                   |

### 18.2 Ce qui n'est pas livré

- **Chantier 4, storage buffers** (§17.4). Les compute shaders en ont besoin : il devient la **première étape du compute graph**.
- Les [écarts restants](material-graph-gaps.md). Aucun ne bloque le render graph ; plusieurs seront résolus par lui : tone mapping et encodage dans une passe de post-traitement (option C du §17.6), transparence exacte, multi-échantillonnage.

### 18.3 Points faibles constatés

1. **Les labels des nœuds faisaient partie de la `programKey`** : deux graphes identiques à leurs labels près ne partageaient pas leur programme. _Corrigé_ : les labels ne nomment que les valeurs du code généré, ils sont exclus de la clé (`CompilerVersion` 3).
2. **Constantes répétées dans le code généré** : reporté à la v2, voir [material-graph-v2.md](material-graph-v2.md).
3. **Aucune mesure de performance** : reporté à la v2, voir [material-graph-v2.md](material-graph-v2.md).
4. **Démo** : quatre erreurs de typecheck antérieures à ce travail (`main.tsx`, `depth-testing`, `index-buffer`, `index.tsx`). _Corrigé._ Les routes « tutoriel » utilisent toujours WebGPU directement.
5. **Ce document** dépassait 1 300 lignes et mêlait la proposition, l'état réel et les évolutions. _Corrigé_ : les écarts sont dans [material-graph-gaps.md](material-graph-gaps.md), les améliorations de la v2 dans [material-graph-v2.md](material-graph-v2.md), les évolutions du moteur dans [evolutions.md](evolutions.md).

### 18.4 Verdict

Le material graph est **suffisant pour passer au render graph et au compute graph**. Ce dont ils ont besoin est en place : séparation entre surface et éclairage, sortie de couleur insérée par le compilateur (déplaçable dans une passe), variantes pilotées par le renderer, capacités des backends. Les storage buffers (chantier 4) seront faits avec le compute graph.
