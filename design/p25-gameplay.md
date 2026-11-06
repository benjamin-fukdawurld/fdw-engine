# P25 : le gameplay

Le cinquième chantier de la [roadmap revue le 30 octobre 2026](roadmap.md#2-vue-densemble) : ce qui manquait pour qu'un personnage se déplace dans un niveau, reporté par P4, P6, P7b et P8. Le root motion ([p6 §10](p6-animation.md#10-la-suite), [p8 §11](p8-tps.md#11-la-suite)), la recherche de chemin ([p8 §11](p8-tps.md#11-la-suite)), le contrôleur de personnage contre les volumes de la scène ([p4](roadmap.md#p4-caméras-entrées-ordonnanceur--démo-fps), [p7b §8](p7b-physics.md#8-la-suite)), les ragdolls ([p7b §8](p7b-physics.md#8-la-suite)). L'éditeur de jeu (P20) s'en servira.

Contraintes : rien de neuf dans le cœur ; du TypeScript pur, testable sans GPU ; aucun moteur physique imposé là où il n'est pas nécessaire (la navigation et le contrôleur de la scène s'en passent ; le ragdoll passe par l'API abstraite de P7b) ; le même code de jeu sur le web et en natif.

## 1. Aujourd'hui

| Ce qui existe                                                                                         | Ce qui manque                                                                                |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| L'`Animator` (P6) : clips, mélanges, machines à états, couches                                        | Le déplacement des clips : les clips `_RM` des packs, des coups qui avancent                 |
| `PhysicsCharacter` (P7b), sur Rapier                                                                  | Un contrôleur sans moteur physique, contre ce que la scène sait déjà : ses volumes           |
| Les volumes de `engine-geometry`, les requêtes de la scène (`raycastEntities`, `queryVolumeEntities`) | Une distance signée et une normale (le GJK de P1 ne dit que « touche » ou « ne touche pas ») |
| L'IA de la démo TPS (P8, P9) : des ennemis qui foncent droit sur le héros                             | Des chemins autour des murs, sur des ponts                                                   |
| Les corps, articulations et groupes de collision de P7b ; les squelettes et poses de P6               | Des corps sur les os, et la pose qu'ils font                                                 |

## 2. Les options

### 2.1 Le root motion

- **Extraire de la pose finale** (le déplacement des hanches d'une image à l'autre, après tous les mélanges) : simple, mais une boucle fait reculer les hanches d'un cycle à chaque tour, et le mélange de deux clips de longueurs différentes mélange des positions, pas des déplacements. Écarté.
- **Un déplacement par clip, pondéré comme les poses** : chaque nœud de clip calcule ce que l'articulation a parcouru entre son temps d'avant et son temps d'après (les boucles comptées par cycles), multiplié par sa part de la pose. Les mélanges, les fondus et les blend spaces synchronisés en héritent sans rien savoir. **Retenu.** La part d'un nœud est déjà connue de l'animateur (`advance(dt, weight)`) ; les couches marquent leurs entrées comme muettes.

Le déplacement est exprimé dans l'espace du personnage tourné comme au début de la mise à jour : c'est ce qu'un contrôleur sait appliquer (`rootMotionToWorld`). Le tourner par cycles demande de composer les segments (un cycle qui tourne de 30° décale le suivant).

### 2.2 La navigation

| Option                                                      | Pour                                                     | Contre                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Recast/Detour en WebAssembly (recast-navigation-js)         | La référence ; tuiles, obstacles, foules                 | Une dépendance lourde de plus (WebAssembly, ~400 Ko), son propre format de géométrie |
| Une grille et A\* dessus                                    | Trivial                                                  | Des chemins en escalier, des milliers de nœuds                                       |
| **Un maillage de polygones convexes, A\* puis l'entonnoir** | Des chemins tendus, peu de nœuds ; du TypeScript lisible | Le construire                                                                        |

**Retenu : le maillage**, construit par une voxelisation à la Recast simplifiée : des colonnes de la taille d'une cellule, les intervalles solides de chaque colonne donnés par les volumes (la boîte même pour un `Aabb`, deux rayons pour les autres), les sols avec de la place au-dessus, liés à leurs voisins à une marche près, érodés du rayon de l'agent, puis rassemblés en rectangles plats. Pas de contours ni de triangulation de régions (Recast) : les rectangles suffisent aux niveaux de boîtes et de rampes, et le funnel tend les chemins quelle que soit la forme des polygones. Les polygones sont convexes, leurs liens des **portails explicites** (deux rectangles voisins ne partagent pas de sommets) ; `NavMesh.fromTriangles` relie des triangles par leurs arêtes communes.

A\* sur des polygones de tailles très inégales se trompe s'il passe par le milieu des portails (un grand rectangle a son milieu loin du chemin) : il passe par le point du portail sur le plus court trajet vers l'arrivée (une recherche par la section dorée), la démo du tutoriel prenait sinon la mauvaise porte.

### 2.3 Le contrôleur contre la scène

- **Un balayage exact de la capsule** (le temps du premier contact contre chaque volume) : exact, mais un balayage par paire de formes.
- **Avancer à petits pas puis repousser** (une capsule jamais plus loin que la moitié de son rayon par pas, repoussée hors de ce qu'elle chevauche) : le rebond des pas et la glissade le long des murs viennent d'eux-mêmes. **Retenu**, sur une **distance signée** des volumes (`signedDistance` : boîte, boîte orientée, sphère, capsule ; les autres valent pour leurs bornes) : le point du segment de la capsule le plus proche d'un volume minimise une fonction convexe, une recherche par la section dorée le trouve.

Les marches comme Rapier : rejouer le déplacement plus haut, puis redescendre ; gardé si l'atterrissage est praticable. Le bord arrondi d'une marche a une normale raide : à la descente, toute normale vers le haut porte, et un rayon sous l'axe de la capsule vérifie que le sol en dessous est praticable — sinon une pente raide se gravirait marche par marche.

`CharacterController` devient l'interface commune : `PhysicsCharacter` l'étend, `SceneCharacter` l'implémente.

### 2.4 Les ragdolls

Les corps sur les os sont créés **tournés comme le nœud du squelette**, la rotation de chaque articulation gardée comme un décalage : l'API de P7b donne l'axe d'une charnière une seule fois, dans l'espace des deux corps ; des corps tournés comme leurs os auraient demandé deux axes. Les rotules n'ont pas de limites dans l'API : les coudes et les genoux sont des charnières limitées. Un package à part (`engine-ragdoll`), qui dépend de l'animation et de la physique sans que l'une dépende de l'autre.

## 3. Le mécanisme

### 3.1 Le root motion

- `RootMotionExtractor` (interne) : l'articulation, la transformation de repos de son parent (pour lire le déplacement dans l'espace du squelette : une armature tournée de 90° et mise à l'échelle 0,01 est prise en compte), l'état de chaque clip au temps 0 (mis en cache).
- `accumulate(clip, from, to, loop, weight, out)` : les segments du déplacement, découpés aux bouts du clip (au plus 8 cycles, comme les événements), composés dans l'espace du personnage, ajoutés à `out` pondérés. Appelé par le nœud de clip à chaque avance (`moveTo`), sauf pour les clips additifs et sous une couche.
- `strip(clip, time, pose)` : l'articulation gardée à sa position du début du clip (x et z, y avec `vertical`), et son lacet ramené à celui du début (avec `rotation` : la rotation autour de y, par une décomposition swing-twist).
- `AnimationClip.sampleJoint(time, joint, pose)` : n'échantillonne que les pistes d'une articulation (une table par articulation faite au premier appel).

### 3.2 La navigation

`buildNavMesh` (§2.2), puis `NavMesh` : les polygones rangés dans des cases en x et z (une case par polygone en moyenne, 256 au plus par côté) ; `closestPoint` par anneaux de cases ; A\* sur un tas binaire ; l'entonnoir de Mikko Mononen, gauche et droite de chaque portail choisies par rapport au centre du polygone qu'on quitte. `NavAgent` dépense `speed × dt` le long des coins et cherche un nouveau chemin quand on l'a poussé à plus de `maxDeviation` de son segment.

### 3.3 Le contrôleur

`SceneCharacter.move` : les volumes proches du déplacement entier récupérés une fois (`queryVolumeEntities` sur la boîte du déplacement, les couches de `QueryOptions`, `ignore`) ; des sous-pas d'au plus la moitié du rayon ; après chacun, quatre passes de dépénétration ; un sol praticable repousse tout droit vers le haut (pas de glissade sur une pente à l'arrêt) ; puis les marches et le collage au sol. La fonction `ground(x, z)` d'un terrain sert de volume de plus, sa normale par différences finies.

### 3.4 Le ragdoll

`activate(pose, matrix, velocity)` : les repères des articulations dans le monde (position, rotation, échelle) de la pose et de la matrice du nœud ; un corps par os, sa capsule tournée le long de l'os ; une articulation vers le corps du plus proche ancêtre qui en a un. `readPose(out)` : les repères des articulations à corps lus des corps, ceux des autres recomposés depuis la pose de l'activation, puis les transformations locales (parent⁻¹ × monde, l'échelle de la pose gardée).

## 4. L'API

```ts
// engine-animation
const animator = new Animator(graph, {
  skeleton,
  clips,
  rootMotion: { joint: 'hips', rotation: true },
});
animator.update(dt);
const step = rootMotionToWorld(animator.rootMotion, heading);
heading += animator.rootMotion.yaw;

// engine-navigation
const navMesh = buildNavMesh({
  bounds,
  volumes: sceneVolumes(scene),
  agentRadius: 0.4,
});
const path = navMesh.findPath(start, end, { partial: true });
const agent = new NavAgent(navMesh, { speed: 3 });

// engine-physics
const character = new SceneCharacter(scene, {
  radius: 0.3,
  height: 1.8,
  ignore,
});
character.move({ x, y, z }); // CharacterController, comme PhysicsCharacter

// engine-ragdoll
const ragdoll = new Ragdoll(world, skeleton, { bones, groups: 2, mask: 1 });
ragdoll.activate(pose, skeletonNode.worldMatrix, velocity);
ragdoll.readPose(out);
```

## 5. Ce qu'il a fallu ajouter au moteur

- **`signedDistance(volume, point, normal?)`** dans `engine-geometry` : la distance signée et sa normale, exactes pour `Aabb`, `Obb`, `Sphere` et `Capsule`.
- **`CharacterController`** dans `engine-physics` : l'interface commune des contrôleurs.
- **`AnimationClip.sampleJoint`**.
- **Deux clips au personnage de la documentation** (`tools/docs/make-character.mjs`) : `Walk_RM` (les hanches avancent à 1,3 m/s) et `TurnLeft_RM` (en tournant d'un douzième de tour par cycle). Le générateur est déterministe : les autres clips et le mesh sont inchangés.

## 6. Mesures

Node 24, un thread (scripts hors du dépôt) :

| Mesure                                                                                           | Temps           |
| ------------------------------------------------------------------------------------------------ | --------------- |
| `buildNavMesh`, le niveau du tutoriel (20 × 20 m, cellules de 0,2 m, 12 volumes) : 56 polygones  | 10 ms           |
| `buildNavMesh`, un labyrinthe de 100 × 100 m (576 volumes, cellules de 0,25 m) : 2 676 polygones | 173 ms          |
| `findPath` à travers le niveau du tutoriel (deux portes, une rampe)                              | 46 µs           |
| `SceneCharacter.move`, un pas de marche de 1/60 s parmi les murs                                 | 2,6 µs          |
| `Animator.update`, 18 articulations, sans puis avec root motion                                  | 0,95 µs, 1,5 µs |
| `world.step` (Rapier), 10 ragdolls de 7 corps en chute                                           | 0,27 ms         |
| `Ragdoll.readPose`, 10 articulations                                                             | 3,7 µs          |

La construction du maillage est à faire au chargement d'un niveau, pas à chaque image ; le reste tient largement dans une image pour des dizaines d'agents.

## 7. Tests

- **`engine-animation`** : le déplacement des hanches pris et la pose gardée sur place, les boucles (un cycle entier ajouté), un clip sans boucle qui s'arrête, un mélange pondéré, les couches écartées et le vertical sur demande, les virages (le pas suivant tourné du cap), une armature tournée et mise à l'échelle, `rootMotionToWorld`, une articulation inconnue.
- **`engine-geometry`** : la distance signée d'une boîte (dehors, dans un coin, dedans), d'une boîte orientée, d'une sphère, d'une capsule, `undefined` pour un frustum.
- **`engine-navigation`** : des triangles reliés par leurs arêtes, les triangles raides écartés et les sommets soudés, le point le plus proche, la ligne droite, l'enregistrement, les polygones inconnus ; le contournement d'un mur à son rayon, la porte la plus courte quelle que soit la taille des polygones, le sol plat en un polygone, un sol sous un pont et le pont séparés (le chemin partiel), les marches, un rebord, une rampe, une fonction du sol ; l'agent qui suit les coins à sa vitesse, s'arrête au bout, cherche un nouveau chemin quand on le pousse.
- **`engine-physics`** : `SceneCharacter` tombe et se pose, glisse le long d'un mur, monte une marche et pas un rebord, monte une pente douce et y reste, pas une raide, reste au sol en descendant une marche, tombe d'une falaise, se pose sur une fonction du sol, ignore ce qu'on lui dit, se cogne à un plafond.
- **`engine-ragdoll`** (sur Rapier) : les corps où la pose met les articulations (sous un nœud tourné), la pose rendue à l'identique à l'activation, la chute au sol (les articulations tiennent, la vitesse du coup), le retrait, les erreurs.
- **Documentation** : les tutoriels « Le root motion », « La navigation » et « Les ragdolls » (EN, FR), leurs exemples vivants et leurs captures (WebGPU, WebGL2) ; le guide « La navigation » ; les sections du root motion (guide « Animation »), du contrôleur sans moteur et des ragdolls (guide « La physique »).

## 8. La suite

1. ~~**La démo TPS** : les orcs sur le maillage de navigation de la forêt (les troncs en volumes), les coups qui avancent par root motion, les ennemis qui tombent en ragdoll.~~ _Fait_ (§11.4).
2. ~~**Les obstacles dynamiques et les tuiles** : reconstruire une région du maillage, découper les obstacles posés en cours de jeu.~~ _Fait_ (§11.2).
3. ~~**L'évitement entre agents** (RVO)~~ _fait_ (§11.3) ; les liens hors du maillage (sauts, échelles).
4. **Les ragdolls** : ~~des limites de cône aux rotules (à ajouter à l'API de P7b)~~ _faites_ (§11.1) ; le retour à l'animation (se relever, par `Pose.blend`), le ragdoll partiel (un bras touché, le reste animé), les moteurs des articulations vers une pose (le ragdoll actif).
5. **Le root motion** : les rotations autour d'autres axes, les clips qui démarrent ailleurs qu'à l'origine.
6. **L'éditeur de jeu (P20)** : le maillage affiché et reconstruit dans l'éditeur, les os d'un ragdoll édités sur le squelette.
7. **La foule contre les murs** : l'évitement ne voit que les agents ; les bords du maillage en obstacles de l'ORCA (les segments de RVO2) garderaient une foule pressée contre un mur sur le maillage.

## 9. Décisions

À valider :

1. **Le root motion par clip, pondéré comme les poses** ; les couches et les clips additifs écartés (§2.1).
2. **Un maillage de navigation maison** (colonnes, érosion, rectangles), pas Recast ; A\* par les points des portails, puis l'entonnoir (§2.2).
3. **Le contrôleur par sous-pas et dépénétration** sur une distance signée, `CharacterController` commun (§2.3).
4. **Les corps du ragdoll tournés comme le nœud** ; un package `engine-ragdoll` (§2.4).

## 10. État

**Faite** (5 novembre 2026), sa suite le 6 novembre (§11) : le root motion de `engine-animation` (`rootMotion`, `rootMotionToWorld`, `AnimationClip.sampleJoint`) ; `engine-navigation` (`NavMesh`, `buildNavMesh`, `sceneVolumes`, `NavAgent`) ; `SceneCharacter` et `CharacterController` d'`engine-physics`, `signedDistance` d'`engine-geometry` ; `engine-ragdoll` (`Ragdoll`) ; les clips `Walk_RM` et `TurnLeft_RM` du personnage de la documentation ; les tutoriels « Le root motion », « La navigation » et « Les ragdolls » (EN, FR) avec leurs exemples vivants et leurs captures, le guide « La navigation », les guides « Animation » et « La physique » complétés. Le 6 novembre : les limites de cône des rotules (l'API de P7b étendue, `ConeLimits`, `setCone`), `TiledNavMesh` (les tuiles, les obstacles), `NavCrowd` (l'évitement réciproque), `heightTolerance`, et la démo TPS qui s'en sert ; le tutoriel « Les foules et les obstacles » (EN, FR) avec son exemple vivant et ses captures, les tutoriels « La navigation » et « Les ragdolls », les guides « La navigation » et « La physique » et la page du jeu à la troisième personne complétés. Reste le §8.

## 11. La suite, faite

Le 6 novembre 2026 : les points 1 à 4 du §8 qui touchent la démo, sans rien de neuf dans le cœur.

### 11.1 Les limites de cône des rotules

L'API de P7b n'avait de limites que pour les charnières et les glissières. **Ajouté** : `JointDesc.cone` (`ConeLimits` : `swing`, le demi-angle du cône autour de `axis`, et `twist`, l'intervalle de la torsion autour de lui) et `PhysicsJoint.setCone`. Le repos est la façon dont les corps sont tournés à la création de l'articulation (comme `fixed`) : `axis` est donné dans l'espace de A, celui de B s'en déduit. Un ragdoll crée ses corps tournés comme le nœud : le repos est la pose de l'activation, comme pour ses charnières.

| Option sur Rapier                                                  | Pour                                     | Contre                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Une articulation générique (`JointData.generic`), ses axes limités | Dans l'API de Rapier.js                  | Les mêmes limites par axe ; pas de moteurs par axe exposés                       |
| **La rotule, ses axes angulaires limités, ajustés à chaque pas**   | Un cône, la torsion à part ; peu de code | Les limites passent par le jeu d'articulations de Rapier.js (`rawSet`, non typé) |
| Une contrainte maison (une impulsion à chaque pas)                 | Exact                                    | Hors du solveur : elle se bat avec lui, instable dans une chaîne                 |

**Retenu : la rotule.** Rapier.js ne donne pas de limites aux rotules, mais son jeu d'articulations les prend (`jointSetLimits` sur `AngX`, `AngY`, `AngZ`, ce qu'appellent ses charnières) ; les repères des deux corps (`setFrameX1`, `setFrameX2`) mettent l'axe du cône sur x. Rapier limite chaque axe à part, en comparant les composantes de la rotation relative au sinus du demi-angle : les deux axes du swing font un **carré**, 41 % plus large en diagonale (mesuré : 0,85 rad pour un cône de 0,6). Avant chaque pas, la liaison ajuste le carré au **cercle** là où est l'articulation : chaque axe borné à ce que l'autre laisse du cercle (`√(s² − q²)`) ; mesuré : 0,63 rad pour 0,6, l'erreur d'un pas. Libre, un axe est borné à ±π (sin(π/2) = 1 : aucune limite) : Rapier n'a pas de quoi retirer une limite.

`engine-ragdoll` s'en sert : `cone` et `twist` sur un os lié par une rotule, autour de l'os tel qu'il pointait à l'activation (de son articulation à `to`, ou de l'ancêtre à elle ; `axis` pour un autre). Et `attach` : le corps d'un os pendu à celui d'une autre articulation que son ancêtre ; les pieds des monstres d'Ultimate Monsters sont sous la racine du rig (de la cinématique inverse), pas sous les jambes.

### 11.2 Les tuiles et les obstacles

`TiledNavMesh` : le maillage par tuiles de `tileCells` cellules (64 par défaut), chacune construite à part par les étapes de `buildNavMesh` (le code partagé, `voxels.ts`), sur les solides de la tuile et d'une **marge** de `agentRadius / cellSize + 2` cellules : les bords de la marge ne sont pas des bords (le sol continue au-delà), l'érosion des sols de la tuile est celle d'un maillage construit d'un coup. Les rectangles restent dans la tuile. Un sol du bord lié à un sol au-delà est noté (sa hauteur, celle d'en face) ; à l'assemblage, deux notes face à face font un portail. Le même maillage qu'en un coup, en plus de polygones (testé : la même aire).

Les **obstacles** découpent : un sol est retiré quand un obstacle remplit sa colonne d'une marche sous lui à la hauteur de l'agent au-dessus, avant l'érosion. Un obstacle n'est pas un sol (une caisse ne se marche pas). Ajouté, déplacé ou retiré, il marque les tuiles de ses bornes élargies du rayon ; `update(maxTiles)` les reconstruit et assemble un nouveau `NavMesh` (les polygones renumérotés). Un `NavAgent` à qui l'on donne le nouveau (`agent.navMesh = …`) cherche un nouveau chemin à sa prochaine mise à jour. Écartés : garder les numéros des polygones des tuiles intactes (des agents sans nouveau chemin), au prix d'un maillage à trous ; reconstruire le `NavMesh` reste peu coûteux.

`heightTolerance` (1 cm par défaut, comme avant) : les sols d'un rectangle à cette distance du premier, sa hauteur leur moyenne. Sur le terrain de la forêt, 30 cm donnent quelques milliers de polygones au lieu d'un par cellule.

### 11.3 L'évitement entre agents

`NavCrowd` : **ORCA** (van den Berg, Guy, Lin et Manocha, 2011), comme la bibliothèque RVO2 le fait, au sol. Chaque voisin (les `maxNeighbors` plus proches dans `neighborDistance`) interdit un demi-plan de vitesses : celles qui le heurteraient dans `timeHorizon` forment un cône coupé d'un disque, l'agent prend la moitié du changement qui en sort (tout, face à un agent qui n'évite pas : `avoids: false`). La vitesse gardée est la plus proche de la préférée dans tous les demi-plans et la vitesse maximale : un programme linéaire en 2D, puis, quand aucun point ne les satisfait tous, celle qui viole le moins le pire. Écartés : des forces de séparation (ce que faisait la démo : des agents qui se bousculent et oscillent) ; RVO (le premier, sans demi-plans : des oscillations entre deux agents).

Ni murs ni obstacles dans la foule : les chemins s'en écartent, les contrôleurs les heurtent (§8, point 7).

### 11.4 La démo TPS

- **La navigation** : le maillage de la forêt construit une fois, quand la forêt est prête (`forestNavMesh` : le terrain par sa fonction de hauteur, les troncs de la zone de jeu en capsules, des cellules de 50 cm, le rayon du démon, `heightTolerance` de 30 cm). Chaque ennemi a un `NavAgent` (un nouveau chemin quand le but a bougé de 75 cm, trois fois par seconde au plus) ; les vagues naissent sur le maillage. La grille des troncs et sa poussée de côté sont retirées.
- **La foule** : `enemy.steer` ne déplace plus, il donne la vitesse voulue ; un système `crowd`, après le graphe et avant la physique, calcule les vitesses de tous (`NavCrowd`) et déplace les contrôleurs. Ceux qui frappent tiennent leur place (`avoids: false`), les autres les contournent.
- **Les coups qui avancent** : les clips d'épée de la bibliothèque frappent sur place, et leurs sources (les `_RM` des packs) ne sont pas dans le dépôt. `withLunges` écrit le pas de chaque coup dans la piste de translation de l'articulation `root` (35 à 70 cm, lissés), le long de +z du modèle à travers l'armature ; l'animateur l'en retire (`rootMotion: { joint: 'root' }`). Le déplacement de chaque image, tourné du cap, s'ajoute au prochain pas fixe du contrôleur (`Actor.move(step, velocity, offset)`). Le pas en code (1,6 m/s pendant 45 % du coup) est retiré.
- **Les ragdolls** : `enemy.die` retire le corps de la physique et active un ragdoll de 13 corps (`monsterBones` : le rig d'Ultimate Monsters, les membres dans des cônes, les pieds pendus aux jambes), poussé à l'opposé du coup ; chaque image, la pose lue des corps est donnée au skinning (`Actor.applyPose`). Les **groupes de collision** du jeu : le niveau (1), les ragdolls (2), les personnages (4) ; les ragdolls tombent sur le niveau, les personnages et la caméra les traversent (`CharacterDesc.groups`, le filtre des `move` et du `shapeCast` de la caméra).
- **Un bogue trouvé en jouant** : `NavAgent.update` pouvait boucler sans fin, ce qui restait du budget d'un pas (un résidu de flottants, `budget − d × budget / d`) ne tombant pas à 0. Le budget est maintenant dépensé d'un coup quand il ne mène pas au coin.

### 11.5 Mesures

Node 24, un thread (scripts hors du dépôt) :

| Mesure                                                                                           | Temps               |
| ------------------------------------------------------------------------------------------------ | ------------------- |
| `forestNavMesh`, la zone de jeu de 212 × 212 m, 1 200 troncs : 16 300 polygones                  | 0,35 à 0,45 s       |
| `findPath` à travers la forêt (jusqu'à 100 m)                                                    | 1,2 ms              |
| `TiledNavMesh`, la place de l'exemple (24 × 16 m, tuiles de 4 m) : un obstacle déplacé, `update` | 1,7 ms (3,5 tuiles) |
| `TiledNavMesh`, 100 × 100 m en tuiles de 64 cellules : un obstacle déplacé, `update`             | 7,5 ms              |
| `NavCrowd.update`, 10 puis 50 agents                                                             | 19 µs, 125 µs       |

Un chemin à travers la forêt coûte une milliseconde : les ennemis n'en cherchent un nouveau que quand leur but bouge.

### 11.6 Tests

- **`engine-physics-rapier`** : un pendule lancé de côté puis en diagonale reste dans son cône (le cône, pas le carré), libre au-delà sans lui, `setCone` refusé à une charnière ; le cône et la torsion mesurés depuis les corps tels qu'ils étaient joints (un quart de tour).
- **`engine-ragdoll`** : une jambe dans son cône (libre, elle part au-delà), un pied pendu à la jambe et non à la racine, une articulation `attach` inconnue.
- **`engine-navigation`** : les sols d'un terrain dans la tolérance (dix fois moins de polygones) ; les tuiles, le même maillage qu'en un coup (la même aire, le même tour du mur) ; les obstacles découpés (une caisse, une capsule), seules leurs tuiles reconstruites, déplacés, retirés ; quelques tuiles par appel ; un agent qui change de chemin quand le maillage change ; deux agents qui se croisent de face, un agent qui contourne un autre qui n'évite pas, la vitesse voulue gardée sans voisin.
- **`demo-scenes`** : les pas des coups pris en root motion sous une armature tournée et mise à l'échelle, la pose gardée sur place ; les os des ragdolls des monstres. La partie jouée sans GPU (un script hors du dépôt : le jeu, Rapier, les modèles, un backend factice) : les orcs suivent leurs chemins jusqu'au héros, frappent, tombent en ragdoll sur le sol.
- **Documentation** : le tutoriel « Les foules et les obstacles » (EN, FR), son exemple vivant et ses captures (WebGPU, WebGL2) ; les captures des ragdolls inchangées (leurs cônes ne changent pas l'image de 1,5 s au-delà de la tolérance).
