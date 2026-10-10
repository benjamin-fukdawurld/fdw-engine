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

Les lumières sont passées à chaque frame : `render({ lights })`, ou
`addScenePasses(graph, { lights })`. Les 16 premières (`MaxLights`) sont
utilisées. Leurs valeurs vont dans les uniforms `frame`, écrits une fois par
frame et par vue.

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
  orthographique, couvrant une sphère : les limites des éléments, ou
  `shadow.bounds`. Sa position est alignée sur les texels de sa tuile, de
  sorte que les ombres ne scintillent pas lorsque la scène bouge. Des limites
  plus petites donnent des ombres plus nettes.
- Un **spot** voit son cône, avec une projection en perspective.

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
