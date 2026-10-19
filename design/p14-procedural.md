# P14 : les shaders procéduraux

Des matériaux calculés plutôt que lus dans des textures ([roadmap P14](roadmap.md#p14-shaders-procéduraux)) : sans uv, sans répétition visible, à toute résolution, animables. Le material graph avait le nécessaire (fonctions-graphes de la bibliothèque standard, trois générateurs, dérivées d'écran de P2b), sauf les entiers bit à bit, une boucle générale, et tout bruit ou motif.

## 1. Les choix

| Question             | Choix                                                                                                                                 | Écartés, et pourquoi                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le hachage           | **PCG** sur des `u32` (Jarzynski et Olano, JCGT 2020) : `pcg`, `pcg2d`, `pcg3d`, `pcg4d`                                              | `fract(sin(x) × 43758)` : dépend de la précision de `sin` du GPU, différent d'un backend à l'autre ; tables de permutation (Perlin) : une texture ou un tableau d'uniforms, et un modulo 289 en flottants (Ashima) imprécis loin de l'origine |
| Où vivent les bruits | **Des fonctions-graphes** de la bibliothèque standard, inlinées                                                                       | Des fonctions natives par langage : trois implémentations à tenir égales, et le compilateur n'optimise plus à travers                                                                                                                         |
| Les dimensions       | 2D, 3D, 4D : une fonction par dimension (`noise.perlin3`) et une macro générique (`stdNoise.perlin`) qui choisit par le type du point | Des entrées génériques dans les fonctions-graphes : pas encore ([écarts](material-graph-gaps.md)) ; les macros suffisent                                                                                                                      |
| Les octaves          | **Déroulées** par défaut, ou dans une **boucle `fold`** (nombre de tours en uniform)                                                  | Seulement déroulées : pas de nombre d'octaves réglable sans recompiler                                                                                                                                                                        |
| La cuisson           | **Une passe plein écran** (`bakeTexture`), ses niveaux calculés ensuite                                                               | Un calcul : les compute graphs n'écrivent que des storage buffers, et l'API abstraite n'a pas de copie d'un buffer vers une texture (§6)                                                                                                      |
| Les bruits du CPU    | **Un package à lui**, `@fdw/engine-noise`, sans dépendance                                                                            | Dans `engine-shader` : la physique et le placement d'objets dépendraient du compilateur de shaders                                                                                                                                            |

## 2. Les entiers

`std.remainder`, `std.bitAnd`, `std.bitOr`, `std.bitXor`, `std.shiftLeft`, `std.shiftRight` (génériques `integer`, composante par composante) ; `std.uvec2/3/4` construisent des vecteurs de `u32`. Dans l'IR, des opérateurs binaires de plus (`%`, `&`, `|`, `^`, `<<`, `>>`) : les trois générateurs les écrivent tels quels, WGSL convertit en `u32` le décalage d'un `i32`. Les produits de `u32` gardent leurs 32 bits bas sur les trois langages, comme `Math.imul` en JavaScript : c'est ce qui rend le hachage identique partout. Le pliage des constantes ne touche toujours pas aux entiers.

Une correction en chemin : un littéral donné à une entrée entière d'une fonction-graphe restait un littéral non typé, que le nœud suivant typait en `f32`. À l'inlining, un tel littéral devient un nœud constant du type de l'entrée.

## 3. La boucle `fold`

`g.fold(initial, count, body)` : état = initial, puis `count` fois état = body(état, index). Dans le graphe, trois nœuds : `loop.state` et `loop.index`, sans entrée, et `loop.end` (entrées `initial`, `count`, `next`, et `state`, `index` reliées aux deux premiers). **Le lien est structurel** : `loop.state` est relié au port `state` de sa fin. Pas d'identifiant de boucle en paramètre, qu'il faudrait renommer à chaque inlining d'une fonction qui en contient une ; l'élimination des sous-expressions communes ne fusionne simplement jamais deux `loop.state`.

- **Le corps** : les nœuds qui dépendent de l'état ou de l'index, sans traverser la fin. Ce qui ne dépend ni de l'un ni de l'autre est calculé avant la boucle. Le corps ne doit atteindre une sortie que par sa fin ; l'état initial et le nombre de tours ne peuvent pas en dépendre.
- **L'imbrication** : une boucle dont la fin est dans le corps d'une autre tourne dedans. Chaque nœud appartient à la boucle la plus intérieure qui le contient ; deux boucles dont les corps se croisent sans s'emboîter sont refusées. Le bruit de Worley 4D, une boucle de 81 cellules, tourne ainsi dans la boucle des octaves d'un fbm.
- **Les étapes** : le corps tourne à la fréquence de sa fin. Sans cela, une valeur du corps calculée par sommet deviendrait un varying, hors de la boucle. L'état est un scalaire ou un vecteur numérique, que l'on peut interpoler.
- **L'IR** : `loop-fold` (arguments : le nombre de tours, l'état initial), un corps en ligne droite comme `loop-sum`. Les générateurs écrivent une variable et un `for`.
- **Refusé** : les lumières (`light.current`, `light.sum`) dans un corps de fold, et un fold dans le corps d'une boucle de lumières. Les dérivées et les lectures de textures implicites d'un corps demandent un nombre de tours uniforme (WGSL l'exige).

`stdLoops.fold` fait de même sur un nœud fonction (`params: { body }`), dont les autres entrées deviennent des entrées de la macro.

## 4. Les bruits

Tous de la forme `noise.<nom><dimension>(point, seed)`. La graine est hachée (`pcg(seed)`), puis mélangée par un ou exclusif à chaque coordonnée entière de la cellule (convertie en `i32`, puis en `u32` bit pour bit) : une autre graine donne d'autres valeurs, pas les mêmes décalées.

| Bruit            | Algorithme                                                                                                               | Intervalle |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `value`          | Une valeur par point entier, interpolée par la courbe quintique t³(t(6t − 15) + 10)                                      | [-1, 1]    |
| `perlin`         | Un gradient unitaire par point entier (le hachage de la cellule, normalisé), même interpolation, × 2/√n                  | [-1, 1]    |
| `simplex`        | Gustavson : les n + 1 sommets du simplexe, noyau (0,5 − d²)⁴, gradients unitaires ; × 99, 108, 109 (2D, 3D, 4D, mesurés) | [-1, 1]    |
| `worley`         | Un point par cellule (`jitter`), les 3ⁿ voisines : `f1`, `f2`, `id` (le hachage de la plus proche), `random`             | [0, ~1,2]  |
| `random`, `hash` | Les flottants dans [0, 1) (les 24 bits hauts, exacts en `f32`) ou les `u32` de la cellule d'un point                     | —          |

Le simplex garde 0,5 pour le rayon de son noyau en 3D et 4D, là où Gustavson prend 0,6 : 0,6 laisse de petites discontinuités au bord des simplexes, qui feraient diverger le CPU et le GPU là où leurs arrondis choisissent deux simplexes différents. Le Worley 2D et 3D est déroulé (9 et 27 cellules), le 4D est une boucle `fold` sur 81 cellules (l'état garde les deux distances et l'indice de la plus proche, dont le hachage est recalculé après).

**Les sommes** (macros, le bruit et les octaves en paramètres) : `fbm`, `ridged` ((1 − |n|)²), `turbulence` (|n|), divisées par la somme des amplitudes ; l'octave i a la graine seed + i. **La déformation du domaine** `warp` : le point plus `strength` fois un fbm par coordonnée (graines seed + 1013, + 2026…).

**Le coût**, en instructions de l'IR de l'étape de fragments d'un matériau qui lit un bruit à la position dans le monde (constantes comprises) :

| Bruit      | 2D  | 3D    | 4D                 |
| ---------- | --- | ----- | ------------------ |
| Valeur     | 220 | 397   | 856                |
| Gradient   | 254 | 463   | 986                |
| Simplex    | 228 | 288   | 419                |
| Cellulaire | 478 | 1 351 | 112 (boucle de 81) |

**La compilation** : les fonctions de bruit inlinées font des graphes de milliers de nœuds, que les passes du compilateur parcouraient en temps quadratique (`WorkingGraph` cherchait les arêtes d'un nœud dans la liste de toutes les arêtes). Les arêtes y sont désormais indexées par leur nœud d'arrivée et de départ, leur ordre conservé : un fbm de 5 octaves de Perlin 3D se compile en **86 ms au lieu de 402**.

## 5. Les motifs, le placement, l'aliasing

- **Les motifs** (`stdPatterns`) : `checker`, `stripes`, `bricks` (rangées décalées, mortier, biseau ; sorties `mask`, `local`, `cell`, `edge`), `tiles` (coins arrondis, par une distance signée à une boîte). La cellule d'une brique, donnée à `noise.random2`, lui donne sa couleur.
- **Le placement** (`stdMapping`) : `objectPosition`, `worldPosition`, `objectNormal`, `worldNormal`, par fragment ; `triplanar` appelle une fonction d'un uv sur les plans yz, xz et xy de la position, mélangés par les poids `pow(|n|, sharpness)` normalisés ; `triplanarTexture` fait de même avec trois lectures d'une texture. Dans un lot statique (P12), la position de l'objet est celle du monde.
- **L'aliasing** : `checkerFiltered` et `stripesFiltered` intègrent le motif sur la largeur du pixel (le maximum des dérivées en x et en y), la formule du damier filtré de I. Quilez ; les sommes avec `filtered: true` pondèrent chaque octave par 1 − smoothstep(0,25, 0,5, empreinte × fréquence), l'empreinte étant la plus grande composante de `fwidth(point)`, et la remplacent par sa moyenne (0 pour fbm, 0,65 et 0,2, mesurées, pour ridged et turbulence). L'empreinte peut aussi être donnée (`footprint`) : une cuisson, l'étape de sommets.

## 6. La cuisson

`bakeTexture(renderer, { material, width, height, format, mipmaps })` (`engine-core`) : une texture `sampled`, `render-attachment`, `copy-src`, une passe plein écran du render graph qui y rend le matériau, puis `addMipmapPass`. Le pipeline est créé par un premier graphe non exécuté, puis attendu (`renderer.whenReady()`) quand le renderer les crée de façon asynchrone.

Par un calcul, il faudrait écrire une texture depuis un compute graph : les compute graphs n'écrivent que des storage buffers (P2 et [cg-webgl2.md](cg-webgl2.md)), et l'API n'a pas de copie d'un buffer vers une texture. La passe plein écran fait le même travail sur les trois backends, sans rien ajouter. Le calcul garde son usage là où le résultat va au CPU : les tests comparent ainsi le GPU au CPU (§7).

Une texture cuite doit souvent se répéter : la roche de la démo lit ses bruits sur un **tore de l'espace 4D** (les u et v de la texture comme deux angles, (cos u, sin u, cos v, sin v) × r), ses bords se raccordent.

## 7. Le CPU, et les tests

`@fdw/engine-noise` refait en TypeScript les hachages (`Math.imul`, `>>>`), les bruits, les sommes et la déformation du domaine, dans le même ordre d'opérations. Les tests :

- **Le CPU seul** (`engine-noise`) : les hachages comparés à l'implémentation de référence en C, les intervalles, la continuité, les sommes.
- **Le compilateur** (`engine-shader`) : chaque bruit de chaque dimension se compile, la boucle du Worley 4D, les octaves déroulées ou en boucle, le filtrage refusé hors de l'étape de fragments, le triplanaire, l'imbrication et les erreurs des boucles ; les trois générateurs écrivent la boucle et les opérateurs entiers.
- **Le GPU contre le CPU** (`tests/rendering`, sur Dawn, Vulkan et WebGL2) : un compute graph évalue en 64 points (des multiples de 1/32, exacts en flottants) chaque bruit en 2D, 3D, 4D, les hachages, le Worley, les sommes (déroulées et en boucle, la boucle à nombre de tours en uniform), la déformation. **Les hachages sont égaux au bit près, les valeurs à 2·10⁻⁵ près** (5·10⁻⁵ pour les sommes) sur les trois backends. Le damier filtré devient gris là où ses cases font un dixième de pixel, le non filtré reste noir et blanc ; une texture cuite a ses niveaux, le dernier gris. Tous les programmes sont validés par DXC et glslang.

## 8. Les démos

- **La galerie** (`buildGallery`, `demo-scenes`) : bois (cernes autour de l'axe, déformés), marbre (domaine déformé deux fois, veines d'un sinus), roche (cellules de Worley, fissures, relief par bump mapping), lave (bruit 4D animé par le temps), briques et tuiles (sur les uv), roche cuite en mapping triplanaire, sur un damier filtré ; native (`procedural`) et dans la documentation.
- **Le terrain du TPS** : ses reliefs par un fbm de `@fdw/engine-noise` ; son sol, l'humus scanné dont la répétition est cassée par des bruits de la position dans le monde (taches, le scan à une seconde échelle) ; la roche cuite (pendant le chargement des modèles) sur ses pentes, en mapping triplanaire.
- **Le terrain procédural** de la documentation : les hauteurs sur le CPU, la mousse sur le GPU par un fbm, et des rochers posés par le CPU là où le même fbm dépasse un seuil, toujours sur la mousse.

## 9. Reportés

- De vraies fonctions dans le code généré : un fbm de bruits 3D inliné fait quelques milliers d'instructions ; des `fn` WGSL et des fonctions GLSL et HLSL réduiraient le code et sa compilation par le pilote.
- Les dérivées analytiques des bruits (le gradient avec la valeur), pour des normales sans dérivées d'écran et dans l'étape de sommets.
- La cuisson par un calcul dans une texture (les storage textures), et dans des textures 3D.
- Des motifs de plus (hexagones, chevrons), et le mapping triplanaire des normal maps.
