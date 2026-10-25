# P21 : les fluides

Le design de la phase P21 de la [roadmap](roadmap.md#p21-les-fluides) : de l'eau et de la fumée simulées sur le GPU, sur les trois backends, qui poussent et portent les corps de la physique.

Contraintes : un seul code pour WebGPU, Vulkan et WebGL2 (les compute graphs, émulés en WebGL2 : [cg-webgl2.md](cg-webgl2.md)) ; rien de plus dans l'API abstraite ni dans le compilateur ; le rendu de l'eau de P17 partagé ; le reste du moteur (matériaux, render graph, physique) inchangé.

## 1. Les choix

| Question                | Choix                                                                                                                                                                          | Écartés, et pourquoi                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Les méthodes            | **Les trois** : un champ de hauteur, une grille eulérienne, des particules ; trois classes qui partagent les corps, les passes et le rendu                                     | Une seule méthode : aucune ne fait à la fois un lac sur un relief (le champ de hauteur), la fumée (la grille) et l'eau qui éclabousse (les particules)                                                                                                                                |
| Le champ de hauteur     | **Les tuyaux virtuels** (O'Brien et Hodgins, Mei et al.) : des flux entre cellules voisines, la masse conservée, les cellules sèches                                           | L'équation des ondes linéaire : des ondes, pas d'écoulement (ni rivière, ni bassin qui se vide) ; les équations de Saint-Venant complètes : l'advection en plus, instable sans schéma soigné                                                                                          |
| La grille               | **Stable fluids** (Stam) sur une **grille décalée** (MAC) : advection semi-lagrangienne, confinement de la vorticité, pression par Jacobi ; la 2D est une grille d'épaisseur 1 | Une grille de centres (Harris, GPU Gems) : essayée d'abord, son damier de pression empêchait la fumée de contourner un obstacle (§4) ; MacCormack ou BFECC : deux advections de plus, à garder pour plus tard ; le multigrille : plus de passes et de buffers pour des grilles de 64³ |
| Les particules          | **Position-based fluids** (Macklin et Müller) : des contraintes de densité résolues en quelques itérations, de grands pas de temps                                             | SPH faiblement compressible : des pas de temps dix fois plus courts ; FLIP : une grille et des particules, deux fois le code                                                                                                                                                          |
| Les voisins             | **Un tri bitonique** des particules par cellule, puis le début et la fin de chaque cellule : sans atomiques, en compute graphs                                                 | Le tri par comptage : il demande des atomiques, que les compute graphs n'ont pas (ni WebGL2) ; une grille de listes de taille fixe : des voisins perdus dans les cellules pleines                                                                                                     |
| Où vivent les champs    | **Des storage buffers de `vec4`**, lus par les matériaux (bilinéaire, trilinéaire à la main)                                                                                   | Des textures : les compute graphs n'en écrivent pas ([P17 §1](p17-ocean.md#1-les-choix))                                                                                                                                                                                              |
| Les corps → le fluide   | **`FluidBodies`** : les corps de la physique (sphères, boîtes orientées) dans un buffer, lus par les trois simulations                                                         | Une voxelisation des colliders : un passage de plus, et les formes du moteur physique à exposer ; les maillages : coûteux, rarement utiles pour pousser un fluide                                                                                                                     |
| Le fluide → les corps   | **La `Buoyancy` de P17** : la hauteur de l'eau et sa **vitesse** (les courants) relues du GPU, une image de retard                                                             | Des forces réduites sur le GPU : sans atomiques, une réduction par corps ; les particules frontières (Akinci) : un second jeu de particules dans le tri                                                                                                                               |
| Le rendu de l'eau       | **Le matériau de la mer** (`oceanGraph`) sur un `WaveShader` du champ de hauteur, dessiné par l'`OceanRenderer`                                                                | Un second matériau d'eau : deux looks à tenir ; l'écume et la réfraction refaites                                                                                                                                                                                                     |
| Le rendu de la fumée    | **Une marche dans le volume en plein écran**, arrêtée à la profondeur de la scène, la lumière du soleil précalculée par cellule                                                | Une boîte dessinée en matériau transparent : ni la profondeur de la scène (la fumée devant un obstacle), ni les faces arrière seules ; des tranches : des artefacts de biais                                                                                                          |
| Le rendu des particules | **En espace écran** : la profondeur des sphères, lissée, ses normales, éclairée comme l'eau de la mer                                                                          | Des sphères : des billes, pas un liquide ; les marching cubes : une grille de densité et des sommets en calcul (dispatch indirect, absent de WebGL2)                                                                                                                                  |

## 2. Les corps

`FluidBodies` réunit les corps de `engine-physics` qui touchent les fluides : leurs colliders de sphère et de boîte, chacun où il est ; l'encombrement des autres (capsules, cylindres, enveloppes convexes) ; ou une forme donnée à `add`. `addShape` ajoute une forme bougée par l'application (un obstacle, une pagaie) : à chaque image, `update()` écrit dans un storage buffer, pour chaque forme, six `vec4` : le centre et la sorte, la rotation (quaternion), la taille, la vitesse, la vitesse angulaire, le centre de masse du corps. Les compute graphs les parcourent par une boucle (`fold`) sur leur nombre (un uniform) : au plus 64 corps.

Dans les graphs, `bodyDistanceInGraph` donne la distance signée d'un point à un corps et la normale, `bodyVelocityInGraph` la vitesse de sa surface en ce point (v + ω × r), `bodySpanInGraph` son étendue verticale au-dessus d'un point (une droite verticale contre une sphère, contre une boîte orientée par ses plans) ; les mêmes fonctions sur le CPU (`bodyContact`, `bodySpan`).

## 3. L'eau en champ de hauteur

`ShallowWater` : une grille de `nx × nz` cellules carrées (`cell` mètres), sur un sol (`ground`, une hauteur par cellule). L'état est dans deux paires de buffers, lues et écrites tour à tour :

- `cells` (`vec4`) : la profondeur d'eau d, l'occupation o (la hauteur de corps dans la colonne d'eau), la vitesse (u, w) ;
- `flux` (`vec4`) : les débits sortants vers les quatre voisines (−x, +x, −z, +z), en m³/s.

**Un pas** (de `dt` fixe, plusieurs par image, deux dispatchs) :

1. **Les flux** : la surface d'une cellule est H = sol + d + o ; chaque flux sortant gagne dt · g · (H − H_voisine) · cell (un tuyau de section cell²) et perd `damping` ; aucun flux négatif ; puis tous les flux d'une cellule sont réduits d'un facteur K = min(1, d · cell² / (Σ flux · dt)) : une cellule ne donne pas plus d'eau qu'elle n'en a. Les bords sont fermés (des murs) ou ouverts (l'eau s'en va, comme vers une cellule sèche du même sol).
2. **La profondeur** : d += dt · (Σ flux entrants − Σ flux sortants) / cell² ; la vitesse, des flux qui traversent la cellule (sur une profondeur d'au moins 1 cm : pas de vitesses folles sur l'eau qui s'assèche) ; les sources (`addSource` : une hauteur par seconde sur les cellules dont le centre est dans le disque, le débit divisé par leur aire : le volume exact) ; l'occupation des corps.

**L'occupation** : o = `stiffness` × (la part de chaque corps sous la seule eau de la colonne, du sol à sol + d), plafonnée à la hauteur du corps au-dessus du sol. Un corps qui s'enfonce élève la surface de sa colonne, les flux poussent l'eau vers les voisines : la vague ; sous un corps qui flotte, l'eau se vide jusqu'à ce que sa surface rejoigne celle autour. Avec une raideur k, le corps écarte k / (k + 1) de l'eau qu'il déplace (6 : 86 %). Écartée : l'occupation qui suit exactement la surface (la part du corps sous H = sol + d + o du pas d'avant) : elle intègre l'écart sans force de rappel, la colonne sous le corps oscille comme un tube en U, sans fin (de 0,1 à 0,97 m d'eau sous une balle immobile, sur une période de 20 s) ; aucun amortissement des flux ne l'arrête. La forme algébrique est stable au plus grand pas (test : une balle à moitié dans l'eau, l'eau au repos au bout de 30 s, la surface relevée de 75 à 100 % du volume déplacé).

La masse est conservée (test : la somme des profondeurs, sans source ni bord ouvert). La condition de stabilité, dt < cell / √(g d) : `update(dt)` découpe l'image en pas de `maxStep` = cell / √(g × `maxDepth`) / 2 au plus.

**La surface pour le rendu** : un troisième dispatch par image écrit `surface` (`vec4`) : H, ∂H/∂x, ∂H/∂z (différences centrées, sur les voisines mouillées) et la vitesse, −1 au sec ; les cellules sèches sont descendues sous le sol (de 5 cm) : le bord de l'eau coupe le terrain au lieu d'y scintiller, et leurs pixels sont écartés (`coverage`, un matériau masqué).

**Le rendu** : `WaterSurface` est un item de rendu : une grille régulière sur le domaine, le matériau de la mer (`oceanGraph`) sur le `WaveShader` du champ de hauteur (`heightFieldShader`) : déplacement vertical lu en bilinéaire, pentes pour les normales, et l'écume des rapides (la vitesse, au-delà de `foamSpeed`, rapportée au jacobien que lit le matériau). Il est dessiné par l'`OceanRenderer`, qui accepte tout `WaterItem` (un `WorldRenderItem` avec son matériau et `refraction`) : l'absorption selon la profondeur, la réfraction, l'écume du rivage, le reflet du ciel viennent de P17.

**La physique** : `heightAt(x, z)` (H, bilinéaire) et `velocityAt(x, z)` relus du GPU (une image de retard, comme le spectre) ; avant la première relecture, l'eau du départ. Le même pas sur le CPU (`stepShallowWater`) est la référence des tests. La `Buoyancy` gagne `velocityAt` (optionnel) : la traînée se calcule contre la vitesse de l'eau, et un courant emporte ce qui flotte.

## 4. La fumée et le feu

`SmokeGrid` : une grille de `nx × ny × nz` cellules cubiques (`cell` mètres) posée dans le monde (`origin`). La 2D est une grille d'épaisseur 1 : le même code, rendue sur un plan (`smokePlaneGraph`). La grille est **décalée** (MAC) : la vitesse à travers les faces, une entrée de plus selon chaque axe (l'entrée (i, j, k) porte les trois faces basses de la cellule (i, j, k)). État :

- `velocity` (`vec4`, sur les faces) : la vitesse à travers les faces basses x, y, z de la cellule ;
- `scalars` (`vec4`) : la densité de fumée, la température ;
- `vorticity` (`vec4`) : le rotationnel au centre, sa norme ;
- `pressure` (`vec4`) : la pression, la divergence ;
- `solids` (`vec4`) : obstacle ou non, la vitesse de l'obstacle (les corps, à chaque image).

**Une image** (7 + `iterations` dispatchs) :

1. **Les obstacles** : les cellules dont le centre est dans un corps prennent sa vitesse en ce point ; les autres non.
2. **L'advection** : chaque face remonte la vitesse (semi-lagrangien, un pas au point milieu) et lit la composante qui la traverse ; chaque cellule fait de même pour les scalaires (la vitesse en un point est trois lectures trilinéaires, une par composante). Puis les forces : la flottaison (`buoyancy` × température, vers le haut) et le poids de la fumée, sur les faces y ; les **émetteurs** (une sphère qui verse fumée et chaleur, souffle avec `velocity`, vacille avec `turbulence` : un bruit simplex qui monte à travers elle) ; la dissipation de la densité et le refroidissement.
3. **La vorticité** : ω = ∇ × u aux centres (les vitesses des centres, moyennes des faces), puis la force de confinement ε · cell · (N × ω), N la direction croissante de |ω|, ramenée aux faces : les volutes que l'advection efface.
4. **La divergence** (le débit net à travers les six faces), puis **la pression** : `iterations` pas de Jacobi (20 par défaut) sur les voisines d'air ; les obstacles et les murs sont écartés de la somme (Neumann), les faces ouvertes comptent une pression nulle (Dirichlet).
5. **La projection** : chaque face perd l'écart de pression entre ses deux cellules ; les faces voisines d'un obstacle prennent sa vitesse, celles des murs zéro (glissement libre).

**La grille de centres, d'abord.** La première version gardait la vitesse aux centres (Harris, GPU Gems 1) : la divergence et le gradient y sont des différences centrées sur deux cellules, le laplacien de Jacobi sur une ; la pression ne voit pas le damier des vitesses. Sous un obstacle, les vitesses alternaient de signe d'une rangée à l'autre et la fumée restait plaquée dessous. La grille décalée met la divergence, le laplacien et le gradient sur les mêmes faces : la projection est exacte (test : la divergence réduite de 95 % par la résolution) et la fumée contourne l'obstacle.

**La lumière** : un dispatch de plus marche de chaque cellule vers le soleil (`lightSteps` cellules) et écrit la transmittance : `shade` (`vec4`) : la densité, la lumière reçue, la température, le combustible. Le rendu ne lit que ce buffer : huit lectures par pas de la marche.

**Le rendu** : `SmokeRenderer.addPass(graph, { smoke, color, depth })` : une passe plein écran. Pour chaque pixel, la droite de la caméra coupe la boîte de la grille ; la marche va de l'entrée jusqu'à la sortie ou la profondeur de la scène (un obstacle dans la fumée la coupe), à pas fixes (`steps`, 64), décalés par pixel d'un bruit (le banding devient un grain) ; à chaque pas, l'extinction (densité × `extinction`), la lumière du ciel et du soleil diffusée (fonction de phase de Henyey-Greenstein), l'**émission** de ce qui brûle (au-delà de `fireThreshold`, croissante, rouge sombre puis la couleur du feu) : le feu. La couleur de la scène derrière est atténuée par la transmittance.

**Les valeurs par défaut des uniforms** : le `ComputeRunner` laisse à zéro les uniforms sans valeur, quel que soit leur `default` (contrairement aux matériaux). Les fluides compilent leurs graphs avec ces défauts (`compileFluid`) et les donnent à chaque dispatch ; sans eux, le seuil des colonnes des particules valait 0 et tout flottait sur la cellule la plus haute.

## 5. Les particules

`ParticleFluid` : `count` particules (une puissance de deux), de rayon r, dans une boîte (`bounds`) découpée en cellules de côté h = 4 r (le rayon du noyau). L'état : `positions` et `velocities` (`vec4`), dans l'ordre des cellules depuis le dernier tri.

**Un pas** (par sous-pas) :

1. **La prédiction** : v += g dt ; p* = p + v dt.
2. **Le tri** : la clé de chaque particule (la cellule de p*), puis un tri bitonique des paires (clé, indice) : log₂ n (log₂ n + 1) / 2 dispatchs, un par étape (une table par étape, comme les papillons de la FFT) ; chaque thread écrit son seul élément (le minimum ou le maximum de la paire), sans dispersion.
3. **Les cellules** : effacées, puis le début et la fin de chaque cellule écrits par les particules triées qui changent de clé (`when`).
4. **Le réordonnancement** : positions, vitesses et prédictions recopiées dans l'ordre trié : les voisins d'une cellule sont contigus en mémoire.
5. **Les contraintes de densité** (`iterations`, 4) : λ_i = −C_i / (Σ |∇C|² + ε), C_i = max(ρ_i / ρ0 − 1, 0) (noyaux poly6 et spiky ; ρ0 la densité d'un réseau au repos, ε 5 % de Σ |∇C|² au repos) ; puis Δp_i = Σ (λ_i + λ_j + s_corr) ∇W / ρ0 (s_corr = −`tensile` (W / W(0,2 h))⁴ / Σ |∇C|²_repos, la pression artificielle, contre les grumeaux) ; puis les collisions : les parois de la boîte et les corps (la particule sortie de la forme ; sa vitesse suit du déplacement).
6. **Les vitesses** : v = (p* − p) / dt, puis la viscosité XSPH ; p = p*.

Les voisins sont une boucle sur les 27 cellules autour, puis sur les particules de chacune (deux `fold` imbriqués, le nombre lu dans le buffer des cellules), plafonnées à `maxPerCell` (48).

**La stabilité** : un barrage qui se rompt dans une cuve de 2,4 m (6 480 particules de 2,5 cm, 2 pas de 1/120 s) explosait contre la paroi d'en face avec 3 itérations et `tensile` à 0,1 : des centaines de particules à la vitesse plafond, collées au couvercle — sur le CPU comme sur le GPU. 5 itérations, ou `tensile` à 0,02, suffisent chacun ; les défauts sont 4 et 0,03 (vitesse la plus grande : 4,8 m/s, au repos en 4 s).

**La physique** : un dispatch par colonne de cellules donne la hauteur du liquide (depuis le haut, la première cellule d'au moins `columnCount` (3) particules, puis la plus haute particule dedans, plus un rayon) et leur vitesse moyenne : relues une image plus tard, ce sont `heightAt` et `velocityAt` de la `Buoyancy`.

**Le rendu** (`ParticleFluidRenderer`) :

1. **La profondeur** : chaque particule un carré face à la caméra, la profondeur de vue de la sphère écrite par pixel (`rgba16float`) ; le test de profondeur contre la scène ;
2. **Le lissage** : un filtre bilatéral séparable (en travers puis en hauteur, trois fois, 17 prises), sa largeur selon la taille de la particule à l'écran : la surface au lieu des billes ;
3. **L'éclairage** : les normales de la profondeur lissée (différences des voisins), la lumière de l'eau de P17 (le reflet du ciel par Fresnel, le soleil, la scène derrière déviée et absorbée sur l'épaisseur — l'écart à la profondeur de la scène).

**En WebGL2**, le calcul émulé est lent pour un tri d'une centaine de dispatchs : les particules y sont disponibles, en moins grand nombre (4 096 de 3 cm dans les exemples de la documentation, 16 384 de 2 cm en WebGPU).

## 6. Le partage avec P17

- `OceanRenderer` dessine tout `WaterItem` (un item de rendu sur le matériau de la mer, avec `refraction`), plus seulement un `Ocean`.
- `WaveShader.coverage` (optionnel) : où il y a de l'eau, les pixels sous 0,5 écartés (un matériau masqué) : les cellules sèches.
- `WaterHeight.velocityAt` (optionnel) : la `Buoyancy` freine contre la vitesse de l'eau ; un courant emporte les corps.
- `Ops` est exporté (les raccourcis des graphs longs), avec les comparaisons, `or`, `xor`, `remainder`, `shiftRight`.

## 7. Mesures

Les trois démos (`basin`, `smoke`, `splash`), 1280 × 720, RTX 2060 SUPER, sans vsync, tout compris (la scène, la physique, le rendu) :

| Démo                                          | Vulkan (ms par image) | Dawn (ms par image) |
| --------------------------------------------- | --------------------- | ------------------- |
| Une mare, 128² cellules, 5 corps qui flottent | 1,4                   | 3,3                 |
| La fumée et le feu, 48 × 96 × 48 cellules     | 4,2                   | 5,5                 |
| Une cuve, 12 100 particules, 2 sous-pas       | 2,8                   | 5,8                 |

En WebGL2 sur SwiftShader (les images de référence de la documentation), une image de la fumée de 32 × 64 × 32 cellules prend environ 1,2 s, une image de 4 096 particules 0,8 s.

## 8. Tests

- **`engine-fluids`** (26 tests) : les pas du CPU (l'eau conservée, le repos d'un lac sur un sol inégal, une goutte qui s'étale de même dans toutes les directions, les sources exactes, les bords ouverts, une balle qui relève l'eau sans la faire osciller ; la fumée qui monte, la divergence réduite par la projection, l'écoulement autour d'un obstacle, la 2D qui reste dans son plan, la lumière à travers la fumée ; le noyau d'intégrale 1, les étapes du tri bitonique, un bloc au repos à la densité de repos, un barrage qui se rompt sans sortir de sa boîte, les collisions et les particules inutilisées) ; les corps (distance signée et normale d'une boîte tournée, étendue verticale, `FluidBodies` et son buffer) ; les compute graphs et les matériaux compilés ; les dispatchs de chaque fluide (faux backend).
- **`engine-ocean`** : la `Buoyancy` emportée par le courant.
- **Suite de rendu, trois backends** (Dawn, Vulkan avec la couche de validation, WebGL2 sur SwiftShader) : **les pas du GPU égaux à ceux du CPU** (le champ de hauteurs avec une boîte tournée, une source et une éclaboussure ; la fumée en 3D et dans un plan, avec un obstacle, un émetteur qui vacille et un qui souffle ; les particules mélangées, triées, avec une sphère) ; le fond vu à travers l'eau peu profonde ; la fumée qui cache le fond ; le liquide qui absorbe le rouge du fond. Tous les programmes validés en HLSL (SPIR-V) et en GLSL ES.
- **Documentation** : les tutoriels « L'eau sur un sol », « La fumée et le feu », « Un liquide de particules » (EN, FR), six exemples vivants et leurs captures en WebGPU et WebGL2 ; le guide « Les fluides ».

## 9. Reportés

- Le champ de hauteurs : l'advection de la vitesse (les équations de Saint-Venant complètes : des sillages qui suivent un bateau), le couplage avec la mer de P17 (une côte où la mer entre dans une rivière), l'écume qui dure.
- La fumée : MacCormack, une grille qui suit la caméra ou s'étend (des grilles creuses), les ombres de la fumée sur la scène.
- Les particules : la pression du liquide sur les corps (des particules frontières, Akinci), l'écume et les embruns, la surface en marching cubes, une épaisseur mesurée (les particules additionnées) au lieu de l'écart à la scène.
- Le dispatch indirect sur les seules particules actives ; les valeurs par défaut des uniforms appliquées par le `ComputeRunner` lui-même.
- Les fluides dans l'éditeur (P20) : des composants pour les sources, les émetteurs et les volumes.
- Les ombres des terrains en cascades dans la démo du bassin : des traits sombres aux limites des cascades sur le terrain en patchs (coupées dans la démo ; à voir avec P3b).

## 10. État

**Faite** (25 octobre 2026) : `@fdw/engine-fluids` (`ShallowWater`, `WaterSurface`, `SmokeGrid`, `SmokeRenderer`, `smokePlaneGraph`, `ParticleFluid`, `ParticleFluidRenderer`, `FluidBodies`, les pas du CPU), les démos `basin`, `smoke` et `splash` de `demo-scenes` (web `/basin`, `/smoke`, `/splash` ; natif `basin`, `smoke`, `splash`), les tutoriels et le guide, le partage avec `engine-ocean` (§6).
