# P11 : Windows d'abord

Le développement se fait maintenant sous Windows, mais la CI ne tourne que sous Linux, et le viewport natif de l'éditeur ne connaît que X11 ([roadmap, revue du 30 octobre](roadmap.md#2-vue-densemble)). Cette première partie de [P11](roadmap.md#p11-plateformes-et-distribution) couvre Windows : la CI, le viewport de l'éditeur, les addons précompilés, le démarrage. macOS et Wayland viendront ensuite.

## 1. Aujourd'hui

- **Les addons se construisent sous Windows** (MSVC, CMake) : `engine-native` (SDL en statique, la fenêtre, l'image, l'audio), `engine-vulkan`, `engine-d3d12`. Les swapchains Vulkan (`VK_KHR_win32_surface`) et Direct3D 12 prennent déjà un `NativeWindowHandle` de système `win32`. Dawn (`webgpu`) a son binaire `win32-x64`.
- **La CI** : deux jobs Linux ([ci.md](ci.md)). `native` construit les addons et lance les projets tagués `gpu` sur lavapipe, sous Xvfb. Rien ne vérifie Windows, ni Direct3D 12 : sa suite de rendu se saute hors de Windows.
- **Direct3D 12 refuse les adaptateurs logiciels** (`chooseAdapter` saute `DXGI_ADAPTER_FLAG_SOFTWARE`) : sans GPU, pas de WARP.
- **L'éditeur** : sa fenêtre de viewport (`apps/editor/native`) est une fenêtre X11 enfant, créée dans le processus du moteur ; le processus principal ne démarre le moteur que sous Linux. Sous Windows, l'éditeur s'ouvre sans vue 3D. Ses tests de bout en bout passent par `xprobe` (XTest, les pixels de l'écran X).
- **Les addons se construisent sur chaque poste** : CMake, un compilateur, le SDK Vulkan (DXC). Les paquets ne sont pas publiés ; chaque addon se charge depuis `build/` de son paquet, ou depuis une variable `FDW_*_ADDON`.
- **Le démarrage** : chaque programme est compilé par DXC à chaque lancement (HLSL vers SPIR-V ou DXIL), puis chaque pipeline par le pilote ; rien n'est gardé d'un lancement à l'autre.

## 2. La CI sous Windows

Un job **`windows`** dans `ci.yml`, en parallèle de `native`, sur `windows-2025` (gratuit : le dépôt est public, [ci.md §1](ci.md#1-le-coût)). Comme `native`, il ne lance que les projets tagués `gpu` touchés par le changement, et s'arrête en succès sinon : son statut peut être exigé pour fusionner.

|                      | Linux (`native`)                 | Windows (`windows`)                                                             |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| Compilateur          | GCC, ccache                      | MSVC (Visual Studio 2022 du runner), sans cache de compilation (§2.1)           |
| Vulkan               | lavapipe (`mesa-vulkan-drivers`) | lavapipe, par l'action `install-vulkan-sdk-action`                              |
| Direct3D 12          | —                                | WARP, le rastériseur logiciel de Windows                                        |
| Dawn                 | Vulkan (lavapipe)                | Direct3D 12 (WARP)                                                              |
| SDK Vulkan           | archive `tar.xz`, en cache       | la même action, avec le loader (le runner n'a pas de pilote GPU qui l'installe) |
| Fenêtres             | Xvfb                             | le bureau du runner (une session interactive)                                   |
| `FDW_REQUIRE_SUITES` | `vulkan,dawn,hlsl,glsl,window`   | `vulkan,d3d12,dawn,hlsl,glsl,window`                                            |
| Éditeur              | Electron, `xprobe`               | Electron, `winprobe` (§3.4)                                                     |

**Le SDK, le loader et lavapipe sous Windows** : l'action [`jakoch/install-vulkan-sdk-action`](https://github.com/jakoch/install-vulkan-sdk-action) installe le SDK de la version fixée, le loader Vulkan (`vulkan-1.dll`, qu'aucun pilote n'installe sur le runner) et lavapipe compilé pour Windows, le tout en cache. Le job désigne lavapipe au loader par `VK_DRIVER_FILES`. L'écrire à la main demanderait l'installateur silencieux du SDK, celui du runtime et une build de Mesa (mesa-dist-win) : trois téléchargements à tenir à jour. SwiftShader, l'autre Vulkan logiciel, demanderait de le compiler : écarté.

**WARP pour Direct3D 12** : une option `adapter: 'warp'` de `D3D12Engine` (et `FDW_D3D12_ADAPTER=warp`, que le job pose) prend `IDXGIFactory4::EnumWarpAdapter`. Sans GPU Direct3D 12, le moteur ne se rabat pas sur WARP de lui-même : un rendu logiciel par surprise ne se remarquerait pas.

**Le temps** : les runners Windows sont plus lents, et MSVC plus que GCC. Les builds des addons (`build/` de chaque paquet, avec les dépendances de FetchContent) sont en cache selon l'empreinte des sources natives, comme sous Linux ; un build incrémental de MSBuild sur un cache restauré suffit. sccache n'apporterait que sur un cache manquant : plus tard, si le job dépasse 30 minutes.

**Le job `check`** reste sous Linux : le TypeScript ne dépend pas du système, et les tests sans GPU tournent déjà sur les postes, sous Windows.

### 2.1 Les tests qui supposent Linux

Lancés sous Windows, les projets tagués `gpu` ont montré ce qui supposait Linux :

- **l'écran** : les tests de fenêtres demandaient `DISPLAY` ou `WAYLAND_DISPLAY` ; `hasDisplay()` de `@fdw/engine-backend/testing` répond oui sous Windows et macOS ;
- **les chemins** : `new URL(…).pathname` donne `/C:/…` sous Windows, et l'addon semblait absent (l'audio natif, le décodeur d'images sautés en silence) ; `glslangValidator` cherché sans `.exe` ;
- **WebGPU dans Chromium** : sous Windows, le _headless shell_ de Playwright n'a pas WebGPU, et SwiftShader par Vulkan, ou ANGLE sur SwiftShader, ne lui laissent pas d'adaptateur. L'éditeur web y tourne dans Chromium (son nouveau mode headless), WebGPU sur SwiftShader, WebGL2 sur WARP (`--use-angle=d3d11-warp`) ;
- **`xvfb-run`** : la cible `test` de l'éditeur de bureau ; elle passe par un script qui ne l'ajoute que sous Linux (§3.4).

Sous VS Code, Nx Console pose `NX_WORKSPACE_ROOT_PATH` avec un lecteur en minuscule (`c:\…`) : Vitest charge alors deux copies de lui-même et aucun test ne trouve son runner. Il faut un `C:` dans cette variable.

## 3. Le viewport de l'éditeur sous Windows

Le même contrat que sous X11 ([native-viewport](../apps/docs/src/content/docs/fr/editor/native-viewport.md)) : une fenêtre enfant de celle d'Electron, placée au-dessus de la zone du viewport, transparente aux entrées, percée de trous pour la page ; le moteur y présente avec sa swapchain, sans copie.

### 3.1 Qui possède la fenêtre

Sous Windows, une fenêtre appartient au **thread** qui l'a créée, et ce thread doit traiter ses messages. Une fenêtre enfant d'une fenêtre d'un autre processus **attache les files d'entrée** des deux threads : si le thread de l'enfant ne traite pas ses messages, l'interface d'Electron gèle.

| Qui crée la fenêtre                                   | Pour                                                                | Contre                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le processus principal d'Electron                     | Même processus que la fenêtre parente                               | Une swapchain sur la fenêtre d'un autre processus : non garanti par DXGI ni par les pilotes Vulkan ; un addon de plus dans le processus principal |
| Le thread JavaScript du moteur, comme sous X11        | Le plus simple                                                      | Une image longue (le chargement d'une scène, une compilation de programmes) gèle l'interface d'Electron : les files d'entrée sont attachées       |
| **Un thread de l'addon, dans le processus du moteur** | Ses messages toujours traités ; la swapchain dans le même processus | Les appels du thread JavaScript passent par des messages à ce thread                                                                              |

**Choix : un thread de l'addon.** `createViewport` démarre un thread qui crée la fenêtre et traite ses messages (`GetMessage`) jusqu'à `destroyViewport`. Le thread JavaScript le pilote par `SetWindowPos`, `SetWindowRgn` (sûrs d'un autre thread) et, pour le reste, des messages à lui (`SendMessage`). La swapchain, Vulkan ou Direct3D 12, se crée sur la fenêtre depuis le thread JavaScript : les deux le permettent dans le même processus ; les messages que DXGI envoie à la fenêtre (au redimensionnement) sont traités par son thread.

### 3.2 Transparente aux entrées

La roadmap prévoyait `HTTRANSPARENT` (la réponse à `WM_NCHITTEST`). Il ne suffit pas : `HTTRANSPARENT` ne fait passer la souris qu'aux fenêtres **du même thread** en dessous, et la page est dans le processus principal.

**Choix : une fenêtre désactivée** (`WS_DISABLED`). Windows saute une fenêtre enfant désactivée au hit-test : la souris va à sa parente, la fenêtre d'Electron, qui la donne à la page. Une fenêtre désactivée ne prend pas non plus le focus : le clavier reste à la page. `WS_EX_NOACTIVATE` en plus, et `HTTRANSPARENT` quand même, pour le cas où le hit-test l'interrogerait.

L'autre voie, `WS_EX_LAYERED | WS_EX_TRANSPARENT` (Windows 8 et plus pour une fenêtre enfant), rend la fenêtre transparente à la souris pour de bon ; mais une fenêtre _layered_ se compose par GDI, et une swapchain DXGI en mode _flip_ n'y présente pas. C'est le repli si une fenêtre désactivée se révélait insuffisante (§7).

### 3.3 Le reste du contrat

- **Les bornes** : en pixels physiques dans la zone cliente de la fenêtre d'Electron, ce que la page envoie déjà. Le thread de la fenêtre est _per-monitor DPI aware v2_, comme Chromium : pas de mise à l'échelle par Windows entre les deux.
- **Les trous** : `SetWindowRgn`, la fenêtre moins les rectangles, comme la région de forme sous X11.
- **Au-dessus de Chromium** : Chromium a des fenêtres enfants à lui (`Chrome_RenderWidgetHostHWND`, pour l'accessibilité). `pumpViewport` remet la fenêtre en tête de l'ordre de ses sœurs (`SetWindowPos(HWND_TOP)`) quand une autre y est passée.
- **Le repli sur Dawn** : `presentViewport` copie l'image relue par `SetDIBitsToDevice` (un DIB 32 bits, BGRA). Dawn tourne dans un processus Node à part, comme sous Linux ; la fenêtre y a aussi son thread.
- **Le handle** : `getNativeWindowHandle()` d'Electron donne le `HWND` (8 octets) ; `viewportWindow` rend `{ system: 'win32', display: HINSTANCE, window: HWND }`, ce que prennent les swapchains.
- **Le backend** : Vulkan par défaut, comme sous Linux, pour un seul chemin principal ; **`FDW_BACKEND=d3d12`** choisit Direct3D 12, sur la même fenêtre ; Dawn en repli. `ViewportSurface` prend une swapchain Vulkan ou Direct3D 12. Direct3D 12 par défaut sous Windows se décidera sur mesures (§6), une fois la suite de rendu complète sur les deux.

Le code X11 et le code Win32 restent deux fichiers de l'addon (`viewport_x11.cpp`, `viewport_win32.cpp`), la même API Node ; `X11Viewport` devient `NativeViewport`.

### 3.4 Les tests de bout en bout

`xprobe` donne les entrées (XTest) et lit les pixels de l'écran. Son pendant, **`winprobe`** : les mêmes commandes, par `SendInput` et une copie de l'écran (`BitBlt` du bureau, qui contient les fenêtres présentées par DXGI). Les deux outils deviennent des cibles du CMake de l'addon de l'éditeur, plutôt qu'un `cc` lancé par les tests. Les tests eux-mêmes ne changent pas.

## 4. Les addons précompilés

Installer et lancer l'éditeur sans CMake, ni compilateur, ni SDK Vulkan.

| Voie                                                                       | Pour                                                     | Contre                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| Paquets npm par plateforme (`@fdw/engine-vulkan-win32-x64`…, à la esbuild) | Le standard pour des paquets publiés                     | Les paquets ne sont pas publiés aujourd'hui ; un registre à tenir |
| `prebuildify` : les binaires dans le paquet                                | Un paquet pour toutes les plateformes                    | Même chose : suppose des paquets publiés                          |
| **Des releases GitHub, par empreinte des sources natives**                 | Rien à publier ailleurs ; gratuit ; marche dans le dépôt | Un script de téléchargement                                       |

**Choix : des releases GitHub.** Un workflow `addons.yml`, sur `main` quand les sources natives changent, construit les addons sous Linux et Windows (x64) et les attache à une release `addons-<empreinte>`, l'empreinte des sources natives de chaque paquet (celle qui sert déjà de clé de cache en CI). `tools/native/build-addon.mjs` cherche d'abord la release de l'empreinte courante et la télécharge dans `build/` ; il ne lance CMake qu'à défaut, ou avec `--from-source`. Le jour où les paquets seront publiés, les mêmes binaires iront dans des paquets par plateforme.

**Ce qui accompagne les addons** : DXC (`dxcompiler.dll` et `dxil.dll`, `libdxcompiler.so`), chargé aujourd'hui depuis le SDK Vulkan ou le système. Il est livré à côté des addons (sa licence, NCSA, le permet), et le chargeur le cherche d'abord à côté de l'addon. Le reste est déjà lié en statique (SDL, miniaudio, stb) ou fourni par le système (le loader Vulkan, Direct3D 12).

**L'application en un exécutable** : l'éditeur empaqueté par electron-builder, en exécutable portable Windows et en AppImage Linux, avec les addons et DXC. Le moteur a besoin des sources TypeScript de `packages/` : elles sont déjà rassemblées par le bundler du processus du moteur. Dernière étape de cette partie.

## 5. Le démarrage

Avant tout, **mesurer** : le temps jusqu'à la première image de l'éditeur (le niveau) et de `demo-native` (`tps`), sous Vulkan et Direct3D 12, à froid et à chaud, découpé en chargement des ressources, compilation DXC, création des pipelines par le pilote. L'ordre des trois mesures suivantes en dépendra.

1. **Un cache des programmes compilés** : le SPIR-V ou le DXIL, sur disque, sous la clé du HLSL, des arguments de DXC et de la version de DXC. Il retire DXC du démarrage à chaud. Dans `engine-backend`, commun aux deux backends natifs ; un dossier de cache donné par l'hôte (`userData` de l'éditeur, un dossier de l'utilisateur pour `demo-native`).
2. **Le cache des pipelines du pilote** : un `VkPipelineCache` lu au démarrage et écrit à l'arrêt (son en-tête désigne le fournisseur, le GPU et le pilote : un cache d'un autre GPU est ignoré) ; sous Direct3D 12, une `ID3D12PipelineLibrary`. Il retire la compilation du pilote.
3. **La précompilation** (la phase 7 du [material graph](material-graph.md)) : un outil qui compile hors ligne les programmes des scènes d'une application dans le cache du point 1, livré avec elle. Le premier lancement profite alors du cache.

Le WebGPU du navigateur garde son propre cache ; rien à faire pour lui.

## 6. Les étapes

1. **WARP** : l'option d'adaptateur de `D3D12Engine` ; la suite Direct3D 12 passe sur WARP, en local.
2. **Le job `windows`** : SDK Vulkan, lavapipe, WARP, les projets tagués `gpu` hors éditeur ; les tests qui supposent Linux corrigés (§2.1).
3. **Le viewport Win32** : l'addon (thread, fenêtre désactivée, trous, ordre), `NativeViewport`, le démarrage du moteur sous Windows, Direct3D 12 en option, le repli Dawn.
4. **`winprobe`** et les tests de l'éditeur sous Windows, en local puis dans le job `windows`. Les mesures de [native-viewport](../apps/docs/src/content/docs/fr/editor/native-viewport.md#ce-que-cela-coûte) refaites sous Windows, Vulkan et Direct3D 12.
5. **Les addons précompilés** : `addons.yml`, le téléchargement dans `build-addon.mjs`, DXC livré.
6. **Le démarrage** : la mesure, puis les caches dans l'ordre qu'elle donne, puis la précompilation.
7. **L'exécutable** de l'éditeur.

Chaque étape vient avec ses pages de documentation (EN, FR) : contribuer sous Windows, la CI, le viewport natif, l'installation sans compilateur.

## 7. Risques

- **La fenêtre désactivée** : si la souris ne passe pas à la page (un comportement de Chromium sur ses fenêtres enfants), repli sur un hook de la fenêtre parente, ou sur `WS_EX_LAYERED` avec une copie (la voie de Dawn). Vérifié en premier à l'étape 3, avant le reste.
- **lavapipe sous Windows** : un binaire tiers, par une action tierce. Si sa suite échoue là où celle de Linux passe, le job exige `d3d12` et `dawn`, et `vulkan` seulement sous Linux.
- **WARP et la suite Direct3D 12** : WARP a ses limites (le ray tracing en particulier : DXR 1.1 sur WARP dépend de la version de Windows). Les tests de rayons se sautent sans DXR, comme aujourd'hui sur un GPU sans.
- **Le bureau des runners Windows** : les tests de l'éditeur demandent une session interactive et une résolution suffisante ; à vérifier, sinon les tests de l'éditeur restent locaux sous Windows.
- **Le temps du job** : si les builds MSVC le portent au-delà de 30 minutes malgré le cache, sccache.

## 8. État (30 octobre 2026)

- **Fait** : WARP (étape 1 ; la suite Direct3D 12 passe entière sur WARP, rayons compris) ; le job `windows` (étape 2) ; le viewport Win32 (étape 3 : Vulkan, Direct3D 12 et Dawn y dessinent et suivent le redimensionnement) ; `winprobe` (étape 4) ; les addons précompilés (étape 5 : `addons.yml`, `tools/native/prebuilt.mjs`, DXC cherché à côté de l'addon).
- **Les addons dans Electron sous Windows** : liés à `node.exe`, ils ne s'y chargeaient pas. Ils le chargent maintenant tard, et un hook leur donne le processus hôte (`tools/native/win_delay_load_hook.c`, comme node-gyp).
- **À vérifier sur un vrai bureau** : les tests de bout en bout de l'éditeur sous Windows (les entrées passent-elles par la fenêtre désactivée, les trous découpent-ils une swapchain _flip_). Le job `windows` exclut l'éditeur jusque-là.
- **À vérifier au premier passage en CI** : l'action du SDK Vulkan (le loader, lavapipe, le chemin de son manifeste), Dawn sur WARP, le temps du job ; la première release des addons.
- **Connu** : sur une RTX locale, Dawn (Direct3D 12) donne parfois un temps GPU de passe aberrant (son timestamp de début figé) ; pas sur WARP.
- **Reste** : le démarrage (étape 6), l'exécutable (étape 7).
