# P4. L'ordonnanceur de systèmes ECS

_Fait_ (14 octobre 2026), avec son tutoriel « Les systèmes et le pas fixe » (`tutorials/systems`, EN et FR, exemple en direct et images de référence). Ce que [backlog §8](backlog.md#8-le-jeu-de-démonstration-et-lentrée) et [scenegraph.md §9.1](scenegraph.md#91-le-cœur-ecs) laissaient pour plus tard : des systèmes ordonnés, la boucle à pas fixe intégrée.

## 1. Résumé

| Fonction | API                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| Systèmes | `scheduler.add(name, run, { phase, before, after, enabled })`, `remove(name)`, `system(name)`, `systems(phase)`     |
| Phases   | `begin` (une fois), `fixed` (à chaque pas), `update` (une fois, par défaut), `render` (une fois, en dernier)        |
| Frame    | `scheduler.update(dt)` ; `frame`, `steps` (pas de la dernière frame), `time` (temps simulé)                         |
| Pas fixe | `scheduler.fixed` (`FixedStep` : `step`, `maxSteps`, `alpha`, `advance()`, `reset()`), `alpha` pour l'interpolation |
| Contrôle | `paused`, `timeScale`, `step()` : sur la phase `fixed` seulement ; `system.enabled`                                 |

`FixedStep` vient du labyrinthe (`demo-scenes`), déplacé dans `engine-scene` ; le labyrinthe l'importe du moteur.

## 2. Les choix

| Question                     | Choix                                                                    | Pourquoi                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Ce qu'est un système         | Une fonction `(dt) => void`, avec un nom                                 | L'ECS reste agnostique : le système atteint son monde par fermeture ; un graph de comportement (P9) en sera un      |
| Où il vit                    | `engine-scene`, à côté du `World`, sans en dépendre                      | Ce que prévoyait le backlog ; utilisable sans scène                                                                 |
| Les phases                   | Quatre, fixes : `begin`, `fixed`, `update`, `render`                     | Ce que demandent un jeu et un éditeur ; pas de phases définies par l'utilisateur tant qu'aucun client n'en a besoin |
| L'ordre dans une phase       | L'ordre d'ajout, précisé par `before` / `after` (tri topologique stable) | Lisible sans contraintes ; les contraintes servent aux modules qui ne se connaissent pas                            |
| Une contrainte sur un absent | Ignorée                                                                  | Un module dit « après la physique », qu'elle soit là ou non                                                         |
| Un cycle                     | Refusé à `add()`, le système n'est pas ajouté                            | L'erreur au moment où on la crée, pas à la frame suivante                                                           |
| Retrait pendant une phase    | Le système est désactivé, puis l'ordre recalculé                         | Pas de système retiré qui s'exécute encore dans la phase en cours                                                   |
| Pause et ralenti             | Sur la phase `fixed` seulement                                           | Sous un menu de pause, les entrées, la caméra et le rendu continuent                                                |
| L'interpolation              | `alpha` exposé ; l'état précédent est gardé par le jeu                   | Le jeu sait ce qui s'interpole (positions, rotations) ; pas de copie automatique des colonnes                       |
| Les longues frames           | `maxSteps` (5) pas au plus, le temps en trop est perdu                   | Le jeu ralentit au lieu de geler (la « spirale de la mort »)                                                        |

## 3. Les tests

`Scheduler.spec.ts` (`engine-scene`) : l'ordre des phases et les `dt` reçus, le tri par contraintes, les contraintes entre phases ignorées, le cycle refusé et le nom pris, les systèmes désactivés et retirés en cours de phase, pause, pas à pas et ralenti, le plafond de pas ; `FixedStep` (pas, `alpha`, `reset`). L'exemple a quatre images de référence (WebGPU, WebGL2) : à l'ouverture, puis en pause après trois pas.

## 4. La suite

Le labyrinthe et la démo FPS passés à l'ordonnanceur. Le temps passé par système (un profil), des ensembles de systèmes activés ensemble, des phases définies par l'utilisateur, si un client en a besoin. Les graphs de comportement (P9) s'y brancheront comme des systèmes.
