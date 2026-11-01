# P23 : le noyau géométrique

Le design de la phase P23 de la [roadmap](roadmap.md#p23-le-noyau-géométrique) : une interface de noyau géométrique abstraite, qui opère sur le B-rep du modèle pivot ([P22](p22-pivot.md)), servie par un noyau existant (OpenCascade) ou par un noyau maison écrit capacité par capacité. C'était l'étape 2 de l'ancien P13.

Contraintes : la topologie et la géométrie vivent dans le pivot, jamais dans le noyau ; pas d'historique de construction (c'est l'édition CAO, [P13](p13-cad-editing.md)) ; pas de dépendance au rendu ; la tessellation à la demande, jamais par défaut. L'interface est déduite des opérations dont les usages ont besoin, pas d'un noyau idéal.

## 1. Aujourd'hui

- **Pas de B-rep ni de noyau.** `@fdw/engine-geometry` porte des volumes (boîtes, sphères, capsules, frustums), des intersections, des index spatiaux et un BVH : de la géométrie pour le rendu et les requêtes, pas de topologie. Le noyau prend donc un autre nom (§2).
- **Des workers** : `WorkerPool` (`engine-resources-native`), les décodeurs d'images et de glTF en workers sur le web.
- **La tessellation par patchs** de P3b (`engine-tessellation`) : des surfaces évaluées sur le GPU pour l'affichage, sans rapport avec la tessellation exacte d'un B-rep.

## 2. Les choix

| Question                       | Choix                                                                                                                                                                                                                                                                               | Écartés, et pourquoi                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| L'architecture                 | **Un registre léger** comme point d'entrée, chaque capacité (extrusion, booléens, congés…) apportée par un plugin ; un backend peut en fournir plusieurs, le noyau maison les remplace une à une                                                                                    | Un noyau monolithique : tout ou rien, impossible à remplacer par morceaux                                             |
| Le contrat d'un plugin         | **Des capacités nommées et versionnées** (le manifeste commun, [P20 §8](p20-game-editor.md#8-le-manifeste-de-capacités-commun)) ; une capacité absente : une erreur explicite ; **un contexte partagé** (la tolérance) entre tous                                                   | Des capacités implicites : un échec tardif ; une tolérance par plugin : des résultats incohérents entre fournisseurs  |
| Les types                      | **Les B-rep du pivot**, en entrée et en sortie                                                                                                                                                                                                                                      | Des types propres au noyau : chaque backend imposerait les siens                                                      |
| L'exécution                    | **Asynchrone dès le départ**, les plugins dans des workers ; une capacité passée en worker ne change rien à l'appelant                                                                                                                                                              | Synchrone d'abord : l'interface changerait le jour du worker                                                          |
| Les transferts                 | **Des identifiants seulement** entre le thread principal et les workers ; **chaque B-rep reste dans un worker**, qui le possède ; la tessellation revient en buffers transférables (déplacés, pas copiés), libérés une fois le GPU servi                                            | Copier le B-rep à chaque appel : des synchronisations et la mémoire doublée                                           |
| La tessellation                | **Deux critères géométriques** : une tolérance absolue (l'écart à la surface exacte) et un angle maximal entre facettes. Le moteur traduit sa distance à la caméra en tolérance                                                                                                     | Des critères d'écran : le noyau connaîtrait la caméra                                                                 |
| La robustesse                  | **Des erreurs typées et explicables**, jamais un B-rep invalide en silence, ce qui rend prévisibles les cas dégénérés (surfaces tangentes, arêtes qui coïncident, intersections presque vides) ; **une batterie de cas pathologiques** que chaque plugin passe avant d'être accepté | Corriger en silence ; des tests au cas par cas                                                                        |
| La vérification, la réparation | **Deux capacités séparées et explicites** : la vérification décrit sans modifier, la réparation corrige à partir des tolérances du pivot. À l'import, la réparation est une option, désactivée par défaut, et le rapport dit ce qui a été réparé                                    | Une réparation automatique : une modification silencieuse                                                             |
| OpenCascade                    | **Le backend de référence**, pas le noyau du produit : il valide l'interface (si OpenCascade ne s'y branche pas proprement, elle est mal conçue) et sert d'étalon à la batterie de tests                                                                                            | Le noyau principal : une dépendance lourde en dur (§1 de la roadmap) ; aucun étalon : rien pour juger le noyau maison |
| Le langage                     | **TypeScript d'abord**, puis WebAssembly (Rust, C++ ou autre) là où la mesure le justifie, **un petit module par capacité**                                                                                                                                                         | Un gros module WebAssembly : une empreinte mémoire monolithique ; WebAssembly d'emblée : optimiser avant de mesurer   |
| Le nom                         | **`@fdw/geometry-kernel`** (à confirmer), et `@fdw/geometry-kernel-occt` pour OpenCascade                                                                                                                                                                                           | `engine-geometry` : pris ; `engine-*` : le noyau ne dépend pas du moteur                                              |

## 3. Les opérations

Par paliers, chacun démontrable de bout en bout, dans l'ordre dont l'édition CAO a besoin :

1. Les primitives et les transformations.
2. Depuis une esquisse 2D : l'extrusion et la révolution. Le noyau reçoit des **profils déjà résolus** (des courbes fermées, sans contraintes) : la géométrie de l'esquisse vit dans le pivot, le solveur appartient à [P13](p13-cad-editing.md).
3. Le long d'une courbe : le balayage.
4. Les booléens (union, différence, intersection), le gros morceau, sur l'intersection de surfaces.
5. Les congés, les chanfreins, puis la suite selon les besoins.

## 4. La tessellation

Un B-rep du pivot et les deux critères en entrée ; un mesh en sortie, avec le lien de provenance face → triangles du pivot (la sélection et l'édition s'en servent). Elle vient tôt : sans elle, rien ne s'affiche dans le moteur. La tessellation reste un cache dérivé, recalculé quand la tolérance demandée change.

## 5. La vérification et la réparation

La vérification détecte et décrit (des sommets qui ne se touchent pas, des faces mal recousues, des tolérances incohérentes). La réparation fusionne les sommets proches, recoud les faces, d'après les tolérances portées par le pivot. Rien n'est corrigé sans que l'utilisateur le sache.

## 6. Les étapes

1. **Le socle** : le registre, le contrat des plugins (capacités, versions, erreur explicite, contexte de tolérance), l'interface asynchrone, les erreurs typées, les workers et la règle des transferts.
2. **Le backend de référence** : OpenCascade derrière l'interface (en WebAssembly, pour les tests et la comparaison seulement), la batterie de cas pathologiques.
3. **Les primitives et les transformations**, en TypeScript.
4. **La tessellation**, et son affichage dans le moteur par l'adaptateur de [P22](p22-pivot.md).
5. **L'extrusion et la révolution** de profils résolus.
6. **La vérification et la réparation.**
7. **Le balayage.**
8. **Les booléens.**
9. **Les congés, les chanfreins** et la suite.
10. **L'optimisation en WebAssembly**, ciblée par les mesures et la batterie de tests.

Les étapes 1 à 5 suffisent à la première feature de bout en bout de [P13](p13-cad-editing.md) (esquisse, extrusion, affichage) ; la suite peut avancer en parallèle de P13.

Démo : une pièce construite par le noyau maison (extrusions, révolution, puis booléens), affichée dans l'éditeur, comparée à OpenCascade par la batterie de tests ; les tutoriels (EN et FR) : écrire une capacité.

## 7. Risques et questions ouvertes

- **Les booléens** : le morceau le plus long et le plus fragile d'un noyau ; la batterie de cas pathologiques doit exister avant.
- **OpenCascade en WebAssembly** : la taille du module et le temps de chargement dans les tests ; sa licence (LGPL 2.1 avec exception) acceptable pour un outil de test, à confirmer.
- **Les opérations à plusieurs corps** : exécutées dans le worker du corps principal, le corps secondaire y étant envoyé une fois, pour ne pas dupliquer un B-rep entre workers.
- **L'éviction du cache de régénération** sur de gros arbres de features : quels résultats garder, lesquels recalculer par le graphe de dépendances (avec [P13](p13-cad-editing.md)).
- Les estimations et les critères de fin de chaque étape.
