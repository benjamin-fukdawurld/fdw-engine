# P8 : la démo TPS, l'épée dans la forêt

Le design de la phase P8 de la [roadmap](roadmap.md#p8-démo-tps--lépée-dans-la-forêt) : un jeu à la troisième personne où un rôdeur armé d'une épée affronte des monstres dans une forêt. La phase réunit les précédentes (l'instancing de P1, l'occlusion de P3, le terrain de P3b, la caméra et l'ordonnanceur de P4, les modèles de P5, l'animation de P6, l'audio de P7, la physique de P7b) et ajoute au moteur ce qui manque pour la tenir.

Contraintes : le même jeu sur le web et en natif (Dawn, Vulkan) ; aucun asset dont la licence interdit la redistribution (le dépôt et la doc sont publics) ; la forêt à 60 images par seconde sur la machine de mesure ; chaque brique du moteur avec son tutoriel (EN, FR) et son exemple vivant.

## 1. Aujourd'hui

| Ce qui existe                                                                                     | Ce qui manque                                                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| L'instancing des objets qui partagent mesh et matériau, `scene.createBatch()` (P1)                | Des niveaux de détail : le sapin fourni fait 7 millions de triangles                                |
| Une shadow map par lumière dans un atlas, ses bornes réglables à la main (`ShadowOptions.bounds`) | Les ombres en cascades (prévues en P2, pas faites) : une forêt de 500 m n'a qu'une ombre floue      |
| Le Hi-Z (P3), le terrain en patchs `buildTerrain` et sa hauteur sur le CPU `heightAt` (P3b)       | Le terrain et la scène dans un même rendu (`RenderOptions` prend `source` ou `items`, pas les deux) |
| `OrbitOperator`, `FlyOperator` (P4)                                                               | Une caméra à la troisième personne : bras, collisions, amortissement                                |
| Le chargement glTF : skins, clips, `MASK`, `BLEND`, double face (P5)                              | Les faces arrière éclairées avec la normale de l'avant (`front-facing` inutilisé)                   |
| `Animator`, l'animation graph, les événements de clips, le skinning en calcul (P6)                | Des clips d'épée, un personnage qui la tient                                                        |
| `SceneAudio`, `SoundEffect`, `MusicPlayer`, les sons faits par le code (P7)                       | Les sons d'une forêt et d'un combat                                                                 |
| `PhysicsCharacter`, les capteurs, `shapeCast`, `overlap`, le heightfield (P7b)                    | Des volumes d'attaque et de dégâts, une IA d'ennemis                                                |
| La démo FPS : systèmes ECS, contextes d'entrée, menu dans la ligne d'état, vagues, sons (P4, P7)  | —                                                                                                   |
| —                                                                                                 | Un brouillard, qui cache le bout de la forêt et l'apparition des niveaux de détail                  |

## 2. Les assets

Fournis par l'utilisateur, à la racine du dépôt (non suivis). Les licences décident de ce qui entre dans le dépôt :

| Asset                                                    | Licence                                                            | Contenu                                                                                                                                      | Usage                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Poly Haven : `fir_tree_01`, `fern_02`, `grass_medium_01` | CC0                                                                | Sapin : 3 variantes, **7 M de triangles** (6,7 M d'aiguilles en `BLEND`), 478 Mo ; fougère 6 k (`MASK`) ; herbe 25 k en 17 touffes (`BLEND`) | La forêt                                                             |
| Poly Haven : `forest_ground_04`                          | CC0                                                                | Une sphère d'aperçu ; ses textures (couleur, normales, rugosité)                                                                             | Le matériau du terrain                                               |
| Poly Haven : `antique_estoc`                             | CC0                                                                | Une épée, 8 k triangles                                                                                                                      | L'arme du héros                                                      |
| Quaternius : Modular Character Outfits, `Male_Ranger`    | CC0                                                                | 27 k triangles, 2 matériaux, squelette « UE » de 65 os                                                                                       | Le héros                                                             |
| Quaternius : Universal Animation Library 1 et 2          | CC0                                                                | 86 clips sur le même squelette : `Idle_Loop`, `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`, `Jump_*`, `Roll`, `Death01`, `Sword_*`, `Hit_*`…   | Les animations du héros                                              |
| Quaternius : Ultimate Monsters, `Orc`, `Demon`           | CC0                                                                | 6 à 7 k triangles, une texture atlas commune, 14 clips chacun (`Idle`, `Walk`, `Run`, `Weapon`, `Punch`, `HitReact`, `Death`…)               | Les ennemis                                                          |
| Quaternius : Bestiary (Imp, Puglin)                      | **Quaternius Asset License : redistribution des assets interdite** | —                                                                                                                                            | **Écarté** : un dépôt public les rendrait téléchargeables tels quels |

Aucun n'est utilisable tel quel : trop lourd (le sapin), en `.gltf` et `.bin` hors de LFS, des PNG de 2048 px, des clips répartis dans d'autres fichiers que les modèles. **Un outil de préparation** (`tools/assets/`, Node, `meshoptimizer` et `sharp` déjà dans les dépendances) écrit des `.glb` compacts, versionnés en LFS ; les sources restent hors du dépôt, l'outil documente d'où elles viennent.

### 2.1 Le sapin

Le sapin `fir_tree_01` a 3 variantes de 2,4 à 4,2 millions de triangles. Mesure faite : ses aiguilles ne sont pas des cartes mais **800 000 aiguilles en géométrie** (des bandes de 5 triangles, 7 cm), et 6 600 tiges de rameaux ; leurs textures sont des JPEG sans alpha (le `BLEND` de Poly Haven ne sert à rien). Une simplification par fusion d'arêtes n'a rien à fusionner.

| Option                                                                                            | Intérêt                                                                           | Coût                                                                                        |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A. `meshopt_simplify` sur tout                                                                    | Rien de spécial à écrire                                                          | Inopérant sur les aiguilles ; le mode « sloppy » les déchiquette                            |
| B. Éclaircir les aiguilles (îlots), agrandir celles qui restent                                   | Le taux d'éclaircie fixe le budget                                                | **Essayé, écarté** : agrandies 4 à 8 fois, les aiguilles et les tiges deviennent des bâtons |
| **C. Des cartes texturées : les aiguilles d'une cellule de grille → un quad, leur texture cuite** | **La silhouette et le détail (dans la texture) ; quelques milliers de triangles** | Une rastérisation sur le CPU, une analyse en composantes principales par cellule            |
| D. Des imposteurs (billboards rendus hors ligne)                                                  | Les arbres lointains à 2 triangles                                                | Un rendu hors ligne, l'éclairage figé ; pas nécessaire (voir §11)                           |

**Choix : C**, la technique des feuillages temps réel (`tools/assets/foliage.mjs`) : les aiguilles regroupées par cellules de 30 cm, 60 cm et 1,2 m (un niveau chacune) ; chaque cellule devient un quad dans le plan de ses aiguilles (les deux premiers axes principaux), agrandi de 25 % ; les aiguilles d'une cellule dense (90ᵉ centile) sont rastérisées dans une texture de 256 px avec alpha, aux couleurs de la texture d'origine, dilatées sous l'alpha ; les normales penchées vers l'extérieur du tronc (la couronne éclairée comme un volume). Le tronc et les branches par `meshopt_simplifyWithAttributes`. Résultat : **25 à 31 k, 4,5 à 5,7 k, 570 à 810 triangles** par variante (contre 2,4 à 4,2 M), `fir.glb` de 11,6 Mo. Les aiguilles en `MASK` : elles projettent des ombres découpées. L'herbe et les fougères, de la géométrie aussi, passent en opaque.

### 2.2 Les animations du héros

Les clips sont dans les fichiers UAL, le héros dans un autre. Le moteur lie un clip aux os par **nœud du même modèle** (`AnimationClip.fromData`).

| Option                                                                          | Intérêt                                                                                 | Coût                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **A. Recopier les clips choisis dans le `.glb` du héros, par nom d'os**         | **Un seul fichier ; rien au moteur ; seuls les clips utiles (environ 15) sont chargés** | Fait hors ligne : changer de clips demande de relancer l'outil            |
| B. Lier au chargement par nom d'os (`fromData(data, skeleton, { by: 'name' })`) | Une bibliothèque d'animations partagée entre personnages, au moteur                     | Charger les deux bibliothèques (15 Mo, avec leur mannequin) pour 15 clips |

**Choix : A** pour la démo, les squelettes étant identiques (mêmes noms, mêmes proportions). La liaison par nom, et le vrai reciblage entre squelettes différents, vont à la suite (§11). L'épée est placée sous l'os `hand_r` par le calcul : la pose de la main dans la garde de `Sword_Idle` (cinématique directe sur les clips), la poignée au centre des phalanges du milieu, la lame de l'auriculaire vers l'index, la garde le long des doigts.

Les monstres d'Ultimate Monsters ont leurs propres clips : rien à recopier. La tenue `Male_Ranger` n'a pas de tête (elle suppose celle du pack _Universal Base Characters_, non fourni) : la capuche reste vide, ce qui passe de dos.

### 2.3 Où vivent les assets

Les modèles servent à la doc (exemples vivants), à la démo web et à la démo native. **Choix : `apps/docs/public/models/forest/`**, là où sont déjà ceux des tutoriels ; la démo web les sert sous `/forest/` par un petit plugin Vite (et les copie dans sa construction), la démo native par un `FileSource`. La fabrique de la scène reçoit le moteur physique et une fonction donnant le `ResourceStore` pour un backend.

## 3. Les options du moteur

### 3.1 Les ombres en cascades

L'atlas d'ombres a une tuile par lumière ; le shader lit une matrice et un rectangle par lumière (`lightShadowMatrices`, `lightShadowRects`, 16 lumières).

| Option                                                                   | Intérêt                                                                      | Coût                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A. Jusqu'à 4 cascades pour chaque lumière                                | Général                                                                      | 4 fois les matrices et rectangles par lumière : 4 Ko de plus dans le bloc `frame` pour un cas rare |
| **B. Une lumière directionnelle en cascades, les autres comme avant**    | **Le cas réel (le soleil) ; quelques tableaux de plus dans le bloc `frame`** | Une seule lumière en cascades par image (une deuxième retombe à une tuile)                         |
| C. Une shadow map qui suit la caméra (ce que fait la promenade en ville) | Rien au moteur                                                               | Floue au loin ou courte ; ce que la forêt doit justement montrer                                   |

**Choix : B.** `ShadowOptions.cascades` (nombre de 1 à 4, distance couverte, répartition entre linéaire et logarithmique, `lambda` de Engel, 2006) ; les cascades sont des tuiles de l'atlas, chacune une passe d'ombre ; leurs sphères englobantes stabilisées (rayon fixe, centre arrondi au texel) pour que les ombres ne scintillent pas quand la caméra tourne ou avance. Dans le shader : la cascade choisie par la profondeur du point dans la vue ; près de la fin d'une cascade, la suivante prend une part croissante des pixels (un tramage par bruit à gradient entrelacé, plutôt qu'un fondu qui doublerait le filtrage) ; les ombres s'estompent sur les derniers 15 % de la distance. Les quatre coordonnées d'ombre sont calculées puis choisies par des `select` : pas d'indexation dynamique d'un tableau de l'uniform block, fragile d'un backend à l'autre. Les membres, des valeurs simples : `cascadeMatrix0..3`, `cascadeRect0..3`, `cascadeSplits`, `cascadeOffsets` (le décalage normal de chaque cascade) ; `shadow.x = 2` marque la lumière en cascades. Les trois backends, WebGL2 compris (pas de calcul en jeu). Le reste de P2 (clusters, IBL) reste à faire.

### 3.2 Les niveaux de détail

| Option                                                                                 | Intérêt                                                                                                      | Coût                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A. Le choix dans `RenderSource.query`, par vue                                         | Au plus près du rendu                                                                                        | La requête ne connaît pas la caméra ; les ombres choisiraient d'autres niveaux que la vue (incohérent)  |
| **B. Un composant `lod` et un système de la scène, choisis pour la caméra principale** | **Les ombres et l'occlusion voient les mêmes niveaux, comme les patchs de P3b ; le reste du rendu inchangé** | Un parcours par image des objets à niveaux (2000 arbres : une boucle sur des colonnes)                  |
| C. Sur le GPU (culling et draws indirects)                                             | Aucun coût CPU                                                                                               | Les draws indirects n'existent pas encore ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)) |

**Choix : B**, dans `engine-scene` : `SceneLods`, `lods.add(at, [{ nodes, maxDistance }…])` et le composant `lod` (les renderers de chaque niveau, le niveau courant) ; `update(camera)` ou `install(scheduler, camera)` (phase `render`) montre le niveau dont la distance convient, avec une hystérésis (10 %). Les niveaux écartés ne sont ni cachés ni retirés : leurs renderers reçoivent un drapeau, **`NodeFlags.Culled`**, que les requêtes ignorent, sans invalider leurs transformations ni leur place dans les octrees (cacher un nœud statique le réindexerait). Les niveaux d'un modèle partagent leurs meshes : 2 500 arbres font un draw instancié par niveau et par primitive. La distance est mise à l'échelle par le champ de vision (`referenceFov` 60°), `bias` la multiplie. La convention `…_LOD0`, `…_LOD1` est lue par `findLodGroups(root)`, dans `engine-scene` plutôt que dans le chargeur glTF : elle vaut pour toute hiérarchie, et le chargeur n'a pas à connaître `SceneLods`.

### 3.3 La caméra à la troisième personne

| Option                                                                          | Intérêt                                                                          | Coût                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A. `OrbitOperator` dont le pivot suit le personnage                             | Existe                                                                           | Pas de collision, pas d'épaule, le pivot suit sans amortissement |
| **B. `ThirdPersonOperator` dans `engine-camera`, les collisions par un rappel** | **`engine-camera` reste sans dépendance à la physique ; tout moteur se branche** | Un opérateur de plus                                             |
| C. L'opérateur dans `engine-physics`                                            | Les collisions sans rappel                                                       | La caméra liée à la physique, contraire au §1 de la roadmap      |

**Choix : B.** Les mêmes intentions que les autres opérateurs (`look`, `drag`, `pointer`, `zoom`), la souris verrouillée, la manette. Un bras de longueur réglable derrière un pivot qui suit la cible amorti (ressort critique, une demi-vie par axe), un décalage d'épaule, un tangage borné. Les collisions : `probe(from, to, radius) → distance`, que la démo implémente par `world.shapeCast` d'une sphère en excluant le personnage ; le bras se raccourcit aussitôt et revient en douceur. `forward` et `right` dans le plan, pour déplacer le personnage par rapport à la caméra.

### 3.4 Le terrain et la scène dans un même rendu

**Choix : `RenderOptions` accepte `source` et `items` ensemble** (les items ajoutés à ce que donne la source), plutôt qu'une source composite à écrire par chaque application. Le terrain prend un matériau donné par l'appelant (`buildTerrain(backend, { material })`) : les textures de `forest_ground_04` répétées, mélangées à une teinte plus sèche sur les pentes. Le même tableau de hauteurs fait le heightfield de la physique.

### 3.5 Le reste

- **Les faces arrière** des matériaux double face : la normale donnée au modèle d'éclairage retournée par `front-facing`, dans le lowering du compilateur plutôt que dans les graphs de `engine-assets` : tous les matériaux en profitent, normal maps comprises ; les matériaux simple face ne dessinent pas leurs faces arrière. Une correction, sans tutoriel ; un test de rendu.
- **Le brouillard** : une option du rendu (`fog: { color, density, heightFalloff, height }`), exponentiel, la densité prise à mi-hauteur du rayon, appliqué après le modèle d'éclairage et avant l'exposition par le compilateur, **par fragment** (interpolée entre les sommets d'un grand sol, la distance donnait un sol tout embrumé), sous la feature `fog` : les vues sans brouillard gardent leurs programmes. Le ciel est la couleur d'effacement. Un ciel en dégradé et l'IBL attendent P2.

## 4. Le jeu

### 4.1 La forêt

- **Le terrain** : 512 m de côté (des patchs de P3b, `buildTerrain` ouvert à des hauteurs et un matériau donnés), la zone de jeu dans un rayon de 100 m, bordée d'un rebord trop raide pour le contrôleur (42°). Une clairière plate au départ. Le même tableau de hauteurs fait le heightfield de la physique.
- **Les arbres** : 2 460 sapins des trois variantes, au moins 6 m les uns des autres (un tirage de fléchettes sur une grille), tournés et mis à l'échelle au hasard (0,8 à 1,25), posés par `heightAt`. Créés par lot (`createBatch`, une fois par variante, niveau et primitive), leurs niveaux à 30, 80 et 320 m ; les troncs de la zone de jeu sont des capsules statiques ; les troncs sont des occludeurs.
- **Le sol** : environ 4 700 touffes d'herbe (agrandies 2,5 fois) et de fougères sur la zone de jeu, chacune un groupe d'un seul niveau (28 et 40 m) : plus simple qu'un anneau de cellules recyclées, et sans coût visible (`SceneLods.update` : 0,9 ms pour 7 000 groupes).
- **La lumière** : un soleil bas en cascades (4, 110 m, un atlas de 4096 px), une ambiante froide, un brouillard qui baisse avec la hauteur.

### 4.2 Le héros

Le `Male_Ranger`, l'estoc sous l'os `hand_r` (les os sont des nœuds de la scène : pas d'API de prise à ajouter). Sur un `PhysicsCharacter` (capsule) ; la gravité, le saut et la roulade par le code du jeu. L'animation graph :

- **la locomotion** : `blend1d` sur la vitesse (`Idle_Loop`, `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`), les clips sans root motion, leurs vitesses accordées à celles du contrôleur ;
- **une machine à états** dont chaque état est entré par une condition sur un paramètre `action` (son numéro) : le code du jeu tient l'action (`move`, `air`, `land`, `roll`, `attackA`, `attackB`, `attackC`, les reprises `recoverA` et `recoverB`, `heavy`, `block`, `hit`, `dead`) et ses règles (l'enchaînement mis en attente, la roulade invulnérable, la parade de face), la machine la suit avec ses fondus. Plus simple à lire et à tester que des triggers, qui restent posés tant qu'une transition ne les consomme pas. Le saut se passe de `Jump_Start` (1,3 s d'élan, trop lent pour un jeu) ;
- **les événements** : `step` (les pas), `swing` (le son du coup), `strike` et `strikeEnd` (la fenêtre où la lame frappe), placés là où la main va le plus vite, mesuré sur les clips par cinématique directe.

Les commandes : déplacement **WASD** (ZQSD en AZERTY) ou stick gauche ; caméra à la souris (verrouillée) ou stick droit ; **clic gauche** ou X : attaque légère ; **clic droit** ou Y : attaque lourde ; **Shift** ou L3 : courir ; **Espace** ou A : sauter ; **C** ou B : roulade ; **F** ou LB : parer ; **Échap** : menu.

### 4.3 Les volumes d'attaque et de dégâts

| Option                                                                          | Intérêt                                                                             | Coût                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A. Un capteur cinématique sur la lame, les événements de contact                | Le moteur fait le test                                                              | Un capteur qui se déplace vite saute ses cibles entre deux pas ; actif hors attaque |
| **B. Un `overlap` de capsule le long de la lame, pendant la fenêtre d'attaque** | **Un test seulement pendant la fenêtre ; la capsule balaie la lame entre deux pas** | Une requête par pas et par attaque en cours                                         |

**Choix : B**, réduit à l'essentiel : un `Blow` (des dégâts, un prédicat des colliders de l'autre camp, ce qu'il a déjà touché) et `strikeCapsule` / `strikeSphere`, qui ne rendent une cible qu'une fois par coup. La lame est une capsule de la garde à la pointe, et le balayage de la pointe depuis le pas précédent une seconde. Les ennemis frappent par une sphère devant eux. Le camp d'un collider se lit par un prédicat (`QueryFilter.predicate`) plutôt que par des groupes de collision : `CharacterDesc` n'en a pas (§11). Dans `demo-scenes` : ce sont des règles de jeu ; les graphs de comportement de P9 les reprendront.

### 4.4 L'IA des ennemis

Des systèmes ECS, comme les drones du FPS : un composant `enemy` (type, état, cible, temps dans l'état, vie, recharge) et des systèmes dans la phase `fixed` :

- **`decide`** : `spawn` → `chase` → `attack` → `recover`, `hurt`, `dead` ; deux au plus frappent à la fois, les autres attendent sur un cercle autour du héros ; le démon ne vacille qu'aux coups lourds (sa `poise`). Pas de perception : les vagues viennent pour le héros ;
- **`steer`** : vers le héros ou sa place sur le cercle, à l'écart des autres, autour des troncs devant lui (une grille des troncs, une poussée de côté), sur un `PhysicsCharacter` par ennemi ;
- **`strike`** : les coups de ceux qui frappent ;
- **`animate`** (à chaque image) : les paramètres de leur `Animator`.

Pas de navmesh : un terrain ouvert de troncs se passe de chemins calculés (§11). Des vagues : quelques orcs, puis davantage, puis le démon et ses orcs. 6 à 10 ennemis à la fois : les meshes skinnés ne s'instancient pas, mais leur coût reste petit.

### 4.5 Les sons et l'interface

Faits par le code (`synth.ts`, comme le FPS) : les pas sur l'humus, le sifflement de la lame, l'impact, la parade, les grognements, le cri du démon, la mort ; une ambiance de vent et d'oiseaux en flux, une musique de combat en fondu enchaîné. L'interface est la ligne d'état du FPS : la vie, la vague, les ennemis restants, le menu (reprendre, son, inverser Y, sensibilité).

### 4.6 Où vit le code

`demo-scenes/src/tps/` : `createTpsScene({ physics, resources })` (une fabrique de scène, dont la scène a une promesse `ready`), ses systèmes, ses tests ; la route `/tps` de la démo web ; la scène `tps` de la démo native (`loadedScenes`) ; l'exemple `tps` de la doc et sa page « Un jeu à la troisième personne » dans « Créer un jeu », à côté du FPS.

## 5. Les étapes

Chacune avec ses tests, et son tutoriel (EN, FR, exemple vivant, captures WebGPU et WebGL2) quand elle ajoute une brique au moteur :

1. **L'outil de préparation et les assets** (`tools/assets/`, les `.glb` en LFS, la page de la doc qui cite les sources et les licences).
2. **Les faces arrière** et **`source` avec `items`** (petites corrections).
3. **Les ombres en cascades** : tutoriel « Les ombres en cascades ».
4. **Les niveaux de détail** : tutoriel « Les niveaux de détail » (la forêt de sapins, les niveaux colorés à la demande).
5. **Le brouillard** : ajouté au tutoriel des ombres ou à un tutoriel « L'atmosphère ».
6. **La caméra à la troisième personne** : tutoriel « La caméra à la troisième personne » (le héros qui marche, sans combat).
7. **La forêt** : terrain, arbres, sol, physique.
8. **Le jeu** : héros, volumes d'attaque, ennemis, vagues, sons, menu ; la page « Un jeu à la troisième personne » ; les démos web et native.
9. **Les mesures**, l'état du design, la roadmap.

## 6. Ce qu'il a fallu ajouter au moteur

- **`engine-shader`** : les faces arrière éclairées (le lowering) ; les membres des cascades (`cascadeMembers`, `MaxCascades`) et le choix de la cascade dans `light.shadowMap` ; le brouillard (`fogMembers`, la feature `fog`).
- **`engine-core`** : `ShadowOptions.cascades`, `cascadeSplits`, `sliceSphere`, les tuiles des cascades dans `ShadowCameras` ; `RenderOptions.fog` ; `source` et `items` ensemble ; **l'instancing dans les passes d'ombre** — elles ne triaient leurs objets que par pipeline : les sapins d'un même mesh y étaient dispersés, dessinés un par un (3 669 draws par image dans la forêt, 207 après le tri par pipeline, matériau et mesh de la vue) : un manque de P1, qui ne se voyait pas sur ses scènes.
- **`engine-scene`** : `SceneLods`, `findLodGroups`, `NodeFlags.Culled`.
- **`engine-camera`** : `ThirdPersonOperator`, `ThirdPersonActions`.
- **`demo-scenes`** : le terrain ouvert à d'autres hauteurs et matériaux (`terrainBase`) ; les sons de la forêt et du combat dans `synth.ts` ; ses dépendances aux ressources, au glTF, à l'animation et au skinning.
- **`tools/assets`** : la lecture et l'écriture de glTF, la simplification, les cartes de feuillage, la recopie des clips, l'aperçu en PNG par Dawn.

## 7. Mesures

La machine de mesure : RTX 2060 SUPER, Linux, Node 24. La partie au menu, la clairière vue par la caméra du jeu (environ 1 700 objets visibles, 5 700 projeteurs d'ombre sur quatre cascades) :

| Mesure                                                     | Valeur                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Démo native, Vulkan, 1280 × 720, sans vsync                | environ 90 images par seconde (82 en moyenne sur 1 500 images, chargement compris)         |
| Démo native, Dawn, 1280 × 720, sans vsync                  | environ 62 images par seconde (57 en moyenne, chargement compris)                          |
| Dawn dans Node, 1920 × 1080 : temps CPU d'une image        | 15,4 ms, dont `render` 13,5 ms, `lod` 0,9 ms, animation 0,5 ms, physique 0,4 ms, IA 0,2 ms |
| Appels de dessin par image (vue et quatre cascades)        | 207 (3 669 avant l'instancing des passes d'ombre)                                          |
| Chargement, des fichiers locaux à la première image du jeu | 1,7 à 1,9 s (26 Mo de `.glb` et de JPEG)                                                   |
| Le sapin, LOD0 / LOD1 / LOD2                               | 25 à 31 k / 4,5 à 5,7 k / 0,6 à 0,8 k triangles (contre 2,4 à 4,2 M)                       |
| `make-forest.mjs`, les trois sapins                        | 17 s                                                                                       |

Sur Dawn, le coût restant est surtout le parcours des octrees (18 % du temps CPU : cinq requêtes par image, la caméra et quatre cascades, sur 30 000 entités dont les niveaux écartés) et les appels de Dawn par Node. Pas encore mesurés : WebGPU et WebGL2 dans Chrome sur le GPU (les tests de la doc tournent sur SwiftShader).

## 8. Tests

- **`engine-shader`** : la normale retournée par `front-facing` pour les modèles éclairés seulement ; le brouillard par fragment, sous sa feature.
- **`engine-core`** : les tuiles et les valeurs des cascades (trois cascades, la quatrième répétant la troisième, les décalages croissants), le repli orthographique, `cascadeSplits` (pas égaux, géométriques), `sliceSphere` (les coins dedans, le centre au bout d'une tranche large) ; le brouillard compilé dans les programmes de la vue qui en a un ; `source` et `items` ensemble.
- **`engine-scene`** : le premier niveau avant la première mise à jour, le niveau de la distance (le même dans les ombres), l'hystérésis, le champ de vision, `bias`, le groupe qui bouge, le retrait, les entités d'un lot, l'installation dans l'ordonnanceur, `findLodGroups`.
- **`engine-camera`** : le pivot et le bras, le tangage borné, l'amortissement, le bras raccourci aussitôt et rallongé en douceur, la sonde qui reçoit l'épaule, le zoom.
- **`demo-scenes`** : les hauteurs de la forêt, la grille des troncs, les coups (une fois par coup, la capsule le long de la lame), l'animation graph et les clips du héros, les contrôles, les sons sur un faux moteur audio, la progression du chargement.
- **Suite de rendu, trois backends** : une ombre en cascades, et sa disparition au-delà de sa portée ; une face arrière éclairée ; le brouillard (loin et près).
- **Documentation** : les tutoriels « Les ombres en cascades et le brouillard », « Les niveaux de détail », « La caméra à la troisième personne » et la page « Un jeu à la troisième personne » (EN, FR), leurs exemples vivants et leurs captures (WebGPU, WebGL2) ; deux tests interactifs (une seule carte d'ombre sans brouillard ; Play qui lance la partie).
- **Une partie sans fenêtre** (Dawn, Rapier, une entrée simulée, hors du dépôt) : les vagues, les coups qui tuent, la mort du héros, la reprise.

## 9. Décisions

Validées (17 octobre 2026), avec les ajustements de la réalisation :

1. **Les assets CC0 seulement** ; le Bestiary écarté, la hyène retirée (§2).
2. **Un outil de préparation** hors ligne : des `.glb` compacts en LFS, les sources hors du dépôt (§2).
3. **Le sapin en cartes d'aiguilles texturées** (l'éclaircie essayée, écartée), simplifié en trois niveaux ; les feuillages en `MASK` ou opaques (§2.1).
4. **Les clips recopiés dans le `.glb` du héros** par nom d'os ; l'épée placée par la pose de la main (§2.2).
5. **Une lumière directionnelle en cascades**, jusqu'à 4, stabilisées, tramées entre elles (§3.1).
6. **Les niveaux de détail comme composant et système de la scène**, un drapeau sans invalidation ; la convention `_LODn` lue par `findLodGroups` (§3.2).
7. **`ThirdPersonOperator` dans `engine-camera`**, les collisions par une sonde (§3.3).
8. **`source` et `items` ensemble** ; le terrain avec ses hauteurs et son matériau (§3.4).
9. **Le brouillard exponentiel** comme option du rendu, par fragment, sous une feature (§3.5).
10. **Les coups par `overlap`** pendant la fenêtre de l'animation, une fois par coup, le camp par un prédicat (§4.3).
11. **L'IA en systèmes ECS, sans navmesh** ; l'action du héros tenue par le code, suivie par l'animation graph (§4.2, §4.4).

## 10. État

**Faite** (17 octobre 2026) : les ombres en cascades (`ShadowOptions.cascades`, `cascadeSplits`, `sliceSphere`) et le brouillard (`RenderOptions.fog`) d'`engine-core` et `engine-shader`, les faces arrière éclairées, `source` et `items` ensemble, l'instancing des passes d'ombre ; `SceneLods`, `findLodGroups` et `NodeFlags.Culled` d'`engine-scene` ; `ThirdPersonOperator` d'`engine-camera` ; les outils `tools/assets` et les modèles de `apps/docs/public/models/forest/` ; la scène `tps` de `demo-scenes` (`createTpsScene` : la forêt, le héros, les orcs et le démon, les coups, les vagues, les sons), dans la démo web (`/tps`) et la démo native ; les tutoriels « Les ombres en cascades et le brouillard », « Les niveaux de détail », « La caméra à la troisième personne » et la page « Un jeu à la troisième personne » (EN, FR) avec leurs exemples vivants et leurs captures, les guides « Lumières et ombres » et « Le graphe de scène ». Reste la suite du §11.

## 11. La suite

1. **Le coût des requêtes de la scène** : cinq parcours d'octree par image sur 30 000 entités ; les niveaux écartés pourraient sortir de l'index, ou les requêtes des cascades se faire en une passe.
2. **Les groupes de collision des personnages** (`CharacterDesc.groups`, `mask`), pour filtrer les coups et la caméra sans prédicat.
3. **Les imposteurs** des arbres lointains, si une scène plus grande le demande ; des cartes d'aiguilles plus fines au LOD0 (le sapin vu de près reste un peu « feuillu »).
4. **La liaison des clips par nom d'os au chargement**, puis le reciblage entre squelettes différents (proportions, poses de repos).
5. **Le root motion** (les fichiers `_RM` des UAL), pour des coups qui avancent.
6. **Un navmesh** et la recherche de chemin, quand un niveau aura des murs et des ponts.
7. **L'IA en graphs de comportement** (P9) — _faite_ (18 octobre 2026) : [p9-behavior.md](p9-behavior.md) §6.
8. **Le reste de P2** : clusters de lumières, IBL, un ciel ; l'occlusion des projeteurs d'ombre.
9. **Une tête pour le rôdeur** (le pack _Universal Base Characters_), et les mesures dans Chrome sur le GPU.
