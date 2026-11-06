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

1. **La démo TPS** : les orcs sur le maillage de navigation de la forêt (les troncs en volumes), les coups qui avancent par root motion, les ennemis qui tombent en ragdoll.
2. **Les obstacles dynamiques et les tuiles** : reconstruire une région du maillage, découper les obstacles posés en cours de jeu.
3. **L'évitement entre agents** (RVO), les liens hors du maillage (sauts, échelles).
4. **Les ragdolls** : des limites de cône aux rotules (à ajouter à l'API de P7b), le retour à l'animation (se relever, par `Pose.blend`), le ragdoll partiel (un bras touché, le reste animé), les moteurs des articulations vers une pose (le ragdoll actif).
5. **Le root motion** : les rotations autour d'autres axes, les clips qui démarrent ailleurs qu'à l'origine.
6. **L'éditeur de jeu (P20)** : le maillage affiché et reconstruit dans l'éditeur, les os d'un ragdoll édités sur le squelette.

## 9. Décisions

À valider :

1. **Le root motion par clip, pondéré comme les poses** ; les couches et les clips additifs écartés (§2.1).
2. **Un maillage de navigation maison** (colonnes, érosion, rectangles), pas Recast ; A\* par les points des portails, puis l'entonnoir (§2.2).
3. **Le contrôleur par sous-pas et dépénétration** sur une distance signée, `CharacterController` commun (§2.3).
4. **Les corps du ragdoll tournés comme le nœud** ; un package `engine-ragdoll` (§2.4).

## 10. État

**Faite** (5 novembre 2026) : le root motion de `engine-animation` (`rootMotion`, `rootMotionToWorld`, `AnimationClip.sampleJoint`) ; `engine-navigation` (`NavMesh`, `buildNavMesh`, `sceneVolumes`, `NavAgent`) ; `SceneCharacter` et `CharacterController` d'`engine-physics`, `signedDistance` d'`engine-geometry` ; `engine-ragdoll` (`Ragdoll`) ; les clips `Walk_RM` et `TurnLeft_RM` du personnage de la documentation ; les tutoriels « Le root motion », « La navigation » et « Les ragdolls » (EN, FR) avec leurs exemples vivants et leurs captures, le guide « La navigation », les guides « Animation » et « La physique » complétés. Reste la suite du §8.
