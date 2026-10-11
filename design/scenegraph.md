# Scenegraph, culling et octree

Donner au moteur une scène : une hiérarchie d'objets, leurs transformations, leurs bornes, et les requêtes spatiales qui permettent de ne préparer et de ne dessiner que ce qui se voit. L'API doit servir tous les domaines visés (jeu, CAO, BIM, modélisation) ; la première implémentation vise le jeu, pour des démos jouables du moteur. Ce document reprend le [§1 du backlog](backlog.md#1-scène--meshes-scenegraph-et-culling-prévu) et la vue de scène du [render graph §10.2](render-graph.md#102-la-vue-de-scène).

## Sommaire

1. [Résumé](#1-résumé)
2. [Le problème](#2-le-problème)
3. [But et intérêt](#3-but-et-intérêt)
4. [Ce que demandent les domaines](#4-ce-que-demandent-les-domaines)
5. [Alternatives](#5-alternatives)
6. [Design : les volumes](#6-design--les-volumes)
7. [Design : le renderer et ses sources](#7-design--le-renderer-et-ses-sources)
8. [Design : l'index spatial et l'octree](#8-design--lindex-spatial-et-loctree)
9. [Design : le scenegraph](#9-design--le-scenegraph)
10. [Design : objets statiques et prémices de l'occlusion culling](#10-design--objets-statiques-et-prémices-de-locclusion-culling)
11. [Les démos](#11-les-démos)
12. [Coût](#12-coût)
13. [Plan d'implémentation](#13-plan-dimplémentation)
14. [Stratégie de test](#14-stratégie-de-test)
15. [Risques, questions et décisions](#15-risques-questions-et-décisions)
16. [Le pool de transforms](#16-le-pool-de-transforms)

---

## 1. Résumé

Des couches, de la plus abstraite à la plus concrète, chacune dans son package :

- **La géométrie** (`@fdw/engine-geometry`, nouveau, sans dépendance) : une **interface de volume** que l'utilisateur peut implémenter (cylindre, capsule…), les volumes de base (boîte, sphère, boîte orientée, capsule, frustum), les rayons, les tests d'intersection (rapides par paire, et génériques pour tout volume convexe), et l'**index spatial** : un contrat (`SpatialIndex`) et ses implémentations, dont un **octree** lâche. Rien n'y dépend du rendu : un moteur physique ou un outil peuvent s'en servir seuls.
- **Le contrat de rendu** (`@fdw/engine-core`) : une **source de rendu** (`RenderSource`) que le `Renderer` interroge pour chaque vue (la caméra, chaque lumière qui touche ce qu'elle voit). Le `Renderer` ne connaît que ce contrat : une scène de CAO, de BIM ou un ECS de jeu s'y branchent sans le modifier.
- **Le scenegraph** (`@fdw/engine-scene`, nouveau) : des interfaces abstraites (nœud, scène) et une première implémentation orientée jeu. Son **cœur est un ECS** : des entités, des composants rangés en colonnes de tableaux typés, des requêtes pour écrire la logique en systèmes. Une **façade de nœuds** (hiérarchie, transformation, composants attachés) en donne une API objet, pour la CAO, le BIM, un éditeur ou un jeu simple. Les valeurs dérivées (matrices monde, bornes, place dans l'index) sont **invalidées** quand ce dont elles dépendent change, et recalculées à la lecture ou avant les requêtes. Calques, **objets statiques** et **occultants**. La scène implémente `RenderSource` avec un frustum culling sur deux octrees (statique, dynamique).
- **L'occlusion culling** (`@fdw/engine-occlusion`, plus tard) : sur le GPU autant que possible (Hi-Z), le CPU seulement en repli. Ce document en pose les prémices : objets statiques, occultants, table des bornes, historique de visibilité, étape enfichable.

Viennent ensuite des démos incrémentales qui construisent un petit jeu : un labyrinthe vu de dessus, parcouru par un personnage muni d'une lampe torche (§11).

## 2. Le problème

- **Pas de scène.** Le `Renderer` reçoit à chaque frame une liste plate de `RenderItem` (`{ mesh, material, transform }`). La matrice locale d'un `Transform` sert de matrice monde : pas de parent, donc pas d'objet porté par un autre (une arme dans une main, une caméra qui suit un joueur, une pièce dans un assemblage).
- **Tout est préparé et dessiné.** Chaque item coûte environ 1,8 µs de CPU par frame (bench du `Renderer`), plus son draw sur le GPU, qu'il soit visible ou non. Un niveau de jeu de 10 000 objets coûte 18 ms de CPU avant le moindre pixel ; un bâtiment BIM, dix fois plus.
- **Les ombres et les lumières englobent tout.** Une lumière directionnelle couvre les bornes de tous les items : sur un grand niveau, sa shadow map s'étale sur toute la scène et perd sa résolution ; chaque lumière redessine tous les objets, et une lumière qui n'éclaire rien de visible coûte autant qu'une autre.
- **Aucune requête spatiale ni aucun volume.** Ni sélection à la souris (CAO), ni rayon (tir, ligne de vue), ni voisinage (collisions) : chaque application devrait parcourir tous ses objets et écrire ses propres tests.

## 3. But et intérêt

| But                                  | Intérêt                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Hiérarchie de nœuds                  | Objets portés par d'autres ; assemblages (CAO), décomposition d'un bâtiment (BIM), personnages (jeu)          |
| Frustum culling                      | Le coût CPU et GPU suit ce qui est visible, plus la taille de la scène                                        |
| Lumières et ombres limitées à la vue | Une lumière qui ne touche pas la vue ne coûte rien ; une shadow map ne dessine que ce qui peut ombrer la vue  |
| Volumes extensibles                  | Les volumes de l'utilisateur (capsule, cylindre) s'intègrent aux index et aux tests : base de la physique     |
| Octree derrière un contrat           | Requêtes en temps logarithmique ; utilisable par toute scène, remplaçable par un BVH ou une grille            |
| Rayons et requêtes                   | Sélection, tir, ligne de vue, collisions simples : la même structure sert au rendu et à l'application         |
| Objets statiques, occultants         | Bornes et index calculés une fois ; la base de l'occlusion culling, du batching et du précalcul de visibilité |
| Contrats séparés des implémentations | Le renderer reste indépendant de la scène ; chaque domaine peut avoir son implémentation                      |

## 4. Ce que demandent les domaines

| Besoin                   | Jeu                             | CAO / modélisation                         | BIM                                    |
| ------------------------ | ------------------------------- | ------------------------------------------ | -------------------------------------- |
| Nombre d'objets          | 10³ à 10⁴, beaucoup mobiles     | 10⁴ à 10⁶, peu mobiles                     | 10⁵ à 10⁶, statiques                   |
| Hiérarchie               | Peu profonde, change en jeu     | Profonde (assemblages), stable             | Par étage, zone, catégorie             |
| Mises à jour             | Chaque frame, beaucoup d'objets | Ponctuelles (édition)                      | Rares                                  |
| Identifiants             | Peu importants                  | Stables, pour la sélection et l'historique | Stables (GUID IFC)                     |
| Requêtes                 | Rayons, voisinage, frustum      | Sélection (rayon, rectangle), frustum      | Frustum, coupes, filtres par catégorie |
| Volumes                  | Capsules, boîtes (physique)     | Boîtes, formes exactes                     | Boîtes                                 |
| Visibilité par catégorie | Calques (minimap, effets)       | Calques, isolation                         | Catégories, étages                     |
| Occlusion                | Utile (villes, intérieurs)      | Utile (assemblages)                        | Décisive (l'essentiel est caché)       |
| Coordonnées              | Locales                         | Grandes, précision                         | Géoréférencées : très grandes          |
| Instancing               | Accessoires répétés             | Pièces répétées (vis)                      | Éléments répétés (fenêtres)            |

Ce qui est commun va dans les contrats : une hiérarchie, des volumes, des bornes, des identifiants, des calques, des requêtes spatiales, une notion d'objet statique. Ce qui diffère (fréquence des mises à jour, nombre d'objets, précision) relève de l'implémentation : d'où des contrats minces et des implémentations par domaine. Celle de ce document vise le jeu ; elle doit rester correcte, sinon optimale, pour les autres.

## 5. Alternatives

### 5.1 Où placer chaque chose

| Package                             | Contenu                                                | Dépend de                                              |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `@fdw/engine-geometry` (nouveau)    | Volumes, rayons, intersections, `SpatialIndex`, octree | rien                                                   |
| `@fdw/engine-core`                  | `RenderSource`, le `Renderer` qui culle par vue        | `engine-geometry` en plus de ses dépendances actuelles |
| `@fdw/engine-scene` (nouveau)       | Interfaces du scenegraph, implémentation orientée jeu  | `engine-core`, `engine-geometry`                       |
| `@fdw/engine-occlusion` (plus tard) | Hi-Z (passes de calcul du render graph), repli CPU     | `engine-core`, `engine-scene`                          |

Alternatives écartées : tout dans `engine-core` (le renderer et une implémentation de scène liés) ; un renderer qui dessine directement un scenegraph (une seule forme de scène possible). La géométrie à part permet à une physique ou à un outil de s'en servir sans le rendu. L'occlusion à part : elle est lourde (passes GPU, tables de la scène), optionnelle, et aura plusieurs implémentations (GPU, CPU).

### 5.2 Le modèle des objets

Les trois modèles, sur le même exemple : un joueur, qui a un corps (un mesh), une lampe et une caméra qui le suit.

**A. Sous-classes de nœuds (three.js, Godot).** Tout est un nœud, et le type du nœud dit ce qu'il est. Dans three.js, `Object3D` porte la transformation, les enfants, `visible` et `layers` ; `Mesh`, `Group`, `PointLight` et `PerspectiveCamera` en héritent. Un objet qui a plusieurs capacités devient plusieurs nœuds :

```ts
const player = new Group(); // la transformation du joueur
player.add(new Mesh(bodyGeometry, skin)); // son corps : un nœud enfant
player.add(new PointLight(0xffcc88)); // sa lampe : un autre nœud
player.add(camera); // la caméra : encore un nœud
scene.add(player);
```

Chaque frame, le renderer de three.js parcourt **tout l'arbre**, recalcule les matrices monde (`updateMatrixWorld`), teste chaque mesh contre le frustum avec sa sphère, et range les visibles. Pas d'index spatial.

**B. Nœuds et attachements (Unity, Unreal).** Le nœud ne porte que la hiérarchie et la transformation ; ses capacités sont des **attachements** (les composants d'Unity, les « components » d'un acteur d'Unreal) :

```ts
const player = scene.root.add(new Node({ name: 'player' }));
player.attach(new MeshRenderer({ mesh: body, material: skin }));
player.attach(new PointLight({ diffuse: { x: 1, y: 0.8, z: 0.5 } }));
player
  .add(new Node({ position: { y: 1.6, z: 3 } }))
  .attach(new Camera({ projection }));
```

La scène tient un **registre par type d'attachement** (tous les `MeshRenderer` dans l'octree, toutes les lumières dans une liste) : le rendu ne parcourt pas l'arbre, il interroge ses registres.

**C. ECS (entités, composants, systèmes).** Une entité n'est qu'un identifiant. Ses données sont des composants rangés en tableaux par type (une position pour chaque entité qui en a une, dans un `Float32Array`). La logique est dans des **systèmes** qui parcourent les entités ayant certains composants. La hiérarchie est un composant `Parent`, et un système de propagation calcule les matrices monde par profondeur :

```ts
const player = world.createEntity();
world.add(player, Transform, { y: 1 });
world.add(player, MeshRenderer, { mesh: body, material: skin });
world.add(player, PointLight, { diffuse: [1, 0.8, 0.5] });
const eye = world.createEntity();
world.add(eye, Transform, { y: 1.6, z: 3 });
world.add(eye, Parent, { entity: player });
world.add(eye, Camera, { projection });

// La logique du jeu : un système, appelé chaque frame.
const movement = system([Transform, Velocity], (transforms, velocities, dt) => { … });
```

| Critère                               | A. Sous-classes                       | B. Nœuds et attachements                        | C. ECS                                                        |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Prise en main                         | La plus simple                        | Simple                                          | Demande d'adopter le modèle, logique comprise                 |
| Plusieurs capacités sur un objet      | Plusieurs nœuds                       | Plusieurs attachements                          | Plusieurs composants                                          |
| Étendre (une capacité nouvelle)       | Une sous-classe ; héritage rigide     | Un attachement                                  | Un composant et un système                                    |
| Hiérarchie                            | Naturelle                             | Naturelle                                       | Un composant ; parcours par profondeur à organiser            |
| Coût du rendu                         | Parcours de tout l'arbre chaque frame | Requêtes sur des registres et des index         | Parcours de tableaux denses : le plus rapide                  |
| Mémoire, cache                        | Un objet par nœud, dispersé           | Un objet par nœud et par attachement            | Tableaux contigus                                             |
| 10⁴ objets mobiles (jeu)              | Correct                               | Correct                                         | Le meilleur                                                   |
| 10⁶ objets statiques (BIM)            | Lourd (objets, parcours)              | Correct avec index statiques ; lourd en mémoire | Le meilleur en mémoire ; requêtes à ajouter                   |
| Adapté à la CAO, au BIM, à un éditeur | Oui : des objets qu'on manipule       | Oui : des objets et leurs propriétés            | Moins : pas d'objet à manipuler, la hiérarchie est secondaire |
| Coût d'implémentation                 | Faible                                | Moyen                                           | Élevé, et en TypeScript le gain demande des tableaux typés    |

**Ce qui coûte en JavaScript.** Un tableau d'objets ne contient que des pointeurs, mais les objets pointés coûtent : un en-tête par objet, des nombres à virgule souvent « emboîtés » dans des objets à part, une centaine d'octets de structure par `Float32Array` (une matrice par nœud est chère). Parcourir 10⁵ objets dispersés dans le tas, c'est un défaut de cache presque à chaque objet ; et le ramasse-miettes parcourt tous les objets vivants, d'où des pauses qui se voient dans un jeu. Un ECS ne gagne donc en JavaScript que si ses données chaudes sont des **colonnes de tableaux typés** (comme bitecs) ; un ECS dont les composants sont des objets JS perd l'essentiel de l'avantage. Ces colonnes sont aussi, presque telles quelles, les tables de la scène qu'attend le rendu piloté par le GPU.

**Décision : un cœur ECS, avec des nœuds comme façade.** B et C se rejoignent si l'on sépare le stockage et l'API : le stockage est celui de C (entités, colonnes typées, requêtes, systèmes), l'API objet celle de B (des nœuds qu'on manipule, des composants qu'on y attache). Un jeu exigeant écrit des systèmes sur le cœur ; la CAO, le BIM, un éditeur ou un jeu simple passent par les nœuds. C'est l'option la plus chère à implémenter (deux niveaux d'API, poignées périmées à détecter), mais la seule qui ne plafonne ni à 10⁶ objets ni pour le GPU. Voir le §9.

### 5.3 La mise à jour des valeurs dérivées

Ce qui dérive d'un nœud : sa **matrice monde** (le produit des matrices locales de ses ancêtres), les **bornes monde** de ses attachements (qui en dépendent), sa **place dans l'index spatial** (qui dépend de ses bornes), et la position des lumières et caméras attachées.

Le point qui décide : **l'index doit être à jour avant toute requête, y compris pour les objets que personne ne lit.** Un objet hors champ qui entre dans le champ doit avoir été déplacé dans l'octree ; or personne n'a demandé sa matrice. Une mise à jour purement à la demande ne le voit pas : il faut que les changements soient **signalés**.

**A. Phase explicite `scene.update()`.** L'application appelle `update()` entre la logique et le rendu ; la scène recalcule tout ce qui a changé.

**B. Paresseuse, à la demande (comme `CachedValue`).** Chaque valeur dérivée garde les versions de ce dont elle dépend, et se recalcule à la lecture si l'une a changé. C'est ce que fait `TransformCache` aujourd'hui avec son parent.

**C. Invalidation, puis recalcul à la demande ou au moment des requêtes** (proposée) :

1. **Invalider** : modifier la transformation d'un nœud (ou le déplacer, l'ajouter, le retirer) l'**invalide**. Le nœud marque sa matrice monde comme périmée, ainsi que celle de ses descendants : le marquage s'arrête aux nœuds déjà périmés, donc invalider dix fois le même nœud dans une frame ne coûte qu'une fois. La racine de la branche invalidée est ajoutée à une **liste de branches à recalculer** de la scène.
2. **Recalculer à la demande** : lire `node.worldMatrix` recalcule la matrice si elle est périmée (celle du parent d'abord, si besoin), puis la marque à jour. Une matrice à jour se lit sans aucun test sur les ancêtres. La logique du jeu lit donc des positions monde justes à tout moment.
3. **Vider avant les requêtes** : toute requête de la scène (le rendu, un rayon, une recherche de voisins) commence par vider la liste : recalcul des branches périmées, des bornes, et mise à jour de l'index pour les nœuds dont les bornes ont changé. `scene.update()` existe toujours, pour vider la liste à un moment choisi (avant la physique, par exemple), mais l'oublier ne donne jamais d'image fausse.

| Critère                          | A. `update()` explicite                                               | B. Paresseuse (versions)                                            | C. Invalidation + à la demande                        |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Coût d'une frame sans changement | Rien si l'on ne garde que les branches modifiées ; tout l'arbre sinon | Rien tant qu'on ne lit pas ; une vérification par lecture           | Rien                                                  |
| Coût d'une lecture de matrice    | Aucun (déjà calculée)                                                 | Vérifier les versions de toute la chaîne d'ancêtres : O(profondeur) | Un test de drapeau ; un recalcul si périmée           |
| Coût d'un nœud modifié           | Recalcul de sa branche                                                | Recalcul à la lecture                                               | Marquage de la branche (une fois par frame), recalcul |
| Index spatial à jour             | Oui, après `update()`                                                 | **Non** : personne ne signale les changements                       | Oui, avant chaque requête                             |
| Valeurs justes en cours de frame | Non, jusqu'au prochain `update()`                                     | Oui                                                                 | Oui                                                   |
| Oubli possible                   | Oui : image en retard d'une frame                                     | Non                                                                 | Non                                                   |
| Déterminisme, débogage           | Le meilleur : un seul moment de calcul                                | Calculs dispersés au fil des lectures                               | Bon : recalculs à la lecture, index aux requêtes      |
| Hiérarchies profondes (CAO)      | Bon                                                                   | Mauvais (chaînes de versions)                                       | Bon                                                   |

**Décision : C, la logique des cached values avec invalidation, stockée dans les colonnes de l'ECS.** La poussée (ce qui change signale son changement, ce dont l'index a besoin) combinée à la paresse (rien n'est recalculé avant d'être lu ou demandé). `CachedValue` a déjà `invalidate()` et des dépendances modifiables, mais il ne fait que tirer : chaque lecture compare les versions de toute la chaîne, et `invalidate()` ne prévient pas les dépendants. Ici :

- chaque valeur dérivée d'une entité a un **bit « périmé »** et une **version** dans des colonnes, pas un objet par entité et par valeur ;
- l'invalidation **pousse** : elle pose le bit sur les dépendants (la branche), en s'arrêtant à ceux qui l'ont déjà, et prévient les **effets** abonnés (l'octree, la table des bornes) ;
- la lecture **tire** : un bit à tester, un recalcul seulement s'il est posé ;
- les **dépendances dynamiques** : dans la hiérarchie, la seule est le parent ; changer de parent remplace le lien et invalide la branche. Un composant de l'utilisateur dont la valeur dérivée dépend d'autres valeurs s'abonne aux invalidations de son entité.

Les **versions** restent en sortie : le renderer compare celle de la matrice monde pour ne réécrire l'uniform `object` d'un objet que s'il a bougé. Les classes `CachedValue` restent pour ce qui est peu nombreux (caméras, lumières, matériaux).

### 5.4 L'index spatial

| Option                       | Intérêt                                                                                                   | Coût                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A. Octree lâche** (retenu) | Insertion et déplacement en O(profondeur) ; un objet n'est que dans une cellule ; pas de découpe d'objets | Cellules qui se recouvrent : un peu plus de tests qu'un octree strict              |
| B. Octree strict             | Cellules disjointes                                                                                       | Les objets à cheval sur une frontière restent haut dans l'arbre, ou sont dupliqués |
| C. BVH                       | Meilleure qualité pour des objets statiques (CAO, BIM) ; réajustable                                      | Reconstruction ou réajustement à chaque mouvement ; plus complexe                  |
| D. Grille uniforme / hachage | Le plus simple ; excellent pour des objets de taille homogène (jeu)                                       | Mauvais quand les tailles varient (un bâtiment et une vis)                         |

Le contrat `SpatialIndex` permet d'ajouter un BVH plus tard, pour les scènes statiques de CAO et de BIM.

### 5.5 L'occlusion culling (plus tard)

Comparées ici pour savoir ce qu'il faut préparer ; aucune n'est implémentée dans ce document.

| Technique                                | Principe                                                                                                               | Backends             | Intérêt                                                                   | Coût                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Hi-Z en deux phases** (retenu d'abord) | Pyramide de profondeur, test des bornes de tous les objets dans un compute ; les visibles dessinés par draws indirects | WebGPU, Vulkan       | Le plus efficace ; aucune latence visible                                 | Compute, draws indirects, rendu piloté par le GPU ([évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu)) |
| Requêtes d'occlusion (CHC++)             | Dessiner les boîtes des objets incertains, demander au GPU si des pixels passent ; résultat à la frame suivante        | Tous (WebGL2 inclus) | Portable ; simple                                                         | Une frame de retard (apparitions) ; une requête par objet ou groupe                                             |
| Rastérisation logicielle des occultants  | Rastériser sur le CPU des versions simplifiées des gros objets statiques, tester les bornes                            | Tous                 | Pas de latence ; pas de GPU : le repli CPU naturel                        | CPU (SIMD, WASM) ; occultants à fabriquer                                                                       |
| Visibilité précalculée (PVS, portails)   | Précalculer, pour des cellules de l'espace, ce qui peut être vu ; portails entre pièces                                | Tous                 | Quasi gratuit à l'exécution ; naturel pour des bâtiments (pièces, étages) | Précalcul ; géométrie statique uniquement                                                                       |

**Décision** : le GPU autant que possible (Hi-Z en deux phases) ; le CPU n'est qu'un repli, pour les backends sans calcul (WebGL2). Le Hi-Z existe en deux variantes, à départager dans le design du package `engine-occlusion` :

- **avec relecture** : le compute écrit un masque de visibilité, relu par le CPU une ou deux frames plus tard. Il s'insère dans le renderer actuel (un draw par objet), au prix d'une latence (des objets qui apparaissent avec un temps de retard) ;
- **piloté par le GPU** : le compute écrit directement les draws visibles dans un buffer indirect. Pas de latence, mais il faut les draws indirects dans l'API abstraite et les tables de la scène.

Toutes ces techniques demandent la même base, posée au §10 : des **objets statiques**, des **occultants** désignés, des **identifiants stables**, une **table des bornes** que le GPU peut lire, et un **historique de visibilité** par objet.

## 6. Design : les volumes

Dans `@fdw/engine-geometry`. Les vecteurs sont des tuples (`[x, y, z]`) ou des tableaux typés ; les fonctions appelées par objet et par frame écrivent dans un objet de sortie fourni, pour ne rien allouer dans les boucles chaudes.

### 6.1 L'interface

```ts
/** A volume of space: built-in, or defined by the application. */
interface Volume {
  // Identifies the type of volume, for the fast intersection tests.
  readonly kind: string;
  // A box containing the volume: what the spatial indices store.
  bounds(out: Aabb): Aabb;
  // The volume transformed by a matrix: exact for rotations, translations
  // and uniform scales, conservative (larger) for non-uniform scales.
  transform(matrix: Mat4): Volume;
  containsPoint(point: Vec3): boolean;
  // The distance along the ray to the volume, or undefined.
  raycast(ray: Ray): number | undefined;
}

/** A convex volume: its support function gives intersections with any other. */
interface ConvexVolume extends Volume {
  // The farthest point of the volume in a direction.
  support(direction: Vec3, out: Vec3): Vec3;
}
```

La **fonction de support** est ce qui rend les volumes de l'utilisateur utilisables partout : l'algorithme **GJK** teste l'intersection de deux volumes convexes quelconques à partir de leurs seules fonctions de support. Un cylindre défini par l'application coupe donc une capsule ou une boîte sans que personne n'ait écrit ce test. C'est aussi la base de la physique : **EPA**, la suite de GJK, donne la pénétration et la normale de contact.

### 6.2 Les intersections

```ts
intersects(a: Volume, b: Volume): boolean;
// A fast test for a pair of kinds, used before GJK.
registerIntersection('capsule', 'sphere', (capsule, sphere) => …);
```

`intersects` cherche un test rapide pour la paire de types (boîte–boîte, sphère–sphère, sphère–boîte, capsule–sphère, boîte orientée–boîte…), puis se rabat sur GJK si les deux volumes sont convexes. Un volume non convexe sans test rapide déclenche une erreur explicite.

### 6.3 Les volumes de base

| Volume    | Usage                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------ |
| `Aabb`    | Boîte alignée sur les axes : les index, le culling                                               |
| `Sphere`  | Bornes rapides des meshes, lumières ponctuelles                                                  |
| `Obb`     | Boîte orientée : les bornes serrées d'un objet tourné                                            |
| `Capsule` | Personnages, physique                                                                            |
| `Frustum` | Six plans extraits d'une matrice vue-projection (Gribb et Hartmann, profondeur [0, 1]) ; convexe |
| `Ray`     | Pas un volume : une origine et une direction, pour les requêtes                                  |

Le frustum culling n'utilise que les tests rapides du frustum contre une boîte ou une sphère, avec un résultat à trois états pour les cellules de l'octree :

```ts
frustum.classifyAabb(box): 'outside' | 'intersects' | 'inside';
```

Utilitaires : `transformAabb(box, matrix, out)` (méthode d'Arvo, sans transformer les huit coins), et `meshBounds(mesh)` dans `engine-core`, qui donne désormais une boîte et une sphère, calculées une fois par version du mesh.

## 7. Design : le renderer et ses sources

### 7.1 La source de rendu

Le renderer n'attend plus forcément une liste : il interroge une **source** pour chaque vue.

```ts
interface RenderSource {
  // The items whose bounds touch a volume (the frustum of a view), with
  // the layer mask of the view.
  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    // What the query is for: what a camera sees, or the casters of a
    // shadow map.
    view: 'camera' | 'shadow'
  ): void;
  // The lights of the source, when the frame does not give its own.
  lights?(): Iterable<BaseLight>;
  // The bounds of everything: how far shadow casters can be.
  bounds?(out: Aabb): Aabb;
}

renderer.render({ source: scene, camera, surface });
renderer.render({ items, camera, surface, lights }); // inchangé
```

`view` est apparu à l'implémentation : l'occlusion culling ne doit s'appliquer qu'aux requêtes d'une caméra, jamais à celles des ombres (un projeteur caché à la caméra peut projeter une ombre visible), et l'historique de visibilité ne compte que les caméras. `bounds` donne jusqu'où prolonger le volume des projeteurs vers la lumière (§7.2).

`items` reste accepté : une liste devient une source sans index, qui fait un **frustum culling brut** (la sphère de chaque item). Les applications actuelles gagnent le culling sans rien changer.

### 7.2 Limiter lumières et ombres à ce que voit la caméra

Le principe : une lumière, une ombre ou un projeteur ne coûtent rien s'ils ne peuvent pas changer un pixel de la vue ; mais rien de ce qui peut en changer un n'est retiré.

- **Les receveurs** : les items retenus par le frustum de la caméra, et leurs bornes réunies (`R`).
- **Les lumières retenues** : une lumière directionnelle touche toujours la vue ; une lumière ponctuelle ou un spot, seulement si son **volume d'influence** coupe le frustum de la caméra. Ce volume est une sphère (une ponctuelle) ou la sphère englobant le cône (un spot), de rayon la distance où l'atténuation passe sous un seuil (1/256 de l'intensité). Au-delà de 16, le renderer garde les directionnelles, puis les autres par contribution estimée sur `R`.
- **Les ombres retenues** : une lumière qui projette des ombres n'a de shadow map que si elle est retenue.
- **Les projeteurs d'une lumière** : tout objet dont l'ombre peut tomber sur `R`. Pour une lumière directionnelle, c'est le volume de `R` **prolongé vers la lumière** (en espace lumière : la boîte de `R`, son plan proche repoussé jusqu'aux bornes de la scène côté lumière). Pour un spot, son frustum, restreint de la même façon. Un arbre hors champ dont l'ombre tombe dans le champ est donc gardé ; un objet derrière la caméra, dont l'ombre tombe derrière elle, ne l'est pas.
- **La shadow map d'une lumière directionnelle** couvre `R`, plus toute la scène : sa résolution suit ce que voit la caméra. `shadow.bounds` reste prioritaire.
- **Statistiques** : `renderer.stats` donne, par frame et par vue, les items testés, retenus et dessinés, et les lumières et ombres retenues.

### 7.3 La matrice monde d'un item

```ts
// As today: a Transform, whose local matrix is the world matrix.
interface RenderItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly transform: Transform;
  readonly castShadow?: boolean;
  // The world bounds, when the source knows them.
  readonly bounds?: Aabb;
}

// A world matrix computed elsewhere (a scene graph), with its version.
interface WorldRenderItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly world: { readonly matrix: Mat4; readonly version: number };
  readonly castShadow?: boolean;
  readonly bounds?: Aabb;
}

type Renderable = RenderItem | WorldRenderItem;
```

Deux types plutôt qu'un `transform` optionnel : le code existant, qui écrit `item.transform.position = …`, compile sans changement. Le renderer et les sources manipulent des `Renderable`.

Le renderer recalcule la matrice des normales et réécrit l'uniform `object` quand la version change, comme aujourd'hui avec le `Transform`. Un `MeshRenderer` du scenegraph **est** un `WorldRenderItem` : rien n'est alloué par frame.

## 8. Design : l'index spatial et l'octree

### 8.1 Le contrat

```ts
interface SpatialIndex<T> {
  insert(item: T, bounds: Aabb): void;
  update(item: T, bounds: Aabb): void;
  remove(item: T): void;
  // inside: the item is in a cell entirely inside the frustum, its own
  // test can be skipped.
  queryFrustum(
    frustum: Frustum,
    visit: (item: T, inside: boolean) => void
  ): void;
  // The items whose bounds touch a volume (any Volume, through its bounds,
  // then intersects()); visit returns false to stop.
  queryVolume(volume: Volume, visit: (item: T) => boolean | void): void;
  // The items whose bounds the ray crosses, nearest first; the exact test
  // (triangles, the item's own volume) is the caller's.
  raycast(ray: Ray, visit: (item: T, distance: number) => boolean | void): void;
  bounds(out: Aabb): Aabb | undefined;
}
```

Il ne connaît ni nœud ni mesh : n'importe quel scenegraph, un ECS, une physique ou une application peuvent l'utiliser avec leurs propres objets.

Deux implémentations :

- **`LinearIndex`** : un tableau, parcouru entièrement. La référence des tests, et le bon choix sous quelques centaines d'objets.
- **`Octree`** : ci-dessous.

### 8.2 L'octree lâche

- **Cellules lâches** : chaque cellule accepte les objets dont le **centre** est dans sa cellule stricte et dont la taille tient dans sa version agrandie d'un facteur 2. Un objet est rangé à la profondeur que lui donne sa taille, dans la cellule de son centre : insertion et déplacement sans descente ni découpe.
- **Racine extensible** : un objet hors de la racine la fait grandir (une nouvelle racine deux fois plus grande, l'ancienne pour enfant), sans tout reconstruire.
- **Profondeur et taille** : profondeur maximale (8 par défaut) ; une cellule n'est subdivisée qu'au-delà de quelques objets (8), et les cellules vides sont retirées.
- **Construction en masse** : `Octree.build(items)` pour un grand nombre d'objets d'un coup (l'octree statique) : tri par cellule plutôt qu'insertions une à une.
- **Déplacement** : `update` ne fait rien si l'objet reste dans sa cellule (le cas courant d'un objet qui bouge un peu), sinon le retire et le réinsère.
- **Requête de frustum** : descente avec `classifyAabb` sur les bornes lâches ; une cellule entièrement dedans livre ses objets et ses descendants sans autre test.
- **Mémoire** : les objets d'une cellule dans un tableau ; la place d'un objet (cellule, indice) dans une table, pour un retrait en O(1).

## 9. Design : le scenegraph

Trois niveaux dans `@fdw/engine-scene` : un **cœur ECS** (le stockage et les requêtes), la **scène** (hiérarchie, transformations, rendu, index, sur ce cœur) et la **façade de nœuds** (l'API objet).

### 9.1 Le cœur ECS

```ts
const world = new World();
const Velocity = defineComponent({ x: 'f32', y: 'f32', z: 'f32' });
const Health = defineComponent({ value: 'u16' });
const Target = defineComponent({ node: 'ref' }); // une colonne d'objets

const enemy = world.create();
world.add(enemy, Velocity, { x: 1 });

// Un système : une fonction qui parcourt une requête.
const moving = world.query(Transform, Velocity);
function move(dt: number) {
  for (const entity of moving) {
    Transform.x[entity] += Velocity.x[entity] * dt; // invalide l'entité (§9.3)
  }
}
```

- **Entités** : un indice (dans les colonnes) et une **génération**, réunis dans un nombre. Détruire une entité incrémente la génération de son indice : une poignée périmée est détectée au lieu de viser l'entité qui a repris l'indice.
- **Composants** : un schéma de champs typés (`f32`, `f64`, `i32`, `u32`, `u16`, `u8`, ou `ref` pour une référence à un objet). Chaque champ est une **colonne** : un tableau typé indexé par entité, agrandi par doublement. Les références (un mesh, un matériau) sont des colonnes d'objets.
- **Appartenance** : un masque de bits par entité (les composants qu'elle a), et pour chaque composant un ensemble creux (_sparse set_) de ses entités : ajout et retrait en O(1), parcours dense. Les archétypes (entités groupées par combinaison de composants) parcourent plus vite mais rendent les ajouts et retraits coûteux ; un jeu en fait beaucoup (états, effets).
- **Requêtes** : `world.query(A, B, not(C))`, tenues à jour à chaque ajout et retrait, et parcourues sans allocation.
- **Systèmes** : de simples fonctions ; le cœur n'impose ni ordonnanceur ni boucle. La scène et les démos les appellent dans l'ordre qu'elles veulent.

### 9.2 La scène

La scène est un `World` dont chaque entité a les colonnes de la hiérarchie et de la transformation, rangées directement par indice d'entité (pas d'ensemble creux : toutes en ont) :

| Colonnes                                        | Contenu                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `Transform` (10 × `f32`)                        | Position, rotation (quaternion), échelle locales                  |
| `World` (16 × `f32`), version (`u32`)           | Matrice monde (valeur dérivée), et sa version                     |
| `Hierarchy` (4 × `i32`)                         | Parent, premier enfant, frère précédent et suivant                |
| Drapeaux (`u8`), calques (`u32`)                | Visible, statique, occultant, bits « périmé » ; masque de calques |
| `lastVisibleFrame` (`u32`), identifiant (`u32`) | Historique de visibilité ; identifiant stable                     |

Et des composants de la scène, ajoutés aux entités qui en ont besoin :

| Composant      | Données                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MeshRenderer` | Mesh, matériau (`ref`), `castShadow` ; bornes monde (6 × `f32`, valeur dérivée) ; emplacement dans la table des bornes ; un `Volume` optionnel pour les requêtes |
| `Light`        | La lumière (`ref`, les classes existantes), dont la position et la direction suivent l'entité                                                                    |
| `CameraView`   | La caméra (`ref`), dont la vue suit l'entité                                                                                                                     |

Le `Renderer` attend des `RenderItem` : chaque entité qui a un `MeshRenderer` en reçoit un, créé une fois, dont `world.matrix` est une vue sur sa ligne de la colonne `World` et `world.version` lit sa version. Aucun objet n'est créé par frame. Le jour du rendu piloté par le GPU, ce sont les colonnes elles-mêmes qui partiront vers le GPU.

### 9.3 L'invalidation et les recalculs

Selon le §5.3 :

- écrire la transformation locale (par la façade, ou par un système avec `scene.touch(entity)` après des écritures directes en colonnes), ajouter, retirer, déplacer une entité ou changer sa visibilité **l'invalide** : le bit « matrice monde périmée » est posé sur sa branche (parcours par les liens de la hiérarchie, arrêté aux entités déjà périmées), et l'entité racine de la branche entre dans la **liste des changements** ;
- lire la matrice monde (`scene.worldMatrix(entity)`, `node.worldMatrix`) la recalcule si le bit est posé, après celle du parent si besoin ;
- toute requête (`query` du rendu, `raycast`, `queryVolume`) et `scene.flush()` **vident la liste** : matrices des branches, bornes monde des `MeshRenderer`, octree et table des bornes pour les entités dont les bornes ont changé, lumières et caméras attachées ;
- les effets (l'octree, la table des bornes, un composant de l'utilisateur) s'abonnent aux invalidations d'un composant ;
- les entités statiques suivent le §10.

Écrire directement dans les colonnes est le chemin le plus rapide pour un système qui déplace des milliers d'entités : il les signale ensuite d'un coup (`scene.touch(entities)`).

### 9.4 La façade de nœuds

```ts
const scene = new Scene();
const player = scene.root.add({ name: 'player', position: { y: 1 } });
player.attach(MeshRenderer, { mesh: body, material: skin });
const hand = player.add({ position: { x: 0.4, y: 0.2, z: -0.3 } });
hand.attach(MeshRenderer, { mesh: sword, material: steel });
const lamp = player.add({ position: { y: 1.5 } });
lamp.attach(Light, {
  light: new SpotLight({ outerCutoff: 25, castShadow: true }),
});
const eye = player.add({ position: { y: 12, z: 6 } });
const camera = eye.attach(CameraView, {
  camera: new Camera({ projection }),
}).camera;

// Each frame: the game logic, then the rendering. Nothing to update by hand.
player.transform.position = { x: player.transform.position.x + speed * dt };
renderer.render({ source: scene, camera, surface });
```

- **`Node`** : une poignée (la scène et l'entité). Elle donne `transform` (mêmes accesseurs que la classe `Transform` : valeurs partielles, et invalidation), `worldMatrix`, `parent`, `children`, `add`, `remove`, `attach(Component, data)`, `get(Component)`, `layers`, `visible`, `static`, `occluder`, `id`, `name`. Les poignées d'une entité détruite lèvent une erreur.
- **Interfaces abstraites** : `SceneNode` et `SceneGraph` décrivent ce qu'est une scène (hiérarchie, matrices monde, calques, requêtes), indépendamment de son stockage ; la façade les implémente. Des outils (sélection, vues de debug, sérialisation, occlusion) peuvent ainsi fonctionner sur une autre implémentation.
- **Calques** : une vue (`render({ layers })`) ne voit que les entités dont les calques coupent les siens. Le jeu s'en sert pour une minimap ou une vue de debug, la CAO pour isoler des catégories, le BIM pour des étages.
- **Recherche** : `scene.byId(id)`, `scene.find(name)`, `node.traverse(visit)`.
- **Événements** : aucun pour l'instant ; une application d'édition voudra savoir ce qui change, ce sera une extension.

### 9.5 La scène comme source

`Scene` implémente `RenderSource` : `query` vide la liste des changements, interroge l'octree statique puis le dynamique, filtre par calques et visibilité, passe l'étape d'occlusion si elle existe (§10), et livre les `RenderItem` des `MeshRenderer`. Le culling passe par l'octree, pas par la hiérarchie : une hiérarchie logique (un étage BIM, un assemblage) n'a pas à être spatialement compacte.

### 9.6 Les requêtes de l'application

```ts
scene.raycast(ray, { layers }, (node, distance) => …);   // sélection, tir, ligne de vue
scene.queryVolume(capsule, {}, (node) => …);              // voisinage, collisions simples
scene.queryVolume(frustum, {}, (node) => …);              // sélection au rectangle
```

Les requêtes travaillent sur les bornes, puis sur le `Volume` du `MeshRenderer` s'il en a un ; un test exact sur les triangles est un utilitaire séparé (`raycastMesh`), appelé sur les candidats. Elles existent aussi par entité (`scene.raycastEntities`), pour les systèmes.

## 10. Design : objets statiques et prémices de l'occlusion culling

- **`static`** : le nœud et ses descendants ne bougent pas (décor, bâtiment, pièce fixe). Leurs matrices et bornes sont calculées une fois ; ils vont dans un **octree statique** à part, construit en masse à la première requête. Modifier un nœud statique reste permis, mais coûte une mise à jour de l'octree statique : un avertissement en développement le signale.
- **`occluder`** : le nœud est un bon occultant (un mur, un bâtiment, une dalle). Le Hi-Z dessinera d'abord les occultants (et ce qui était visible) pour construire sa pyramide ; pour l'instant, `scene.occluders()` les liste.
- **Table des bornes** : chaque nœud qui porte un mesh reçoit un **emplacement** stable dans une table dense (`Float32Array` des boîtes monde, par emplacement), tenue à jour avec l'index. C'est ce qu'un compute shader lira pour tester tous les objets d'un coup : la première des « tables de la scène » du [render graph §10.2](render-graph.md#102-la-vue-de-scène).
- **Historique de visibilité** : chaque nœud garde la dernière frame où il a été retenu par la vue principale (`lastVisibleFrame`). C'est la donnée de base du Hi-Z en deux phases (dessiner d'abord ce qui était visible) et des requêtes d'occlusion.
- **Étape de visibilité enfichable** : la requête de la scène enchaîne frustum, puis une étape d'**occlusion** optionnelle (`OcclusionCuller`, une interface définie dans `engine-scene`, implémentée plus tard par `engine-occlusion`), puis la livraison.
- **Identifiants stables** : déjà au §9.1 ; ils servent aux résultats différés (un masque de visibilité relu une frame plus tard).

Ce que les objets statiques ouvrent ensuite, hors de ce document : le **batching statique** (fusionner les meshes statiques d'un même matériau par cellule de l'octree, pour moins de draws), l'**instancing**, et le précalcul de visibilité.

## 11. Les démos

Après le scenegraph, une série de démos **incrémentales** qui construisent pas à pas un petit jeu : un **labyrinthe vu de dessus** (perspective plongeante ou isométrique), un personnage qui le parcourt avec une **lampe torche** (un spot porté par le personnage), dans le noir : on ne voit que ce qu'éclaire la lampe. Chaque démo est jouable dans le navigateur et dans la fenêtre native (les événements de `NativeWindow` sont déjà des événements DOM), et met en valeur une partie du moteur.

| Démo | Contenu                                                                                                                                  | Ce qu'elle montre                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| L1   | Le labyrinthe généré (murs, sol : des milliers d'entités statiques), caméra libre au-dessus, vue de dessus en incrustation, statistiques | Entités statiques, octree statique, frustum culling                        |
| L2   | Le personnage : déplacement au clavier (et à la manette plus tard), collisions contre les murs, caméra qui le suit                       | Façade de nœuds, hiérarchie, requêtes de volumes (capsule contre l'octree) |
| L3   | La lampe torche : un spot porté par le personnage, orienté vers la souris, ombres des murs, aucune lumière ambiante                      | Lumières et ombres limitées à la vue (§7.2), culling des projeteurs        |
| L4   | Le jeu : objets à ramasser, ennemis qui rôdent (systèmes ECS), ligne de vue par rayons, condition de victoire                            | Cœur ECS et systèmes, rayons, entités dynamiques                           |

**Ne voir que ce qu'éclaire la lampe.** Sans lumière ambiante, ce qui est hors du cône est noir : c'est un rendu naturel du moteur, avec les ombres des murs pour masquer ce qui est derrière. Le culling peut aller plus loin : quand une vue n'a que des lumières bornées (spots, ponctuelles) et aucun terme ambiant, un objet hors de tous les volumes d'influence est noir, donc inutile à dessiner. Cette option (`render({ cullUnlit: true })`) prolonge le §7.2 ; elle est sans effet dès qu'une lumière directionnelle ou un ambiant éclairent la vue.

Ce qu'un jeu demande en plus, à construire au fil des démos : une boucle à pas fixe pour la logique, l'entrée (clavier, souris, manette) commune au navigateur et à la fenêtre native, des collisions simples (volumes contre l'octree statique), et des meshes moins pauvres que des cubes (génération, ou chargement glTF).

## 12. Coût

| Étape                                                  | Taille estimée  | Risque                                     |
| ------------------------------------------------------ | --------------- | ------------------------------------------ |
| Volumes, intersections, GJK                            | Moyenne         | Moyen : GJK demande des tests soignés      |
| Index linéaire et octree                               | Moyenne         | Moyen : correction et performances         |
| Sources de rendu, culling des vues, lumières et ombres | Moyenne         | Moyen : touche le `Renderer` et les ombres |
| Cœur ECS (entités, colonnes, requêtes)                 | Moyenne         | Moyen : performances, poignées périmées    |
| Scène, invalidation, façade de nœuds                   | Moyenne         | Moyen : l'invalidation doit être exacte    |
| Statique, occultants, table des bornes                 | Petite          | Faible                                     |
| Démo et documentation                                  | Moyenne         | Faible                                     |
| Démos du labyrinthe (L1 à L4)                          | Moyenne chacune | Faible à moyen (entrée, collisions)        |

**Objectifs de performance**, avec les benchs du fake backend :

- 10 000 nœuds dont 10 % visibles : requête de la caméra sous 0,2 ms, frame CPU complète sous 0,5 ms (contre environ 18 ms sans culling).
- 1 000 nœuds dynamiques qui bougent chaque frame : invalidation et recalculs sous 1 ms.
- 100 000 nœuds statiques : construction de l'octree statique sous 100 ms.

**Mesures** (S1 à S6, mêmes benchs) :

| Mesure                                               | Objectif | Mesuré  |
| ---------------------------------------------------- | -------- | ------- |
| Requête de la caméra, 10 000 nœuds, 1 000 visibles   | 0,2 ms   | 0,06 ms |
| 1 000 nœuds qui bougent, puis la requête             | 1 ms     | 0,6 ms  |
| Frame CPU complète, 1 000 objets visibles            | 0,5 ms   | 1,9 ms  |
| Octree seul, 100 000 objets construits en masse      | 100 ms   | 100 ms  |
| 100 000 nœuds statiques créés par la façade, indexés | 100 ms   | 485 ms  |

- La frame complète : l'objectif était mal posé. Le coût d'un objet **dessiné** (environ 1,6 µs) est celui du `Renderer`, pas de la scène ; sans culling, la même frame coûte environ 18 ms. Le gagner demande de réduire le travail du renderer par objet (§5 du backlog) ou les draws eux-mêmes (instancing, rendu piloté par le GPU).
- La création : environ 3 µs par nœud, dans le chemin générique d'ajout des composants. Une création en lot qui écrit directement les colonnes (chargement d'un niveau, d'un modèle BIM) est notée au backlog.

## 13. Plan d'implémentation

- **S1. Géométrie** _(fait)_ (`engine-geometry`) : `Volume`, `ConvexVolume`, `Aabb`, `Sphere`, `Obb`, `Capsule`, `Frustum`, `Ray` ; tests rapides par paire, `registerIntersection`, GJK ; `transformAabb`. Tests exacts, bench.
- **S2. Index** _(fait)_ (`engine-geometry`) : `SpatialIndex`, `LinearIndex`, `Octree` (lâche, racine extensible, construction en masse) ; requêtes frustum, volume, rayon. Tests d'équivalence avec l'index linéaire ; bench.
- **S3. Sources de rendu** _(fait ; `RenderItem` et `WorldRenderItem` séparés, `view` et `bounds` ajoutés au contrat)_ (`engine-core`) : `RenderSource`, `RenderItem.world` et `bounds`, la boîte de `meshBounds`, la liste comme source à culling brut, le culling des vues, les lumières et ombres limitées à la vue (§7.2), `renderer.stats`.
- **S4. Cœur ECS** _(fait)_ (`engine-scene`) : `World`, entités et générations, `defineComponent` et colonnes typées, ensembles creux, requêtes. Tests, bench (création, ajout, retrait, parcours).
- **S5. Scène et façade** _(fait)_ (`engine-scene`) : colonnes de la hiérarchie et de la transformation, composants `MeshRenderer`, `Light`, `CameraView`, invalidation par bits « périmé », liste des changements et effets, calques, identifiants, recherche, requêtes ; façade `Node` et interfaces `SceneNode`, `SceneGraph` ; `Scene` comme `RenderSource`.
- **S6. Statique et prémices de l'occlusion** _(fait, avec S5 ; la table des bornes est la colonne `MeshRenderer.bounds`)_ : entités statiques et octree statique, `occluder`, table des bornes, `lastVisibleFrame`, l'étape `OcclusionCuller`.
- **S7. Documentation** _(fait ; plus le tutoriel « Créer un jeu », écrit au fil des démos)_ : guides « Geometry » et « Scene graph » (cœur ECS, façade, invalidation), tutoriel avec exemple vivant, en anglais et en français ; README des packages.
- **L1 à L4. Les démos du labyrinthe** (§11), une par une, chacune vérifiée avant la suivante, chacune avec sa page du tutoriel. _L1 à L4 faites_ (`packages/demo-scenes/src/maze/`, route `maze` de la démo pour la dernière étape, `demo-native -- maze`, `-- maze-1` à `-- maze-3` pour les précédentes). L3 a ajouté au renderer l'option `cullUnlit` (`lightReaches`, `spotVolume`) : quand toutes les lumières de la vue sont bornées, ce qu'aucune n'atteint n'est pas dessiné. Leçon : le terme ambiant d'une lumière ne s'atténue pas avec la distance, il rend visible la limite du culling ; les lumières de la lampe n'en ont pas, et le fond est noir. L4 : gemmes, sortie, ennemis (composants `Gem` et `Enemy`, systèmes en simples fonctions, logique à pas fixe), déplacement des ennemis sur le graphe du labyrinthe (BFS), lignes de vue par les rayons de la scène, éblouissement par le faisceau ; la mini-carte devient une carte de l'exploration avec brouillard (cellules découvertes en marchant ou en éclairant, image dessinée sur le CPU et envoyée par la nouvelle méthode `writeTexture` des backends, un seul draw), la vue du culling restant sur la touche C. Noté pour une étape suivante : rendre transparents les murs entre la caméra et le personnage, qui peuvent le cacher.
- **Ensuite** : le design de `engine-occlusion` (§5.5), le batching statique et l'instancing.

## 14. Stratégie de test

- **Volumes** : cas exacts (frustum d'une caméra connue, boîtes dedans, dehors, à cheval), rayons rasants ; GJK comparé aux tests rapides sur des paires aléatoires (mêmes réponses), et un volume défini dans le test (un cylindre) contre les volumes de base.
- **Index** : sur des milliers d'objets aléatoires qui bougent, l'octree et l'index linéaire donnent les mêmes résultats pour les mêmes requêtes (tests de propriété) ; croissance de la racine ; retraits ; construction en masse.
- **Cœur ECS** : création et destruction (générations, poignées périmées), ajout et retrait de composants, requêtes tenues à jour, croissance des colonnes.
- **Scène** : matrices monde d'une hiérarchie connue ; seules les branches invalidées sont recalculées (compteurs) ; une lecture en cours de frame est juste ; l'index est à jour avant chaque requête ; calques ; nœuds statiques ignorés après leur premier calcul.
- **Renderer** : sur le fake backend, un objet hors champ n'est ni préparé ni dessiné ; un projeteur hors champ dont l'ombre tombe dans le champ est dessiné dans la shadow map, celui dont l'ombre tombe hors champ ne l'est pas ; une lumière ponctuelle loin de la vue n'est pas envoyée ; `stats`.
- **Suite de rendu** : des tests de pixels sur tous les backends (un objet derrière la caméra n'apparaît pas ; l'ombre d'un objet hors champ, si).
- **Benchs** : les objectifs du §12, suivis à chaque étape.

## 15. Risques, questions et décisions

**Risques :**

- **Le culling des ombres** : retirer un projeteur dont l'ombre est visible serait une erreur visible. Le volume des projeteurs (§7.2) est conservateur, et les tests de pixels le vérifient.
- **La portée des lumières** : nos lumières n'ont pas de portée, seulement une atténuation ; le seuil de 1/256 coupe une lumière très intense trop tôt. Une portée explicite (`range`) sera ajoutée aux lumières si le seuil ne suffit pas.
- **Le coût de la façade** : une poignée `Node` est un petit objet ; en créer une par accès dans une boucle chaude annulerait le gain des colonnes. Les systèmes travaillent sur les entités, la façade sert aux manipulations ponctuelles ; les benchs le vérifient.
- **Écritures directes en colonnes** : un système qui écrit dans `Transform` sans `scene.touch()` laisse des valeurs dérivées périmées. En développement, une vérification optionnelle compare les colonnes à une copie pour signaler les oublis.
- **GJK** : sensible aux cas dégénérés (volumes plats, contacts tangents) ; tolérances et tests de propriété.
- **La précision des grandes coordonnées** (BIM géoréférencé, grands mondes) : pas traitée ici. La voie est le rendu relatif à la caméra (matrices monde en `Float64Array` sur le CPU, translation de la caméra retirée avant l'envoi au GPU) ; le contrat `world` le permettra.

**Décisions :**

1. **Packages** : `engine-geometry` (volumes, index), contrats de rendu dans `engine-core`, `engine-scene`, et `engine-occlusion` à part plus tard. _Validé, avec la géométrie et l'occlusion à part._
2. **Volumes** : une interface extensible (`Volume`, `ConvexVolume` avec fonction de support), des tests rapides par paire et GJK pour le reste. _Demandé._
3. **Modèle des objets** : un cœur ECS (colonnes typées, ensembles creux, requêtes), avec des nœuds comme façade (§5.2, §9). _Validé._
4. **Mise à jour** : la logique des cached values avec invalidation (bits « périmé » et versions dans les colonnes, effets abonnés), recalcul à la lecture, vidage avant les requêtes (§5.3). _Validé._
5. **Lumières et ombres** : limitées à ce qui peut changer la vue, sans rien retirer qui la change (§7.2). _Validé._
6. **Occlusion** : le GPU autant que possible (Hi-Z), le CPU seulement en repli ; variante (relecture ou pilotée par le GPU) à choisir dans son propre design. _Validé._
7. **Démos** : un labyrinthe vu de dessus, avec un personnage muni d'une lampe torche, construit en démos incrémentales (§11). _Validé._

## 16. Le pool de transforms

Ajouté après S6, à la demande : la classe `Transform` et le `TransformCache` du renderer posaient, à petite échelle, le problème que règle l'ECS.

### 16.1 Le problème

- **Un `Transform`** : un `ArrayBuffer` de 40 octets, trois vues (`Vec3View`, `QuatView`) lisant chacune à travers un `DataView` : environ 8 objets dispersés. Et `transform.position.x = 5` change la valeur sans incrémenter la version : le renderer ne voit pas le changement.
- **Le `TransformCache`** créé par le renderer pour chaque objet dessiné : 5 `CachedValue`, leurs `SnapshotValue` et tableaux de dépendances, 5 `Float32Array` : une vingtaine d'objets, de l'ordre du kilo-octet. Chaque lecture de version remonte la chaîne : c'était le premier poste du profil du culling.
- **L'envoi de l'uniform `object`** : réécrit champ par champ par un `DataView`, alors que ses 112 octets pourraient être copiés d'un bloc.

### 16.2 Le design

Un **`TransformPool`** : un `Float32Array` de N blocs, un par transform, agrandi par un facteur F quand il est plein (2 par défaut, comme la libstdc++ et la libc++ ; MSVC prend 1,5), les emplacements libérés réutilisés.

| Floats | Contenu                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 0–15   | Matrice monde (dérivée)                                                     |
| 16–27  | Matrice des normales (dérivée), 3 × vec4 : la disposition de WGSL et std140 |
| 28–37  | Position, rotation (quaternion), échelle locales                            |
| 38–39  | Libres (bloc de 160 octets)                                                 |

À côté : une version locale (incrémentée à chaque écriture), une version monde (à chaque recalcul) et un bit « périmé » par bloc.

- Les 112 premiers octets d'un bloc sont **l'uniform `object`** : le renderer l'envoie d'une copie quand la disposition du programme y correspond (le cas de tous les backends), et garde l'écriture champ par champ sinon. Plus tard, le pool entier pourra partir d'un bloc vers un storage buffer (rendu piloté par le GPU).
- C'est un compromis avec l'orientation données : un bloc par transform (tableau de structures) plutôt qu'une colonne par champ, parce que ce que l'on lit ensemble (matrices de l'uniform, valeurs locales d'un transform) est contigu.

**`Transform` devient un proxy** sur un bloc d'un pool (le pool par défaut, ou un autre) : même nom, même constructeur, mêmes accesseurs (valeurs partielles, `position.x`, `version`). Ses vecteurs lisent et écrivent dans le pool, et leurs écritures invalident le bloc comme les autres. La matrice monde et celle des normales sont recalculées à la lecture si le bloc est périmé. `TransformSnapshot` n'exige plus les classes `Vec3View` et `QuatView`, mais une interface (les composantes et `asArray()`) : `TransformCache` et `TransformAdapter` fonctionnent avec les deux.

**Libération** : `transform.dispose()` rend le bloc tout de suite ; à défaut, un `FinalizationRegistry` le rend quand le ramasse-miettes récupère le proxy. Un oubli ne fuit pas : il est libéré plus tard.

**Le renderer** ne passe plus par `TransformCache` pour les `Transform` : il lit la version monde et le bloc dans le pool.

**La scène** (T4) range ses transforms dans son propre pool, indexé par entité, à la place de ses colonnes `Transform` et `WorldMatrix` : `node.transform` est un vrai `Transform`, le renderer n'a qu'un chemin, et les systèmes écrivent `data[e * stride + offset]`.

**Caméras et lumières** ne changent pas : une caméra par vue, 16 lumières au plus par frame, rien à gagner. Un pool de lumières disposé comme une structure GPU viendra avec le culling des lumières (RG6), quand des centaines de lumières iront dans un storage buffer.

### 16.3 Plan

- **T1.** _(fait)_ `TransformPool` : blocs, croissance, emplacements libres, versions, bits « périmé », recalcul des matrices ; tests, bench.
- **T2.** _(fait)_ `Transform` comme proxy, `dispose()` et `FinalizationRegistry`, `TransformSnapshot` assoupli. Les tests existants passent sans modification.
- **T3.** _(fait)_ Le renderer lit le pool, envoie l'uniform `object` d'une copie ; benchs avant et après.
- **T4.** _(fait)_ La scène sur son propre pool, `node.transform` comme vrai `Transform`.

**Décisions** : bloc disposé comme l'uniform `object` ; nom `Transform` gardé ; `dispose()` et `FinalizationRegistry` ; T4 après T3 ; caméras et lumières inchangées. _Validées._

### 16.4 Résultats

T1 à T4 sont faits. Deux ajustements en route :

- **La matrice des normales est calculée à la lecture**, avec son propre bit « périmé » (`updateNormal()`) : seuls les objets dessinés la paient, pas tous ceux qui bougent.
- **Les transforms d'une scène sont détachés par la scène** quand leur entité est détruite, plutôt que de vérifier leur validité à chaque accès.

| Mesure (1 000 transforms)                                     | Avant   | Après   |
| ------------------------------------------------------------- | ------- | ------- |
| Transforms seuls, immobiles : versions lues                   | 6,2 µs  | 4,4 µs  |
| Transforms seuls, en mouvement : matrices recalculées et lues | 1,93 ms | 0,09 ms |
| Renderer, 1 000 objets en mouvement (frame)                   | 8,6 ms  | 6,8 ms  |
| Scène, 1 000 nœuds en mouvement puis la requête               | 0,58 ms | 0,67 ms |
| Scène, frame du Renderer (1 000 visibles)                     | 1,83 ms | 1,84 ms |

La scène perd environ 90 ns par nœud déplacé : le `Transform` (accesseurs, notification du pool) s'intercale entre le nœud et les données. C'est le prix d'une seule classe `Transform` partout ; les systèmes qui écrivent directement dans `scene.transforms.data` ne le paient pas.
