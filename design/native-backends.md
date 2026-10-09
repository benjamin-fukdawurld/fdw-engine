# Phase 6 : backends natifs

Faire tourner le moteur hors du navigateur, dans une fenêtre native : d'abord en WebGPU (Dawn), puis avec un backend Vulkan dont les shaders sont écrits en HLSL et compilés en SPIR-V par DXC. Ce document complète le [§14.1 du material graph](material-graph.md#141-précisions-sur-la-phase-6), qui fixe les grandes lignes (Dawn d'abord, HLSL pour Vulkan) et laisse ouverte la question de l'hôte natif.

## Sommaire

1. [Résumé](#1-résumé)
2. [Le problème](#2-le-problème)
3. [But et intérêt](#3-but-et-intérêt)
4. [Ce que l'on a, ce qui manque](#4-ce-que-lon-a-ce-qui-manque)
5. [Alternatives pour l'hôte](#5-alternatives-pour-lhôte)
6. [Design : fenêtres et surfaces natives](#6-design--fenêtres-et-surfaces-natives)
7. [Design : HLSL](#7-design--hlsl)
8. [Design : backend Vulkan](#8-design--backend-vulkan)
9. [Coût](#9-coût)
10. [Plan d'implémentation](#10-plan-dimplémentation)
11. [Stratégie de test](#11-stratégie-de-test)
12. [Risques et questions](#12-risques-et-questions)

---

## 1. Résumé

- **L'hôte** : le moteur reste en TypeScript, exécuté par Node. Ce qui doit être natif l'est dans des **addons C++** (N-API), comme `dawn.node` l'est déjà pour WebGPU : une fenêtre SDL2, puis un backend Vulkan.
- **Étape 1, WebGPU natif** : `dawn.node` (le package `webgpu`) dans une fenêtre SDL2. `dawn.node` ne sait pas présenter dans une fenêtre : la première version **recopie** chaque image dans la fenêtre. C'est assez pour sortir `Surface` du navigateur, valider la boucle de rendu et les événements, et lancer les scènes de la démo dans une fenêtre.
- **Étape 2, HLSL** : un générateur `HlslCodegen` (TypeScript) et ses layouts, validés par DXC (HLSL → SPIR-V) et `spirv-val`, sans encore de backend qui les exécute.
- **Étape 3, Vulkan** : un addon C++ qui implémente une API proche de notre API abstraite (buffers, textures, pipelines à partir du SPIR-V, groupes de ressources, passes, barrières), et une couche TypeScript qui en fait un `RenderBackend`. La suite de rendu partagée passe sur Vulkan, et la démo s'affiche dans une fenêtre sans copie.
- **Ensuite, si besoin** : présentation sans copie pour Dawn, Direct3D 12 avec le même HLSL.

## 2. Le problème

Le moteur ne tourne que dans un navigateur : les surfaces sont des canvas, la boucle de rendu est `requestAnimationFrame`. Hors du navigateur, seul le rendu hors écran existe, avec Dawn, dans les tests.

Les cibles visées (CAO, BIM, jeux) ont souvent besoin d'applications de bureau : accès aux fichiers, gros volumes de données, intégration à des outils natifs. Ces applications ont aussi besoin de fonctions que WebGPU n'expose pas, ou pas encore : ray tracing, bindless, requêtes de pipeline.

L'API abstraite n'a été éprouvée que par deux backends web. Ses hypothèses sur la synchronisation, les surfaces et le cycle de vie des images ne sont pas validées : sur WebGPU et WebGL2, la synchronisation est implicite et la présentation automatique. `transition()` et `present()` existent dans l'API mais ne font rien d'utile aujourd'hui.

## 3. But et intérêt

| But                               | Intérêt                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fenêtre native                    | Applications de bureau ; démo et outils hors navigateur                                                                                  |
| Valider l'API abstraite           | La synchronisation explicite (transitions du render graph), les swapchains et `present()` servent enfin ; les écarts apparaissent tôt    |
| HLSL                              | Un langage pour Vulkan et Direct3D 12, et celui du ray tracing (DXR, `SPV_KHR_ray_tracing`) : la voie de l'[évolution §2](evolutions.md) |
| Performances et fonctions natives | Plus de limite du navigateur (taille des buffers, extensions, requêtes) ; base pour le bindless et le ray tracing                        |

## 4. Ce que l'on a, ce qui manque

**Ce que l'on a :**

- `engine-webgpu` tourne déjà sur Dawn hors du navigateur : `new WebGpuEngine({ gpu })` avec le `gpu` du package `webgpu`, et les surfaces hors écran (`WebGpuOffscreenSurface`) des tests de rendu.
- `Surface` est une interface : `init`, `getCurrentTarget`, `present`, `format`, `width`, `height`.
- Le render graph calcule les transitions entre usages (`CompiledRenderGraph.transitions`), et `GpuCommandEncoder.transition()` les reçoit.
- La génération de code passe par une IR commune : un générateur de plus ne touche ni aux graphes, ni au compilateur.

**Ce qui manque :**

- **Présenter dans une fenêtre avec Dawn hors navigateur.** Le README du package `webgpu` est explicite : pas de canvas, seulement le rendu dans des textures et leur relecture. Présenter sans copie demanderait de construire Dawn nous-mêmes, avec une liaison vers les surfaces natives.
- **Une fenêtre et ses événements** : création, redimensionnement, clavier, souris, fermeture, et une boucle de rendu sans `requestAnimationFrame`.
- **Le HLSL** : générateur, layouts (règles d'empaquetage des `cbuffer`), DXC.
- **Un accès à Vulkan depuis le runtime JavaScript.**

Sur la machine de développement, on a Linux, une NVIDIA RTX 2060 Super, Vulkan (`vulkaninfo`), SDL2, g++, clang et CMake. DXC n'y est pas (à installer), Deno non plus.

## 5. Alternatives pour l'hôte

| Hôte                                                                         | Intérêt                                                                                                                                  | Coût, limites                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Node + addons C++ (N-API)** (proposé)                                   | Le moteur reste tel quel ; même architecture que `dawn.node` ; un seul outillage natif (CMake, node-addon-api) pour la fenêtre et Vulkan | Du C++ à maintenir ; binaires par plateforme (compilés à l'installation, ou fournis précompilés) ; un appel N-API par commande (~50 à 100 ns : négligeable devant un draw)      |
| B. Construire Dawn avec des surfaces natives                                 | Dawn sans copie, dans la fenêtre                                                                                                         | Construire et suivre Dawn (dépôt, outils de Chromium, plus d'une heure de compilation) ; un fork de `dawn.node` à maintenir. Utile plus tard si Dawn natif doit être performant |
| C. Deno (WebGPU intégré, `Deno.UnsafeWindowSurface`, SDL2 par FFI)           | Fenêtre native sans copie, sans C++                                                                                                      | Ce n'est pas Dawn mais wgpu (Firefox) ; change de runtime (outillage Nx et Vitest à adapter) ; n'apporte rien pour Vulkan                                                       |
| D. Electron                                                                  | Fenêtre et WebGPU immédiats                                                                                                              | C'est Chrome : rien de natif n'est validé, rien pour Vulkan                                                                                                                     |
| E. Hôte natif (C++ ou Rust) qui embarque un moteur JavaScript, ou réécriture | Contrôle total                                                                                                                           | Disproportionné : tout le moteur est en TypeScript                                                                                                                              |
| F. Vulkan par FFI depuis TypeScript (koffi), sans addon                      | Pas de C++                                                                                                                               | L'API Vulkan est verbeuse (structures chaînées, pointeurs) : beaucoup d'appels FFI, coûteux et fragiles ; pas de VMA                                                            |

**Proposition : A.** Le moteur ne change pas d'hôte, et chaque partie native est un addon de taille raisonnable. Le backend Vulkan est un addon **à gros grain** : il expose des opérations du niveau de notre API abstraite (créer un pipeline, enregistrer une passe), pas l'API Vulkan elle-même. Les appels JavaScript → C++ restent peu nombreux par frame.

**Décision** : Electron est écarté (trop lourd, trop lent, rien de natif validé).

### 5.1 Comparatif : Node et addons, Deno, Dawn construit, hôte natif

Construire Dawn n'est pas un autre hôte : c'est une autre manière d'obtenir WebGPU dans une fenêtre, qui demande aussi un addon (un fork de `dawn.node`) ou une FFI. Les quatre options se comparent pourtant sur les mêmes critères.

| Critère                        | A. Node + addons C++                                                                | C. Deno                                                                                      | B. Dawn construit (dans Node)                                                   | E. Hôte natif                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| WebGPU dans une fenêtre        | Par copie (N1), sans copie avec B                                                   | **Sans copie, tout de suite** (`UnsafeWindowSurface`)                                        | **Sans copie**                                                                  | Selon ce qui est embarqué                                                                           |
| Implémentation de WebGPU       | Dawn (celle de Chrome, celle des tests)                                             | wgpu (celle de Firefox) : écarts de comportement, support dans Deno déjà retiré puis rétabli | Dawn, à la révision choisie                                                     | Dawn ou wgpu, liés en natif                                                                         |
| Vulkan, HLSL, ray tracing      | Addon C++ : contrôle total                                                          | Bibliothèque native appelée par FFI : même travail natif qu'en A                             | Rien : WebGPU n'a ni ray tracing ni bindless ; Vulkan reste à faire             | Contrôle total                                                                                      |
| Coût de départ                 | Moyen : outillage CMake + N-API                                                     | Faible pour WebGPU ; moyen pour Vulkan (même bibliothèque native qu'en A)                    | Élevé : Dawn et ses dépendances (plusieurs Go de sources, 30 à 60 min de build) | Très élevé : embarquer V8 et refaire ses liaisons, ou réécrire le moteur                            |
| Maintenance                    | Les addons                                                                          | Les bibliothèques natives ; suivre l'évolution de WebGPU dans Deno                           | Suivre Dawn (API C qui évolue), reconstruire par plateforme                     | Tout                                                                                                |
| Performance CPU                | V8 ; ~50 à 100 ns par appel N-API, négligeable avec des commandes groupées          | V8 ; FFI rapide                                                                              | Comme A                                                                         | Native ; mais un moteur JavaScript embarqué sans JIT (QuickJS) serait 10 à 30 fois plus lent que V8 |
| Outillage actuel (Nx, Vitest)  | **Inchangé**                                                                        | Deux runtimes (Vitest sous Deno est fragile) : tests sous Node, applications sous Deno       | Inchangé                                                                        | À reconstruire                                                                                      |
| Distribution d'une application | Node + fichiers `.node` ; exécutable unique avec les Single Executable Applications | `deno compile` : exécutable unique, simple                                                   | Comme A, binaires de Dawn en plus (dizaines de Mo)                              | Un binaire natif                                                                                    |
| Portabilité                    | CMake, Node-API à ABI stable (un binaire par plateforme, pas par version de Node)   | Bonne ; FFI identique partout                                                                | Dawn cible Vulkan, Metal, D3D12 : la meilleure couverture WebGPU                | Selon la pile choisie                                                                               |

**Lecture :**

- **Deno** est la voie la plus rapide vers WebGPU dans une fenêtre sans copie. Pour Vulkan, il n'économise rien : la partie native est la même, appelée par FFI au lieu de N-API. Il coûte en revanche un second runtime, et il change d'implémentation de WebGPU (wgpu au lieu de Dawn).
- **Construire Dawn** est le meilleur moyen d'avoir WebGPU natif partout (Metal sur macOS, D3D12 sur Windows), mais il n'avance pas l'objectif HLSL, Vulkan et ray tracing. C'est un complément de A, pas une alternative. Il vaut d'être fait si WebGPU natif sans copie devient nécessaire, par exemple sur macOS sans passer par MoltenVK.
- **L'hôte natif** n'a de sens que si le moteur quitte TypeScript. Ce serait une autre architecture, par exemple un cœur natif compilé aussi en WebAssembly pour le web. C'est hors de propos tant que le moteur est en TypeScript.

**Se garder les portes ouvertes** : les bibliothèques natives exposent une **API C** (`extern "C"`, des poignées opaques), et l'addon N-API n'en est qu'une fine couche de liaison. La même bibliothèque reste utilisable par la FFI de Deno ou de Bun, ou par un hôte natif, sans réécriture.

## 6. Design : fenêtres et surfaces natives

Un package **`engine-native`** (Node uniquement) :

- **`NativeWindow`** : une fenêtre SDL2 (titre, taille, plein écran), avec ses événements (redimensionnement, clavier, souris, fermeture) exposés comme des événements DOM (`EventTarget`), pour garder le style de la démo.
- **La boucle** : `runLoop(frame)` remplace `requestAnimationFrame`. Elle traite les événements SDL, appelle `frame(time)` et laisse respirer la boucle d'événements de Node (`setImmediate`), pour que les promesses (pipelines asynchrones, relectures) avancent. La cadence suit la synchronisation verticale quand le backend la fournit (swapchain Vulkan en FIFO).
- **L'addon** : SDL2 derrière quelques fonctions N-API (fenêtre, événements, poignée native de la fenêtre pour Vulkan, envoi d'une image pour la présentation par copie).

**Surfaces :**

- **`DawnWindowSurface`** (étape 1) : la scène est rendue dans une texture (comme la surface hors écran), copiée dans un buffer (`copyTextureToBuffer`), relue (`mapAsync`), puis envoyée à la fenêtre (texture SDL). Trois buffers tournent, pour que la relecture d'une frame ne bloque pas le rendu de la suivante : l'affichage a une ou deux frames de retard. En 1920 × 1080 RGBA8, cela fait 8 Mo par image, environ 500 Mo/s à 60 Hz : supportable pour valider et pour des outils, pas pour une application finale.
- **`VulkanWindowSurface`** (étape 3) : une swapchain sur la fenêtre (`SDL_Vulkan_CreateSurface`). `getCurrentTarget()` acquiert l'image, `present()` la présente : le `present()` de l'interface trouve son usage.
- **Redimensionnement** : `Surface` gagne `resize(width, height)` (ou suit la fenêtre), et le render graph recrée ses ressources de taille relative (il le fait déjà quand la taille change).

**Ce que deviendra N1 si Dawn est construit plus tard (B)** : presque tout reste.

- La fenêtre, ses événements, la boucle, le redimensionnement et la démo native servent tels quels, pour Vulkan aussi.
- Seule la présentation par copie (`DawnWindowSurface`, une à deux centaines de lignes) serait remplacée par une surface sans copie.
- Elle resterait d'ailleurs utile : captures d'écran, enregistrement vidéo, tests sans fenêtre.

### 6.1 Portabilité

Linux d'abord. Les backends natifs doivent se compiler et tourner ailleurs sans gros changements :

- **Build** : CMake ; addons Node-API (ABI stable), construits par `cmake-js`.
- **Dépendances vendorisées** (FetchContent ou sous-modules) plutôt que celles du système : SDL3 (la version actuelle de SDL : surfaces Vulkan et Metal, meilleure gestion du haut DPI), en-têtes Vulkan, volk (chargement de Vulkan), VMA.
- **Code natif** : C++20 standard, sans API propre à un système. Ce qui en dépend (poignées de fenêtre, chemins des bibliothèques) passe par SDL ou reste isolé dans un fichier par plateforme.
- **DXC** : versions officielles pour Linux et Windows ; le Vulkan SDK le fournit sur les trois plateformes.
- **macOS** : Vulkan par MoltenVK (portability subset). Dawn construit (B) donnerait Metal directement, si MoltenVK ne suffit pas.

## 7. Design : HLSL

Un **`HlslCodegen`**, à côté de `WgslCodegen` et `GlslEsCodegen`, qui produit du HLSL Shader Model 6 :

- **Un module** avec les entry points (`vs_main`, `ps_main`, `cs_main`), comme le WGSL.
- **Les ressources** : `cbuffer` pour les blocs d'uniforms, `Texture2D`, `SamplerState` et `SamplerComparisonState`, `StructuredBuffer` et `RWStructuredBuffer` pour les storage buffers. Les bindings Vulkan s'écrivent `[[vk::binding(b, set)]]`, ceux de Direct3D 12 `register(t0, space1)` : la `PhysicalLayoutStrategy` du backend les choisit.
- **Les matrices** : `#pragma pack_matrix(column_major)`, et `mul(m, v)` pour garder la convention du moteur.
- **Les layouts** : les `cbuffer` compilés pour Vulkan suivent par défaut le std140 assoupli de Vulkan. Les offsets sont vérifiés par réflexion du SPIR-V (SPIRV-Reflect ou spirv-cross) dans les tests, contre ceux de la `PhysicalLayoutStrategy`. C'est la même méthode que pour le mat3 en std140.
- **Les points délicats** : le `discard` après tout le corps (comme en GLSL), la boucle `loop-sum`, `SampleCmpLevelZero` pour les ombres, l'axe Y (voir §8), la profondeur [0, 1] (Vulkan et Direct3D l'utilisent déjà).
- **DXC** : le binaire officiel (`dxc -spirv -T vs_6_0 …`) en dépendance de développement pour les tests ; à l'exécution, l'addon Vulkan lie `libdxcompiler` et compile au moment de la création du pipeline. La précompilation des programmes reste pour la phase 7.

## 8. Design : backend Vulkan

**Un addon C++ (`engine-vulkan`), à gros grain**, et une couche TypeScript qui implémente `RenderBackend` en l'appelant :

- **Version** : Vulkan 1.3 au minimum, avec le dynamic rendering (pas d'objets `VkRenderPass` ni de framebuffers) et synchronization2 (décision : le moteur vise les GPU actuels et à venir). Les extensions plus récentes (descriptor buffers, ray tracing, mesh shaders) seront utilisées quand elles sont présentes, derrière des capacités.
- **Mémoire** : VMA (Vulkan Memory Allocator).
- **Ressources** :
  - les bind groups de l'API abstraite deviennent des descriptor sets alloués dans des pools ;
  - les layouts deviennent des `VkDescriptorSetLayout`, partagés comme aujourd'hui par leur clé ;
  - les pipelines sont créés à partir du SPIR-V que DXC produit du HLSL généré.
- **Commandes** : la couche TypeScript enregistre les commandes d'une frame dans une liste compacte. L'addon les rejoue dans un `VkCommandBuffer` au `submit`, ce qui fait un seul appel N-API par frame et non un par draw. C'est le modèle du backend WebGL2, qui rejoue déjà des commandes enregistrées.
- **Synchronisation** :
  - les transitions du render graph deviennent des barrières (`vkCmdPipelineBarrier2`) ;
  - les transitions initiales des ressources importées (l'image de la swapchain, de « non définie » à « attachment », puis vers « présentation ») sont à ajouter au render graph ([backlog §2](backlog.md#2-render-graph)) ;
  - les écritures de buffers (`buffer.write`) passent par des buffers de transfert, ordonnées avant les commandes de la frame, comme le garantit WebGPU ;
  - deux frames au plus sont en vol, avec une fence chacune.
- **Axe Y** : le clip space de Vulkan a son y vers le bas. On le corrige par un viewport de hauteur négative (Vulkan 1.1), sans toucher aux shaders ni aux matrices.
- **Validation** : les couches de validation de Vulkan sont activées en développement et dans les tests. Leurs messages font échouer les tests.

## 9. Coût

| Étape                     | Taille estimée | Ce qui coûte                                                                                                                                   |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| N1. Fenêtre et Dawn natif | Petite         | Premier addon (outillage CMake et N-API, intégration Nx), boucle de rendu, relecture en anneau                                                 |
| N2. HLSL                  | Moyenne        | Générateur complet (tous les cas de WGSL et GLSL), layouts, réflexion, DXC dans les tests                                                      |
| N3. Vulkan                | Grande         | L'addon (ressources, descriptors, pipelines, commandes, synchronisation, swapchain), la couche TypeScript, la mise au point avec la validation |

Le coût durable est le C++ à maintenir et à construire sur chaque plateforme. Il reste concentré dans deux addons, derrière des interfaces étroites.

## 10. Plan d'implémentation

| Étape                                        | Contenu                                                                                                                                                                             | Critère de fin                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **N1. Fenêtre native et WebGPU (Dawn)**      | Package `engine-native` : addon SDL3, `NativeWindow`, boucle, `DawnWindowSurface` (présentation par copie), redimensionnement ; une démo native qui lance les scènes de la démo web | Les scènes PBR et ombres s'affichent dans une fenêtre sous Linux ; redimensionnement et fermeture ; le rendu est égal à celui de la surface hors écran |
| **N2. HLSL**                                 | `HlslCodegen`, layout Vulkan, snapshots ; DXC et `spirv-val` dans les tests ; réflexion des offsets                                                                                 | Tous les programmes de la suite de rendu (surfaces, plein écran, calcul, ombres) compilent en SPIR-V valide, avec les offsets attendus                 |
| **N3. Vulkan hors écran**                    | Addon `engine-vulkan` : instance, device, VMA, buffers, textures, samplers, pipelines, descriptors, commandes, barrières ; couche `RenderBackend` ; surface hors écran              | La suite de rendu partagée passe sur Vulkan, sans erreur de validation                                                                                 |
| **N4. Vulkan dans une fenêtre**              | Swapchain, `present()`, transitions des ressources importées, frames en vol                                                                                                         | La démo native tourne sur Vulkan, sans copie, à la cadence de l'écran                                                                                  |
| N5. (plus tard) Dawn sans copie, Direct3D 12 | Selon les besoins                                                                                                                                                                   |                                                                                                                                                        |

_N1 fait._

- **`@fdw/engine-native`** :
  - la bibliothèque `fdw_window` (C++20, API C dans `native/include/fdw/window.h`) au-dessus de SDL3 3.2.0, récupéré et compilé par CMake (FetchContent) ;
  - l'addon `fdw_native.node`, une fine liaison Node-API écrite en C ;
  - `NativeWindow` (fenêtre et événements DOM : `close`, `resize`, clavier, pointeur, molette) ;
  - `runLoop` (la boucle hors navigateur, avec un `throttle`) ;
  - `DawnWindowSurface` (présentation par copie : texture, `copyTextureToBuffer`, `mapAsync`, affichage par la fenêtre, au plus deux images en vol) ;
  - `createDawnEngine`.
- **Construction** : `nx run engine-native:build-native` (`scripts/build.mjs`), en cache Nx, et dépendance des tests. Node-API ayant une ABI stable, les en-têtes de n'importe quelle installation de Node conviennent : le script les cherche à côté du Node courant puis dans le `PATH`.
- **Démos** : les scènes PBR et ombres sont sorties des routes React dans **`@fdw/demo-scenes`** (une scène se construit à partir d'un `RenderBackend` et d'une `Surface`). La démo web et **`apps/demo-native`** (`nx run demo-native:start -- shadows`, exécutée par jiti) les partagent.
- **Mesures** : sur la machine de développement (RTX 2060 Super, écran à 60 Hz), la démo native suit la cadence de l'écran en régime établi (900 images en 15,6 s, démarrage compris).
- **Tests** : la logique des fenêtres et de la boucle avec un faux addon ; une vraie fenêtre SDL3 cachée quand un écran est disponible ; l'image affichée par `DawnWindowSurface` égale à celle de la surface hors écran, le nombre d'images en vol borné, le suivi de la taille de la fenêtre.
- **Correction en route** : une relecture en cours quand le device est détruit (fermeture de la fenêtre) est abandonnée sans erreur.

Le redimensionnement interactif et la fermeture se vérifient à la main sur la démo native.

## 11. Stratégie de test

| Niveau          | Quoi                                                                                   | Outils                                                                                          |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Générateur HLSL | Code émis pour des IR fixes                                                            | Snapshots Vitest                                                                                |
| Validité        | Le HLSL compile en SPIR-V valide                                                       | DXC, `spirv-val` (Vulkan SDK ou paquets de la distribution)                                     |
| Layouts         | Offsets des `cbuffer` et des storage buffers                                           | Réflexion du SPIR-V, comparée à la `PhysicalLayoutStrategy`                                     |
| Rendu           | La suite partagée (`describeRenderer`) sur Vulkan hors écran, comme sur Dawn et WebGL2 | Vitest dans Node, avec la validation de Vulkan                                                  |
| Fenêtre         | Création, redimensionnement, boucle                                                    | Tests manuels sur la démo native ; un test minimal si un serveur X virtuel est disponible en CI |

## 12. Risques et questions

| Sujet                  | Risque                                                    | Réponse                                                                                                |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plateformes            | Construire les addons sous Windows et macOS               | Linux d'abord ; CMake et node-addon-api sont portables ; macOS passera par MoltenVK (Vulkan sur Metal) |
| Synchronisation Vulkan | Erreurs subtiles (barrières manquantes, écritures en vol) | Couches de validation, barrières déduites du render graph, deux frames en vol au plus                  |
| Layouts HLSL           | Règles d'empaquetage différentes de WGSL et std140        | Réflexion du SPIR-V dans les tests                                                                     |
| DXC                    | Dépendance lourde (binaire et bibliothèque)               | Binaire en dépendance de développement ; bibliothèque liée à l'addon ; précompilation en phase 7       |
| Présentation par copie | Latence et bande passante (étape 1)                       | Assumé comme étape de validation ; Vulkan (N4) et éventuellement Dawn sans copie (N5) la remplacent    |

**Décisions :**

- Electron est écarté.
- Linux d'abord, en gardant les backends natifs portables (§6.1).
- Vulkan 1.3 au minimum.
- N1 avec présentation par copie est acceptée ; ce qu'elle laisse si Dawn est construit plus tard est au §6.

**Question à trancher :** l'hôte (§5.1). La proposition est Node et addons C++, avec des bibliothèques natives à API C.
