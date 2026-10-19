# P7b : la physique

Le design de la phase P7b de la [roadmap](roadmap.md#p7b-physique) : une API physique abstraite que l'utilisateur implémente pour brancher le moteur physique de son choix, sa liaison à l'ECS et au pas fixe de l'ordonnanceur (P4), une vue de débogage, et un moteur intégré pour les démos, le même dans le navigateur et en natif.

Contraintes : pas de grosse dépendance en dur (§1 de la roadmap) : le cœur ne dépend d'aucun moteur physique ; le même code de jeu sur le web et en natif (Node) ; les corps comme composants ECS, la simulation dans la phase `fixed`, les nœuds dessinés entre deux pas.

## 1. Aujourd'hui

| Ce qui existe                                                                                            | Ce qui manque                                                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| L'ordonnanceur : la phase `fixed`, `alpha` pour l'interpolation (P4)                                     | Un système de physique, et l'interpolation des corps sans code de jeu      |
| L'ECS : des composants en colonnes, `onAdded`/`onRemoved`, les transforms dans un pool (`TransformPool`) | Des corps attachés aux entités, retirés avec elles                         |
| Les volumes et les rayons de `engine-geometry`, `scene.raycast` (le tir de la démo FPS)                  | Des collisions, des contacts, des articulations, des corps qui se poussent |
| Le `Renderer` : des meshes de triangles                                                                  | Des lignes (la vue de débogage)                                            |

Le contrôleur de personnage de P4, « contre les volumes de la scène », n'a pas été écrit : la balle et les drones de la démo FPS se contentent des rayons de la scène.

## 2. Les options

### 2.1 Le moteur intégré

Mesures (`/tmp`, hors du dépôt) : 1000 puis 4000 boîtes en grille de 10 de côté lâchées sur un sol, 600 pas de 1/60 s, Node 24, un thread, WebAssembly ; Rapier `@dimforge/rapier3d-compat` 0.21.0, Jolt `jolt-physics` 1.1.0 (`wasm-compat`, un thread, couches et paramètres par défaut, sans `OptimizeBroadPhase` : un réglage plus fin le rapprocherait sans doute).

| Candidat                | Langage, liaisons                                           | Licence    | Taille (WebAssembly, gzip) | Pas moyen, 1000 / 4000 boîtes | Remarques                                                                                                                         |
| ----------------------- | ----------------------------------------------------------- | ---------- | -------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Rapier**              | Rust ; liaisons JS officielles, typées                      | Apache-2.0 | 1,7 Mo (intégré en base64) | **1,05 / 3,9 ms**             | Déterministe sur une machine (une variante multi-plateforme existe) ; contrôleur de personnage, capteurs, articulations, requêtes |
| Jolt (JoltPhysics.js)   | C++ ; liaisons WebIDL (Emscripten), mémoire gérée à la main | MIT        | 0,7 Mo                     | 9,1 / 38,7 ms                 | Le plus rapide en natif ; en WebAssembly, un objet `new`/`destroy` par vecteur ; un addon natif à écrire                          |
| PhysX (physx-js-webidl) | C++ ; WebIDL                                                | BSD-3      | non mesurée                | non mesuré                    | Liaisons non officielles, API lourde ; le GPU de PhysX hors de portée en WebAssembly                                              |
| Bullet (ammo.js)        | C++ ; WebIDL                                                | zlib       | non mesurée                | non mesuré                    | Peu maintenu ; API ancienne                                                                                                       |

**Choix : Rapier, le même module WebAssembly dans le navigateur et dans Node.** Le plus rapide de nos mesures, l'API JS la plus simple (des objets JS, pas de mémoire à libérer à la main), tout ce que demande l'API abstraite (y compris le contrôleur de personnage). Le natif de la démo est Node : la version WebAssembly y tourne telle quelle. Un addon natif (Rapier en Rust, ou Jolt en C++) ne se justifierait que si une démo dépassait le budget d'une image ; l'API abstraite le permettra sans toucher au jeu.

Le paquet `-compat` intègre le module en base64 : 1,7 Mo gzip au lieu de 1,2 Mo pour le `.wasm` seul, mais aucun fichier à servir ni de configuration de bundler, la même importation dans Vite et dans Node.

### 2.2 L'API

| Option                                                     | Intérêt                                                                                               | Coût                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A. Utiliser Rapier directement                             | Rien à écrire                                                                                         | Le jeu, l'ECS et les outils liés à Rapier ; contraire au §1           |
| **B. Des interfaces, des descriptions en données simples** | **Un autre moteur ne change que la création du monde ; les formes sont lisibles (débogage, éditeur)** | Une couche de traduction ; ce que l'API ne couvre pas passe par `raw` |
| C. Un ECS physique (les corps décrits par des colonnes)    | Pas d'objet par corps                                                                                 | Tous les moteurs ont leurs objets : on recopierait les colonnes       |

**Choix : B.** `PhysicsEngine` → `PhysicsWorld` → `PhysicsBody`, `PhysicsCollider`, `PhysicsJoint`, `PhysicsCharacter`. Les entrées sont des données (`BodyDesc`, `ColliderDesc`, `Shape`, `JointDesc`, `CharacterDesc`), les sorties des interfaces. `readPose(out, offset)` lit une pose sans allocation, pour les boucles de la liaison.

### 2.3 La liaison à la scène

| Question                       | Choix                                                                                              | Pourquoi                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Où vit le corps                | Un composant `physics body` de l'entité : le corps, qui suit qui, les poses des deux derniers pas  | L'interpolation sans code de jeu ; les colonnes parcourues sans objet                 |
| Qui suit qui                   | `body` (dynamique : le nœud suit), `node` (cinématique : le corps suit le nœud), `none` (statique) | Une plateforme s'anime comme un nœud ; un personnage est déplacé par son contrôleur   |
| Le nœud d'un corps qui le suit | Sous la racine, refusé ailleurs                                                                    | Sa transformation locale est sa pose dans le monde : pas d'inverse de matrice par pas |
| L'échelle                      | Celle du nœud est celle du mesh ; les formes ont leur taille                                       | Une forme mise à l'échelle non uniforme n'existe pas dans tous les moteurs            |
| Les systèmes                   | `physics` (phase `fixed`) et `physics:sync` (phase `update`), par `install(scheduler)`             | Ceux de P4 ; un système de jeu se place par `before: ['physics']`                     |
| Les corps au repos             | Le nœud n'est plus écrit (un pas de plus après l'arrêt)                                            | Un tas de 1000 boîtes endormies ne coûte plus rien                                    |
| Le retrait                     | Le corps part avec le nœud (`onRemoved`)                                                           | Pas de corps orphelin                                                                 |
| La téléportation               | `teleport()` : les deux poses remplacées                                                           | Pas de trajet dessiné entre l'ancienne et la nouvelle position                        |

### 2.4 Les requêtes

Rapier 0.21 ne met à jour sa phase large qu'au pas : une requête ne voit un corps créé ou déplacé qu'après le pas suivant. **Choix : en faire le contrat de l'API** (« les requêtes voient le monde du dernier pas »), plutôt qu'un pas de durée nulle pour rafraîchir (des événements en double, des divisions par zéro dans le solveur). Pour un jeu à pas fixe, c'est l'état que voient déjà les systèmes.

### 2.5 La vue de débogage

| Option                                             | Intérêt                                                            | Coût                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| A. Le rendu de débogage de Rapier (`debugRender`)  | Rien à écrire                                                      | Propre à Rapier ; un autre moteur n'aurait rien                                                          |
| **B. Les lignes calculées depuis l'API abstraite** | **Tout moteur en profite ; les couleurs par état sont les nôtres** | Les formes dessinées par nous ; les enveloppes convexes calculées par le moteur ne sont que leurs points |
| C. Des meshes transparents par forme               | Pas de nouvelle topologie                                          | Un nœud par collider ; les contacts et les rayons mal servis                                             |

**Choix : B**, dessinées par un mesh de lignes : `MeshDescription.topology` (`line-list`), que les trois backends savaient déjà créer ; le `Renderer` la passe au pipeline et à sa clé.

## 3. L'API

`@fdw/engine-physics` (dépend de `engine-scene`, `engine-core`, `engine-shader` pour la liaison et la vue de débogage) :

- **Les formes** (`Shapes`) : sphère, boîte (demi-dimensions), capsule et cylindre selon y, convexe (points, ou points et triangles de l'enveloppe), mesh (triangles creux), heightfield (`rows × columns`, ligne après ligne, lignes selon z, colonnes selon x, centré).
- **Les corps** : `static`, `dynamic`, `kinematic` ; pose, vitesses, `gravityScale`, amortissements, `ccd`, `canSleep`, `lockRotations`. `setPose` (téléportation), `moveTo` (cinématique : le pas suivant), `applyImpulse` (en un point), `applyForce` (pendant un pas), `applyTorqueImpulse`, `mass`, `sleeping`.
- **Les colliders** : forme, décalage, densité, matériau (frottement, rebond, règles de combinaison), groupes de collision (16 bits de groupes, 16 de masque), capteur, événements.
- **Les articulations** : `fixed` (soudées telles qu'elles sont), `ball`, `hinge`, `slider` ; ancres, axe, limites, moteur (vitesse, ou cible et ressort).
- **Les requêtes** : `raycast`, `raycastAll`, `shapeCast`, `overlap`, avec un `QueryFilter` (masque, corps exclu, types sautés, capteurs, prédicat).
- **Les événements** : `world.events` (début et fin de contact, entrée et sortie des capteurs, du dernier pas), `world.contacts()` (les points, pour le débogage).
- **Le contrôleur de personnage** : un corps cinématique, `move(déplacement)` → ce qui en a été fait, au sol ou non, les colliders heurtés ; pente maximale, marches, accroche au sol, poussée des corps dynamiques.

`ScenePhysics` (la liaison, §2.3) et `PhysicsDebugView` (§2.5) sont écrits contre l'API seule : un test les fait tourner sur un faux moteur sans collisions.

## 4. Rapier

`@fdw/engine-physics-rapier` : `createRapierPhysics()` charge le module une fois et renvoie un `RapierPhysics`. Ce qu'il a fallu contourner :

- **Les limites des articulations** données dans `JointData` sont ignorées : posées après la création (`setLimits`).
- **Une enveloppe convexe dégénérée** (des points alignés) fait échouer le module (« expected instance of p ») au lieu de renvoyer `null` : l'erreur est traduite.
- **Les forces** restent appliquées jusqu'à leur remise à zéro : remises à zéro après le pas qui les a vues.
- **Le heightfield** : les hauteurs par colonnes, `rows - 1 × columns - 1` cellules ; vérifié par des rayons.
- **Le témoin d'un shape cast** est déjà dans le monde.
- **Les capteurs** reçoivent tous les types de collisions (`ActiveCollisionTypes.ALL`) : sans cela, un personnage cinématique n'entre pas dans un capteur statique.

## 5. Ce qu'il a fallu ajouter au moteur

- **`MeshDescription.topology`** : la topologie d'un mesh (`triangle-list` par défaut), passée au pipeline et à sa clé par le `Renderer`.
- **Vulkan : les groupes vides.** Après un changement de pipeline, le rejeu natif reliait tous les groupes déjà posés, y compris à un index que le nouveau pipeline laisse vide (le matériau sans uniform des lignes) : une erreur de validation. Le pipeline garde quels groupes il utilise ; les autres ne sont plus reliés (ils restent posés pour le suivant, comme en WebGPU).
- **`createCapsule`** dans `demo-scenes` : le mesh des capsules.

## 6. Mesures

`RapierPhysics.bench.ts` (Node 24, un thread) : 1000 boîtes lâchées en tas, mesurées pendant leur première seconde (toutes éveillées, en collision), la pile reconstruite chaque seconde simulée :

| Mesure                                | Moyenne par pas |
| ------------------------------------- | --------------- |
| `world.step`                          | 3,2 ms          |
| `ScenePhysics.step` et `sync` (nœuds) | 3,8 ms          |

La liaison coûte donc environ 0,6 µs par corps en mouvement et par pas (lecture de la pose, écriture interpolée du nœud). Sur dix secondes, à mesure que les boîtes s'endorment, le pas tombe à 1 ms en moyenne. Le terrain de jeu de la démo (environ 60 corps, une chaîne, des capteurs) : 0,4 à 1 ms par pas, 60 images par seconde en natif (Dawn, Vulkan) comme dans le navigateur.

## 7. Tests

- **`engine-physics`** (faux moteur sans collisions) : la pose d'une matrice mise à l'échelle et tournée, le mélange de poses par le plus court chemin ; les lignes de chaque forme à leur pose, la croissance des tableaux, les couleurs par état, les contacts ; la liaison : les nœuds dessinés entre deux pas, sans interpolation, l'arrêt de l'écriture au repos, les corps cinématiques amenés à leur nœud (sous un parent), les statiques sous un parent, le refus hors de la racine, le retrait avec le nœud ou seul, le remplacement, la téléportation, l'écriture dans le pool ; la vue de débogage (lignes, rayons vieillis, rendu en `line-list` sur le faux backend).
- **`engine-physics-rapier`** : la chute libre et le sommeil, les poses sans allocation, les impulsions, les forces d'un pas, la gravité par corps, les corps cinématiques qui poussent, le rebond et le frottement, les rayons et leurs filtres, les shape casts sur une boîte tournée, les chevauchements, les événements des capteurs et des contacts, les points de contact, une chaîne et une charnière (limites, moteur), une soudure, toutes les formes, le heightfield, le contrôleur de personnage (glisser le long d'un mur, monter une marche) ; la liaison sur Rapier : une pile qui tient, un rayon qui en touche le sommet, un nœud retiré, un personnage qui marche.
- **Suite de rendu, trois backends** : une ligne dessinée par un matériau sans uniform après un matériau qui en a (Dawn, Vulkan avec la couche de validation, WebGL2).
- **Documentation** : le tutoriel « La physique » (EN, FR), son exemple vivant et ses captures (WebGPU, WebGL2), à l'ouverture et avec la vue de débogage ; le guide « La physique ».
- **Démos** : la scène `physics` dans la démo web et la démo native (Dawn, Vulkan sans message de validation).

## 8. La suite

1. **Le contrôleur de personnage contre les volumes de la scène** (P4), comme une implémentation de `PhysicsCharacter` sans moteur, si un client veut se passer de Rapier.
2. **Le TPS (P8)** : le personnage animé de P6 sur `PhysicsCharacter`, les volumes d'attaque en capteurs, la caméra TPS par `shapeCast`.
3. **Les ragdolls** sur les squelettes de P6, les véhicules (le `DynamicRayCastVehicleController` de Rapier), les corps mous.
4. **Le déterminisme multi-plateforme** (le paquet déterministe de Rapier) pour le réseau, et l'instantané du monde (`takeSnapshot`) pour les sauvegardes.
5. **Un moteur natif** (un addon Rust ou C++) derrière la même API, si une démo dépasse le budget d'une image.
6. **L'éditeur de jeu (P20)** : les formes en données simples se sérialisent et s'éditent ; la vue de débogage y servira telle quelle.

## 9. Décisions

À valider :

1. **Rapier en WebAssembly, le même module web et natif** ; pas d'addon natif tant qu'une mesure ne le demande pas (§2.1).
2. **Une API d'interfaces et de descriptions en données simples** ; les objets du moteur accessibles par `raw` (§2.2).
3. **Les corps comme composants**, la simulation et l'interpolation comme systèmes de l'ordonnanceur ; les nœuds qui suivent leur corps sous la racine (§2.3).
4. **Les requêtes voient le monde du dernier pas** (§2.4).
5. **La vue de débogage écrite contre l'API**, en lignes : `MeshDescription.topology` (§2.5).

## 10. État

**Faite** (16 octobre 2026) : `engine-physics` (l'API, `Shapes`, `ScenePhysics`, `PhysicsDebugView`, `drawWorld`, `DebugLines`), `engine-physics-rapier` (`createRapierPhysics`, `RapierWorld` et ses objets), `MeshDescription.topology`, la correction des groupes vides de Vulkan ; la scène `physics` de `demo-scenes` (une pyramide, des dominos, une chaîne, une porte sur charnière, un balayeur cinématique, une pluie de formes, une zone qui s'allume, le tir de balles, la poussée par rayon), dans la démo web (`/physics`) et la démo native ; le tutoriel « La physique » (EN, FR) avec son exemple vivant et ses captures, le guide « La physique ». Reste la suite du §8.
