# Audit du code — FdwEngine

_Date : 31/10/2026, sur la branche `FDW-P11-2` au commit `390133b`, soit environ 150 commits après l'audit précédent (02/10/2026, commit `f722411`)._
_Périmètre : tout le dépôt (45 packages et 5 applications, environ 200 000 lignes de TypeScript, plus les addons natifs C/C++ et la CI). L'audit du 02/10 a servi de liste de contrôle : son statut détaillé est à l'annexe A._

**Légende des statuts :**

| Statut      | Signification                                          |
| ----------- | ------------------------------------------------------ |
| 🟢 Corrigé  | Corrigé depuis l'audit précédent, vérifié dans le code |
| 🟡 Partiel  | Correction commencée mais incomplète                   |
| 🔴 Ouvert   | Toujours présent                                       |
| ⚪ Obsolète | Le code visé n'existe plus                             |
| 🆕 Nouveau  | Nouveau constat                                        |

Les points marqués « (vérifié) » ont été confirmés par une exécution : spec jetable, script Node, commande Nx ou chronométrage. Les autres viennent de la relecture du code.

---

## Sommaire

0. [Synthèse](#0-synthèse)
1. [Les timeouts des tests qui s'allongent](#1-les-timeouts-des-tests-qui-sallongent)
2. [Compilation, Nx et CI](#2-compilation-nx-et-ci)
3. [Backends et rendu : engine-backend, engine-core, engine-webgpu, engine-webgl2, engine-shader, engine-graph](#3-backends-et-rendu)
4. [Addons natifs : Vulkan, Direct3D 12, N-API](#4-addons-natifs)
5. [Simulation et runtime : fluides, océan, physique, animation, comportement, audio, entrées, caméra, géométrie](#5-simulation-et-runtime)
6. [Assets, ressources et scènes](#6-assets-ressources-et-scènes)
7. [Édition, éditeur et applications](#7-édition-éditeur-et-applications)
8. [Hygiène du dépôt](#8-hygiène-du-dépôt)
9. [Plan d'action](#9-plan-daction)
10. [Annexe A : statut de l'audit du 02/10](#annexe-a--statut-de-laudit-du-0210)
11. [Annexe B : statut des corrections (02/11/2026)](#annexe-b--statut-des-corrections-02112026)

---

## 0. Synthèse

### Ce qui va bien

- 🟢 Les trois points bloquants du 02/10 sont résolus : le workspace Nx est synchronisé, tout compile, et il y a des tests partout (Vitest seulement, plus de Jest) (vérifié : `nx sync:check`, `tsc -b`, `nx run-many -t typecheck lint test`).
- 🟢 La même suite de rendu tourne de bout en bout sur chaque backend (Dawn, Vulkan sur lavapipe, D3D12 sur WARP, WebGL2 sur SwiftShader), et les programmes sont validés en HLSL et en GLSL ES.
- 🟢 L'app Electron est configurée correctement : `contextIsolation`, `sandbox`, une CSP sans `unsafe-eval`, des clés de stockage filtrées.
- 🟢 La clé du cache de shaders HLSL inclut la version et le commit de DXC, la cible, les arguments et la source.

### Ce qui pose problème

1. **La durée des tests augmente à chaque phase**, et les timeouts ne font que la suivre (§1). La cause n'est ni l'aléa ni « un CI chargé » en général :
   - certains tests font en série un travail qui grandit avec le moteur ;
   - une référence CPU est très lente ;
   - deux tests se synchronisent sur le rythme des images ;
   - la CI fait tourner en même temps plus de rasteriseurs logiciels qu'elle n'a de cœurs.
2. **Les parseurs et chargeurs ne résistent pas aux entrées malformées** : cycles de nœuds (glTF, scènes, assets), bombe de décompression KTX2, allocations non bornées (§6).
3. **Les addons natifs ont des use-after-free et des états bloqués** : images du swapchain libérées au resize, liste D3D12 bloquée après un seul échec, hazard de lecture dans le suivi Vulkan (§4).
4. **Les ressources GPU fuient à la destruction** : `Renderer.destroy`, pipelines WebGL2, meshes et samplers des fluides et de l'océan (§3, §5).
5. **Il y a des bugs de correction visibles** : textures 3D créées en 2D en WebGPU, `Buffer.write` qui écrase ses voisins, nœuds physiques figés à 30 fps, NaN dans le spectre de l'océan et dans le BVH (§3, §5).

### Les 10 priorités

| #   | Point                                                                                                                                                                                               | Section    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Tests de rendu : paralléliser DXC, spirv-val et spirv-cross, ne plus jouer deux fois la suite Dawn, limiter le parallélisme des projets `gpu`. Retirer ensuite les timeouts ajoutés depuis le 24/10 | §1         |
| 2   | Référence CPU de la fumée sans allocation dans les boucles                                                                                                                                          | §1.3       |
| 3   | Tests de layout et de graph : attendre un signal du moteur, pas un nombre d'images                                                                                                                  | §1.4, §1.5 |
| 4   | Use-after-free du swapchain (Vulkan et D3D12), liste D3D12 bloquée, segfault sur un argument DXC                                                                                                    | §4         |
| 5   | Cycles et bornes dans glTF, scene-io et engine-assets ; bombe zlib/zstd KTX2                                                                                                                        | §6         |
| 6   | `dimension: '3d'` dans `TextureFactory`, padding destructif de `Buffer.write`                                                                                                                       | §3         |
| 7   | Physique : `moved` remis à zéro trop tôt, `addCharacter` sur un nœud déjà équipé                                                                                                                    | §5         |
| 8   | `GraphClient.save` désynchronisé, listeners de pointeur non retirés, ordre des frères après undo                                                                                                    | §7         |
| 9   | Fuites GPU à la destruction : Renderer, pipelines WebGL2, fluides, océan                                                                                                                            | §3, §5     |
| 10  | Cache CI : `maxCacheSize` Nx, clés par branche, filtres de chemins pour docs et bench                                                                                                               | §2         |

---

## 1. Les timeouts des tests qui s'allongent

### 1.1 L'historique

| Commit    | Date  | Test                                                     | Timeout            |
| --------- | ----- | -------------------------------------------------------- | ------------------ |
| `3303c0d` | 24/10 | suite de rendu, « adds up the octaves »                  | 5 s → 30 s         |
| `e3ec2dd` |       | docs, graph du jeu dans son tutoriel                     | 60 s → 120 s       |
| `a95800b` |       | même test                                                | `test.slow()` (×3) |
| `3b50e81` |       | editor-web, layout (`waitFor` sur la largeur du canvas)  | 1 s → 10 s         |
| `081a27b` |       | engine-fluids, deux tests de fumée                       | 5 s → 30 s         |
| `0fa1b52` |       | tests/rendering, tout le projet                          | 5 s → 30 s         |
| `a3da07c` |       | docs, captures des exemples (+ occlusion-culling à 60 s) | 20 s → 30 s        |
| `c35193b` | 27/10 | programmes HLSL                                          | 30 s               |
| `e70b69c` |       | même test                                                | timeout retiré     |
| `b8fe1ac` |       | même test                                                | 30 s → 60 s        |

En une semaine, la suite de rendu est passée de 87 à 99 tests (`it(` dans `suite.ts`), et le nombre de programmes compilés croît avec elle (166 aujourd'hui). Chaque phase ajoute du travail, et ce travail s'exécute en série.

### 1.2 Programmes HLSL et GLSL : du travail en série qui croît linéairement (vérifié)

[programs.spec.ts](tests/rendering/src/programs.spec.ts) traite chaque programme ainsi :

- `compileHlsl` lance **un processus DXC par étage**, chacun dans un `mkdtemp`/`rm` ([spirvTools.ts:62-93](packages/engine-vulkan/src/tools/spirvTools.ts#L62-L93)) ;
- `validateSpirv` lance **un spirv-val**, dans un autre répertoire temporaire ;
- `reflectUniformBlocks` lance **un spirv-cross**, dans un troisième.

Le tout s'exécute un programme après l'autre, dans un seul test.

Mesures sur un poste de 24 cœurs inoccupé :

| Mesure                                                     | Valeur                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| Programmes / étages                                        | 166 / 274                                                      |
| Processus lancés pour le HLSL                              | environ 820, en série                                          |
| Coût d'un lancement à vide (dxc / spirv-val / spirv-cross) | 34 / 13 / 14 ms                                                |
| Test HLSL                                                  | **13,1 s** (programme le plus long : « fractal sums », 361 ms) |
| Test GLSL (un glslangValidator par programme ou par draw)  | 5,2 s                                                          |
| `programs.spec.ts` seul                                    | 27 s                                                           |
| Le même fichier, avec les 3 autres specs du projet         | **44 s**                                                       |

Sur un runner GitHub à 4 vCPU, avec lavapipe et WARP qui tournent en même temps, il faut multiplier ces durées. Chaque programme ajouté allonge donc le test d'environ 50 ms × (sa part de la charge).

Deux aggravations :

- **La suite Dawn tourne deux fois.** `programs.spec.ts` rejoue `describeRenderer` sur Dawn uniquement pour enregistrer les programmes, alors que `dawn.spec.ts` joue la même suite, au même moment, dans un autre worker. Cela fait environ 100 tests et 25 s de GPU logiciel en double (vérifié).
- **Un test casse sous la charge.** Lancés ensemble, `dawn.spec` et `programs.spec` échouent tous les deux sur « measures the GPU time of the passes » avec **80 523 ms** pour une passe (vérifié ; ils passent quand on les lance séparément). Cause probable : [WebGpuPassTimer.ts:108-116](packages/engine-webgpu/src/render/WebGpuPassTimer.ts#L108-L116) résout `_used` paires de timestamps, alors qu'une passe non jouée à cette image garde l'horodatage d'une image précédente. `end >= begin` laisse alors passer un écart énorme. Il faut ne lire que les paires écrites à cette image (un masque par slot).

**Corrections :**

1. Faire tourner les programmes dans un pool de `os.availableParallelism()` tâches, et non en série. Gain attendu : environ ×6 à ×8 sur un poste, ×3 sur un runner.
2. Utiliser un seul répertoire temporaire par programme au lieu de trois, et y lancer spirv-val et spirv-cross côte à côte.
3. Mettre en cache les résultats par `programKey` + version de DXC (le `FileShaderCache` de `82a36d9` le permet déjà) : un programme inchangé n'est pas revalidé.
4. Enregistrer les programmes dans `dawn.spec.ts` via `recordPrograms`, puis valider dans le même fichier (ou par un `globalSetup`), pour supprimer la deuxième suite Dawn.
5. Une fois ces corrections faites, **retirer** le `testTimeout: 30_000` de [vitest.config.mts](tests/rendering/vitest.config.mts) et les `timeout` de `programs.spec.ts`, et revenir aux 5 s par défaut.

### 1.3 Fumée : une référence CPU qui alloue à chaque cellule (vérifié)

« rises from a fire » (grille 8×16×8 = 1 024 cellules, 41 pas) prend 1,7 s, et « flows around an obstacle » (24×32×1, 120 pas) 2,0 s, sur un poste inoccupé. Cela fait **environ 30 ms par pas pour 1 024 cellules**, soit environ 30 µs par cellule et par pas.

Décomposition mesurée (41 pas) :

| Variante                               | Durée  |
| -------------------------------------- | ------ |
| complète                               | 1,2 s  |
| sans feu                               | 1,06 s |
| sans solveur de pression (0 itération) | 0,68 s |
| 42 000 `simplexNoise` seuls            | 22 ms  |

Le bruit n'y est pour rien. Le coût vient du style de [smoke/cpu.ts](packages/engine-fluids/src/smoke/cpu.ts), qui alloue en permanence :

- `eachCell` et `eachFace` créent un tableau `[i, j, k]` par visite ;
- `shift`, `center`, `neighborCell` et `p.map(...)` créent des tableaux ;
- `faceLattice(grid, axis)` crée un objet et trois tableaux **à chaque échantillon** ;
- `sampleLatticeCpu` fait trois `[0, 1, 2].map` par appel ([grid.ts:223-280](packages/engine-fluids/src/smoke/grid.ts#L223-L280)) ;
- la confinement appelle `force()` deux fois par face et par axe, avec six `neighborCell`.

Le solveur de Jacobi alloue aussi un `Float32Array` par itération.

À 30 s de timeout, le test tolère un ralentissement de ×15 ; ce n'est plus un test unitaire.

**Correction :** réécrire les boucles chaudes avec des index entiers et des scratch préalloués (lattices calculées une fois par pas, deux tampons de pression alternés). Le travail est mécanique et le gain attendu dépasse ×10. La même remarque vaut pour `engine-noise` (§5). Ensuite, retirer les `{ timeout: 30_000 }` de [smoke.spec.ts](packages/engine-fluids/src/smoke.spec.ts).

### 1.4 Layout de l'éditeur web : un test qui attend des images

Le test (1,5 s ici) masque les docks, puis attend que `canvas.width` grandisse. Or la nouvelle taille fait deux étapes avant d'arriver au canvas :

1. [useViewportBounds.ts:57-65](packages/editor-ui/src/useViewportBounds.ts#L57-L65) lit les bornes **une fois par `requestAnimationFrame`** ;
2. le message traverse le `MessageChannel`, puis est appliqué entre deux images du moteur ([EditorEngine.ts:209-212](packages/editor-ui/src/engine/EditorEngine.ts#L209-L212), boucle `run()` `:316-340`), qui tourne sur le même thread que la page.

Le délai est donc de **2 à 3 images**. Sur SwiftShader avec la scène `shadows` d'un runner chargé, une image peut durer une seconde ou plus : passer de 1 s à 10 s ne fait que suivre la cadence d'images, et la prochaine fonctionnalité de rendu demandera de nouveau plus.

**Correction :** se synchroniser sur un événement, pas sur une durée. Le moteur publie déjà `stats` avec `width` et `height` : il suffit qu'il envoie aussi un message `resized` (ou `stats` immédiat) quand `setBounds` change la taille, et que le test l'attende. Le test peut aussi utiliser une scène vide plutôt que `shadows`.

### 1.5 Graph du jeu dans la documentation : le test attend le chargement complet du jeu

[apps/docs/tests/editor.spec.ts](apps/docs/tests/editor.spec.ts) attend que la liste des graphs contienne « Enemies » ou « hero animation ». Ces graphs ne sont listés qu'une fois **tout le jeu TPS chargé** ([tps.ts:594-610](packages/demo-scenes/src/tps/tps.ts#L594-L610)) :

- 30 Mo de modèles et de textures JPEG ;
- `bakeRockTexture` sur le GPU ;
- `buildForest` ;
- l'instanciation des ennemis et du héros, et la compilation de leurs pipelines.

Tout cela se fait sur SwiftShader, pendant que la boucle de l'éditeur dessine des images sans arrêt. Le commentaire du test le reconnaît lui-même (« The game saturates SwiftShader »), et la parade a été de donner à ce test son propre navigateur.

Par ailleurs, Playwright lance par défaut 50 % des cœurs en workers, donc deux Chromium avec SwiftShader (lui-même multi-thread) sur un runner à 4 vCPU. Chaque asset, ennemi ou passe de rendu ajouté au jeu allonge le test.

**Correction :**

1. Ce test vérifie l'éditeur de graphs, pas le jeu : lui donner un niveau minimal (`options.level`, un ennemi, pas de forêt) via un paramètre de la page de doc réservé aux tests.
2. Dans l'éditeur, limiter la cadence des images tant que la scène charge (`ready` non résolu), ou les suspendre quand l'iframe n'est pas visible.
3. Mettre `workers: 1` pour le projet `webgpu` de [playwright.config.mts](apps/docs/playwright.config.mts), ou utiliser `fullyParallel: false` avec un seul projet SwiftShader à la fois.

Le même raisonnement vaut pour les timeouts par exemple (`tps` 120 s, `occlusion-culling`/`levels-of-detail`/`coast` 60 s) et pour les captures passées de 20 à 30 s.

### 1.6 La cause commune : la CI fait tourner plus de GPU logiciels qu'elle n'a de cœurs

| Niveau                                  | Parallélisme par défaut                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Nx (`nx run-many -t test`)              | 3 projets à la fois ([nx.json](nx.json) ne fixe pas `parallel`)                                          |
| Vitest, dans chaque projet              | environ un worker par cœur ; tests/rendering lance ses 4 specs en même temps                             |
| Dans chaque worker                      | lavapipe, WARP et SwiftShader répartissent la rastérisation sur tous les cœurs ; DXC lance des processus |
| Runners `ubuntu-24.04` / `windows-2025` | **4 vCPU**                                                                                               |

Le job `native` peut ainsi faire tourner en même temps : Dawn deux fois, lavapipe, WARP, Chromium avec SwiftShader (editor-web) et des processus DXC, sur 4 cœurs. Chaque test GPU ajouté ralentit **tous les autres**. C'est pourquoi des tests anciens, inchangés, exigent eux aussi des timeouts plus longs. La mesure du §1.2 le montre : le même fichier passe de 27 s à 44 s sur 24 cœurs dès que ses voisins tournent.

**Correction :**

1. Lancer `nx run-many -t test --projects="$PROJECTS" --parallel=1` pour les projets `gpu`. Ils sont déjà dans un job à part, donc le job `check` n'est pas ralenti.
2. Dans [tests/rendering/vitest.config.mts](tests/rendering/vitest.config.mts), fixer `maxWorkers: 2` (ou `fileParallelism: false` sur CI).
3. **Suivre les durées plutôt que les timeouts** : ajouter le reporter `junit` en CI, publier le fichier, et faire échouer un test qui dépasse son budget de plus de 50 % par rapport à `main`. Le dossier `tools/bench` existe déjà pour ce genre de comparaison.
4. Ne plus allonger un timeout sans un chronométrage local qui justifie la nouvelle valeur.

### 1.7 Autres tests instables relevés

- `packages/engine-resources-web/src/web.spec.ts:229` a échoué une fois dans la suite complète, sans être reproduit seul : c'est une question de durée.
- Le test « real addon » d'`engine-resources-native` ne tourne **jamais** en CI (§4.4).

---

## 2. Compilation, Nx et CI

### 2.1 État (vérifié)

| Point                                            | Statut   | Détail                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -b`, typecheck                              | 🟢       | 0 erreur sur tous les packages audités.                                                                                                                                                                                                                                    |
| `nx sync:check`                                  | 🟢       | À jour.                                                                                                                                                                                                                                                                    |
| Tests                                            | 🟢       | Ils passent : par exemple 532 tests pour les 6 packages du §3, 53 pour engine-vulkan, 15 pour engine-d3d12.                                                                                                                                                                |
| Lint                                             | 🟡       | 0 erreur, une trentaine de warnings. Les `.eslintrc.json` d'engine-backend, engine-core, engine-webgpu et engine-webgl2 sont au format legacy et **ignorés par ESLint 9**, donc `@nx/dependency-checks` ne s'applique jamais. Il faut les migrer vers `eslint.config.mjs`. |
| `NX_WORKSPACE_ROOT_PATH` en minuscules (Windows) | 🆕 basse | Les tests lancés par Nx échouent (« Cannot read properties of undefined (reading 'config') ») si le chemin est `c:\…`. À documenter dans le README.                                                                                                                        |

### 2.2 Cibles Nx

| Gravité | Lieu                                                                   | Constat                                                                                                                                                                                                                   | Correction                                               |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| moyenne | `packages/engine-{vulkan,d3d12}/project.json` (`build-native.outputs`) | Seul le `.node` est déclaré. `dxcompiler`, `dxil.dll` et `.prebuilt` (déposés par `tools/native/prebuilt.mjs:169-178`) ne sont pas restaurés depuis le cache : l'addon revient sans son DXC.                              | Les ajouter aux `outputs`.                               |
| moyenne | mêmes fichiers (`build-native.inputs`)                                 | Manquent : `FDW_FROM_SOURCE`, le mode debug, la version de `node-api-headers`, le Windows SDK. Sans `VULKAN_SDK`, le script sort en 0 sans rien produire (`scripts/build.mjs:15-21`), et ce succès vide est mis en cache. | Ajouter ces inputs, et faire échouer le script sans SDK. |
| basse   | `tests/rendering/project.json`, `packages/engine-vulkan/project.json`  | `FDW_REQUIRE_SUITES`, `FDW_D3D12_ADAPTER` et `VK_DRIVER_FILES` ne sont pas des inputs : un succès obtenu avec des suites sautées peut être rejoué depuis le cache.                                                        | `{ "env": … }` pour chacune.                             |
| basse   | `packages/engine-native/project.json`                                  | `dependentTasksOutputFiles: "**/*.js"` ignore le `.node` d'engine-vulkan.                                                                                                                                                 | Ajouter `**/*.node`.                                     |

### 2.3 Workflows GitHub

| Gravité | Lieu                                             | Constat                                                                                                                                                                                                                                                                                                                      | Correction                                                                                           |
| ------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| moyenne | `ci.yml`, `docs.yml`                             | `.nx/cache` est sauvé sous une clé par commit, avec des `restore-keys` : chaque run réenregistre tout le cache, qui grossit. En local, il fait 6,3 Go pour 335 entrées, et `nx.json` n'a pas de `maxCacheSize` (vérifié). Avec le SDK, Playwright et les builds natifs, le quota de 10 Go va tourner en éviction permanente. | `maxCacheSize: "1GB"`, une clé par branche, ne sauver que sur `main`.                                |
| moyenne | `bench.yml`, `docs.yml`                          | Aucun filtre de chemins : chaque PR lance la build de la doc, ses captures Playwright et les benchmarks (jusqu'à 45 min).                                                                                                                                                                                                    | `paths`/`paths-ignore`, ou `nx affected` ; benchmarks sur `main` ou sur un label.                    |
| moyenne | `addons.yml:30-114`, `tools/native/prebuilt.mjs` | Les prébuilts sont publiés depuis `main` sans attendre la CI ni faire de test de chargement, et le téléchargement n'est pas vérifié par un `sha256`. Le hash des prébuilts ignore `scripts/build.mjs`, `VULKAN_SDK_VERSION` et `node-api-headers`, donc des binaires périmés restent servis.                                 | `workflow_run` sur une CI en succès, smoke test, `sha256` publié ; compléter le hash et les `paths`. |
| moyenne | `design/ci.md`                                   | Le document a divergé des workflows : docs et bench tournent sur chaque PR, la liste des projets `gpu` est incomplète, `windows` n'est pas dans les statuts exigés.                                                                                                                                                          | Aligner le document, et décider si Windows bloque une PR.                                            |
| basse   | `ci.yml` (`windows`)                             | Il n'y a pas de sccache ou de ccache pour MSVC.                                                                                                                                                                                                                                                                              | sccache.                                                                                             |
| basse   | `ci.yml`, `docs.yml`                             | `playwright install --with-deps` relance `apt` même quand le cache Playwright est présent.                                                                                                                                                                                                                                   | Séparer `install-deps` et `install`.                                                                 |
| basse   | tous                                             | Les actions tierces sont épinglées par tag, alors que `addons.yml` a `contents: write`.                                                                                                                                                                                                                                      | Épingler par SHA.                                                                                    |

---

## 3. Backends et rendu

### 3.1 engine-webgpu

| Statut | Gravité | Lieu                                                                                         | Constat                                                                                                                                                                                                          | Correction                                                                                  |
| ------ | ------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 🔴     | haute   | [TextureFactory.ts:128-152](packages/engine-webgpu/src/gpu/TextureFactory.ts#L128-L152)      | `dimension` n'est jamais transmis, donc une texture `3d` est créée en 2D (vérifié avec Dawn). Les textures 3D de KTX2 et d'engine-assets sont inutilisables en WebGPU, alors qu'elles marchent en WebGL2.        | `dimension: type === '3d' ? '3d' : '2d'`, plus un test Dawn.                                |
| 🆕     | moyenne | [BufferFactory.ts:126-127](packages/engine-webgpu/src/gpu/BufferFactory.ts#L126-L127)        | Une écriture dont la longueur n'est pas un multiple de 4 est complétée par des zéros qui **écrasent jusqu'à 3 octets voisins** : `[1..8]`, puis `write(0, [9,9])`, donne `9,9,0,0,5,6,7,8` (vérifié).            | Ne compléter que si l'écriture atteint la fin du buffer, sinon lever une erreur.            |
| 🆕     | moyenne | [WebGpuPassTimer.ts:108-116](packages/engine-webgpu/src/render/WebGpuPassTimer.ts#L108-L116) | Des timestamps d'une image précédente sont lus, ce qui donne une passe de 80 s (vérifié, §1.2).                                                                                                                  | Masque des paires écrites à cette image.                                                    |
| 🔴     | moyenne | `TextureFactory.ts:154`                                                                      | La table d'octets par pixel lève son exception **après** `createTexture`, donc la texture fuit (vérifié). Elle duplique aussi `texelBytes` d'engine-backend, qui gère `bgra8unorm` alors qu'elle ne le gère pas. | Valider le format avant de créer la texture, avec `texelBytes`.                             |
| 🔴     | moyenne | `WebGpuEngine.ts:31-83, 107-118`                                                             | `device.lost` et `uncapturederror` ne sont pas gérés. `destroy()` pendant `init()` laisse l'état `ready` avec un device actif (vérifié).                                                                         | Écouter `device.lost`, et dans `init()` annuler le résultat si l'état a changé entre-temps. |
| 🆕     | basse   | `wgslLayoutStrategy.ts:221`, `WgslCodegen.ts:476-490`                                        | La ligne de la table d'objets est calculée en std140 mais lue comme une struct WGSL de stockage. Les deux coïncident aujourd'hui, mais rien ne le vérifie.                                                       | Assertion sur la taille et les offsets, ou `@size`/`@align`.                                |
| 🔴     | basse   | `WebGpuSurface.ts:29, 34, 80-91`, `TextureFactory.ts:279-293`                                | La surface ne peut pas s'initialiser en pause, `getPreferredCanvasFormat` ignore l'option `gpu`, une vue est créée à chaque accès, et le sampler ne reçoit pas de label.                                         | —                                                                                           |

### 3.2 engine-webgl2

| Statut | Gravité | Lieu                                                                                                         | Constat                                                                                                                                                                                                                                                                     | Correction                                                                                       |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 🆕     | moyenne | `WebGl2PipelineFactory.ts:403-413, 588`, `engine-backend/src/render/types.ts:121-127`                        | `GpuRenderPipeline` n'a pas de `destroy()`. Il y a un VAO par pipeline qui n'est jamais supprimé, `_linkedPrograms` grandit sans limite, et le programme lié en double (cache trouvé après coup, ou échec du link) fuit. En WebGPU, `_modules` n'a pas d'éviction non plus. | Supprimer programme et shaders sur ces chemins, et ajouter `destroy()` au contrat des pipelines. |
| 🆕     | moyenne | `WebGl2CommandEncoder.ts`, `WebGl2PipelineFactory.ts`, `WebGl2Buffer.ts`, `readback.ts`, `shader/storage.ts` | Environ 2 200 lignes critiques n'ont pas de test unitaire (il n'existe que 2 specs). La suite de rendu les couvre en bout en bout, mais pas les cas limites.                                                                                                                | Tests avec un contexte GL simulé.                                                                |
| 🆕     | basse   | `WebGl2Buffer.ts:170-196`                                                                                    | Le contrat d'écriture diffère de WebGPU : offset non aligné accepté, `copy-dst` non vérifié. Un code valide en WebGL2 échoue donc en WebGPU.                                                                                                                                | `checkBufferWrite` commun dans engine-backend.                                                   |
| 🆕     | basse   | `WebGl2Engine.ts`                                                                                            | `webglcontextlost` et `webglcontextrestored` ne sont pas gérés.                                                                                                                                                                                                             | —                                                                                                |

### 3.3 engine-core

| Statut | Gravité | Lieu                                                                             | Constat                                                                                                                                                                                                                                                                  | Correction                                                     |
| ------ | ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 🆕     | moyenne | [Renderer.ts:1540-1571](packages/engine-core/src/render/Renderer.ts#L1540-L1571) | `destroy()` ne libère ni les vertex et index buffers des meshes (`_meshes` est une `WeakMap` non itérable, `:716`), ni les uniforms des matériaux, ni `_fullscreenMesh`, ni le sampler du tone mapping. En WebGL2, ils fuient jusqu'au GC, à chaque changement de scène. | Tenir un `Set` des ressources créées.                          |
| 🔴     | moyenne | `Camera.ts:53-76`, `light/*.ts`                                                  | `Object.freeze` ne protège pas les vues : `spot.position.x = 9` écrit la valeur sans incrémenter la version, et les caches deviennent périmés (vérifié).                                                                                                                 | Vues en lecture seule, ou setters qui incrémentent la version. |
| 🆕     | basse   | `render/lightVolumes.ts:22`                                                      | Un `outerCutoff` supérieur à 90° n'est borné que dans `lightClusters` : `spotVolume` élimine alors des zones éclairées. L'unité n'est pas documentée.                                                                                                                    | Borner dans le setter de `SpotLight`.                          |
| 🔴     | basse   | `light/BaseLight.ts:30-35`, `Camera.ts:79-81`                                    | Les versions démarrent à 1, 4 et 7 ; le setter de `projection` garde l'objet de l'appelant (vérifié). Les exports nommés et par défaut sont mélangés.                                                                                                                    | —                                                              |

### 3.4 engine-backend

| Statut | Gravité | Lieu                                                                                                                                                             | Constat                                                                                                                                                                                                       | Correction                                         |
| ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 🆕     | moyenne | `gpu/{GpuType,GpuArray,GpuStruct,structs,arrays,…}.ts`, `material/*`, `camera/CameraAdapter.ts`, `transform/*`, et `engine-webgpu/src/gpu/{structs,arrays,…}.ts` | Environ **1 750 lignes de code mort mais exporté** : tout passe désormais par `PhysicalLayoutStrategy`. Plusieurs anciens points y deviennent ⚪.                                                             | Supprimer (garder `CameraCache` et `CachedValue`). |
| 🔴     | moyenne | `math/TransformMath.ts:54-60`                                                                                                                                    | Une échelle nulle donne une normal matrix `[Inf, NaN…]` envoyée au GPU (`Renderer.ts:2748`), alors que `TransformPool.normalBlock` renvoie 0 dans ce cas : il y a deux implémentations divergentes (vérifié). | Réutiliser `normalBlock`.                          |
| 🔴     | moyenne | `math/wgpu-matrix/{mat4,vec4,quat,mat3}.ts`                                                                                                                      | `setRotation` et `setScaling` sont faux, et `vec4` ignore `w` dans six fonctions. C'est exporté, mais non utilisé et non testé.                                                                               | Corriger et tester, ou supprimer.                  |
| 🔴     | moyenne | `package.json`                                                                                                                                                   | `wgpu-matrix`, `@preact/signals-core` et `@webgpu/types` ne sont pas déclarés (ce qui serait détecté une fois le lint migré, §2.1).                                                                           | Les déclarer.                                      |
| 🆕     | basse   | `shader/std140LayoutStrategy.ts:134-240`, `engine-webgpu/src/shader/wgslLayoutStrategy.ts:83-190`                                                                | `writeUniform` existe en deux copies presque identiques.                                                                                                                                                      | Extraire, paramétré par les strides.               |

### 3.5 engine-shader et engine-graph

| Statut | Gravité | Lieu                                                                         | Constat                                                                                                                                                                                                          | Correction                                                   |
| ------ | ------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 🆕     | basse   | `WgslCodegen.ts:78-209`, `GlslEsCodegen.ts:93-208`, `HlslCodegen.ts:174-502` | Huit helpers de nommage sont dupliqués dans les trois codegens, et ils ont déjà divergé : seul GLSL fusionne `__`, si bien que `a__b` et `a_b` donnent tous deux `u_a_b`, ce qui fait une déclaration en double. | `codegen/naming.ts` commun, et refuser `__` à la validation. |
| 🆕     | basse   | `compiler/{generateIr,optimize,…}.ts`, `std/*`                               | Environ 2 900 lignes de compilateur ne sont testées qu'indirectement.                                                                                                                                            | Tests unitaires sur `optimize` et `generateIr`.              |
| 🆕     | basse   | `engine-graph/src/structure.ts:203-225`                                      | `topologicalOrder` est en O(n²) (`shift()`), et le message de cycle liste aussi les nœuds situés en aval.                                                                                                        | Index de lecture.                                            |

---

## 4. Addons natifs

### 4.1 engine-vulkan

| Gravité | Lieu                                                               | Constat                                                                                                                                                                                                                                                | Correction                                                             |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| haute   | `native/src/tracking.cpp:77-84` (et `:114-118`, `:147-151`)        | **Hazard read-after-write** : une lecture qui suit une autre lecture ajoute ses stages sans barrière, alors que la barrière posée depuis l'écriture ne couvrait que le premier lecteur (par exemple copie → uniform au fragment → storage au compute). | Suivre la dernière écriture et les stages déjà synchronisés avec elle. |
| haute   | `native/src/swapchain.cpp:134-140`, `node_vulkan.c:281, 1240`      | **Use-after-free** : `releaseImages` fait `delete` des textures du swapchain au resize, alors que des externals JS gardent ces pointeurs.                                                                                                              | Résoudre les handles par id.                                           |
| moyenne | `swapchain.cpp:358-366`                                            | La taille demandée est comparée à l'extent clampé : le swapchain peut être recréé (avec `vkDeviceWaitIdle`) à chaque image.                                                                                                                            | Comparer à la dernière taille demandée.                                |
| moyenne | `swapchain.cpp:192-200`                                            | Après un échec de `vkCreateSwapchainKHR`, `outdated` reste à false, et l'acquire suivant indexe hors bornes.                                                                                                                                           | `outdated = true`.                                                     |
| moyenne | `commands.cpp:60-63, 639-663`                                      | Les groupes et le pipeline ne sont pas remis à zéro à chaque passe : une passe utilise un groupe hérité sans barrière.                                                                                                                                 | Remettre l'état à zéro à chaque passe (sémantique WebGPU).             |
| basse   | `texture.cpp:54-55`, `node_vulkan.c:838-847`, `context.cpp:66-106` | La copie de `depth24plus-stencil8` utilise 8 octets par pixel au lieu de 4 ; un argument DXC NULL passe ; `pendingWaits` est perdu quand `submit` échoue.                                                                                              | —                                                                      |

### 4.2 engine-d3d12

| Gravité | Lieu                                          | Constat                                                                                                                                                                                             | Correction                                                 |
| ------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| haute   | `native/src/context.cpp:291-299, 347-354`     | **Un seul `Close()` en échec bloque le contexte** : la liste est marquée soumise, et le HRESULT de `Reset` n'est pas vérifié (vérifié : une copie hors bornes, puis trois copies valides échouent). | Recréer la liste et réinitialiser le suivi d'état.         |
| haute   | `node_d3d12.c:842-849`, `shader.cpp:113, 123` | **Segfault** avec `compileHlsl('x', ['-T', 1])` (vérifié, code 139).                                                                                                                                | `TypeError` et borner `count`.                             |
| haute   | `swapchain.cpp:48-53`, `node_d3d12.c:1243`    | Use-after-free des images du swapchain, comme pour Vulkan.                                                                                                                                          | Idem.                                                      |
| moyenne | `commands.cpp:296, 335, 694, 723`             | Aucune vérification de bornes dans le replay : copies, indirect, `copyTexture` (vérifié). Sans la debug layer, c'est un comportement indéfini.                                                      | Tester `offset + size` et les alignements.                 |
| moyenne | `texture.cpp:377, 450`                        | Copies de `depth24plus-stencil8` invalides (`R32G8X24_TYPELESS`) (vérifié).                                                                                                                         | `GetCopyableFootprints` par plan.                          |
| moyenne | `rays.cpp:341, 389, 395-398`                  | La réallocation du TLAS libère avant d'allouer, et le TLAS ne garde aucune référence vers ses BLAS, qui peuvent être détruits pendant qu'il les utilise.                                            | Allouer avant de libérer ; `ComPtr` des BLAS dans le TLAS. |
| moyenne | `context.cpp:358-368`                         | Si `Signal` échoue, un allocator encore en vol peut être `Reset`.                                                                                                                                   | Déclarer le contexte perdu.                                |
| basse   | `shader.cpp:50-58`, `commands.cpp:70-72`      | `dxil.dll` reste chargé quand `dxcompiler.dll` échoue ; l'état du replay n'est pas remis à zéro à chaque passe.                                                                                     | —                                                          |

### 4.3 Cache de shaders HLSL (`82a36d9`)

- 🟢 La clé couvre la version et le commit de DXC, la cible, les arguments et le HLSL.
- 🆕 **moyenne** : une entrée corrompue va directement au driver, sans vérification de l'en-tête SPIR-V ou DXBC et sans recompilation en cas d'échec (`VulkanPipelineFactory.createShader`, `shader.cpp:232-244`). Il faut vérifier le magic et un hash, puis recompiler en cas d'échec.
- 🆕 **basse** : la clé ignore `dxil.dll`. Le cache n'a ni éviction ni limite de taille ([ShaderCache.ts:96-107](packages/engine-vulkan/src/shader/ShaderCache.ts#L96-L107)) : prévoir un sous-répertoire par version de DXC.

### 4.4 engine-native, audio, input, resources (N-API)

| Gravité | Lieu                                                                   | Constat                                                                                                                                                                                                               | Correction                                                       |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| moyenne | `engine-resources-native/src/native.spec.ts:164-169`, `project.json:6` | Le test de l'addon réel est en `skipIf(!existsSync(addon))`, le projet n'a pas le tag `gpu` et pas de `dependsOn` vers `build-native` : **il ne tourne jamais en CI** (vérifié). Même chose pour engine-input-native. | Tag `gpu` et `dependsOn`, ou `canRun` avec `FDW_REQUIRE_SUITES`. |
| basse   | `engine-native/native/src/node_window.c:46-57, 110`                    | Les handles de fenêtre n'ont pas de type tag : un clip audio passé à leur place provoque un crash.                                                                                                                    | `napi_type_tag_object`, comme dans `node_audio.c`.               |
| basse   | `node_audio.c:424`, `node_image.c:198`                                 | L'`ArrayBuffer` d'entrée peut être détaché pendant que le pool libuv le lit.                                                                                                                                          | Copier avant de mettre le travail en file.                       |
| basse   | `node_audio.c:62-65, 424-433`, `node_window.c:108`                     | Fuites sur les chemins d'erreur N-API ; `malloc` non testé.                                                                                                                                                           | —                                                                |

Points vérifiés sans problème : les finalizers, les enums alignés avec engine-backend, aucun pointeur de TypedArray gardé après un appel, `last_error` en `thread_local`, et la copie de repli pour Electron.

---

## 5. Simulation et runtime

| Statut | Gravité | Lieu                                                                                             | Constat                                                                                                                                                                                                                                 | Correction                                                         |
| ------ | ------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 🆕     | haute   | [ScenePhysics.ts:233](packages/engine-physics/src/ScenePhysics.ts#L233)                          | `moved` repasse à 0 au deuxième pas immobile sans attendre `sync()`. Avec plusieurs pas fixes par image (30 fps pour une physique à 60 Hz), le nœud reste figé sur une pose intermédiaire : corps à x = 0,1, nœud à x = 0,05 (vérifié). | Ne remettre `moved` à 0 qu'après une écriture faite dans `sync()`. |
| 🆕     | haute   | `ScenePhysics.ts:129-130`                                                                        | `addCharacter` sur un nœud qui a déjà un corps : l'ancien corps fuit, et Rapier plante avec `RuntimeError: unreachable` (vérifié).                                                                                                      | Faire `_characters.set` après `attach()`.                          |
| 🆕     | haute   | `engine-ocean/src/spectrum.ts:146-157`                                                           | JONSWAP avec `windSpeed: 0` ou `fetch: 0` : toutes les amplitudes valent NaN, sur le GPU comme dans `Buoyancy` (vérifié).                                                                                                               | Valider les paramètres, ou renvoyer un spectre nul.                |
| 🆕     | haute   | `engine-geometry/src/bvh/Bvh.ts:372-390`                                                         | `rayBoxDistance` calcule `0 × ∞ = NaN` : un rayon vertical en x = 0 traverse un sol en grille (vérifié). Le WGSL a le même défaut.                                                                                                      | Traiter `d === 0` comme le font `rayBox` et `raycastBox`.          |
| 🆕     | haute   | `engine-behavior/src/BehaviorInstance.ts:167`                                                    | `flow.delay(NaN)` crée un minuteur qui bloque définitivement tous les délais de l'instance (vérifié).                                                                                                                                   | `Number.isFinite(s) ? Math.max(0, s) : 0`.                         |
| 🆕     | moyenne | `ScenePhysics.ts:194`                                                                            | `teleport()` écrit la pose monde comme pose locale sous un parent : x = 20 au lieu de 10 (vérifié).                                                                                                                                     | N'écrire que si `follow === Follow.body`.                          |
| 🆕     | moyenne | `engine-physics-rapier/src/RapierPhysics.ts:403-410, 519-536`                                    | Un corps supprimé à l'intérieur d'un capteur n'émet jamais `end` (vérifié). `filter.exclude` est ignoré par `move`. Un personnage survit à son corps.                                                                                   | Émettre les `end` avant la purge, et retirer le contrôleur.        |
| 🆕     | moyenne | `engine-ocean/src/OceanSpectrum.ts:148, 222`                                                     | Avec `resolution: 4`, on dispatche 0,5 workgroup, donc rien n'est calculé (vérifié). Sans relecture, `fields` relance une FFT CPU complète à chaque image.                                                                              | `n >= 8` ; une évaluation au plus par `update`.                    |
| 🆕     | moyenne | `engine-ocean/src/gerstner.ts:106`, `fields.ts:106-121`                                          | `sample()` réalloue et recalcule toutes les phases : 7 échantillons × 379 points par pas pour la barque.                                                                                                                                | Phases en cache dans `update`.                                     |
| 🆕     | moyenne | `engine-ocean/src/OceanRenderer.ts:237`                                                          | `environmentIntensity` est copié une seule fois : après un `setLook`, le reflet et le ciel divergent.                                                                                                                                   | Relire la valeur à chaque `addPasses`.                             |
| 🆕     | moyenne | `engine-fluids/src/shallow/ShallowWater.ts:446`, `particles/ParticleFluid.ts:452`                | Une relecture lancée avant `reset()` ou `clear()` réécrit l'état ancien, ce qui donne un à-coup de flottaison.                                                                                                                          | Compteur de génération.                                            |
| 🆕     | moyenne | `ParticleFluidRenderer.ts:612`, `SmokeRenderer.ts:382`, `OceanRenderer.ts:93, 223, 245`          | `destroy()` laisse fuir des meshes et des samplers.                                                                                                                                                                                     | Les suivre et les détruire.                                        |
| 🆕     | moyenne | `engine-fluids/src/fluids.spec.ts:99`                                                            | Le test « read back for the physics » ne fait aucun `await` et ne vérifie jamais `heightAt`. `splash`, `addSource` et `reset` ne sont pas testés.                                                                                       | —                                                                  |
| 🆕     | moyenne | `engine-tessellation/src/patchMesh.ts:448`                                                       | Le mesh de lancer de rayons coupe les quads selon l'autre diagonale que le shader : les rayons touchent une autre surface que celle dessinée. Il n'y a aucun test.                                                                      | Indexer `[c00, c01, c11, c00, c11, c10]`, plus un test.            |
| 🆕     | moyenne | `engine-skinning/src/graph.ts:106`                                                               | Le mode `vertex` lit les poids bruts, et `compute` les poids normalisés : les deux modes divergent (écart avec p6 §6).                                                                                                                  | Poids normalisés partout.                                          |
| 🆕     | moyenne | `engine-animation/src/Animator.ts:184`                                                           | Dans un blend synchronisé, une vitesse négative joue le clip à l'endroit (vérifié).                                                                                                                                                     | Phase miroir.                                                      |
| 🆕     | moyenne | `engine-behavior/src/Interpreter.ts:109`                                                         | `maxSteps` ne compte pas la même chose en interprété et en compilé (vérifié).                                                                                                                                                           | Aligner.                                                           |
| 🆕     | moyenne | `engine-input-web/src/WebInputSource.ts:118-119`                                                 | Il n'y a ni `setPointerCapture` ni `pointercancel` : un bouton relâché hors de l'élément reste enfoncé.                                                                                                                                 | Capturer le pointeur et traiter l'annulation.                      |
| 🆕     | basse   | `Animator.ts:659`, `Interpreter.ts:234`, `engine-noise/src/fractal.ts:113`                       | NaN accepté dans `Parameters.set` ; les tours de `forLoop` ne comptent pas dans `maxSteps` ; `fbm` avec 0 octave renvoie NaN.                                                                                                           | Valider les entrées.                                               |
| 🆕     | basse   | `WebAudioEngine.ts:629, 684-697`, `MusicPlayer.ts:287-291`                                       | Les bus ne sont pas déconnectés avec un contexte fourni, l'écouteur `abort` n'est jamais retiré, et `stop()` puis `play()` démarre sans fondu enchaîné.                                                                                 | —                                                                  |
| 🆕     | basse   | `engine-input/src/Input.ts:258-264`, `engine-camera/src/target.ts:31-51`, `instances.ts:157-166` | Un stick qui dérive monopolise `lastDevice` ; le pan orthographique ne suit pas le pointeur ; `frontFace` est inversé pour les instances miroirs.                                                                                       | —                                                                  |

**Allocations dans les boucles chaudes.** C'est un problème transversal, et la même cause que le §1.3. Sont concernés :

- `engine-noise/src/noise.ts` : environ 1,3 µs par fbm 2D, soit environ 1,4 s pour une heightmap de 1024² (vérifié) ;
- `engine-animation` (closures par clip, `Pose.add`, `subarray`) ;
- `engine-skinning` (`invert` alloue un `Float64Array` par nœud et par image) ;
- `engine-behavior` (un `Frame` par nœud exécuté) ;
- `engine-geometry` (un `Uint32Array` par feuille visitée et par rayon) ;
- `engine-fluids/buffers.ts` (environ 240 objets par image), `bodies.ts` ;
- `engine-camera` et `engine-input`.

Une règle de lint (ou une revue) contre `map`, `forEach` et les littéraux de tableau dans les fonctions appelées par cellule ou par image serait utile, avec un benchmark par module dans `tools/bench`.

**Duplication.** `lookValues` existe en trois copies (WaterSurface, ParticleFluidRenderer, Ocean), `toneMapping*` en deux, `Ocean.sampleAt` recopie `heightAbove`, et la détection des corps retirés est dupliquée entre fluids et ocean.

---

## 6. Assets, ressources et scènes

| Statut | Gravité | Lieu                                                                                                                                              | Constat                                                                                                                                                                                                                              | Correction                                                        |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 🆕     | haute   | `engine-gltf/src/scene/physics.ts:319-330`                                                                                                        | Les parents sont remontés sans détecter les cycles : deux nœuds parents l'un de l'autre font boucler le chargeur à l'infini (vérifié).                                                                                               | Valider l'arbre au décodage.                                      |
| 🆕     | haute   | `engine-ktx2/src/workers.ts:37-44`                                                                                                                | **Bombe de décompression** : un fichier de 261 Ko gonfle à 256 Mo avant d'être rejeté (vérifié).                                                                                                                                     | Décompresser par morceaux et borner à `uncompressedByteLength`.   |
| 🆕     | haute   | `engine-scene-io/src/instantiate.ts:191`                                                                                                          | Une scène qui s'inclut elle-même (A → A, ou A → B → A) fige le processus : récursion en microtâches, sans que l'annulation puisse l'arrêter (vérifié).                                                                               | Pile des URI en cours et profondeur maximale.                     |
| 🆕     | haute   | `engine-scene-io/src/instantiate.ts:234`                                                                                                          | Un batch dont `parent` est invalide n'est pas libéré par `dispose()` (vérifié).                                                                                                                                                      | Valider dans `parseFdwScene`.                                     |
| 🆕     | moyenne | `engine-gltf/src/scene/import.ts:229-234`, `engine-assets/src/instantiate.ts:206`                                                                 | Un cycle provoque un stack overflow, et un nœud partagé est émis plusieurs fois (vérifié).                                                                                                                                           | `Set` des nœuds visités.                                          |
| 🆕     | moyenne | `engine-gltf/src/geometry.ts:140-143, 349-354`                                                                                                    | Les indices ne sont pas comparés au nombre de sommets : normales NaN, et en strip/fan, `Uint16` tronque 70 000 en 4 464 (vérifié).                                                                                                   | Vérifier l'indice maximal et choisir le type d'index d'après lui. |
| 🆕     | moyenne | `engine-gltf/src/accessors.ts:253, 283`, `reader.ts:211-214`                                                                                      | Un `byteOffset` négatif donne des zéros, et l'allocation se fait avant le contrôle de bornes : `count = 2^29` alloue 8 Gio (vérifié).                                                                                                | Borner avant d'allouer.                                           |
| 🆕     | moyenne | `engine-obj/src/obj.ts:109-113, 195-206`                                                                                                          | Un indice de face invalide donne des positions NaN, sans warning (vérifié).                                                                                                                                                          | Valider, puis ignorer la face avec un warning.                    |
| 🆕     | moyenne | `engine-gltf/src/scene/import.ts:113-155`                                                                                                         | `fileAccessors` est une copie moins sûre de `GltfReader.readBuffer`.                                                                                                                                                                 | Factoriser.                                                       |
| 🆕     | moyenne | `engine-resources/src/sources/HttpSource.ts:27`                                                                                                   | Une URL absolue venant d'une scène reçoit les `headers` configurés : `Authorization` part chez un tiers (vérifié).                                                                                                                   | `allowedOrigins`, ou pas d'en-têtes hors de l'origine.            |
| 🆕     | moyenne | `engine-resources/src/uri.ts:49, 73`                                                                                                              | `..` au-delà de la racine : `HttpSource` sort de `base` (vérifié).                                                                                                                                                                   | Borner à la racine du schéma.                                     |
| 🆕     | moyenne | `ResourceStore.ts:221, 924`                                                                                                                       | L'écouteur `abort` n'est jamais retiré (100 écouteurs après 100 chargements) ; `providedBytes` ne copie pas, donc un décodeur qui transfère le buffer le détache (vérifié).                                                          | Retirer l'écouteur ; copier les octets.                           |
| 🆕     | moyenne | `engine-assets/src/instantiate.ts:145-156`                                                                                                        | Un clone de handle fuit quand le modèle n'est pas prêt (vérifié).                                                                                                                                                                    | `require()` avant `clone()`.                                      |
| 🆕     | moyenne | `engine-scene-io/src/format.ts:297`, `engine-scene/src/scene/Scene.ts:313`                                                                        | `count` n'est pas comparé aux longueurs des tableaux : positions NaN (vérifié).                                                                                                                                                      | Valider.                                                          |
| 🆕     | basse   | `accessors.ts:288`, `ktx2/codec.ts:174-193`, `obj/mtl.ts`, `nodes.ts:99-121`, `format.ts:213-324`, `ResourceStore.ts:382`, `ArchiveSource.ts:182` | Strides chevauchants, indices signés, largeur 0, cube non carré, chemins MTL absolus, `types["constructor"]` qui lit le prototype, entrées de 0 octet jamais évincées, zip stocké sans contrôle de bornes (vérifié pour la plupart). | Valider à l'entrée, `Object.hasOwn`.                              |

**Tests manquants :** il n'existe aucun test de robustesse sur des entrées malformées (accessor hors bornes, sparse, cycles, bombes zlib/zstd, data URI). Un petit corpus de fichiers malformés par parseur, joué en CI, couvrirait la plupart de ces constats.

---

## 7. Édition, éditeur et applications

### 7.1 Édition, undo/redo et plugins

| Statut | Gravité | Lieu                                                                                                             | Constat                                                                                                                                                                                            | Correction                                                    |
| ------ | ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 🆕     | haute   | `graph-editor/src/client.ts:138, 227`                                                                            | Les resolvers de `save()` sont dans une file FIFO, mais le workspace ne répond pas pour une session inconnue : la file se décale, le 2ᵉ save résout le 1ᵉʳ, et le dernier reste pendant (vérifié). | Id de requête ; rejeter les saves en attente à la fermeture.  |
| 🆕     | haute   | `graph-editor/src/GraphCanvas.tsx:354-355`, `editor-plugin-animation-graph/src/main.tsx:130`                     | Les listeners de `window` ne sont retirés qu'au `pointerup` : rien sur `pointercancel` ni au démontage (vérifié).                                                                                  | `setPointerCapture`, ou un cleanup dans un `useEffect`.       |
| 🆕     | haute   | `engine-editing/src/commands/commands.ts:176, 213`                                                               | L'undo d'une suppression ou d'un reparentage ne restaure pas l'ordre des frères (vérifié).                                                                                                         | Mémoriser le frère suivant, et `setParent(…, before)`.        |
| 🆕     | moyenne | `commands.ts:207`                                                                                                | `ReparentCommand.do` n'est pas atomique quand un cycle est détecté en cours de route (vérifié).                                                                                                    | Tout valider avant de déplacer.                               |
| 🆕     | moyenne | `engine-graph-editing/src/GraphSession.ts:337`, `commands.ts:83`                                                 | Deux drags distincts (ou deux renommages) fusionnent en une seule entrée (vérifié).                                                                                                                | `History.seal()` à la fin du geste.                           |
| 🆕     | moyenne | `GraphCanvas.tsx:552-553`, `editor-plugin-isolate/src/main.tsx:139-158`                                          | Une suppression mixte crée 2 entrées, isoler N nœuds en crée N, et désactiver le plugin laisse les nœuds cachés (vérifié).                                                                         | `history.transaction` ; un disposable dans les subscriptions. |
| 🆕     | moyenne | `engine-editing/src/EditingTools.ts:127`                                                                         | Il n'y a pas de `dispose()` : les listeners de sélection s'accumulent, 2 par affichage de `LevelView` (vérifié).                                                                                   | `dispose()` appelé par `LevelView.destroy()`.                 |
| 🆕     | moyenne | `editor-ui/src/engine/level/LevelDocument.ts:465`                                                                | `redoLabels.at(-1)` affiche le redo le plus lointain au lieu du prochain (vérifié).                                                                                                                | `redoLabels[0]`.                                              |
| 🆕     | basse   | `History.ts:209`, `pluginHost.ts:287`, `GraphSession.ts:310-322`, `editor-plugin-behavior-graph/src/main.tsx:37` | Une commande qui lève une exception disparaît des deux piles ; un plugin `failed` se réactive tout seul ; un `remove` vide salit la session ; `acceptsBehaviorType` est copié.                     | —                                                             |

### 7.2 apps/editor (Electron)

| Gravité | Lieu                                                        | Constat                                                                                                                                                                                                          | Correction                                                                                         |
| ------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| moyenne | `apps/editor/src/main/index.ts:16-31`, `main/host.ts:35-73` | Il n'y a ni `will-navigate` ni handler de permissions, et l'IPC ne vérifie pas `senderFrame` : une page vers laquelle la fenêtre aurait navigué garde le preload, avec le stockage et les dialogues de fichiers. | Refuser la navigation hors de l'app, refuser toutes les permissions, vérifier l'URL de l'émetteur. |
| moyenne | `main/host.ts:81-89`                                        | Dans l'app packagée, l'origine de toute URL `file:` vaut `"null"`, donc n'importe quel `popout.html` du disque s'ouvre avec le preload (vérifié).                                                                | Comparer à l'URL exacte du popout livré, ou utiliser un protocole `app://`.                        |
| basse   | `main/index.ts:56-59`, `electron-builder.yml`               | Le listener `engine:connect` fuit à chaque fenêtre recréée ; aucun fuse Electron n'est configuré.                                                                                                                | `@electron/fuses`.                                                                                 |

### 7.3 apps/demo et demo-scenes

| Gravité | Lieu                                                                                    | Constat                                                                                                                           | Correction                                               |
| ------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| moyenne | `apps/demo/src/routes/loading-model/route.tsx:32-47`, `material-graph/route.tsx:94-189` | Quitter la route pendant un `await` démarre une boucle sur un renderer détruit, ou laisse un rejet non attrapé (`Layout.tsx:60`). | Drapeau `disposed` ou `AbortController`, et un `.catch`. |
| moyenne | `demo-scenes/src/shadows.ts:136`, `pbr.ts:108`                                          | `destroy` ne libère pas les meshes, ce qui aggrave le §3.3.                                                                       | Détruire meshes et matériaux.                            |
| basse   | `apps/demo/src/hooks/useSurface.ts:82-109`, routes WebGPU brutes                        | La surface n'est jamais libérée, et des buffers et textures restent sans `destroy`.                                               | —                                                        |

---

## 8. Hygiène du dépôt

| Statut | Gravité | Point                                                                                                                                                                                                                                    | Correction                                                                                                                       |
| ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 🟡     | moyenne | `apps/demo/public/Mustang.obj` (95,7 Mo) est toujours un blob git normal, pas LFS, et aucune route ne le charge, pas plus que `Mustang.mtl` et `teapot.obj` (vérifié).                                                                   | Les retirer, ou `git lfs migrate`. **Ces deux options suppriment des données ou réécrivent l'historique : à décider en équipe.** |
| 🔴     | basse   | 4 `*.tsbuildinfo` sont commités (demo, editor ×2, editor-ui).                                                                                                                                                                            | `*.tsbuildinfo` dans le `.gitignore`, et `git rm --cached`.                                                                      |
| 🆕     | basse   | `.gitignore:62` contient `assets` sans ancrage, ce qui ignore `tools/assets/` et `apps/demo/src/assets/` (vérifié avec `git check-ignore`). Les fichiers ajoutés y sont invisibles, pour git comme pour les hash Nx.                     | `/assets`.                                                                                                                       |
| 🆕     | basse   | `antique_estoc_1k.gltf/` (2,5 Mo, LFS) est à la racine : c'est une source de `tools/assets/make-characters.mjs`.                                                                                                                         | Le déplacer sous `assets/`.                                                                                                      |
| 🔴     | basse   | `three`, `@11ty/nunjucks` et `node` sont toujours à la racine sans être utilisés ; `lucide-react` est déclaré dans editor-plugin-material-graph sans être utilisé ; apps/demo et editor-web ne déclarent pas leurs dépendances `@fdw/*`. | Nettoyer.                                                                                                                        |
| 🔴     | basse   | `tsconfig.base.json:22-23` a des `paths` vers `packages/ui`, qui n'existe pas ; les `exports` pointent vers `src/*.ts`.                                                                                                                  | —                                                                                                                                |
| ⚪     | —       | `dist/` à la racine (8 Mo) est ignoré : rien à faire.                                                                                                                                                                                    | —                                                                                                                                |

---

## 9. Plan d'action

**Semaine 1 : rendre aux tests une durée stable (§1).** C'est le chantier qui débloque les autres, car chaque correction ajoute aujourd'hui des tests qui ralentissent tous les autres.

1. `programs.spec.ts` : pool de processus, un seul répertoire temporaire par programme, programmes enregistrés depuis `dawn.spec.ts`.
2. Masque des timestamps dans `WebGpuPassTimer`.
3. `--parallel=1` pour les projets `gpu` en CI, et `maxWorkers` dans tests/rendering.
4. Référence CPU de la fumée sans allocation.
5. Message `resized` du moteur pour le test de layout ; niveau minimal pour les tests de graph de la doc ; `workers: 1` pour SwiftShader.
6. Rapport JUnit des durées en CI, puis **retrait des timeouts** de `0fa1b52`, `081a27b`, `3b50e81`, `3303c0d`, `c35193b`/`b8fe1ac` et `e3ec2dd`/`a95800b`, un par un, en s'appuyant sur ces durées.

**Semaine 2 : crashes et sécurité.** §4 (use-after-free, liste D3D12, segfault DXC, hazard Vulkan), §6 en haute gravité (cycles, bombe KTX2, scènes récursives), §7.2 (navigation et origine dans Electron), §6 `HttpSource`.

**Semaine 3 : correction visible.** Textures 3D et `Buffer.write` en WebGPU, physique (`moved`, `addCharacter`, `teleport`), NaN dans l'océan, le BVH et les comportements, `GraphClient.save`, undo de l'ordre des frères.

**Ensuite.** Fuites GPU à la destruction, suppression des ~1 750 lignes de code mort, migration ESLint et dépendances déclarées, allocations par image, cache CI et filtres de chemins, et l'hygiène du §8.

---

## Annexe A : statut de l'audit du 02/10

| Point du 02/10                                                                                 | Statut  | Commentaire                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| Workspace Nx désynchronisé (`engine-webgpu/tsconfig.lib.json`)                                 | 🟢      | `nx sync:check` à jour.                                                                         |
| engine-webgpu ne compile plus (`TextureFactory.ts:59`)                                         | 🟢      | `initialData` est typé `ArrayBufferView<ArrayBuffer>`.                                          |
| Aucun test, `nx test` cassé                                                                    | 🟢      | Vitest partout, Jest retiré.                                                                    |
| Padding de la branche `writeBuffer`                                                            | 🟡      | Le padding existe, mais il écrase les octets voisins (§3.1).                                    |
| `try/finally` dans `CachedValue`                                                               | 🟢      | —                                                                                               |
| Exports de `DirectionalLight`, `PointLight`, `SpotLight`                                       | 🟢      | —                                                                                               |
| Shader Phong, pipeline recréé à chaque image, rafraîchissement de la caméra                    | ⚪      | Remplacés par engine-shader et le `Renderer`.                                                   |
| Stratégie de structs uniform (`hasDynamicSize`, alignement, `runtimeSize`)                     | 🟢 / ⚪ | Corrigé, mais le code est désormais mort (§3.4).                                                |
| Indices uint32 et triangulation OBJ                                                            | ⚪      | L'importeur de la démo est supprimé, remplacé par `@fdw/engine-obj` (voir §6 pour ses défauts). |
| `Object.freeze` sur Camera et lumières, versions des lumières, projection gardée par référence | 🔴      | §3.3.                                                                                           |
| Normal matrix en 3×3                                                                           | 🟢 / 🔴 | Correcte, mais sans garde pour une échelle nulle dans `TransformMath` (§3.4).                   |
| wgpu-matrix (`setRotation`, `setScaling`, `vec4`)                                              | 🔴      | Le code a été déplacé dans engine-backend sans être corrigé (§3.4).                             |
| `TextureFactory` : vues, couches, mipmaps, `ImageBitmap`                                       | 🟢      | Sauf `dimension: '3d'` (§3.1) et la taille du bitmap.                                           |
| `WebGpuEngine` : `device.lost`, course `destroy`/`init`                                        | 🔴      | §3.1.                                                                                           |
| Démo : course sur le moteur (`globals/engine.ts:18-22`)                                        | 🔴      | `instance` est assigné avant `await init()`.                                                    |
| Démo : `ResizeObserver` déconnecté (`RenderSurface.tsx:24-56`)                                 | 🔴      | Masqué par la taille fixe de `Layout.tsx:68`.                                                   |
| Démo : nettoyage, `StrictMode`, `.catch`, `destroyEngine`                                      | 🟡      | Le nettoyage est fait en partie ; `destroyEngine` est mort ; il manque un `.catch` (§7.3).      |
| `Mustang.obj` hors LFS                                                                         | 🟡      | §8.                                                                                             |
| `*.tsbuildinfo` commités ; dépendances inutiles à la racine ; `paths` vers `packages/ui`       | 🔴      | §8.                                                                                             |
| `design/material-graph.md` non référencé                                                       | 🟢      | Lié depuis le README.                                                                           |

---

## Annexe B : statut des corrections (02/11/2026)

_Corrections faites sur les branches `FDW-CI-FIX` puis `FDW-AUDIT-FIX` (commits `5b97b14`, `a4b2224`, `66f649b` et suivants). Chaque correction de comportement a un test, sauf mention contraire. Vérifié : `nx run-many -t typecheck lint test` sur tout le workspace, et la suite de rendu sur Dawn, Vulkan (lavapipe), Direct3D 12 (WARP) et WebGL2 (448/448). Les workflows GitHub ne sont validés que par leur syntaxe, en attendant le premier run._

| Section                          | Statut | Ce qui a été fait                                                                                                                                                                                                                                                                                                                                   | Ce qui reste                                                                                                 |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| §1.2 Programmes HLSL/GLSL        | 🟢     | Pool de `availableParallelism()` tâches, un répertoire par programme, spirv-val et spirv-cross côte à côte, cache par `shaderKey`, programmes enregistrés depuis `dawn.spec.ts` (plus de deuxième suite Dawn). HLSL 13,1 s → 4,3 s, GLSL 5,2 s → 1,3 s. Masque des timestamps et borne par le temps mur dans `WebGpuPassTimer`.                     | —                                                                                                            |
| §1.3 Fumée                       | 🟢     | Boucles en index entiers, scratch préalloués, deux tampons de pression ; résultats identiques au bit près ; ×5,5 à ×7,6 ; timeouts de 30 s retirés.                                                                                                                                                                                                 | —                                                                                                            |
| §1.4 Layout de l'éditeur         | 🟢     | `stats` envoyé dès la première image à la nouvelle taille, `ResizeObserver` dans `useViewportBounds` ; le test attend la largeur dans la barre d'état.                                                                                                                                                                                              | —                                                                                                            |
| §1.5 Graph du jeu dans la doc    | 🟢     | `?level=minimal` (terrain sans forêt, un orc, sans les 15 Mo de plantes) ; test de 42 s à 6-9 s, `test.slow()` retiré ; `workers: 1` pour WebGPU.                                                                                                                                                                                                   | Timeouts des captures gardés, faute de mesure sur un runner à 4 vCPU.                                        |
| §1.6 Parallélisme en CI          | 🟢     | `--parallel=1` pour les projets `gpu`, `maxWorkers: 2`, rapports JUnit, budget de durée (`tools/ci/durations.mjs` : échec au-delà de +50 % et +1 s par rapport à la médiane de `main`, base dans le cache d'Actions de `main`).                                                                                                                     | —                                                                                                            |
| §1.1 Timeouts                    | 🟢     | `testTimeout: 30_000` global de tests/rendering retiré (5 s par défaut) ; un timeout par test lent, justifié par sa durée mesurée en commentaire.                                                                                                                                                                                                   | —                                                                                                            |
| §1.7 Tests jamais joués          | 🟢     | engine-resources-native et engine-input-native tagués `gpu`, avec `dependsOn` ; suite `native` dans `FDW_REQUIRE_SUITES`.                                                                                                                                                                                                                           | engine-audio-native a le même `skipIf`.                                                                      |
| §2.1 Lint, README                | 🟢     | `.eslintrc.json` migrés en `eslint.config.mjs`, dépendances déclarées ; `NX_WORKSPACE_ROOT_PATH` documenté ; lint d'apps/editor corrigé (dépendances installées à part, inconnues de Nx).                                                                                                                                                           | —                                                                                                            |
| §2.2 Cibles Nx                   | 🟢     | `outputs` et `inputs` de `build-native` complétés, échec sans SDK, variables d'environnement en inputs, `**/*.node`, `maxCacheSize: 1GB`.                                                                                                                                                                                                           | —                                                                                                            |
| §2.3 Workflows                   | 🟢     | Cache Nx par `main`, filtres de chemins, `addons.yml` après une CI verte avec smoke test et `sha256`, `install-deps` séparé, actions épinglées par SHA, `design/ci.md` aligné ; **`Windows` est un statut exigé** (à activer dans le ruleset de `main`).                                                                                            | sccache (il faudrait le générateur Ninja). Le hash des prébuilts change : republier.                         |
| §3.1 engine-webgpu               | 🟢     | Textures 3D, format validé avant création, `checkBufferWrite` commun (plus de padding destructif), `device.lost` et `uncapturederror`, course `destroy`/`init`, surface en pause, assertion de la ligne de la table d'objets.                                                                                                                       | —                                                                                                            |
| §3.2 engine-webgl2               | 🟢     | `destroy()` dans le contrat des pipelines (VAO, programmes comptés), contexte perdu ou restauré, tests sur un GL simulé.                                                                                                                                                                                                                            | `readback.ts` et `shader/storage.ts` sans test unitaire.                                                     |
| §3.3 engine-core                 | 🟢     | `Renderer.destroy()` libère meshes, uniforms, sampler et pipelines ; vues suivies qui incrémentent la version ; cutoffs bornés et documentés.                                                                                                                                                                                                       | —                                                                                                            |
| §3.4 engine-backend              | 🟢     | Environ 1 750 lignes de code mort supprimées ; normal matrix commune ; wgpu-matrix corrigé et testé ; `writeUniform` commun.                                                                                                                                                                                                                        | —                                                                                                            |
| §3.5 engine-shader, engine-graph | 🟢     | `codegen/naming.ts` commun, `__` refusé ; tests de `optimize` et `generateIr` ; `topologicalOrder` en O(n).                                                                                                                                                                                                                                         | —                                                                                                            |
| §4.1 engine-vulkan               | 🟢     | Hazard RAW (testé avec la validation de synchronisation), swapchain par id (testé), taille demandée, `outdated`, état remis à zéro par passe, `depth24plus-stencil8`, arguments DXC, `pendingWaits`. TLAS : BLAS gardés en vie, allocation avant libération. Bornes des requêtes sans débordement.                                                  | —                                                                                                            |
| §4.2 engine-d3d12                | 🟢     | `Close()` en échec (testé par un hook de test), segfault DXC, swapchain par id (testé), bornes du replay, copies par plan, TLAS (testé), `Signal` → contexte perdu (testé), `dxil.dll`, bornes des requêtes.                                                                                                                                        | —                                                                                                            |
| §4.3 Cache de shaders            | 🟢     | En-tête, SHA-256 et magic vérifiés, recompilation sur une entrée invalide, `dxil.dll` dans la clé, un sous-répertoire par version de DXC ; éviction LRU sur la taille (512 Mio par défaut, `FDW_SHADER_CACHE_MAX_SIZE`), documentée.                                                                                                                | —                                                                                                            |
| §4.4 N-API                       | 🟢     | Type tags des fenêtres, entrées copiées avant le pool libuv, chemins d'erreur et `malloc`.                                                                                                                                                                                                                                                          | —                                                                                                            |
| §5 Simulation et runtime         | 🟢     | Toutes les lignes, dont : physique (`moved`, `addCharacter`, `teleport`, capteurs), océan (NaN, résolution, phases), BVH, comportements, animation, skinning, entrées, audio, caméra, `frontFace` des instances miroirs (CPU, WebGPU, Vulkan et D3D12) ; allocations des boucles chaudes (fbm ×2, résultats identiques) ; duplications factorisées. | `buffers.ts` et `bodies.ts` des fluides allouent encore quelques objets par image.                           |
| §6 Assets et ressources          | 🟢     | Toutes les lignes, avec un corpus d'entrées malformées généré dans les tests ; limites d'allocation glTF (256 Mio par accessor, 2 Gio par fichier, options et `FDW_GLTF_MAX_*`), documentées.                                                                                                                                                       | —                                                                                                            |
| §7.1 Édition                     | 🟢     | `GraphClient.save` par id, listeners de pointeur, ordre des frères, `ReparentCommand` atomique, `History.seal()`, transactions, `EditingTools.dispose()`, `redoLabels[0]`, plugins `failed`.                                                                                                                                                        | `acceptsBehaviorType` reste copié, avec un test d'équivalence.                                               |
| §7.2 Electron                    | 🟢     | Navigation et fenêtres limitées aux pages de l'app, permissions refusées (sauf l'écriture du presse-papier), `senderFrame` vérifié, listener retiré, fuses.                                                                                                                                                                                         | Fuses non vérifiées par un packaging ; tests e2e à jouer hors sandbox.                                       |
| §7.3 Démo                        | 🟢     | Routes annulables, `.catch`, surface libérée, ressources des routes WebGPU, course du moteur, `ResizeObserver`, meshes des scènes.                                                                                                                                                                                                                  | —                                                                                                            |
| §8 Hygiène                       | 🟢     | `*.tsbuildinfo` ignorés, `/assets` ancré, estoc sous `assets/`, dépendances nettoyées ou déclarées, `paths` retirés ; `.obj`/`.mtl` en LFS.                                                                                                                                                                                                         | Les 95 Mo de `Mustang.obj` restent dans l'historique (`git lfs migrate` et force push, à décider en équipe). |

**Constats découverts pendant les corrections :**

- 🟢 TLAS de Vulkan et TLAS logiciel de WebGPU : un BLAS détruit restait utilisé par le TLAS (`VK_ERROR_DEVICE_LOST`, faux impacts). Corrigé, testé sur les trois backends.
- 🟢 Requêtes D3D12 et Vulkan : `first + count` débordait (écriture hors bornes avec `first = 0xFFFFFFFF`). Corrigé, testé.
- 🟢 Test des matériaux masqués : en mode `any`, le rayon sur la moitié gardée de la feuille croise aussi le sol, et WARP peut renvoyer l'un ou l'autre. L'assertion accepte les deux.
- 🟢 Docs, « the material of the tutorial, edited live » sur WebGPU : sous Windows, les flags Chromium de Playwright ne donnaient pas d'adaptateur WebGPU (ANGLE sur SwiftShader n'a pas de device D3D11), l'éditeur passait sur WebGL2 et le test ne le voyait pas. Flags propres à Windows (`--use-angle=d3d11-warp`) ; le test échoue maintenant sur un repli.
- 🟢 engine-vulkan : une texture qui n'a que des usages de copie n'a plus de vue (`VUID-VkImageViewCreateInfo-image-04441`) ; après un submit en échec, les layouts des textures sont restaurés et le command buffer de transfert recréé. Testés avec la couche de validation.
- 🟢 Docs : les pages d'accueil des modules de l'API manquaient (starlight-typedoc les supprime sans option `readme`), 74 liens cassés ; `check-links.mjs` ignorait les pages de l'API sous Linux seulement. Corrigé.
- 🟢 Tests instables sous la charge : `ShaderCache.spec.ts` (une éviction en arrière-plan), `engine-resources-web` (des `sleep` fixes), `EditorShell.spec.tsx` (le menu qui se ferme cache encore la page). Ils attendent maintenant un état, plus une durée.
- 🟢 editor-ui : un outil ou un mode dont le plugin finit de charger après la fermeture de l'éditeur pilotait une machine disparue (« No service editor.machine », rejet non attrapé). Ignoré une fois l'éditeur fermé, testé.
