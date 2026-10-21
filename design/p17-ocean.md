# P17 : la mer et les vagues

Le design de la phase P17 de la [roadmap](roadmap.md#p17-la-mer-et-les-vagues) : une mer animée sur les trois backends, éclairée de façon physique, qui porte les corps de la physique.

Contraintes : un seul code pour WebGPU, Vulkan et WebGL2 ; rien de plus dans l'API abstraite ni dans le compilateur ; la hauteur de l'eau sur le CPU, pour la physique ; le reste du moteur (matériaux, render graph, physique) inchangé.

## 1. Les choix

| Question                    | Choix                                                                                                         | Écartés, et pourquoi                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Les vagues                  | **Les deux** : des sommes de Gerstner et le spectre de Tessendorf, derrière une même interface (`WaveShader`) | Gerstner seul : pas l'air du large ; le spectre seul : pas de vagues exactes sur le CPU pour un lac, un jeu stylisé                                                          |
| La FFT                      | **Des compute graphs** (spectre, étapes de papillons, champs), une table de papillons par étape               | Un rendu dans des textures écrit à la main pour WebGL2 : les compute graphs y tournent déjà par des points ([cg-webgl2.md](cg-webgl2.md)), le même code partout              |
| Où vivent les champs        | **Deux storage buffers de vec4**, lus en bilinéaire par le matériau (4 lectures par cascade)                  | Des textures : les compute graphs n'écrivent pas de textures, et l'API n'a pas de copie buffer → texture ([P14 §6](p14-procedural.md#6-la-cuisson)) ; pas de mipmaps (§4)    |
| Huit champs réels           | **Rangés deux par deux** dans quatre champs complexes (a + ib), leurs spectres étant hermitiens               | Huit FFT : deux fois plus de passes et de mémoire                                                                                                                            |
| La répétition               | **Des cascades** (233, 37,7 et 6,3 m), chacune une bande de longueurs d'onde                                  | Une tuile : la répétition se voit de haut ; une tuile plus grande : moins de détail                                                                                          |
| La surface                  | **Des anneaux (clipmap)** autour de la caméra, déplacés par pas de leur plus grande cellule                   | La tessellation de P3b : ses patchs sont fixes dans le monde, la mer va jusqu'à l'horizon où que soit la caméra ; une grille projetée : les sommets glissent sous les vagues |
| Voir sous l'eau             | **Un `OceanRenderer`** : la scène et sa profondeur, le ciel copié, puis la mer qui les lit                    | Un matériau transparent : ni la profondeur d'eau (absorption, écume du rivage) ni la scène déviée                                                                            |
| La flottaison               | **Des points** par corps (Archimède et frein de l'eau), sur l'API abstraite de la physique                    | Le volume immergé exact d'un maillage : coûteux, et un moteur physique l'a rarement ; une force au centre : le corps ne se redresse pas                                      |
| La hauteur pour la physique | Analytique pour Gerstner ; **relue du GPU sans attendre** (une image de retard) pour le spectre               | Une FFT sur le CPU à chaque pas : 100 ms à 128 points ; attendre la relecture : un aller-retour par image                                                                    |

## 2. Les vagues

Les deux sources donnent, en chaque point (x0, z0) de la surface au repos, son déplacement (dx, h, dz) et ses dérivées (∂h/∂x, ∂h/∂z, ∂dx/∂x, ∂dz/∂z, ∂dx/∂z). La normale est le produit vectoriel des tangentes de la surface déplacée, le jacobien du mouvement horizontal (1 + ∂dx/∂x)(1 + ∂dz/∂z) − (∂dx/∂z)² donne l'écume.

**Le spectre** (Tessendorf, _Simulating Ocean Water_) :

- Sur le CPU, une fois (`createSpectrum`) : pour chaque vecteur d'onde **k** de chaque cascade, h0(**k**) = (ξr + iξi)/√2 · √(S(**k**) Δk²/2), ξ gaussiens (Box-Muller sur un générateur à graine), S le spectre : **JONSWAP** (S(ω) = α g² ω⁻⁵ e^(−5/4 (ωp/ω)⁴) γ^r, α et ωp par la vitesse du vent et le fetch, converti en nombres d'onde par dω/dk / k) ou **Phillips** (A e^(−1/(kL)²)/k⁴ cos²θ), étalé par cos^2s(θ/2) normalisé. La variance des hauteurs est l'intégrale du spectre (test : à 20 % près sur une mer tirée).
- La relation de dispersion de l'eau profonde ω = √(gk) (finie : √(gk tanh(kd))), **arrondie aux multiples de 2π/T** (T = 200 s) : la mer boucle, et la phase ωt reste petite en `f32` quel que soit le temps (t mod T sur le CPU).
- Les ondes de Nyquist (première ligne, première colonne) sont retirées : leur opposée est elle-même, ce qui laisserait des parties imaginaires dans les champs rangés par deux.
- **Les bandes** : la cascade c garde |k| de la fin de la bande précédente à 4 vagues sur le côté de la tuile suivante (2π·4/L_{c+1}) ; une cascade dont la bande dépasserait sa fréquence de Nyquist (πN/L_c) est refusée.
- Sur le GPU, à chaque `update(time)`, quatre compute graphs, **16 dispatchs** en 128 (un par étape) dans une seule soumission, une passe de calcul chacun : le spectre au temps t et les quatre champs complexes rangés (dx + i dz, h + i ∂dx/∂z, ∂h/∂x + i ∂h/∂z, ∂dx/∂x + i ∂dz/∂z), 7 étapes sur les lignes, 7 sur les colonnes, les champs (le signe (−1)^(x+z) des ondes centrées sur k = 0, la `choppiness`). Les étapes vont et viennent entre deux paires de buffers ; chaque dispatch lie ses propres ressources (une table de papillons par étape), donc ses propres uniforms ([`ComputeRunner`](../packages/engine-core/src/compute/ComputeRunner.ts) partage les uniforms des dispatchs d'une soumission qui lient les mêmes ressources).
- **La FFT** : une décimation en temps de rayon 2, hors place ; l'étape s a, pour chaque point i, (a, b, w) tels que out[i] = in[a] + w · in[b], la première lisant son entrée dans l'ordre des bits inversés. Les tables sont calculées sur le CPU (`butterflyTables`) ; la même FFT tourne sur le CPU (`inverseFft2d`), comparée à la DFT directe dans les tests.
- Une cellule de WebGL2 est un `vec4` : un texel par élément, un seul dessin par écriture (deux par dispatch).

**Gerstner** : chaque vague a sa direction, sa longueur, son amplitude A, sa raideur Q ; le mouvement horizontal est Q/(k·n) (GPU Gems 1, ch. 1). Ses constantes sont dans le code du matériau, ses phases (φ − ωt ramenées à [0, 2π) sur le CPU) dans des uniforms `vec4`, quatre par uniform.

## 3. La surface

`clipmapGrid` : 7 anneaux de 2 × 32 cellules, de 0,5 m à 32 m (1 km de chaque côté), puis une jupe de carrés qui doublent jusqu'à 20 km au moins : 22 553 sommets, 44 768 triangles, un seul mesh statique.

- **Le suivi de la caméra** : la matrice monde est une translation par pas de la plus grande cellule (32 m). Les sommets restent sur les mêmes points du monde : les vagues ne glissent pas sous eux.
- **Pas de fissure** : sur le bord extérieur d'un anneau, les sommets impairs (entre deux sommets de l'anneau suivant) sont ramenés sur leur voisin pair, à la construction. Les triangles s'y replient (les dégénérés sont retirés), les arêtes des deux anneaux coïncident. La translation garde la parité. Entre le dernier anneau et la jupe, et dans la jupe, les arêtes ne coïncident pas : les vagues s'y sont effacées, tout est plat.
- **L'effacement des vagues** : dans l'étape de sommets, chaque cascade (chaque vague de Gerstner) s'efface avec la distance à 2 fois son côté (sa longueur), avant que les cellules ne soient trop grandes pour elle, et toutes avant la jupe.

## 4. Le matériau

`oceanGraph`, une surface `unlit` qui calcule sa lumière :

- **Le filtrage sans mipmaps** : les champs sont dans des buffers. Dans l'étape de fragments, une cascade s'efface quand un de ses texels est plus petit que le pixel (l'empreinte du pixel par `fwidth` du point au repos), et la variance de ses pentes (calculée sur le CPU, par cascade : Σ k² S Δk²) s'ajoute à la rugosité GGX : α² + 2σ² (Beckmann). Au loin, l'eau devient un reflet doux au lieu de scintiller.
- **La réflexion** : la texture cube de l'environnement dans la direction réfléchie (jamais sous l'horizon), son niveau selon la rugosité ; Fresnel de Schlick, F0 = 0,02.
- **Le soleil** : GGX, Smith-Schlick, Fresnel sur le demi-vecteur, ses `sunDirection` et `sunColor` (copiés d'une `DirectionalLight` par `setSun`).
- **La transmission** (avec `refraction`) : la scène derrière l'eau à la position du pixel déviée par la normale (moins là où l'eau est mince, pas vers ce qui est devant l'eau), absorbée par e^(−absorption × épaisseur), l'épaisseur étant l'écart des profondeurs de vue ; la lumière diffusée par l'eau (`scatterColor` × le ciel et le soleil) pour le reste. Sans `refraction`, l'eau est opaque.
- **La diffusion sous la surface, approchée** : le soleil à travers les crêtes, (−v · l)⁴, plus sur l'eau haute.
- **L'écume** : où le jacobien passe sous `foamThreshold`, et où l'eau est plus mince que `shoreFoam`, morcelée par deux bruits simplex qui dérivent.
- **Le bord de l'eau** : la scène non déviée se fond dans l'eau sur ses premiers centimètres.

`std` n'a pas d'exponentielle : e^x s'écrit `pow(e, x)`.

## 5. Les passes

`OceanRenderer.addPasses` : `scene` (la couleur en `rgba16float`, la profondeur de vue en sortie), `ocean background` (le ciel là où la profondeur vaut 0, écrit deux fois par une cible de plus : l'image et la copie que lit l'eau), `ocean` (la mer sur l'image, la profondeur de la scène chargée, la copie et la profondeur en `inputs`). `render` ajoute le tone mapping. Le ciel est une texture cube sRGB de 64² et ses niveaux (`createSky`), le même que reflète l'eau.

## 6. La flottaison

`Buoyancy`, sur l'API abstraite de `engine-physics` (aucun moteur en dur) : à chaque pas fixe, avant `physics`, chaque point d'un corps (une part égale du volume) mouillé sur `depth` pousse de ρ g V × son immersion et freine contre la vitesse du point (v + ω × r), en ce point (`applyForce(force, point)`). Les corps endormis sur l'eau sont réveillés.

**La barque** : ses points sont un réseau qui remplit la coque jusqu'au plat-bord (379 points, chacun sa cellule), pas seulement son fond : gîtée, elle enfonce plus de volume de son côté bas, ce qui la redresse ; des points sur le seul fond la laissaient chavirer à la première vague. Une coque légère (150 kg) et le poids de l'équipage bas dans la barque (300 kg, un collider de plus) mettent le centre de masse sous l'eau ; `drag` 3 et `angularDamping` 1,5 tiennent lieu de l'énergie qu'une vraie coque perd dans ses vagues. Sur 25 s du spectre de la côte : une gîte moyenne de 8,5° (93° avant, retournée), 30° au plus.

**Accéléré en chemin** : le calcul émulé de WebGL2 dessinait une instance d'un point par thread, que SwiftShader traite instance par instance : une mise à jour du spectre y prenait 22 s. Un seul dessin non instancié de tous les points (le thread et le texel de son élément depuis `gl_VertexID`) : 0,36 s ([cg-webgl2.md §6.3](cg-webgl2.md#63-le-dispatch)), la suite de rendu inchangée.

**Corrigé en chemin** : `engine-physics-rapier` remettait à zéro les forces après chaque pas, pas les couples, que Rapier garde à part : une force en un point faisait tourner le corps de plus en plus (la barque se retournait). `resetTorques` après `resetForces`, et un test.

## 7. Mesures

La côte (`coast`, 1280 × 720, Vulkan, RTX 2060 SUPER, sans vsync, neuf corps qui flottent, la relecture comprise) :

| Vagues                    | ms par image | Images par seconde |
| ------------------------- | ------------ | ------------------ |
| Spectre, 128², 3 cascades | 3,3          | 303                |
| Six vagues de Gerstner    | 1,9          | 532                |

Le spectre seul (`update`, débit sur 300 mises à jour, Vulkan) : **0,16 ms** en 128², 0,65 ms en 256². La relecture du déplacement (768 Ko en 128²) : 0,9 ms de latence, non attendue. Sous Dawn, la côte tourne à 78 images par seconde (400 images, démarrage compris).

## 8. Tests

- **`engine-ocean`** : la FFT contre la DFT directe ; le spectre : sa variance, l'absence de vagues contre le vent avec Phillips, **les huit champs rangés par deux contre la somme directe des ondes** en des points de la grille, la boucle sur la période, la répétition des tuiles, le refus d'une cascade trop petite ; Gerstner : ses dérivées contre des différences finies, la hauteur au-dessus d'un point, les phases ramenées ; la grille : tous les triangles vers le haut, toutes les arêtes partagées sauf celles de la jupe ; la flottaison : la poussée d'un corps à moitié dans l'eau, rien dans l'air, l'oubli des corps retirés ; les compute graphs et le matériau compilés, avec ou sans ce qui est derrière l'eau ; l'océan qui suit la caméra et se dessine (faux backend).
- **`engine-physics-rapier`** : une force en un point ne fait tourner le corps que pendant un pas.
- **Suite de rendu, trois backends** (Dawn, Vulkan avec la couche de validation, WebGL2 sur SwiftShader) : **les champs du GPU égaux à ceux du CPU** à 0,2 % de leur maximum ; le fond rouge vu à travers 15 cm d'eau, la couleur de l'eau au-dessus de 6 m.
- **Documentation** : les tutoriels « La mer et ses vagues » et « Des objets qui flottent » (EN, FR), leurs exemples vivants et leurs captures en WebGPU et WebGL2 ; le guide « L'océan ».

## 9. Reportés

- La vue sous l'eau (le plan de la caméra coupé par la surface, le brouillard sous-marin, les caustiques), les sillages (une simulation locale ajoutée aux champs), l'écume qui dure (un champ accumulé d'une image à l'autre).
- Les vagues sur les hauts-fonds (la profondeur dans la dispersion par endroit, le déferlement) ; l'eau sur le relief pour les lacs et les rivières (P21).
- Les ombres sur l'eau, les autres lumières ; les reflets en espace écran (le rivage dans l'eau), que la réflexion de l'environnement remplace pour l'instant.
- Le choix de la direction et de la force du vent sans recréer le spectre (les amplitudes recalculées en calcul).

## 10. État

**Faite** (21 octobre 2026) : `@fdw/engine-ocean` (`OceanSpectrum`, `GerstnerWaves`, `Ocean`, `OceanRenderer`, `Buoyancy`, `createSky`, la FFT et le spectre sur le CPU), la côte de `demo-scenes` (`createCoast` : web `/coast`, natif `coast` et `coast-gerstner`), les tutoriels et le guide, la correction des couples de `engine-physics-rapier`.
