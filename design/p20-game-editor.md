# P20 : l'éditeur de jeu

Le design de la phase P20 de la [roadmap](roadmap.md#p20-léditeur-de-jeu) : ce qui manque pour faire un petit jeu entièrement dans l'éditeur de P18. L'essentiel de l'outillage existe déjà ; ce document dit, pour chaque brique, ce qui existe et ce qui manque, et ne conçoit que les manques. Les briques restent dans des packages à part, branchées par plugins, et servent aussi l'édition CAO ([P13](p13-cad-editing.md)).

Contraintes : l'éditeur n'est que l'interface visible, sans logique métier ni calcul ; le moteur ne connaît rien de l'édition ; les tâches lourdes dans des workers, avec le moins de transferts possible ; pas de modification silencieuse (des erreurs typées et explicables) ; pas d'empreinte mémoire doublée.

## 1. Aujourd'hui

- **La sélection, les gizmos, l'historique** (P15, `@fdw/engine-editing`) : le picking par le buffer d'identifiants, la multi-sélection et le survol, le contour ; les gizmos de déplacement, de rotation et d'échelle ; l'`History` (transactions imbriquées, fusion, groupes, limite) et les commandes de scène (transforms, propriétés, création, suppression par une corbeille, reparentage). Le niveau édité et chaque session de graph ont leur historique : une pile par document.
- **Les scènes** (P16, `@fdw/engine-scene-io`) : `SceneData`, `captureScene` et `instantiateScene`, les codecs par composant, le format `fdw-scene` (JSON et binaire, migrations), les instances de modèles et de scènes avec leurs **surcharges par chemin de nœud** (les préfabriqués), l'export glTF.
- **Les composants** (`defineComponent`, `engine-scene`) : un schéma de stockage (types, `defaults`, `version`, `persist`). Ni libellé, ni bornes, ni éditabilité : pas d'inspecteur par type de composant, pas de commande générique de modification d'un champ.
- **Les ressources** (P5, `engine-resources`, `engine-assets`) : les sources, le store, la `CatalogSource` (identifiant → chemin), les sous-ressources par URI (`forest.scene.json#mesh/3`), le suivi des fichiers (`watch.ts` en natif et sur le web) et le rechargement à chaud ; les données CPU et leurs réalisations GPU ; les chargeurs glTF, OBJ, KTX2 ; des pools de workers (`WorkerPool`). Pas de GUID, pas de métadonnées à côté des assets, pas de projet, pas de cuisson.
- **Les graphs** (P19) : `engine-graph`, `engine-graph-editing`, `graph-editor` et trois plugins. Une nouvelle sorte de graph s'ajoute par sa sorte et un plugin : **aucun éditeur de graphs à écrire**.
- **L'éditeur** (P18) : le moteur hors de l'interface (processus utilitaire sous Electron, `MessageChannel` sur le web), le `LevelDocument` (scène, historique, sélection), l'arbre de la scène et un inspecteur fixe (nom, visibilité, transform, composants), les plugins à manifeste. Le débogueur de comportements sait geler la scène.
- **La distribution** (P11) : l'exécutable de l'éditeur ; rien pour un jeu.

## 2. Les choix

| Question                        | Choix                                                                                                                                                                                                                                                                       | Écartés, et pourquoi                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le format de la scène           | **`fdw-scene`, séparé du modèle pivot** ([P22](p22-pivot.md)) : un format de travail, lisible, comparable dans un gestionnaire de versions, riche en composants. Une conversion scène → pivot, si besoin, est un plugin de P22                                              | Le pivot comme format de scène : un format d'échange, fait pour convertir sans perte, pas pour les composants d'un jeu                                                                                    |
| La description d'édition        | **Un emplacement d'extensions sur la définition d'un composant**, que le moteur ne lit jamais : chaque package y accroche ses données sous une clé typée à lui. L'éditeur y met libellés, bornes, éditabilité, déclarés à la main                                           | Des champs d'édition dans le schéma : le moteur connaîtrait l'édition ; des décorateurs ou un générateur : une étape de build. L'interface reste assez petite pour qu'un générateur la produise plus tard |
| L'historique                    | **Une pile par document** (l'`History` de P15), comme aujourd'hui ; les commandes génériques de champ dessus                                                                                                                                                                | Une pile globale : avec des onglets, une annulation déferait une action d'un autre fichier                                                                                                                |
| Les surcharges des préfabriqués | **Par identifiant stable porté par le nœud**, le chemin en repli signalé ; pour l'imbrication, la chaîne des identifiants traversés. La règle du nommage topologique de P13 : l'identifiant d'abord, la description ensuite                                                 | Par chemin seul (aujourd'hui) : un renommage ou un réordonnancement casse la surcharge                                                                                                                    |
| L'identité des assets           | **Un GUID par asset, unique dans son projet**, indépendant du nom et du chemin ; dans un fichier de métadonnées à côté de la source (GUID, réglages d'import, dépendances), lisible et versionné                                                                            | Le chemin comme identité : un déplacement casse les références ; un GUID universel : inutile tant qu'un projet ne référence pas un autre                                                                  |
| Le projet                       | **Un dossier**, avec à sa racine un manifeste (nom, version du format, réglages)                                                                                                                                                                                            | Une base de données : ni lisible ni comparable                                                                                                                                                            |
| Le catalogue                    | **Un index dérivé**, reconstruit depuis les métadonnées et gardé en cache, monté sur la `CatalogSource` existante (`asset:<guid>`). Deux GUID identiques (un asset copié) détectés à l'ouverture, la régénération proposée                                                  | Le catalogue comme source de vérité : deux vérités à tenir d'accord                                                                                                                                       |
| La cuisson                      | **Un cuiseur par type d'asset**, fourni par un plugin ; en tâche de fond dans des workers, déclenché par le suivi des fichiers ; la source affichée en attendant. Le cache hors du dossier versionné, de clé le hash de la source, des réglages et de la version du cuiseur | Une cuisson bloquante à l'import ; un cache versionné : il se recalcule et ne se partage pas                                                                                                              |
| Les aides de la vue             | **Dans `engine-editing`**, qui a déjà ses passes (contour, gizmos) : la grille, l'aide de la caméra du jeu, sa vue en incrustation. Ni le moteur ni le jeu exporté ne les embarquent                                                                                        | Dans le moteur : le jeu publié les porterait                                                                                                                                                              |
| Jouer dans l'éditeur            | **Un second monde dans le même processus** : la scène capturée, réinstanciée dans un monde de jeu qui partage le store ; détruit à l'arrêt. Derrière une interface de session de jeu                                                                                        | Un second processus : les assets chargés deux fois, la mémoire doublée. L'interface de session le permettra plus tard, si le besoin apparaît                                                              |
| La publication                  | **Un runtime sans éditeur**, les assets **recuits pour la plateforme cible** (web, natif : les formats de textures compressées diffèrent)                                                                                                                                   | Publier le cache de l'éditeur : il sert à l'édition, ce n'est pas un livrable                                                                                                                             |

**Hors de P20** (à valider) : l'éditeur de timeline et de courbes, l'interface du jeu (HUD), un profiler, le scripting rechargé à chaud tant que les graphs de comportement suffisent.

## 3. Les composants et l'inspecteur

**Les extensions des composants.** `ComponentOptions` gagne un emplacement d'extensions : une clé typée (`defineExtension<T>(name)`) et sa valeur, lues par `component.extension(key)` ; `engine-scene` ne les interprète jamais. Un petit changement générique, fait une fois.

**La description d'édition**, dans un package de l'éditeur : sa clé et son type (par champ : libellé, unité, bornes, pas, éditable ou en lecture seule, groupe), déclarés à côté du composant. Les composants sans description restent montrés par leur schéma, en lecture seule.

**L'inspecteur généré** : un panneau par type de composant, construit depuis la description ; chaque modification passe par une **commande générique de champ** de l'`History` : annulable, les modifications continues fusionnées (un curseur qu'on glisse est une entrée), groupées quand elles touchent plusieurs entités. Les règles de l'`History`, que les nouvelles commandes suivent : une commande décrit son inverse (elle sait s'annuler, ou garde de quoi le faire), les modifications continues font une seule entrée, une action sur plusieurs objets s'annule d'un coup. L'édition CAO y branche ses paramètres de features ([P13](p13-cad-editing.md)).

## 4. Les identifiants stables et les préfabriqués

Les nœuds des modèles et des scènes portent un identifiant stable, écrit dans `fdw-scene` et gardé à travers les éditions. Les surcharges d'une instance sont adressées par lui ; le chemin reste le repli d'un identifiant perdu, et chaque repli est signalé. Puis les **surcharges des instances imbriquées**, adressées par la chaîne des identifiants traversés (reportées de P16). Le format d'identifiant est celui du pivot (aléatoire, unique partout), pour qu'une scène convertie en pivot garde ses identités.

## 5. Le projet, le catalogue et la cuisson

- **Le projet** : le dossier, son manifeste, les sources et leurs métadonnées ; l'éditeur l'ouvre par l'hôte (le système de fichiers sur le bureau, la File System Access API sur le web).
- **Le catalogue** : parcouru à l'ouverture, gardé en cache, relié aux références des scènes (`asset:<guid>`). Les GUID dupliqués détectés, la régénération proposée.
- **L'import de formats externes** : les chargeurs existants (glTF, OBJ, KTX2), puis le kernel de conversion ([P22](p22-pivot.md)), dont l'éditeur tire des assets.
- **La cuisson** : le contrat des cuiseurs, déclarés par le manifeste de capacités commun (§8) ; un cuiseur de textures vers un format compressé (KTX2, Basis, sur `engine-ktx2`), puis un cuiseur de meshes (indexation, quantification, ordre des sommets) ; le rechargement à chaud de l'asset recuit.

## 6. Jouer dans l'éditeur

L'interface `GameSession` (lancer, pause, pas à pas, arrêter), puis son implémentation en second monde : `captureScene` sur le niveau édité, `instantiateScene` dans un monde de jeu qui partage le `ResourceStore` (les assets chargés une fois) ; l'ordonnanceur, la physique et les comportements tournent dans ce monde seul. À l'arrêt, le monde est détruit : la scène éditée n'a jamais changé. Un garde-fou sur le temps d'une image, sur le gel de la scène du débogueur de comportements. Puis le pas à pas et l'inspection du monde de jeu pendant l'exécution (l'arbre et l'inspecteur branchés sur lui, en lecture).

## 7. La publication

Un runtime sans éditeur (le moteur, la scène, le store sur les assets cuits), le bundling des assets recuits pour la cible, la publication en page web autonome et en natif (l'exécutable de P11).

## 8. Le manifeste de capacités commun

Les trois nouveaux projets (P20, [P22](p22-pivot.md), [P23](p23-geometry-kernel.md), et [P13](p13-cad-editing.md)) déclarent leurs plugins de la même façon : un identifiant, une version, des capacités nommées et versionnées. C'est une base commune, petite et sans dépendance, que chaque registre étend (les cuiseurs, les lecteurs et écrivains de P22, les capacités du noyau de P23, les features et les contraintes de P13). Le manifeste des plugins de l'éditeur (P18, étape 12 : commandes, vues, menus) en reste distinct : il décrit des contributions à l'interface, pas des capacités. À trancher dans le design de l'étape 1 : un package à part (`@fdw/capabilities`) ou une partie d'un package existant.

## 9. Les étapes

Du plus bloquant au moins bloquant :

1. **Les extensions des composants** : l'emplacement dans `engine-scene` ; la clé et le type de la description d'édition côté éditeur.
2. **L'inspecteur et les commandes génériques** : un inspecteur par type de composant, généré ; la commande générique de champ (annulation, fusion, groupes).
3. **Les identifiants stables et les préfabriqués** : les identifiants des nœuds, les surcharges par identifiant (le chemin en repli signalé), puis les instances imbriquées.
4. **Le projet et le catalogue** : le dossier et son manifeste, les GUID, les métadonnées, le catalogue dérivé sur la `CatalogSource`, les doublons, les références des scènes.
5. **La cuisson** : le contrat des cuiseurs, les workers, le cache ; le cuiseur de textures, puis de meshes ; le rechargement à chaud.
6. **Les outils de la vue** : la grille, l'aide de la caméra du jeu, sa vue en incrustation quand elle est sélectionnée.
7. **Jouer dans l'éditeur** : `GameSession`, le second monde, le garde-fou ; puis le pas à pas et l'inspection.
8. **La publication** : le runtime sans éditeur, les assets recuits par cible, la page web et le natif.

En plus, reprises du plan d'origine : le navigateur de ressources (sur le catalogue de l'étape 4) ; la mise en place d'un niveau (poser des modèles, des lumières, des caméras, des volumes ; les formes de collision avec la vue de débogage de P7b).

Chaque étape vient avec ses pages de documentation (EN, FR) et ses tests.

Démo : **un petit jeu fait entièrement dans l'éditeur**, par exemple un niveau du TPS reconstruit, joué dans l'éditeur puis publié sur le web.

## 10. Questions ouvertes

- La forme exacte de l'API des extensions de composants (clés typées, lecture et écriture), à l'étape 1.
- Le pas à pas et l'inspection du monde de jeu pendant l'exécution, à l'étape 7.
- L'interaction avec la caméra du jeu dans la vue, avec l'UX de l'éditeur.
- Les estimations et les critères de fin de chaque étape.
