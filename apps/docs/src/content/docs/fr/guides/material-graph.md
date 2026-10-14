---
title: Material graph
description: Comment les matériaux sont décrits, typés, compilés et spécialisés.
sidebar:
  order: 1
---

Chaque matériau, effet de post-traitement et noyau de calcul du moteur est
un **graphe de nœuds typés**, construit avec le `GraphBuilder` de
`@fdw/engine-shader`. Le graphe est une donnée : il est sérialisé en JSON,
compilé en un programme indépendant du backend, puis traduit dans le langage
de chaque backend (WGSL, GLSL ES 3.00, HLSL).

## Construire un graphe

```ts
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';

const g = new GraphBuilder('textured');
const texel = g.call(std.textureSample, {
  texture: g.texture('map'),
  sampler: g.sampler('mapSampler'),
  uv: g.attribute('uv', BuiltinTypes.vec2f),
});
g.surface({
  shadingModel: 'pbr',
  baseColor: texel.swizzle('rgb'),
  roughness: 0.5,
});
const graph = g.build();
```

| Méthode                                           | Ajoute                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `g.call(node, inputs, options?)`                  | Un nœud à une seule sortie, renvoyée                                                                                       |
| `g.node(node, { inputs, params })`                | Un nœud à plusieurs sorties (ou aucune), renvoyées par nom                                                                 |
| `g.attribute(semantic, type)`                     | Un attribut de sommet du mesh                                                                                              |
| `g.uniform(name, type, { default, slot })`        | Une valeur du matériau                                                                                                     |
| `g.texture(name)`, `g.sampler(name)`              | Une texture (`dimension: 'cube'` pour un cube), un sampler du matériau (`comparison: true` pour les tests de profondeur)   |
| `g.storage(name, arrayType(element), { access })` | Un storage buffer (WebGPU, Vulkan)                                                                                         |
| `g.builtin(name)`                                 | `vertex-index`, `instance-index`, `frag-coord`, `front-facing`, `screen-uv`, `global-invocation-id`…                       |
| `g.engine(name)`                                  | `camera.view`, `camera.projection`, `camera.inverseViewProjection`, `camera.position`, `object.world`, `time`, `exposure`… |
| `g.constant(type, value)`                         | Une constante, intégrée au code                                                                                            |
| `g.parameter(name, default)`                      | Un paramètre statique, lu par les macros                                                                                   |
| `g.surface(inputs)`                               | La fin d'un matériau : une surface et son modèle d'éclairage                                                               |
| `g.fullscreen({ color })`                         | La fin d'une passe plein écran                                                                                             |
| `g.output(name, value)`                           | Une valeur du matériau pour les sorties de la scène déclarées `'material'` (voir le guide du render graph)                 |
| `g.target(name, value, location)`                 | Une cible de couleur de plus (1, 2…), avec `fullscreen` ou les étapes brutes : plusieurs cibles par passe                  |
| `g.compute({ workgroupSize })`, `g.write(…)`      | La fin d'un compute graph, et ses écritures                                                                                |

`build()` valide l'ensemble du graphe et renvoie un `MaterialGraphData` :
`serializeGraph()` et `parseGraph()` le convertissent en JSON et inversement.

## Types

Les types sont ceux des shaders : scalaires (`f32`, `i32`, `u32`, `bool`),
vecteurs, matrices, tableaux, textures et samplers (`BuiltinTypes.vec3f`,
`BuiltinTypes.mat4f`…). Chaque nœud est vérifié lorsqu'il est ajouté, et une
erreur nomme le nœud et le port :

```
error: #n3.b: std.mul: got vec4<f32>, incompatible with vec3<f32> connected to "a"
```

- La seule conversion implicite est la **diffusion d'un scalaire** (_splat_) :
  un `f32` se connecte à une entrée `vec3<f32>`. Les autres nécessitent un
  nœud : `std.convert`, `std.vec3`, `std.extend`, ou un swizzle.
- Les nœuds **génériques** prennent le type de leurs entrées : `std.mul` d'un
  `f32` et d'un `vec3` est un `vec3`.
- Les **swizzles** appartiennent aux connexions : `texel.swizzle('rgb')`.
- Les **ressources** sont identifiées par leur nom : deux nœuds utilisant
  `'map'` doivent déclarer la même texture.

## La bibliothèque standard

| Groupe       | Nœuds                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arithmétique | `add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`, `fract`, `sqrt`, `pow`, `sin`, `cos`, `saturate`, `clamp`, `mix`, `step`, `smoothstep`                                                                                 |
| Vecteurs     | `dot`, `length`, `normalize`, `cross`, `reflect`, `vec2`, `vec3`, `vec4`, `extend`, `convert`, `transform`, `transform3`                                                                                                         |
| Comparaisons | `less`, `lessEqual`, `greater`, `greaterEqual`, `equal`, `notEqual`, `select`                                                                                                                                                    |
| Textures     | `textureSample`, `textureSampleLevel`, `textureSampleCompare`, `textureSampleCube`, `textureSampleCubeLevel` ; `textureLoad`, `textureLoadDepth` : un texel par ses coordonnées entières, sans sampler (profondeurs, `r32float`) |
| Dérivées     | `dpdx`, `dpdy`, `fwidth` : le changement d'un pixel au suivant (stage fragment seulement, `y` vers le bas)                                                                                                                       |
| Tableaux     | `index`, `arrayLength` (storage buffers)                                                                                                                                                                                         |
| Étapes       | `perFragment` : ce qui en dépend est calculé par pixel                                                                                                                                                                           |
| Lumières     | `light.current`, `light.sum`, `light.shadow` (`stdLights`)                                                                                                                                                                       |
| Macros       | `staticSwitch`, `optionalAttribute`, `repeat`, `normalMapping`, `bumpMapping`, `parallaxMapping`, `parallaxOcclusionMapping`, `displacement` (`stdMacros`)                                                                       |

Ils se trouvent tous dans `std`, `stdLights` et `stdMacros` ;
`createStandardRegistry()` renvoie un registre de tous les types de nœuds
standard.

## Surfaces et modèles d'éclairage

`g.surface()` termine un matériau. Le compilateur la remplace par l'étape
de sommets standard (espace objet, monde, puis clip) et par le **modèle
d'éclairage**, dont les entrées sont celles de la surface :

| Modèle  | Entrées, en plus de `baseColor` et `alpha`                                   |
| ------- | ---------------------------------------------------------------------------- |
| `unlit` | —                                                                            |
| `phong` | `emissive`, `normal`, `specular`, `shininess`                                |
| `pbr`   | `emissive`, `normal`, `metallic`, `roughness`, `occlusion` (comme dans glTF) |

Chaque surface accepte aussi `positionOffset`, qui déplace les sommets dans
l'espace objet. Un modèle d'éclairage est un graphe de fonction : voir
[Un modèle d'éclairage personnalisé](/fdw-engine/fr/tutorials/custom-shading-model/).
Il peut aussi être appelé comme n'importe quelle fonction,
`g.call('lighting.pbr', inputs)` avec `worldPosition` : une passe plein écran
éclaire ainsi un G-buffer (voir
[Rendu différé](/fdw-engine/fr/tutorials/deferred-rendering/)), avec la
caméra et les lumières des dernières passes de scène.
`camera.positionFromDepth` (`uv`, `viewDepth`) donne la position dans le
monde d'un pixel à partir de sa profondeur.

## Les attributs calculés

`g.vertexAttribute(sémantique, valeur)` calcule un attribut de sommet au
lieu de le lire dans le mesh : toutes les lectures de l'attribut
(`g.attribute`, le vertex stage de la surface, les macros,
`hasAttribute.<sémantique>`) reçoivent la valeur, calculée dans le vertex
stage. Un sommet généré depuis son numéro (`g.builtin('vertex-index')`)
donne ainsi sa position, sa normale et ses uv, et le mesh n'a besoin
d'aucun vertex buffer (`Mesh.setVertexCount`). La valeur ne peut pas lire
l'attribut qu'elle remplace. C'est ce qu'utilisent les patchs de la
tessellation : voir [Tessellation](/fdw-engine/fr/tutorials/tessellation/).

```ts
g.vertexAttribute('position', position);
g.vertexAttribute('normal', normal);
g.surface({ baseColor }); // Placée et éclairée avec eux.
```

## Fonctions

Une fonction est un graphe doté de nœuds `functionInput` et `functionOutput`,
utilisé comme un nœud :

```ts
const f = new GraphBuilder('scale');
const value = f.functionInput('value', BuiltinTypes.vec3f);
const factor = f.functionInput('factor', BuiltinTypes.f32, { default: 2 });
f.functionOutput('result', f.call(std.mul, { a: value, b: factor }));
const scale = defineFunction(f.build(), { id: 'my.scale' });

g.surface({ baseColor: g.call(scale, { value: color }) });
```

Le compilateur l'insère en ligne : le programme est le même que si les nœuds
étaient écrits sur place. `build()` embarque les fonctions qu'un graphe
appelle, de sorte que son JSON se compile seul. La récursion est refusée.

## Macros et variantes

Une **macro** est un nœud évalué à la compilation, remplacé par les nœuds
qu'elle génère. Les macros lisent des **paramètres statiques** : les
`features` du matériau, puis les `parameter` déclarés par le graphe, puis ce
dont dispose le mesh (`hasAttribute.<semantic>`).

| Macro                            | Rôle                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `macro.staticSwitch`             | `ifTrue` ou `ifFalse`, selon une feature ; une seule branche est compilée     |
| `macro.optionalAttribute`        | Un attribut quand le mesh le possède, une valeur de repli sinon               |
| `macro.repeat`                   | Applique une fonction `count` fois                                            |
| `macro.normalMapping`            | La normale issue d'une normal map, avec les tangentes du mesh ou les dérivées |
| `macro.bumpMapping`              | La normale inclinée par les pentes d'une hauteur                              |
| `macro.parallaxMapping`          | Les uv décalés le long de la vue par une carte de hauteur                     |
| `macro.parallaxOcclusionMapping` | Les uv où la vue rencontre le relief, en `steps` lectures                     |
| `macro.displacement`             | Le décalage des sommets le long de leur normale, pour `positionOffset`        |

Voir [Détails de surface](/fdw-engine/fr/tutorials/surface-details/).

Chaque paramètre lu entre dans la **clé de variante** du programme : un mesh
avec couleurs et un mesh sans obtiennent deux programmes seulement si le
graphe lit les couleurs. Les paramètres que personne ne lit ne créent pas de
variantes.

## Compilation

`compile(graph, options)` renvoie un `CompiledProgram` : une représentation
intermédiaire (instructions SSA typées, une liste par étape), la disposition
de ses ressources, et une **clé de programme**. Le `Renderer` compile pour
vous ; appelez `compile` vous-même pour les compute graphs, les outils ou
les tests.

1. **Validation** du graphe, et de ce que le backend prend en charge
   (`capabilities`).
2. **Abaissement** (_lowering_) : `output.surface` devient l'étape de sommets
   et le modèle d'éclairage ; `output.fullscreen`, un triangle couvrant la
   cible.
3. **Optimisations** : code mort (ressources inutilisées comprises),
   propagation des constantes, sous-expressions communes.
4. **Étapes** : chaque valeur est constante, par draw, par sommet ou par
   fragment. Une valeur par sommet utilisée par l'étape de fragments est
   interpolée, et calculée le plus tôt possible ; `std.perFragment` maintient
   une valeur dans l'étape de fragments (éclairage, normalisation).
5. **Disposition** : `frame` (groupe 0, caméra, temps, lumières), `material`
   (groupe 1), `object` (groupe 2 : la table d'objets, voir
   [Backends](/fdw-engine/fr/guides/backends-and-surfaces/#données-des-objets-et-instanciation)),
   puis les slots personnalisés. `object.world` et `object.normalMatrix`
   lisent la ligne de l'objet dessiné ; une étape fragment qui les lit reçoit
   la ligne par un varying flat.
6. **Clé de programme** : un hachage du graphe optimisé, indépendant des
   identifiants des nœuds et des valeurs des uniforms. Les matériaux ayant le
   même graphe partagent leur programme.

Les backends résolvent ensuite la disposition (bindings, offsets) et
génèrent le code : `WgslCodegen`, `GlslEsCodegen`, `HlslCodegen`.

## Limites

- Au plus 16 lumières par frame.
- Pas encore d'éclairage basé sur l'image (IBL) : le terme ambiant est une
  couleur par lumière.
- Les storage buffers contiennent des tableaux de scalaires, de vecteurs ou
  de matrices (pas de structures), et ne sont pas disponibles en WebGL2.
- Les entrées des fonctions ont des types concrets (pas de génériques), et
  `textureSample` n'accepte que des textures 2D.
