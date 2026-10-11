---
title: Lumières et ombres
description: Les lumières d'une frame, comment les modèles d'éclairage les additionnent, et comment les shadow maps sont dessinées et lues.
sidebar:
  order: 4
---

## Lumières

| Lumière            | Propriétés                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `DirectionalLight` | `direction` ; `castShadow`, `shadow`                                                                                              |
| `PointLight`       | `position` ; `constantAttenuation` (1), `linearAttenuation` (0), `quadraticAttenuation` (0)                                       |
| `SpotLight`        | `position`, `direction`, l'atténuation, `innerCutoff` (0) et `outerCutoff` (17.5), demi-angles en degrés ; `castShadow`, `shadow` |

Toutes ont des couleurs `ambient`, `diffuse` et `specular`, linéaires, et
pouvant dépasser 1. Une lumière ponctuelle ou un spot est atténué par
`1 / (constant + linear × d + quadratic × d²)` ; un spot s'estompe de son
angle intérieur à son angle extérieur.

Les lumières sont passées à chaque frame — `render({ lights })`, ou
`addScenePasses(graph, { lights })` — ou viennent de la source (les lumières
attachées aux nœuds d'une scène). Leurs valeurs vont dans les uniforms
`frame`, écrits une fois par frame et par vue.

## Seulement ce que voit la caméra

Une lumière ne coûte rien lorsqu'elle ne peut changer aucun pixel de la vue :

- une lumière directionnelle éclaire toujours la vue ;
- une lumière ponctuelle ou un spot n'est utilisé que si sa **portée**
  atteint le frustum de la caméra. Sa portée est la distance où son
  atténuation tombe sous 1/256 de sa couleur la plus forte
  (`lightRange(light)`) ; une lumière sans atténuation atteint tout ;
- parmi les lumières restantes, 16 au plus (`MaxLights`) sont utilisées : les
  directionnelles, puis les autres selon la lumière qu'elles apportent à ce
  que voit la caméra.

`renderer.stats.get('scene')` donne, pour la dernière frame, le nombre de
lumières utilisées, de shadow maps et d'objets projetant des ombres dessinés.

## Comment les modèles les utilisent

Les modèles d'éclairage éclairés additionnent les lumières, par fragment :

- `phong` : termes ambiant, diffus (`N·L`) et spéculaire
  (`(V·R)^shininess`) ;
- `pbr` : Cook-Torrance avec GGX, Smith-Schlick et le Fresnel de Schlick,
  comme dans glTF, plus le terme ambiant.

Un modèle personnalisé les lit avec `light.current` et les additionne avec
`light.sum` : le compilateur transforme les nœuds situés entre les deux en
une boucle sur les lumières. Voir
[Un modèle d'éclairage personnalisé](/fdw-engine/fr/tutorials/custom-shading-model/).

## Ombres

Avec `castShadow: true`, une lumière directionnelle ou un spot projette des
ombres. Chaque frame, alors :

1. **Une passe d'ombres** (`scene shadows`) dessine les objets projetant des
   ombres dans un **atlas**, une texture de profondeur de `shadowAtlasSize`
   (2048) pixels, découpée en tuiles égales, une par lumière. Elle utilise la
   variante **profondeur seule** des matériaux : pas de couleur, uniquement
   la position, et le discard des matériaux masqués.
2. **Les passes de la scène** lisent l'atlas : les modèles `phong` et `pbr`
   multiplient la lumière directe de chaque lumière par sa visibilité,
   obtenue par comparaison avec sa shadow map, filtrée sur 3 × 3 texels
   (PCF).

Les caméras des lumières :

- Une **lumière directionnelle** voit la scène avec une projection
  orthographique, couvrant **ce que voit la caméra** (les limites des
  éléments visibles), ou `shadow.bounds`. Sa taille change par paliers, et sa
  position par texels entiers, de sorte que les ombres ne scintillent pas
  lorsque la caméra bouge.
- Un **spot** voit son cône, jusqu'à ce que voit la caméra, avec une
  projection en perspective.

Les deux s'étendent **vers la lumière** aussi loin que va la scène : un arbre
hors de la vue dont l'ombre tombe dans la vue la projette ; un objet dont
l'ombre tombe hors de la vue n'est pas dessiné dans la shadow map. Une
lumière n'a de shadow map que si elle est utilisée, et si quelque chose est
visible.

Ce qui projette des ombres :

- les éléments avec `castShadow: false` n'en projettent pas, ni les
  éléments transparents ;
- `addScenePasses(graph, { shadows: false })` désactive les ombres d'une
  vue ;
- les lumières ponctuelles ne projettent pas encore d'ombres.

### Shadow acne

Une surface comparée à sa propre profondeur s'ombre elle-même en bandes :
c'est le **shadow acne**. Trois décalages le combattent :

- la passe d'ombres applique un **biais de profondeur proportionnel à la
  pente** (_slope-scaled depth bias_) ;
- `shadow.normalBias` déplace les points le long de leur normale avant la
  comparaison, en texels de la shadow map (1 par défaut) ;
- `shadow.bias` abaisse leur profondeur, en profondeur normalisée (0 par
  défaut).

Un décalage trop grand détache les ombres des objets qui les projettent
(**peter panning**). Les valeurs par défaut conviennent à la plupart des
scènes.

### Dans un modèle personnalisé

`light.shadow`, en une `position` et une `normal`, donne la visibilité de la
lumière en cours d'addition : 1 éclairé, 0 dans l'ombre. Il lit l'atlas
lorsque la frame a des ombres (la feature `shadows`, définie par le
renderer), et vaut 1 sinon :

```ts
const visibility = f.call(stdLights.shadow, { position, normal });
```

## Coûts

Chaque lumière avec ombres dessine les objets projetant des ombres une fois
de plus. L'atlas est partagé, donc davantage de lumières donnent des tuiles
plus petites : 4 lumières dans un atlas de 2048 obtiennent chacune
1024 × 1024. Augmentez `shadowAtlasSize` pour des ombres plus nettes, au prix
de la mémoire.
