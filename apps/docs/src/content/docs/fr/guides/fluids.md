---
title: Les fluides
description: Les fluides de @fdw/engine-fluids — l'eau en champ de hauteurs, la fumée et le feu dans une grille de cellules, un liquide de particules ; les corps de la physique qui les poussent et qu'ils portent ; leur rendu, leurs coûts et leurs limites.
sidebar:
  order: 19
---

`@fdw/engine-fluids` simule des fluides sur le GPU, en compute graphs : le
même code en WebGPU, Vulkan et WebGL2 (où les compute graphs tournent en
dessins dans des textures). Les tutoriels montrent chacun à l'œuvre :
[l'eau sur un sol](/fdw-engine/fr/tutorials/shallow-water/),
[la fumée et le feu](/fdw-engine/fr/tutorials/smoke/),
[un liquide de particules](/fdw-engine/fr/tutorials/liquid/).

## Quelle méthode

| Méthode                | Classe          | Pour                                                                                       | Pas pour                                                 |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Un champ de hauteurs   | `ShallowWater`  | Mares, rivières sur un relief, bassins, rides, sillages ; de grandes zones                 | L'eau sur l'eau : cascades, vagues qui déferlent         |
| Une grille de cellules | `SmokeGrid`     | Fumée, feu, vapeur, poussière dans l'air ; en 2D (un plan) ou en 3D                        | Une surface libre (l'eau) : la grille n'en a pas         |
| Des particules         | `ParticleFluid` | L'eau qui éclabousse, se verse, se brise sur les parois ; de quelques litres à quelques m³ | De grandes zones : les particules sont petites et chères |

Ils partagent :

- **`FluidBodies`** : les corps de `@fdw/engine-physics` (leurs colliders
  de sphère et de boîte, l'encombrement des autres) ou des formes bougées
  par l'application (`addShape`), écrits une fois par image (`update()`)
  dans un storage buffer de six `vec4` par forme : centre et sorte,
  rotation, taille, vitesse, vitesse angulaire, centre de masse. Jusqu'à 64
  formes, lues par tous les graphs dans une boucle (`bodiesInGraph`,
  `bodyDistanceInGraph`, `bodySpanInGraph`).
- **Le rendu de l'eau** de `@fdw/engine-ocean` : la `WaterSurface` d'un
  champ de hauteurs est dessinée avec le matériau de la mer par
  l'`OceanRenderer` ; la lumière du liquide de particules est la même
  (`WaterLook`).
- **La `Buoyancy`** de `@fdw/engine-ocean`, pour ce qui flotte : un champ de
  hauteurs et un liquide de particules donnent `heightAt` et `velocityAt`,
  relus du GPU une image plus tard.
- **Un jumeau sur le CPU** de chaque pas (`stepShallowWater`, `stepSmoke`,
  `stepParticles`) : les tests font tourner les deux et les comparent, sur
  tous les backends.

## `ShallowWater`

La méthode des **tuyaux virtuels** (O'Brien et Hodgins 1995, Mei et al. 2007) : une grille de colonnes d'eau sur un sol, qui échangent l'eau par les
quatre faces de chaque cellule.

- **L'état** : `cells` (profondeur, occupation, vitesse x, vitesse z) et
  `flux` (sortants vers −x, +x, −z, +z, en m³/s), deux paires de storage
  buffers lues et écrites tour à tour ; `surface` (hauteur, pentes,
  vitesse, −1 au sec) pour le rendu.
- **Un pas** : les flux (des écarts de surface, amortis, jamais négatifs,
  réduits pour qu'aucune cellule ne donne plus d'eau qu'elle n'en a), puis
  les profondeurs, les vitesses, les sources, l'occupation des corps. La
  masse est conservée.
- **Les pas** : `maxStep = cell / √(g × maxDepth) / 2` ; `update(dt)`
  découpe une image en autant.
- **Les corps** : l'occupation d'une colonne vaut `stiffness` fois la part
  des corps sous sa seule eau, au plus leur hauteur entière : elle élève la
  surface, les flux écartent l'eau. Une colonne dont l'occupation suivrait
  exactement sa surface oscille comme un tube en U (aucun amortissement n'y
  fait) : avec `stiffness` k, k / (k + 1) de l'eau déplacée s'écarte, de
  façon stable.
- **Les sources** : `addSource({ x, z, radius, rate })`, négatif pour
  vider ; `splash(x, z, radius, volume)` verse un volume en un pas. Au plus 16.
- **Les bords** : `'closed'` (des murs) ou `'open'` (l'eau s'en va comme
  vers une cellule sèche du même sol).

`WaterSurface(water, { environment })` : une grille de `density` sommets par
cellule, son matériau `oceanGraph` sur `heightFieldShader(water)` : la
hauteur dans l'étape de sommets, les pentes dans l'étape de fragments
(bilinéaire), l'écume de l'eau rapide (à partir de `foamSpeed`) par le
jacobien, les cellules sèches écartées (la `coverage` du `WaveShader`, un
matériau masqué).

## `SmokeGrid`

Les **stable fluids** (Stam 1999) sur une **grille décalée** (MAC) : la
vitesse à travers les faces (un buffer d'une entrée de plus selon chaque
axe, `faceSize`), le reste aux centres.

- **L'état** : `velocity` (faces), `scalars` (densité, température),
  `pressure` (pression, divergence), `solids`, `vorticity` ; `shade`
  (densité, lumière du soleil, température) pour le rendu.
- **Une image** : les obstacles, l'advection de la vitesse (faces) et des
  scalaires (cellules), semi-lagrangienne avec un pas au point milieu ; la
  flottaison, le poids, les émetteurs, la dissipation ; la vorticité et son
  confinement ; la divergence ; `iterations` pas de Jacobi ; la projection
  (glissement libre le long des murs et des obstacles) ; la lumière vers le
  soleil. 7 + `iterations` dispatchs.
- **Les bords** : les faces `open` (pression nulle, l'air s'en va), les
  autres des murs ; les obstacles de `FluidBodies` entraînent l'air avec
  eux.
- **Les émetteurs** : des sphères, `density`, `temperature`, `velocity`,
  `turbulence` (un bruit simplex qui monte). Au plus 16.
- **Dans un plan** : `resolution: [nx, ny, 1]` ; dessinée par
  `smokePlaneGraph`.

`SmokeRenderer` : la scène (couleurs linéaires, profondeur de vue), puis une
marche plein écran par fumée (`addPass`), puis le tone mapping.
`setSun(smoke, light)` règle la direction de la lumière dans la grille et sa
couleur dans la marche ; `setLook(smoke, look)` l'albédo, le ciel, le feu
(`SmokeLook`).

## `ParticleFluid`

Les **position-based fluids** (Macklin et Müller 2013).

- **L'état** : `positions`, `velocities` (un vec4 par particule), dans
  l'ordre de leurs cellules depuis le dernier tri ; les `active` premières
  sont utilisées.
- **Un pas** : la prédiction ; les clés ; le tri bitonique (log₂ n (log₂ n +
  1. / 2 dispatchs, un buffer de (j, k) par étape) ; les plages des
     cellules (effacées, puis écrites là où les clés changent) ; le
     réordonnancement ; `iterations` × (λ, Δp, collisions avec la boîte et les
     corps) ; les vitesses ; la viscosité XSPH.
- **Les voisins** : les 27 cellules autour, au plus `maxPerCell` (48)
  particules chacune, deux boucles imbriquées des compute graphs.
- **Les colonnes** : un dispatch par colonne de cellules donne la surface et
  sa vitesse (`columns`), relues pour `heightAt` et `velocityAt`.

`ParticleFluidRenderer` : les sphères dans une profondeur du liquide (des
quads masqués, `particleDepthGraph`), le filtre bilatéral
(`smoothDepthGraph`, `smoothing` passes), la lumière (`liquidShadingGraph`).
`addPasses(graph, { liquid, camera, color, sceneDepth, depth })` pour un
render graph à soi.

## Les coûts

Les trois démos (`basin`, `smoke`, `splash` dans `apps/demo` et
`apps/demo-native`), 1280 × 720, Vulkan, RTX 2060 SUPER, sans vsync, tout
compris (la scène, la physique) :

| Démo                                            | ms par image | Images par seconde |
| ----------------------------------------------- | ------------ | ------------------ |
| Une mare, 128² cellules, 5 corps qui flottent   | 1,4          | 700                |
| La fumée et le feu, 48 × 96 × 48 cellules       | 4,2          | 238                |
| Une cuve, 12 100 particules de 2 cm, 2 sous-pas | 2,8          | 362                |

Sous Dawn (WebGPU dans une fenêtre native) : 3,3, 5,5 et 5,8 ms. En WebGL2
le calcul est émulé : les exemples de la documentation y utilisent moins de
cellules et de particules.

## Les limites

- **Un champ de hauteurs** a une hauteur par colonne : pas d'eau sur l'eau,
  pas de vague qui déferle. Ses vagues n'ont pas de quantité de mouvement
  propre (les tuyaux n'emportent pas la vitesse) : un sillage ne suit pas
  un bateau.
- **La fumée** est aussi fine que sa grille : les détails de moins de deux
  cellules s'estompent ; une advection semi-lagrangienne diffuse
  (MacCormack en garderait plus). La grille ne suit pas la caméra.
- **Les particules** ne sont pas triées avec les corps : le liquide ne pousse
  les corps que par la `Buoyancy` de ses colonnes, qui ne connaît qu'une
  surface par colonne (pas de liquide dans un corps creux). Leur surface est
  dessinée en espace écran : pas de reflets du liquide dans le liquide, ni
  écume ni embruns encore.
- Aucun fluide ne projette ni ne reçoit d'ombres.
