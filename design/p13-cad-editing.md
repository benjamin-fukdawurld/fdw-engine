# P13 : l'édition CAO

Le design de la phase P13 de la [roadmap](roadmap.md#p13-le-modeleur-cao) : l'édition CAO paramétrique dans l'éditeur. Construire des solides depuis des esquisses 2D, les modifier par leurs paramètres, régénérer le B-rep. Les données et l'arbre de features sont dans le modèle pivot ([P22](p22-pivot.md)), les opérations dans le noyau géométrique ([P23](p23-geometry-kernel.md)) ; l'interface reprend celle de l'éditeur de jeu ([P20](p20-game-editor.md)).

Contraintes : ne redéfinir ni le B-rep ni l'arbre de features (le pivot) ; aucune opération géométrique ici (les plugins du noyau) ; pas d'historique imposé : un B-rep sans arbre reste éditable en direct. L'éditeur n'est que l'interface visible : aucun calcul géométrique ni logique métier.

## 1. Aujourd'hui

- **L'éditeur** (P18, P20) : le shell à docks, les plugins, la sélection par le buffer d'identifiants, les gizmos, l'`History` de P15 (une pile par document), l'inspecteur généré et ses commandes génériques (P20, étape 2).
- **Pas de B-rep, d'arbre de features, de solveur, de rendu en grandes coordonnées** : la scène est en `f32` autour de l'origine.

## 2. Les choix

| Question                  | Choix                                                                                                                                                                                                                                    | Écartés, et pourquoi                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Le modèle d'édition       | **L'arbre de features du pivot** : des nœuds à paramètres et entrées (une extrusion d'une esquisse sur une distance) ; ses types fournis par des plugins, déclarés par le manifeste commun                                               | Un modèle propre à l'éditeur : un second arbre à tenir d'accord                                                                   |
| Le nommage topologique    | **Des identifiants stables** des faces et des arêtes, tenus par les plugins du noyau à travers les régénérations ; perdu, **une description géométrique** (« la face la plus haute de normale Z ») en repli, signalé                     | La description seule : fragile dès que la pièce change ; l'identifiant seul : une feature cassée à chaque changement de topologie |
| Le solveur de contraintes | **Une interface abstraite**, comme le noyau ; un solveur simple fourni, un autre branchable ; **chaque type de contrainte est un plugin**                                                                                                | Un solveur intégré : impossible à remplacer ; des contraintes en dur                                                              |
| La régénération           | **Un graphe de dépendances** : la feature modifiée et ses dépendantes recalculées, l'amont en cache                                                                                                                                      | Tout recalculer : lent sur un gros arbre                                                                                          |
| Pendant le recalcul       | **L'ancien résultat affiché**, un indicateur discret, puis remplacé d'un coup ; un nouveau changement annule le calcul en cours et relance ; un échec garde l'ancien résultat et explique l'erreur                                       | Un aperçu provisoire : un second calcul à écrire, maintenir et exécuter. Une extension possible si les mesures le demandent       |
| L'édition directe         | **Le même mécanisme** : un B-rep sans arbre est le point de départ de l'arbre ; chaque opération sur ses faces, arêtes ou sommets y devient une feature, par les mêmes plugins                                                           | Un second système d'édition. La limite assumée : la construction d'origine d'un modèle importé n'est pas paramétrable             |
| Annuler, rétablir         | **L'`History` de P15**, une pile par document : retirer une feature ou rétablir un paramètre, puis régénérer ; les paramètres et les esquisses par les commandes génériques de [P20](p20-game-editor.md#3-les-composants-et-linspecteur) | Une pile d'actions à part : deux mécanismes d'annulation dans le même éditeur                                                     |
| L'enregistrement          | **Par un écrivain du pivot** qui garde l'arbre de features ; le rapport dit ce qui serait perdu dans un format sans historique                                                                                                           | Une persistance propre au pivot ([P22 §2](p22-pivot.md#2-les-choix))                                                              |
| La récupération           | **Une fonction de l'éditeur** : l'enregistrement périodique du fichier de travail, configurable et désactivable                                                                                                                          | Rien : une perte de travail au premier plantage                                                                                   |
| L'exécution               | **Dans les workers du noyau**, par son interface asynchrone ; seuls des identifiants passent ([P23 §2](p23-geometry-kernel.md#2-les-choix))                                                                                              | Sur le thread de l'interface : une interface figée pendant les régénérations                                                      |

## 3. La précision des grandes coordonnées

Gardée de l'ancien P13, absente de la spec : le rendu relatif à la caméra (les positions en `f64` sur le CPU, l'origine du rendu à la caméra), décisif pour la CAO et le BIM ; il compte aussi pour les grands niveaux. Il a son design à part, et peut avancer avant le reste de la phase.

## 4. Les esquisses et le solveur

La géométrie de l'esquisse (le plan et les courbes) vit dans le pivot. Le solveur calcule les positions depuis les contraintes ; le noyau ne reçoit que des profils résolus. Les contraintes, des plus simples aux plus riches :

1. **Géométriques, sans valeur** : coïncidence de deux points, horizontal, vertical, parallèle, perpendiculaire ; la fixation, qui empêche l'esquisse de flotter.
2. **Les relations** : concentrique, point sur une courbe, tangent, égalité de longueurs ou de rayons, point milieu.
3. **Les cotes** : distance, longueur, rayon ou diamètre, angle ; en dernier, car elles apportent les valeurs que l'arbre de features pilote.

## 5. L'interface

Trois zones, qui lisent et modifient le pivot sans logique géométrique : **la vue 3D** (la sélection des faces et des arêtes par le lien face → triangles de la tessellation), **l'arbre de features** (l'historique, les paramètres dans l'inspecteur de P20), **le mode esquisse** 2D sur le plan choisi (les contraintes affichées, le retour du solveur : sous-contraint, sur-contraint, en conflit). Chaque zone est un plugin de l'éditeur. L'UX détaillée a son design à part.

## 6. Les étapes

1. **La précision des grandes coordonnées** (§3), indépendante du reste.
2. **Le socle de l'arbre de features** : le modèle d'édition sur l'arbre du pivot, les types de features en plugins, le graphe de dépendances.
3. **La régénération** : le recalcul partiel, le cache amont, l'annulation d'un calcul en cours, l'échec qui garde l'ancien résultat.
4. **Le nommage topologique** : les identifiants tenus par les plugins du noyau, la description en repli, signalée.
5. **Les esquisses et le solveur** : l'interface, le solveur simple, les contraintes dans l'ordre du §4.
6. **La première feature de bout en bout** : esquisse, extrusion, régénération, affichage ; elle valide ensemble les étapes 2 à 5.
7. **Annuler, rétablir, enregistrer** : par l'`History`, l'écrivain et son rapport ; la récupération après plantage.
8. **L'édition directe** : pousser ou tirer une face, déplacer une face, supprimer une face en refermant le trou, un congé sur une arête (la liste à confirmer).
9. **L'intégration à l'éditeur** : les trois zones (§5).
10. **Les features avancées** : révolution, balayage, congés et la suite, au rythme des capacités du noyau.
11. **L'éditeur du middleware** (de l'ancien P13) : le modeleur et l'éditeur de jeu réunis, les pièces modélisées posées dans les niveaux.

Démo : **l'application de modélisation** : une pièce esquissée, extrudée, modifiée par ses cotes, enregistrée puis rouverte avec son historique ; un STEP importé puis édité en direct ; la pièce posée dans un niveau.

## 7. Questions ouvertes

- La liste des opérations d'édition directe à livrer en premier.
- L'UX détaillée de l'éditeur CAO.
- L'éviction du cache de régénération sur de gros arbres ([P23 §7](p23-geometry-kernel.md#7-risques-et-questions-ouvertes)).
- Les estimations et les critères de fin de chaque étape.
