# P0 : le socle — intégration continue, documentation, mesures

Que chaque changement soit vérifié automatiquement avant les chantiers de performance et les nouvelles briques ([roadmap P0](roadmap.md#p0-socle)). Contrainte : un projet personnel, donc **aucun coût**.

## 1. Le coût

Le dépôt est public : sur GitHub Actions, les runners standard (Linux, Windows, macOS) sont gratuits et sans limite de minutes, et GitHub Pages est gratuit. Ce qui serait payant, et qu'on évite :

- passer le dépôt en privé (quota de minutes, macOS compté dix fois) ;
- des runners plus gros, ou avec GPU : la suite de rendu tourne en **logiciel** (lavapipe pour Vulkan, SwiftShader pour Chromium) ;
- un service externe payant : le cache de Nx reste dans le cache de GitHub Actions (10 Go par dépôt, gratuit).

Les limites qui restent sont le temps (un job dure au plus 6 heures, 20 jobs en parallèle) : on les respecte en ne testant que ce qui a changé, et avec des caches.

## 2. Les workflows

| Workflow     | Quand                                                                                              | Ce qu'il fait                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ci.yml`     | Chaque pull request, chaque push sur `main`                                                        | Les vérifications (§3) : format, typecheck, lint, tests, suite de rendu, sous Linux et Windows                  |
| `docs.yml`   | Chaque pull request et push sur `main`, mais ne travaille que si `docs` est affecté (et à la main) | Construit la doc, vérifie ses liens, compare les captures des exemples, publie sur GitHub Pages                 |
| `bench.yml`  | Push sur `main` hors doc et design ; pull request avec le label `benchmark` (et à la main)         | Les benchmarks, comparés à leur base dans le même job (§5)                                                      |
| `addons.yml` | Après une CI verte sur un push de `main`, quand une release manque pour l'état des sources natives | Construit les addons précompilés (Linux, Windows), les charge depuis leur archive, les publie avec leur SHA-256 |

Communs à tous :

- `concurrency` : une nouvelle exécution sur la même branche annule la précédente ;
- des **caches** : `node_modules` (selon `package-lock.json`), le cache de Nx (`.nx/cache`), les dépendances CMake des addons (SDL, volk… récupérées par FetchContent) et `ccache`, le SDK Vulkan ;
- le cache de Nx est **restauré depuis le dernier run de `main` et sauvé par `main` seulement** : une pull request le lit sans ajouter d'entrée aux 10 Go du dépôt ; `nx.json` le plafonne (`maxCacheSize: 1GB`) ;
- les actions tierces **épinglées par commit** (la version en commentaire) : `addons.yml` écrit des releases ;
- la version du SDK Vulkan dans `tools/native/VULKAN_SDK_VERSION`, lue par les workflows et comprise dans le hash des addons précompilés ;
- Node 24, la version du projet.

## 3. `ci.yml` : les vérifications

Deux jobs Linux en parallèle :

1. **`check`** : `prettier --check`, puis `nx affected -t typecheck lint test` (tous les projets, hors suite de rendu et addons). Le plus rapide : quelques minutes, le premier retour.
2. **`native`** : les addons et la suite de rendu.
   - installe le SDK Vulkan (DXC, spirv-val, spirv-cross), Mesa (`mesa-vulkan-drivers` : lavapipe, un Vulkan logiciel), les dépendances de SDL, et Chromium pour Playwright ;
   - construit les addons (`engine-native`, `engine-vulkan`) ;
   - lance les tests des packages natifs et la suite de rendu : Vulkan sur lavapipe, Dawn, HLSL (DXC et spirv-val), WebGL2 dans Chromium avec SwiftShader.

**Quels projets.** Les projets qui ont besoin du GPU, d'un SDK ou d'un écran portent le tag `gpu` (`engine-webgpu`, pour ses tests sur Dawn, `engine-native`, `engine-vulkan`, `engine-d3d12`, `rendering-tests`, `engine-audio-web` et `editor-web`, pour leurs tests dans Chromium, `engine-audio-native`, `engine-input-native` et `engine-resources-native`, pour l'addon d'`engine-native`, et `editor`) : `check` les exclut (`nx affected --exclude=tag:gpu`), `native` ne lance qu'eux, et seulement s'ils sont touchés par le changement (`nx show projects --affected --projects tag:gpu`). Sinon `native` s'arrête tout de suite, en succès : le statut reste exigible pour fusionner. Les fenêtres tournent dans un écran virtuel (Xvfb). Les projets `gpu` passent **un à la fois** (`nx run-many --parallel=1`) : chacun fait tourner des GPU logiciels qui s'étalent sur les 4 vCPU du runner. Leurs durées sont publiées (rapport JUnit, artefact `junit-<os>`) : on les suit plutôt que d'allonger les timeouts.

**Le budget de durée.** `tools/ci/durations.mjs` lit les rapports JUnit du job (`test-output/junit.xml` des projets `gpu` sous Vitest : `rendering-tests`, `engine-webgpu`, `engine-vulkan`, `engine-d3d12`, `engine-native`, `editor-web`) et compare chaque test réussi à sa **base : la médiane de ses cinq dernières durées sur `main`**, sous le même OS. Un test plus lent que sa base de plus de 50 % **et** de plus d'une seconde fait échouer la pull request (`--threshold`, `--margin` ; la seconde écarte le bruit des petits tests) ; le tableau des dépassements et des tests les plus lents va dans le résumé du job. La base est un fichier JSON (`test-durations.json`) gardé dans le **cache de GitHub Actions de `main`** (`durations-<os>-main-<sha>`) : chaque push sur `main` restaure le dernier, y ajoute ses durées (`update`) et le sauve ; une pull request le restaure seulement. Préféré à l'artefact du dernier run de `main` (`gh run download`) : `main` ne teste que les projets affectés, un artefact n'a donc que quelques projets, et celui d'un run sans projet `gpu` affecté manque ; le fichier fusionné garde les durées de chaque test depuis le dernier run qui l'a lancé, sans droit `actions: read` ni appel d'API. Préféré aussi à un fichier versionné, qu'il faudrait commiter depuis la CI. Sans base (cache expiré, après 7 jours sans accès), la comparaison ne fait rien et le prochain push de `main` la recrée. Un test sorti du cache de Nx ne tourne pas, n'a pas de rapport, et n'est pas comparé.

**Pas de saut silencieux.** Aujourd'hui, une suite se désactive quand son SDK, son addon ou son adaptateur manque : c'est pratique sur un poste, mais en CI une suite sautée passerait pour réussie. Une variable `FDW_REQUIRE_SUITES=vulkan,dawn,hlsl,glsl,window,native` fait échouer les tests quand une suite exigée ne peut pas tourner : `canRun(name, ready, reason)` de `@fdw/engine-backend/testing`, appelée par chaque suite. WebGL2 n'en a pas besoin : sans Chromium, sa suite échoue déjà.

**Windows et macOS** ne sont pas dans P0 : les addons n'y sont pas encore construits (c'est la phase P11). Windows s'est ajouté avec P11 : un troisième job, **`windows`**, les projets tagués `gpu` sous Windows, Direct3D 12 compris, à chaque pull request comme `native` ([p11-windows.md §2](p11-windows.md#2-la-ci-sous-windows)). macOS viendra ensuite.

**Le code généré** : le WGSL est déjà validé par Dawn (Tint) dans la suite de rendu, le HLSL par DXC et spirv-val. On ajoute le GLSL ES (WebGL2) par `glslangValidator` (dans le SDK Vulkan), sur les programmes de la suite que WebGL2 peut exécuter (ni calcul, ni storage buffer) : `dawn.spec.ts` enregistre les programmes pendant la suite Dawn (une seule fois), puis `programs.ts` valide les deux langages, en parallèle. naga demanderait une chaîne Rust pour un gain faible face à Tint : écarté.

## 4. `docs.yml` : la documentation

- Construit le site (`nx run docs:build`), avec la référence API.
- Vérifie les liens internes, ancres comprises : `tools/docs/check-links.mjs` (`npm run docs:links`), sur le site construit.
- **Captures des exemples vivants** : `@playwright/test` (`npx nx run docs:visual`) ouvre la page de chaque exemple dans Chromium, sur WebGL2 et sur WebGPU (SwiftShader), et compare le canvas seul (pas les polices) à une référence versionnée (`apps/docs/tests/screenshots/`), avec une tolérance (1 % des pixels). L'horloge des exemples est figée (`?time=1.5`) et le rendu s'arrête après quelques frames (`?frames=10`) : l'image est la même à chaque exécution, et le CPU est libre pendant la capture. En CI, le site est construit une fois puis les captures se partagent quatre jobs (`Examples`, un par backend et par moitié des exemples), trop lentes sur SwiftShader pour un seul job de 30 min. Sur WebGL2, un exemple qui demande du calcul doit afficher son message. Une différence publie le rapport et les images de l'écart en artefact ; lancé à la main avec `update-screenshots`, le workflow rend de nouvelles références sur la machine de la CI.
- **Publie** sur GitHub Pages, sous `/fdw-engine/`, depuis `main`. À faire une fois dans les réglages du dépôt : Pages → Source → GitHub Actions.

## 5. Les mesures

**Les benchmarks** (`*.bench.ts` : renderer, render graph, scène, ECS, géométrie, compilation). Les runners partagés sont bruyants : une mesure isolée d'un jour à l'autre ne veut rien dire. `bench.yml` mesure donc **le changement et sa base dans le même job**, sur la même machine : la base (la cible de la pull request, ou le commit précédent de `main`) dans un worktree, avec les outils du changement. `tools/bench/run.mjs` lance les benchmarks de chaque package et en tire un JSON compact ; `tools/bench/compare.mjs` compare deux de ces fichiers en un tableau, dans le résumé du job. Un benchmark est signalé plus lent (ou plus rapide) au-delà de 20 % **et** de la somme des marges d'erreur des deux mesures ; le job n'échoue jamais pour autant. Deux exécutions du même code restent sous 7 % d'écart sur un poste. Les résultats de `main` sont gardés 90 jours en artefact, pour la tendance.

**Le profilage GPU**, pour P1 et la suite :

- **une durée par passe**, l'abstraction commune : WebGPU n'écrit de timestamps qu'au début et à la fin d'une passe (`timestampWrites`), et WebGL2 ne mesure que des durées. Chaque backend propose un minuteur de passes (`createPassTimer`), absent où le GPU ne mesure pas : la fonctionnalité `timestamp-query` en WebGPU (demandée à la création du device quand l'adaptateur l'a), deux timestamps autour de la passe en Vulkan (deux commandes du flux natif, hors des passes : `RESET_QUERIES` et `WRITE_TIMESTAMP`), une requête `TIME_ELAPSED` en WebGL2 (`EXT_disjoint_timer_query_webgl2`) ;
- **le render graph mesure ses passes** avec l'option `timing` du `RenderGraphRunner` : `runner.passTimes` donne la durée GPU de chaque passe de rendu et de calcul, en millisecondes, par nom. Les résultats arrivent quelques frames plus tard, lus sans attendre (trois jeux de requêtes en vol). C'est le runner, pas `renderer.stats`, qui les porte : les passes appartiennent au graphe ;
- c'est un outil de poste : en CI, les GPU sont logiciels, leurs temps ne disent rien du matériel.

## 6. Le flux de travail

Plus de commit direct sur `main` : chaque changement passe par une branche (`FDW-P0`, …) et une pull request.

- **Une règle sur `main`** (un ruleset du dépôt) : pas de push direct, pas de force push, pas de suppression ; une pull request obligatoire ; les statuts `Check`, `Native and rendering`, `Windows`, `Build the documentation` et les quatre `Examples (…)` verts pour fusionner (ceux de la doc réussissent tout de suite quand elle n'est pas affectée) ; `Windows` bloque une PR comme les autres, car il est le seul à tester Direct3D 12 ; les conversations résolues.
- **Fusion par squash** : un commit par pull request sur `main`, un historique linéaire ; les branches supprimées après la fusion.
- **Le format en local** : `npm run format` formate les fichiers suivis par git, `npm run format:check` vérifie comme la CI.

## 7. Ce que P0 laisse en place

- Une CI verte exigée sur les pull requests (une règle de protection de `main`, à activer dans les réglages du dépôt).
- La doc en ligne à chaque push sur `main`.
- Des benchmarks comparés à chaque push, et des durées GPU par passe pour profiler P1.
- Une page « Contribuer » de la doc mise à jour : ce que la CI vérifie, comment reproduire un job sur son poste, comment mettre à jour une capture de référence.

## 8. Les étapes

1. `ci.yml`, job `check`.
2. `ci.yml`, job `native` : lavapipe, le SDK Vulkan, les addons, `FDW_REQUIRE_SUITES`. Le risque principal : Dawn et le Vulkan logiciel (Dawn peut refuser un adaptateur CPU ; sinon, SwiftShader pour Dawn).
3. La validation du GLSL ES.
4. `docs.yml` : construction, liens, publication ; puis les captures.
5. Les timestamps GPU dans les backends et le render graph.
6. `bench.yml`.
