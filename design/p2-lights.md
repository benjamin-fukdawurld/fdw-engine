# P2 : les lumières à grande échelle et l'environnement

Le design de la phase P2 de la [roadmap](roadmap.md#p2-lumières-et-ombres-à-grande-échelle) : un nombre de lumières sans limite fixe, chaque pixel ne sommant que celles qui l'atteignent (le culling en clusters), et l'éclairage par l'environnement (IBL : l'irradiance, le spéculaire préfiltré, la table BRDF). Les cascades d'ombres de la phase ont été faites avec P8 ([p8-tps.md](p8-tps.md) §3.1).

Contraintes : les mêmes graphs et le même compilateur sur les quatre backends (WebGPU, WebGL2, Vulkan, Direct3D 12), WebGL2 compris, qui n'a ni calcul natif ni rendu dans les faces d'un cube ; `light.current` et `light.sum` gardent leur sens ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)) : les shading models de l'application n'ont pas à changer ; le path tracer tire ses lumières dans le même format et lit le même environnement ([roadmap §6](roadmap.md#6-rester-compatible-avec-le-ray-tracing)).

## 1. Avant

| Ce qui existait                                                                                                               | Le problème                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Les lumières dans des tableaux de 16 `vec4` (une `mat4` pour la matrice d'ombre) du bloc `frame` : `MaxLights = 16`           | 16 lumières au plus, choisies par le renderer (les directionnelles, puis les plus fortes) ; un bloc `frame` de 4 000 octets          |
| `light.sum` : une boucle sur `lightCount`                                                                                     | Chaque fragment évalue toutes les lumières de l'image, même lointaines                                                              |
| Le terme ambiant des lumières (`ambient × baseColor × occlusion`) ; le commentaire du modèle `pbr` : « l'IBL le remplacera » | Pas de reflets de l'environnement : les métaux sont noirs sans lumière directe dans la direction du reflet, l'écart le plus visible |
| Le path tracer : ses propres lumières (`packLights`, 4 `vec4`), un ciel en dégradé                                            | Un second format de lumières ; pas d'environnement                                                                                  |

## 2. Les choix

| Question                         | Choix                                                                                                                                                                                                                                                                     | Écartés, et pourquoi                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Où vivent les lumières           | **Un pool de lumières, un storage buffer** (`lights`, ressource du moteur du groupe `frame`) : 13 `vec4` par lumière, les membres de `lightMembers` à leur décalage ; WebGL2 le lit dans sa texture de données (les storage buffers émulés de [cg-webgl2.md](cg-webgl2.md)) | Des tableaux uniformes plus grands : la limite de 16 Ko des blocs de WebGL2 (environ 75 lumières) ; une texture de données propre aux lumières : un second chemin, alors que les storage buffers existent partout                                                                                       |
| Le découpage                     | **Des clusters** : 16 × 9 tuiles de l'écran, 24 tranches de profondeur logarithmiques entre les plans proche et lointain de la caméra (3 456 clusters)                                                                                                                    | Des tuiles 2D (Forward+) : une tuile qui couvre un premier plan et le fond liste toutes les lumières entre les deux ; un découpage en pixels (tuiles de 32 px) : le nombre de clusters suivrait la taille de l'image                                                                                       |
| Qui remplit les clusters         | **Le CPU**, à chaque image et sur tous les backends : 0,8 ms pour 1 000 lumières (§8)                                                                                                                                                                                     | Une passe de calcul (prévue dans la roadmap) : sans atomiques dans l'IR, les listes demandent deux passes (des masques de bits, puis le n-ième bit) ; en WebGL2, le calcul émulé par des points serait plus lent que le CPU. Reportée (§9) : à faire quand le CPU ne suit plus, au-delà de quelques milliers |
| Le cluster d'un fragment         | **Depuis la position du point** donnée à `light.sum` (l'entrée `position`) : sa profondeur dans la vue, ses coordonnées dans le clip space ; le CPU projette avec les mêmes matrices                                                                                       | Depuis `frag-coord` : son origine change avec le backend (en bas à gauche en GLSL), et il ne vaut rien dans une passe plein écran (le rendu différé)                                                                                                                                                       |
| Les lumières globales            | **En tête du pool**, sommées partout : les directionnelles et celles sans portée (sans atténuation) ; une seule boucle : l'indice de boucle sous leur nombre, la lumière elle-même, au-delà, la liste du cluster                                                          | Une liste par cluster qui les répète : 3 456 copies par lumière ; deux boucles : le corps de la boucle (l'éclairage) généré deux fois                                                                                                                                                                        |
| L'atlas de l'environnement       | **Une texture 2D, des cartes octaédriques en tuiles** (4 × 2 tuiles de (taille + 2)², une bordure d'un texel repliée sur l'arête) : 6 niveaux de rugosité, l'irradiance, la table BRDF                                                                                   | Un cube avec ses niveaux : le rendu dans une face et un niveau n'existe pas dans l'API abstraite, et WebGL2 n'a pas de copie de cube ; des harmoniques sphériques pour l'irradiance : un second format, et l'atlas a déjà la place                                                                         |
| La source                        | **Un panorama équirectangulaire**, un **cube**, ou **une fonction de graph de la direction** (un ciel procédural) : capturés d'abord dans un panorama de 4 × 2 texels par texel de tuile, avec ses niveaux                                                                | Le panorama seul : les cubes du moteur (le ciel de l'océan de P17) et les ciels procéduraux seraient à convertir par l'application                                                                                                                                                                         |
| Le préfiltrage                   | **Des passes plein écran** sur le GPU, une par tuile (son viewport), à la première image et après `update()` ; le tirage d'importance filtré (Křivánek et Colbert 2008) dans les niveaux de la capture                                                                    | Sur le CPU : des secondes pour un atlas de 128 ; en passes de calcul : pas de textures de stockage dans l'IR, et pas de calcul natif en WebGL2                                                                                                                                                             |
| L'éclairage par l'environnement  | **La somme séparée de Karis** (2013) : le diffus × l'irradiance + le spéculaire préfiltré × (F0 × A + B) ; dans `pbr`, et dans `phong` (l'irradiance, et des reflets aussi rugueux que les reflets spéculaires sont larges), × l'occlusion                                | L'approximation analytique de la table BRDF (Karis 2014) : moins juste aux angles rasants, et la table ne coûte qu'une tuile                                                                                                                                                                              |

## 3. Le pool de lumières

**Le format** (`lightMembers`, `LightVec4s = 13` dans `engine-shader`) : la lumière `i` commence au `vec4` `i × 13`.

| Décalage | Membre          | Contenu                                                                                                 |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| 0        | `position`      | xyz, w = 1 pour un point ou un spot, 0 pour une directionnelle (xyz : la direction vers la lumière)     |
| 1, 2, 3  | `ambient`, `diffuse`, `specular` | Les couleurs (rgb)                                                                     |
| 4        | `attenuation`   | Les facteurs constant, linéaire, quadratique                                                            |
| 5, 6     | `spotDirection`, `spotCone` | La direction du spot ; les cosinus des angles intérieur et extérieur ((-1, -2) : partout)   |
| 7, 8     | `shadow`, `shadowRect` | Les valeurs d'ombre et la tuile de l'atlas, comme avant                                          |
| 9 à 12   | `shadowMatrix`  | Les quatre colonnes de la matrice d'ombre                                                               |

**Le compilateur** : `light.current` lit le pool (l'opération `index` sur le storage buffer) à l'indice de la lumière de la boucle, une `mat4` construite de ses colonnes ; le binding `lights` est ajouté aux programmes qui ont un `light.current`. Le bloc `frame` garde `lightCount` et perd les tableaux : 704 octets au lieu de 4 000 (720 avec l'environnement).

**Le renderer** : `writeLightPool(lights, out, shadows, rayOffset)` (`engine-core`) écrit les enregistrements ; un pool par nom de vue (deux scènes d'un graph ont leurs lumières), un buffer qui double quand il manque de place, les groupes qui le tiennent refaits. Les passes plein écran lisent le pool de la dernière scène (le rendu différé), ou un pool vide avant la première. Plus de limite : toutes les lumières dont la portée atteint le frustum sont dans le pool, les globales d'abord ; `strongestLights` a disparu.

## 4. Les clusters

**Dans le graph** : `light.sum` gagne une entrée `position` (le point éclairé, en monde ; facultative) et un paramètre `clustered`, posé par le compilateur. Avec la feature `lightClusters` (le renderer la donne aux variantes éclairées), chaque `light.sum` qui a une position reçoit une macro `light.cluster` qui calcule, depuis la position :

1. la profondeur dans la vue, `d = −(view × p).z` (comme les cascades), et la tranche `floor(log2(d) × échelle + biais)` (`lightClusterDepth` : x l'échelle, y le biais) ;
2. la tuile, depuis les coordonnées du clip space `(viewProjection × p).xy / w` ;
3. le cluster `(tranche × tuiles y + y) × tuiles x + x`, son en-tête dans `lightGrid` : le premier élément de sa liste, sa longueur ; le nombre de lumières globales (`lightClusters.w`).

**La boucle** (`translateLightSum`) : `count = globales + longueur` ; dans le corps, la lumière est `i` pour `i < globales`, sinon `lightGrid[premier + i − globales]` (lu à 0 pour les globales : la soustraction déborderait). Le corps reste le même : les shading models (`phong`, `pbr`) donnent leur position, ceux de l'application gardent la boucle sur toutes les lumières tant qu'ils n'en donnent pas.

**Le remplissage** (`LightClusters.assign`, sur le CPU) : chaque lumière bornée est entourée d'une sphère (sa portée ; pour un spot, la plus petite sphère autour de son cône, d'après « Cull that cone », Wronski 2017) ; pour chaque tranche qu'elle traverse, la part de la sphère dans la tranche est bornée par une boîte de l'espace de la vue, dont les huit coins projetés donnent les tuiles couvertes. Les paires (cluster, lumière) sont comptées, puis rangées par cluster (un tri par comptage). Le test est conservateur : une lumière peut être listée dans un cluster qu'elle n'atteint pas (les coins des boîtes), jamais l'inverse.

**La portée** est celle de `lightRange` : là où l'atténuation passe sous 1/256 de la couleur la plus forte de la lumière. Au-delà, une lumière n'est plus sommée : chaque lumière coupée l'est à moins d'un pas de couleur 8 bits, mais les queues de centaines de lumières proches s'additionnent (quelques pour cent de lumière en moins dans une scène dense, sans arête visible). L'option `lightClusters: false` du renderer revient à la somme de toutes les lumières.

**Les dérivées** : le corps d'une boucle en clusters tourne un nombre de fois propre à chaque pixel, en flot de contrôle non uniforme : le compilateur y refuse les nœuds qui calculent des dérivées (`textureSample`, `dpdx`, `dpdy`, `fwidth`), avec un message qui propose `textureSampleLevel` ou le calcul hors de la boucle (WGSL les refuse aussi, et ailleurs elles sont indéfinies). Sans position, ou sans la feature, la boucle reste uniforme.

**Les mêmes clusters partout** : le cluster d'un point ne dépend que de ses coordonnées dans le clip space et de sa profondeur, calculées avec les matrices que le CPU projette : ni l'origine des pixels, ni la convention de profondeur du backend n'interviennent.

## 5. L'environnement

**L'API** (`engine-core`) : `new Environment(source, { intensity, size, samples })`, la source `{ panorama }` (une texture 2D équirectangulaire, u autour de la verticale, 0,5 vers −z, v du zénith au nadir), `{ cube }` ou `{ sky }` (une fonction de graph : `direction` → `color`) ; `intensity` change sans coût ; `update()` le fait préfiltrer à nouveau. `render({ environment })`, `addScenePasses(graph, { environment })`, `addFullscreenPass(graph, name, { environment })`.

**Le préfiltrage**, ajouté au graph de la première image (et après `update()`) avant les passes qui lisent l'atlas :

1. **La capture** : une passe plein écran écrit la source dans un panorama de `4 × taille` sur `2 × taille` texels (16 directions par texel, au niveau de la source dont les texels ont la taille de ceux de la capture), puis ses niveaux (`addMipmapPass`).
2. **Les tuiles** : une passe plein écran par tuile, son viewport sur la tuile et sa bordure (`FullscreenPassOptions.viewport`, nouveau : `screen-uv` couvre le rectangle). Le point de la tuile `(screen-uv × (taille + 2) − 1) / taille` ; ceux de la bordure, hors de [0, 1], sont repliés sur l'arête par `environment.octahedralDirection` (les arêtes d'une carte octaédrique se rejoignent en miroir) : le filtre bilinéaire y trouve le texel d'à côté.
   - les tuiles 0 à 5 : la radiance pour une rugosité `k / 5` : 64 directions GGX (une suite de Fibonacci), N = V = R, pondérées par N·L, chacune lue au niveau de la capture dont les texels couvrent l'angle solide de l'échantillon ; la tuile 0 (le miroir) : un échantillon ;
   - la tuile 6 : l'irradiance / π, 256 directions en cosinus ;
   - la tuile 7 : la table de la somme séparée, A et B pour N·V (u) et la rugosité (v), avec k = α / 2.

**Le format** : `rgba16float` là où le backend le rend (tous aujourd'hui), `rgba8unorm` sinon (les couleurs au-delà de 1 coupées).

**Dans les shaders** : les fonctions de graph `environment.radiance(direction, rugosité)` (deux tuiles mélangées), `environment.irradiance(normale)`, `environment.brdf(N·V, rugosité)`, lues au niveau 0 (`textureSampleLevel` : elles marchent aussi dans les programmes de calcul) ; `environment.octahedral`, `environment.equirect` et leurs inverses. Les ressources du moteur `environmentMap`, `environmentSampler` (bilinéaire, bords bloqués) et la valeur `environment` du bloc `frame` (la taille des tuiles, la taille d'un texel de l'atlas, l'intensité). La macro `environment.light` (le diffus et le spéculaire de la somme séparée) est noire et ne coûte rien sans la feature `environment`, que le renderer donne aux vues qui ont un environnement.

**L'IR** gagne `log2`, `exp2` (les tranches des clusters), `acos` et `atan2` (le panorama), dans les trois générateurs (`atan` à deux arguments en GLSL).

**Montrer l'environnement** : une sphère ou un cube autour de la caméra, d'un matériau `unlit` qui lit `environment.radiance` dans la direction de la vue (le tutoriel).

## 6. Les rayons

- **Les lumières** : `packLights` écrit le format du pool (`writeLightPool`), les noyaux du path tracer et des reflets les lisent par `poolLight` (la radiance : le diffus × π).
- **Le ciel** : `PathTraceOptions.environment` et l'option `environment` des reflets : les rayons perdus voient le panorama capturé (`environment.equirect`, × l'intensité) au lieu du dégradé. `renderer.environmentTextures(environment)` préfiltre sur le champ si besoin et donne la capture et l'atlas aux techniques hors des passes du renderer. Un environnement changé (version, intensité) recommence l'accumulation.
- Les noyaux restent à 8 storage buffers (le test les compte) : le panorama est une texture.

## 7. Tests

- **`engine-shader`** : le pool (le binding, les décalages lus, la `mat4` de quatre colonnes), la boucle des clusters (le compte, les deux `select`, la lecture de la grille, `log2`), sans la feature, dans `phong` et `pbr` ; l'environnement sans coût sans sa feature, ses quatre lectures avec, `atan2` et `acos` ; les générateurs (WGSL, GLSL ES, HLSL) et la disposition du bloc `frame`.
- **`engine-core`** : les clusters contre la force brute (20 000 points tirés près de 60 lumières et spots : chaque lumière qui atteint un point est dans son cluster ; le test échoue si l'on retire une tranche ou rétrécit les sphères), les lumières hors de la vue, les globales ; le pool (l'ordre, les valeurs) ; le préfiltrage à la première image et après `update()` seulement, ses viewports.
- **La suite de rendu** (Dawn, Vulkan, Direct3D 12, WebGL2 sur SwiftShader) : 300 lampes colorées sur un sol vu en perspective, chaque pixel comparé à la somme sur le CPU des lumières qui l'atteignent (±2) ; l'environnement : les reflets miroir dans huit directions (±1), l'irradiance d'un ciel blanc au-dessus de l'horizon pour cinq élévations de la normale, `(1 + sin β) / 2` (±2 %), son intensité, la table BRDF, le `pbr` éclairé par un ciel gris, les sources panorama et cube ; le path tracer éclairé par l'environnement.

- **Documentation** : le guide « Lights and shadows » (EN, FR), les tutoriels « Hundreds of lights » et « Image-based lighting » (EN, FR) avec leurs exemples vivants (`many-lights`, `environment-lighting`) et leurs captures ; « A custom shading model » donne la position à `light.sum` ; le path tracing et son environnement.

## 8. Mesures

Le CPU des lumières d'une image (le pool et les clusters), des lampes de portée 4 sur un sol de 200 × 200 vu en perspective (`lightClusters.bench.ts`) :

| Lumières | Temps par image |
| -------- | --------------- |
| 100      | 0,08 ms         |
| 1 000    | 0,83 ms         |
| 4 000    | 3,2 ms          |

## 9. Reportés

- **Le culling sur le GPU** : à faire quand le CPU ne suit plus (au-delà de quelques milliers de lumières). Sans atomiques dans l'IR : une passe de masques de bits (un fil par cluster et par mot de 32 lumières), puis une passe qui range le n-ième bit (un fil par place de liste) ; les mêmes buffers, lus par les mêmes shaders.
- **Les ombres des lumières ponctuelles** (six faces), et le culling des projeteurs par tuile.
- **Le chargement des panoramas HDR dans le navigateur** : le décodeur natif (`stb_image`) les lit en `rgba16float` ; il manque un décodeur RGBE en TypeScript pour le web.
- **L'échantillonnage des lumières par importance dans le path tracer** (une lumière tirée au hasard parmi toutes : bruité avec des centaines) et de l'environnement (ses texels brillants).
- **La compensation de l'énergie des rebonds multiples** (Fdez-Agüera 2019) : les métaux rugueux un peu trop sombres.

## 10. État

Fait (27 octobre 2026) : le pool, les clusters sur le CPU, l'environnement et son préfiltrage, le path tracer et les reflets sur le pool et l'environnement, leurs tests sur les quatre backends.
