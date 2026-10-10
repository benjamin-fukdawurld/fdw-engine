---
title: Couleurs et HDR
description: Couleurs linéaires, textures sRGB, la cible HDR, le tone mapping et l'encodage.
sidebar:
  order: 5
---

## Couleurs linéaires

Les matériaux calculent des couleurs **linéaires** : des valeurs
proportionnelles à la lumière, où additionner deux lumières additionne leurs
couleurs. L'éclairage, le blending et le filtrage ne sont corrects qu'en
valeurs linéaires. Les écrans et les images, en revanche, stockent des
couleurs **encodées** en sRGB, qui consacre davantage de précision aux tons
sombres.

Le moteur sépare les deux :

- Les **textures de couleur** utilisent un format `-srgb`
  (`rgba8unorm-srgb`) : le GPU les décode en valeurs linéaires lors de
  l'échantillonnage, avant le filtrage.
- Les **textures de données** — normal maps, rugosité, masques — utilisent
  un format linéaire (`rgba8unorm`) : leurs valeurs ne sont pas des couleurs.
- Les **couleurs passées aux matériaux** (uniforms, constantes) sont
  linéaires. Une couleur choisie en sRGB, comme `#ff8000`, est d'abord
  convertie : environ `((c / 255 + 0.055) / 1.055) ^ 2.4` par composante.
- **La sortie** est encodée une seule fois, à la fin.

## La sortie du renderer

```ts
const renderer = new Renderer(backend, {
  output: { toneMapping: 'aces', encoding: 'srgb' },
});
renderer.render({ items, camera, surface, exposure: 1.5 });
```

| Option        | Valeurs                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `toneMapping` | `none` (par défaut) : écrêté à 1 ; `reinhard` ; `aces` ; `neutral` : Khronos PBR Neutral, qui préserve les couleurs de base des matériaux |
| `encoding`    | `srgb` (par défaut), pour l'affichage ; `linear`, pour conserver les valeurs (tests, traitements ultérieurs)                              |
| `exposure`    | Par frame : multiplie les couleurs linéaires avant le tone mapping. 1 par défaut                                                          |

Le tone mapping compresse les valeurs linéaires non bornées dans la plage de
l'écran, au lieu d'écrêter les hautes lumières. Utilisez-le dès que les
lumières sont fortes, ou avec des matériaux PBR.

## La cible HDR

Lorsque le backend peut rendre dans du `rgba16float`, `render()` dessine en
deux étapes :

1. la scène, en valeurs linéaires, dans une texture `rgba16float`
   transitoire ;
2. une passe plein écran `tone mapping` : exposition, tone mapping et
   encodage, dans la surface.

Les matériaux transparents **se mélangent alors en valeurs linéaires**,
comme le fait la lumière. Sans la cible HDR, chaque matériau applique
lui-même la sortie, et les matériaux transparents mélangent des couleurs
encodées : un résultat légèrement trop sombre.

| Backend | Render target `rgba16float`               |
| ------- | ----------------------------------------- |
| WebGPU  | Oui                                       |
| Vulkan  | Oui                                       |
| WebGL2  | Avec l'extension `EXT_color_buffer_float` |

`backend.capabilities.renderableFormats` les liste ;
`new Renderer(backend, { hdr: false })` désactive la cible HDR.

Dans votre propre render graph, dessinez la scène avec `linear: true` dans
une texture `rgba16float`, et appliquez la sortie dans votre dernière passe
plein écran (voir [Post-traitement](/fdw-engine/fr/tutorials/post-processing/)).
Les opérateurs de tone mapping et d'encodage sont des graphes de fonction :
`color.toneMapReinhard`, `color.toneMapAces`, `color.toneMapNeutral`,
`color.linearToSrgb`.

## Multiéchantillonnage

`new Renderer(backend, { samples: 4 })` dessine la scène avec 4 échantillons
par pixel dans des attachments multiéchantillonnés, résolus dans la cible à
la fin des passes de la scène — dans la texture HDR lorsqu'il y en a une, de
sorte que le tone mapping s'applique à des valeurs résolues. WebGL2 limite le
nombre d'échantillons à ce que le format autorise.
