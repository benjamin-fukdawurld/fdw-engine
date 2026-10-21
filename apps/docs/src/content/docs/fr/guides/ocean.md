---
title: L'océan
description: La mer de @fdw/engine-ocean — les vagues (spectre océanique par FFT sur le GPU, vagues de Gerstner), la grille autour de la caméra, le matériau de l'eau, les passes qui voient à travers, et la hauteur de l'eau pour la physique.
sidebar:
  order: 18
---

`@fdw/engine-ocean` dessine une mer sur tous les backends, éclairée par son
environnement et le soleil, et dit à la physique où est l'eau. Les
tutoriels la montrent à l'œuvre : [la mer et ses vagues](/fdw-engine/fr/tutorials/ocean/),
[des objets qui flottent](/fdw-engine/fr/tutorials/floating-objects/).

| Pièce                   | Ce que c'est                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `OceanSpectrum`         | Les vagues d'un spectre océanographique, calculées sur le GPU par FFT inverses, en cascades      |
| `GerstnerWaves`         | Des sommes de vagues de Gerstner, évaluées dans le vertex shader et sur le CPU                   |
| `Ocean`                 | L'élément de rendu : une grille d'anneaux autour de la caméra, son matériau, la hauteur de l'eau |
| `OceanRenderer`         | Les passes : la scène, le ciel, la mer qui voit la scène à travers, le tone mapping              |
| `Buoyancy`              | Archimède pour les corps de `@fdw/engine-physics`, en des points, avec le frein de l'eau         |
| `createSky`, `skyColor` | Un ciel de jour dans une texture cube, avec ses niveaux : ce que l'eau reflète                   |

## Les vagues

Les deux sources donnent les mêmes huit valeurs en chaque point (x0, z0) de
la surface au repos : son déplacement (dx, h, dz) et leurs dérivées
(∂h/∂x, ∂h/∂z, ∂dx/∂x, ∂dz/∂z, ∂dx/∂z), d'où viennent la normale et le
jacobien du mouvement (`WaveSample`, `sampleNormal`, `sampleJacobian`).

**`OceanSpectrum`** (Tessendorf, _Simulating Ocean Water_) :

- `createSpectrum(options)` tire, une fois sur le CPU, une amplitude
  complexe aléatoire h0(**k**) pour chaque vecteur d'onde de chaque cascade,
  de variance S(**k**) Δk² / 2, S étant le spectre : JONSWAP (vitesse du
  vent, fetch, facteur de pic γ) ou Phillips, réparti autour du vent par
  cos^2s(θ/2). Les fréquences sont celles de l'eau profonde, ω = √(g|k|)
  (avec `depth`, √(g|k| tanh(|k|d))), arrondies aux multiples de 2π /
  `period` : la mer boucle.
- `update(time)` exécute quatre compute graphs : le spectre à ce temps,
  puis les étapes de la FFT sur les lignes puis les colonnes (un dispatch
  par étape, chacun lisant les papillons de son étape dans un storage
  buffer), puis les champs. Deux champs réels partagent chaque FFT complexe
  (a + ib, leurs spectres étant hermitiens) : quatre FFT pour huit champs.
- Les cascades sont des tuiles de tailles différentes (233, 37,7 et 6,3 m
  par défaut), chacune gardant les vagues d'une bande de longueurs, jusqu'à
  4 vagues sur le côté de la tuile suivante. Une cascade dont la bande
  dépasserait sa plus courte vague est refusée.
- `displacement` et `derivatives`, deux storage buffers de vec4 (cascade,
  ligne selon z, colonne selon x), sont ce que lit le matériau.
- Le côté CPU : `fields` (le dernier déplacement relu, ou calculé par
  `evaluateSpectrum` avant la première lecture ou avec `readback: false`),
  `sample(x0, z0)`, `heightAt(x, z)`. La FFT du CPU (`inverseFft2d`,
  `butterflyTables`) est celle du GPU, comparée au GPU par les tests en
  WebGPU, Vulkan et WebGL2.

**`GerstnerWaves`** : une liste de `{ direction, wavelength, amplitude,
steepness, phase }`. Le mouvement horizontal d'une vague est steepness /
(k × nombre) : toutes les raideurs à 1, les crêtes de toutes les vagues se
pincent en un point là où elles se rencontrent. Le matériau reçoit leurs
constantes dans le code et leurs phases en uniforms (`wavePhases0`…,
ramenées à [0, 2π) sur le CPU : aucune précision perdue après des heures).

## La grille

`clipmapGrid({ cell, levels, size, horizon })` : des carrés de 2 × `size`
cellules, la première de `cell` mètres (0,5), chaque anneau autour du
précédent aux cellules deux fois plus grandes (7 anneaux : 1 km de chaque
côté), puis une jupe plate jusqu'à l'horizon (20 km au moins), environ
23 000 sommets en tout. L'`Ocean` la déplace sous la caméra par pas de la
plus grande cellule (`grid.step`, 32 m), pour que ses sommets restent sur
les mêmes points du monde. Sur le bord extérieur d'un anneau, les sommets
entre deux de l'anneau suivant sont ramenés sur l'un d'eux : les arêtes
coïncident, sans fissure une fois déplacées. Les vagues s'effacent des
sommets avant la jupe.

La tessellation de [P3b](/fdw-engine/fr/tutorials/tessellation/) était
l'autre choix : ses patchs sont fixes dans le monde, alors que la mer va
jusqu'à l'horizon où que soit la caméra ; les anneaux suivent la caméra sans
rien coûter au CPU.

## Le matériau

`oceanGraph(shader, { refraction, fade })`, sur le `WaveShader` des vagues
(`spectrumShader`, `gerstnerShader`) : un autre est possible, avec les
trois mêmes méthodes.

- **L'étape de sommets** : le point au repos (x0, z0) du sommet, les vagues
  ajoutées, chacune effacée avec la distance à `fade` fois sa longueur (le
  côté de sa tuile pour une cascade) : au-delà, les sommets sont trop
  espacés.
- **L'étape de fragments** : les dérivées au point au repos du pixel ; les
  vagues plus courtes que quelques pixels s'effacent, la variance de leurs
  pentes ajoutée à la rugosité GGX (α² + 2σ²) : l'eau lointaine devient un
  reflet doux.
- **La lumière** : l'environnement reflété (Fresnel de l'eau, F0 = 0,02),
  son niveau selon la rugosité ; un reflet GGX du soleil ; à travers l'eau,
  la scène déviée par la normale, absorbée par e^(−absorption ×
  profondeur), et la lumière diffusée par l'eau ; le soleil à travers les
  crêtes ; l'écume là où le jacobien passe sous `foamThreshold` et là où
  l'eau est plus mince que `shoreFoam`.
- Les uniforms de `WaterLook` (`setLook`), `sunDirection` et `sunColor`
  (`setSun(light, intensity)`), la texture cube `environment` et ses
  `environmentLevels`.

## Les passes

`OceanRenderer.addPasses(graph, options)` (les options
d'`addScenePasses`, plus `ocean`) :

| Passe              | Écrit                                               | Lit                                     |
| ------------------ | --------------------------------------------------- | --------------------------------------- |
| `scene`            | la couleur (rgba16float), la profondeur de vue      | —                                       |
| `ocean background` | le ciel là où la profondeur vaut 0, deux fois (MRT) | la couleur, la profondeur               |
| `ocean`            | la mer sur une copie, contre la profondeur          | l'autre copie, la profondeur (`inputs`) |

Elle rend l'image, en couleurs linéaires ; `render` ajoute le tone mapping
(`neutral` par défaut) et présente. Le backend doit rendre en rgba16float
(tous le font ; WebGL2 par `EXT_color_buffer_float`).

## La physique

`ocean.heightAt(x, z)` est la hauteur de l'eau au-dessus d'un point du
monde : le point de la surface au repos que les vagues y amènent est trouvé
par six itérations de point fixe. Pour le spectre, les hauteurs viennent du
GPU avec une image de retard (`buffer.read()`, non attendu : la lecture
suivante part quand la précédente est finie).

`new Buoyancy(water, { density, gravity })`, `add(body, { points, volume,
depth, drag })`, `install(scheduler)` (le pas fixe, avant `physics`).
Chaque point représente volume / nombre ; mouillé sur `depth` (la racine
cubique de sa part par défaut), il pousse vers le haut de ρ g V × son
immersion, et freine contre la vitesse du point (v + ω × r) de `drag` ×
masse / nombre. `boxPoints` répartit les points d'une boîte.

## Les coûts

Sur la côte du tutoriel (1280 × 720, Vulkan, RTX 2060 SUPER, sans vsync) :
**3,3 ms par image avec le spectre, 1,9 ms avec six vagues de Gerstner**
(la côte, neuf corps qui flottent, la relecture comprise). Le spectre
lui-même, 128 × 128 points et trois cascades : **0,16 ms** de GPU par mise
à jour (0,65 ms en 256) ; relire ses 768 Ko prend 0,9 ms, sans l'attendre.
WebGL2 exécute les FFT en dessinant des points dans des textures : 32
dessins de 49 152 points par image, 0,36 s par mise à jour sur SwiftShader
(le rendu logiciel des tests).

## Les limites

- Pas de vue sous l'eau, pas de sillages, pas d'écume qui dure (l'écume est
  celle de l'image) : plus tard.
- Les hauteurs relues ont une image de retard : quelques millimètres,
  quelques centimètres dans une tempête.
- Les ombres ne tombent pas sur l'eau, et seul le soleil l'éclaire.
- Les vagues sont celles de l'eau profonde : pas de réfraction des vagues
  par le fond, pas de déferlement sur la plage (l'écume et l'absorption
  suivent la profondeur, les vagues non).
