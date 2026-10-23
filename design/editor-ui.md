# L'éditeur : l'interface

Le design de l'interface de l'éditeur, pour la phase P18 de la [roadmap](roadmap.md#p18-léditeur--electron-et-web) : le layout, les composants, les plugins, et les deux hôtes (Electron et web) qui partagent la même interface. L'état et les services sont dans [editor-state.md](editor-state.md) ; les deux documents seront fusionnés une fois le socle fait.

Contraintes :

- Une base extensible par plugins, pas un outil figé : les panneaux de l'éditeur sont eux-mêmes des plugins.
- L'organisation d'une QMainWindow : menu bar, status bar, docks latéraux, toolbars sur les quatre côtés, et une zone centrale découpable comme les groupes d'éditeurs de VS Code.
- **Une seule interface** pour l'application de bureau (Electron, rendu natif) et la version web (rendu dans un canvas).
- Des dépendances compatibles avec un usage commercial.

## 1. Les choix

| Question            | Choix                                                                                                                                                                               | Écartés, et pourquoi                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Les dock panels     | **[dockview](https://dockview.dev/)** (`dockview-react`, MIT) : onglets, groupes, drag & drop, flottants, popouts, `toJSON` / `fromJSON`, thèmes par variables CSS, sans dépendance | [FlexLayout](https://github.com/caplin/FlexLayout) : ses borders collent au besoin, mais l'API est plus rigide et les popouts moins aboutis ; [rc-dock](https://github.com/ticlo/rc-dock) : peu actif |
| Le squelette        | **Des instances de dockview imbriquées** dans un `GridviewReact` (§3)                                                                                                               | Une seule instance avec des groupes autour du centre : le drag est fluide partout, mais il faut verrouiller des groupes et filtrer les drops pour retrouver la rigidité de QMainWindow                |
| Les composants      | **shadcn/ui** sur Tailwind 4 (déjà utilisé par la doc), resserrés pour un éditeur                                                                                                   | Une bibliothèque fermée (MUI, Mantine) : plus lourde, moins facile à densifier, thème à double emploi avec celui de dockview                                                                          |
| Les plugins         | **Le modèle de VS Code** : un manifeste déclaratif (contribution points) et du code chargé à la demande (§5)                                                                        | Des plugins qui modifient l'application : pas de contrat, cassés à chaque version                                                                                                                     |
| Electron et web     | **Un package d'interface partagé**, `@fdw/editor-ui`, et deux applications minces qui fournissent un `EditorHost` (§2)                                                              | Une seule application avec des `if (electron)` : la plateforme fuit partout ; l'éditeur web servi dans Electron : perd le rendu natif                                                                 |
| Le backend de rendu | **La variable `FDW_BACKEND`**, avec un repli quand le backend demandé ne démarre pas (§4)                                                                                           | Un choix dans l'interface : changer de backend recrée le moteur, et l'éditeur n'en a pas besoin en cours de session                                                                                   |

Licence : MIT autorise l'usage dans une application propriétaire ; il faut garder la mention de copyright et la licence dans la distribution (un fichier de licences tierces ou l'écran « À propos »). Avant de distribuer : vérifier le `LICENSE` de la version installée et auditer l'arbre (`license-checker`).

## 2. Deux hôtes, une interface

```
packages/editor-ui      le shell React, dockview, shadcn, les registres, les stores, les plugins built-in
        ▲                 ne connaît ni Electron ni le DOM du moteur : il parle à un EditorHost
        │
apps/editor             Electron : le processus principal, le processus du moteur, l'addon X11
apps/editor-web         Vite : une page, le moteur dans la page, un canvas
```

`@fdw/editor-ui` exporte `<EditorShell host={…} />`. Chaque application crée son `EditorHost` et le passe au shell ; le shell l'enregistre dans le registre de services ([editor-state.md §5](editor-state.md#5-le-registre-de-services)). Ce que l'hôte fournit :

| Service                 | Electron (`apps/editor`)                                                        | Web (`apps/editor-web`)                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Le moteur               | Un processus utilitaire, joint par le `MessagePort` actuel                      | Dans la page, joint par un `MessageChannel` : le même protocole ; dans un worker plus tard     |
| Le viewport             | La zone réservée par React, mesurée, une fenêtre X11 enfant au-dessus (fait)    | Un `<canvas>` dans la même zone, à la taille de la zone                                        |
| Les entrées             | `WebInputSource` sur l'élément de la page, rejoué dans le moteur (fait)         | `WebInputSource` sur l'élément du canvas, sans relais (fait)                                   |
| Les fichiers du projet  | `engine-resources-native` dans le processus du moteur, les dialogues d'Electron | `engine-resources-web` ; File System Access API (Chromium), sinon import et export de fichiers |
| La persistance (layout) | Un fichier JSON dans `userData`, et dans le projet                              | IndexedDB, et dans le projet                                                                   |
| Les popouts             | `window.open` autorisé par `setWindowOpenHandler`                               | `window.open`, soumis au bloqueur de fenêtres                                                  |
| Les plugins             | `import()` de modules ES depuis le disque                                       | `import()` de modules ES depuis une URL                                                        |

**Le protocole du moteur est le contrat.** Les messages de `apps/editor/src/shared/protocol.ts` (bornes, scène, entrées, statistiques) passent dans `@fdw/editor-ui` ; le côté moteur (`apps/editor/src/engine`) devient un module qui tourne aussi bien dans le processus utilitaire que dans la page. Le shell ne tient jamais d'objet du moteur, seulement une connexion : c'est déjà le cas dans Electron, où le moteur est dans un autre processus, et la version web garde ainsi le même code. Le moteur web passera dans un worker (`OffscreenCanvas`, possible en WebGPU comme en WebGL2) quand l'audio y sera résolu : `AudioContext` n'existe pas dans un worker.

Le reste du shell est identique : la menu bar est un composant de la page dans les deux hôtes (pas de menu natif d'Electron), ce qui garde les contributions des plugins au même endroit.

## 3. Le layout façon QMainWindow

Un squelette à zones fixes autour d'une zone centrale libre :

```
┌──────────────────────────── menu bar ────────────────────────────┐
├──────────────────────────── toolbar haut ────────────────────────┤
│ tb │ dock gauche │      zone centrale (DockviewReact)     │ dock │ tb │
│    │ (Paneview)  │  viewports, éditeurs de graphs, scripts │ droit│    │
│    │             ├─────────────────────────────────────────┤      │    │
│    │             │        dock bas (console, ressources)    │      │    │
├──────────────────────────── toolbar bas ─────────────────────────┤
└──────────────────────────── status bar ──────────────────────────┘
```

- **La zone centrale** est un `DockviewReact` complet : groupes découpables, onglets déplaçables, popouts.
- **Chaque dock** est un petit `DockviewReact`, un `PaneviewReact` (sections repliables empilées, comme l'explorateur de VS Code) ou un simple panneau.
- **La menu bar et la status bar** sont des composants fixes, remplis par les registres.
- **Les toolbars** sont des composants ordinaires, hors de dockview : leur côté et leur visibilité vivent dans le store de l'éditeur.

La persistance : le store de l'éditeur garde la visibilité des docks, des toolbars (avec leur côté), de la menu bar et de la status bar ; chaque instance de dockview donne son `toJSON()` ; le tout forme un seul document de layout, enregistré par l'hôte (§2).

**Le viewport natif** (Electron) : la fenêtre X11 enfant est posée au-dessus de la zone ; elle ne peut rien avoir par-dessus. Les menus, les infobulles et les panneaux flottants de dockview qui débordent sur le viewport seraient donc cachés par lui. _Tranché à l'étape 10_ : **une région de forme**. La page envoie au moteur, à chaque frame où ils changent, les rectangles de ce qui passe au-dessus du viewport (les popups de Radix, les groupes flottants, les menus et les cibles de drop de dockview, les éléments marqués `data-over-viewport`) ; l'addon les retire de la région de la fenêtre (Shape, `ShapeBounding`, comme la région d'entrée), et la page se voit à travers. Le viewport figé, écarté : une image à relire et à afficher à chaque menu. La version web n'a pas ce problème.

**Le viewport toujours monté** : les panneaux de dockview ont le rendu `always` (vérifié dans la version 8) : leur contenu vit dans un calque à la racine de l'instance, placé sur leur groupe, et un onglet caché l'est par `visibility: hidden`, sa boîte restant en place. Le viewport lit donc sa visibilité (`checkVisibility`) en plus de ses bornes, à chaque frame : caché, il envoie une zone vide, et le moteur ne dessine plus.

## 4. Le choix du backend

Le backend est choisi au démarrage par **`FDW_BACKEND`**, le même nom pour les deux hôtes :

| Hôte     | Valeurs            | Sans la variable | Repli                                                                                                   |
| -------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------- |
| Web      | `webgpu`, `webgl2` | `webgpu`         | **WebGL2** : pas de `navigator.gpu`, `requestAdapter()` sans adaptateur, ou échec de création du device |
| Electron | `vulkan`, `dawn`   | `vulkan`         | **Dawn** : addon Vulkan absent, pas d'ICD ou de device adapté, échec de création de la swapchain        |

- **Une valeur inconnue** donne un avertissement et le repli.
- **Le backend actif** (et le repli éventuel, avec sa raison) est envoyé par le moteur dans le message `ready`, affiché dans la status bar et exposé en context key (`engine.backend`) pour les clauses `when` : un panneau propre à Vulkan peut ne s'afficher qu'avec lui.
- **Web** : la variable est lue à la construction et au serveur de développement (`envPrefix` de Vite étendu à `FDW_`), le repli se fait à l'exécution. `FDW_BACKEND=webgl2 npx nx run editor-web:dev`.
- **Electron** : la variable est lue par le processus principal et transmise au processus du moteur, qui fait le repli. `FDW_BACKEND=dawn npx nx run editor:dev`. Dawn tourne dans **un processus Node à part**, lancé par le processus du moteur, qui lui relaie les messages de la page par l'IPC de Node : le V8 d'Electron refuse les `ArrayBuffer` externes que `dawn.node` crée à chaque `getMappedRange` (les uploads du moteur comme la relecture des images). Il faut donc un Node 24 à côté d'Electron (`FDW_NODE`), à embarquer à la distribution (P11).
- **D'autres backends** (Direct3D 12, Metal) s'ajouteront comme d'autres valeurs, avec leur repli propre à la plateforme.
- **Dawn dans le viewport** : `dawn.node` ne présente pas dans une fenêtre ([native-backends.md](native-backends.md)) ; comme `DawnWindowSurface`, il rend dans une texture relue, que l'addon de l'éditeur copie dans la fenêtre enfant (`XShmPutImage`). Environ 500 Mo/s en 1080p à 60 Hz : un repli qui marche, pas le chemin normal, d'où Vulkan par défaut. Sans copie avec N5.

## 5. Shadcn/ui

dockview fait le layout, shadcn/ui les composants dans les panneaux.

- **Le thème** : les variables CSS de dockview pointent sur celles de shadcn (`--background`, `--border`, `--muted`) : un seul réglage pour le mode sombre.
- **Les panneaux** : `Input`, `Slider`, `Select`, `Tabs`, `Tooltip`, `ScrollArea` pour l'inspecteur, l'outliner, les réglages ; `ContextMenu` et `Command` (la palette de commandes) ; un arbre maison pour la scène.
- **Les en-têtes** : onglets et actions d'en-tête de dockview faits de boutons shadcn (points d'extension à vérifier dans la version installée).
- **La densité** : shadcn est aéré pour un éditeur ; tailles et paddings réduits (`size="sm"`, tokens ajustés).
- **Les popouts** : les portals de Radix visent le `document.body` de la fenêtre principale ; dans une popout, il faut un `container` propre à la fenêtre et les styles de Tailwind copiés dans son document.
- **Le preflight de Tailwind** peut toucher aux boutons et aux onglets de dockview : quelques overrides.

## 6. Les plugins

Le modèle de VS Code : un manifeste déclaratif et du code chargé à la demande. L'application n'a pas d'interface en dur, elle lit des registres que les plugins remplissent. L'outliner, l'inspecteur, le viewport et la console sont des plugins built-in : ils servent de test à l'API.

```json
{
  "id": "acme.material-editor",
  "version": "1.0.0",
  "engine": "^1.0.0",
  "main": "./dist/index.js",
  "activationEvents": ["onView:acme.materials", "onCommand:acme.newMaterial"],
  "contributes": {
    "views": [
      {
        "id": "acme.materials",
        "title": "Matériaux",
        "icon": "palette",
        "location": "left",
        "when": "scene.hasSelection"
      }
    ],
    "commands": [{ "id": "acme.newMaterial", "title": "Nouveau matériau" }],
    "toolbars": [
      { "id": "acme.tools", "side": "top", "items": ["acme.newMaterial"] }
    ],
    "menus": {
      "scene.context": [{ "command": "acme.newMaterial", "group": "create" }]
    },
    "keybindings": [{ "command": "acme.newMaterial", "key": "ctrl+shift+m" }],
    "inspectors": [
      { "forType": "Material", "component": "acme.MaterialInspector" }
    ]
  }
}
```

**Les points d'extension :**

- **views** : un panneau, son emplacement par défaut (`left`, `right`, `bottom`, `center` : les zones du squelette), son icône.
- **commands** : le cœur du système ; menus, toolbars, raccourcis et palette ne référencent que des identifiants de commandes.
- **menus, toolbars** (avec un côté), **status bar, keybindings** : déclaratifs, avec une clause `when` sur les context keys (sélection, mode, type de l'objet actif, backend).
- **inspectors, editors** : un composant pour un type d'objet ou de ressource du moteur.
- **settings** : un JSON Schema, d'où les formulaires de préférences.
- **tools, modes** : des sous-machines ([editor-state.md §3](editor-state.md#3-la-machine-de-léditeur)).
- **Plus tard**, propres au moteur : thèmes, importeurs et exporteurs, gizmos, outils du viewport.

**Côté application :**

- **Les registres** (`ViewRegistry`, `CommandRegistry`, `MenuRegistry`) : le shell ne lit qu'eux, le squelette dockview crée ses panneaux à partir d'eux.
- **Les context keys et `when`** : un petit évaluateur d'expressions ; toute l'interface conditionnelle reste déclarative.
- **L'activation paresseuse** : le code d'un plugin est chargé au premier événement d'activation (une vue ouverte, une commande, un type de fichier).
- **L'API** : `activate(ctx)` reçoit `ctx.commands.register`, `ctx.views.registerComponent`, `ctx.services`, `ctx.state`, `ctx.subscriptions` ; chaque enregistrement rend un `dispose()`.
- **Les dépendances partagées** : React, shadcn et le design system sont fournis par l'hôte (`@fdw/editor-ui`, en externe par une import map), pour qu'un plugin n'embarque pas sa propre copie de React.

_Fait à l'étape 12_ (le détail est dans [packages/editor-ui/README.md](../packages/editor-ui/README.md#the-plugins)) :

- **Le manifeste** est vérifié à l'enregistrement (`readManifest`) ; `engine` est une plage de la version de l'API (`editorApiVersion`, `1.0.0`). Un manifeste invalide, ou une contribution dont l'identifiant est pris, rend le plugin `invalid`, sans contributions. Les points d'extension faits : `commands` (`enablement`, `toggled`, `palette`), `views`, `menus`, `toolbars`, `statusBar`, `keybindings`, `tools`, `modes`. `inspectors`, `editors` et `settings` attendent ce qu'ils décrivent (l'inspecteur à l'étape 13).
- **Les menus** : des menus par identifiant, `menubar` pour la menu bar, dont les éléments sont des sous-menus ; les éléments triés par groupe puis par ordre, séparés par groupe, chacun avec son `when`. Les éléments faits d'un registre (un par panneau, par scène, par côté de toolbar) sont ajoutés par le code du plugin (`ctx.menus.append`).
- **Les outils et les modes** sont aussi des commandes (`Tool: Mark`), qui activent leur plugin puis l'outil ; relancée, la commande le termine.
- **Les événements d'activation** : `onView:`, `onCommand:`, `onTool:`, `onMode:` sont déduits des contributions (comme VS Code depuis la 1.74) ; le manifeste n'ajoute que `onStartup`. Le code des plugins de `onStartup`, et de ceux des outils et du mode du snapshot gardé, est chargé avant le runtime : leur `activate` enregistre leurs outils avant que la machine ne se restaure. Un plugin lit donc la machine et les context keys à l'appel, pas dans `activate` (un avertissement le dit).
- **Les icônes** d'un manifeste sont des noms (`editorIcons`, de lucide) : connues sans le code du plugin, une toolbar s'affiche avant son activation.
- **Les raccourcis** : les lettres et les chiffres par leur place sur le clavier (`code`), le reste par son nom ; dans un champ de texte, seulement ceux avec ctrl, alt ou meta, et Échap ; le dernier enregistré dont la clause tient l'emporte. Échap (`editor.cancel`) termine les outils, laissé aux menus qui le traitent.
- **La palette** : cmdk (le `Command` de shadcn) dans un dialogue de Radix, Ctrl+Shift+P ou F1 ; son contenu est un trou du viewport natif, sans voile sombre (il ne voilerait pas le viewport natif).
- **Les built-in** : `fdw.workbench` (le menu View, les docks, la status bar, la palette, l'accueil, la liste des plugins), `fdw.viewport` (le viewport, le menu Scene), `fdw.outliner`, `fdw.inspector`, `fdw.console`.
- **Le plugin d'exemple** : `@fdw/editor-plugin-sample`, écrit comme un tiers (il n'importe que `@fdw/editor-ui`) : un outil dans l'emplacement `primary` (une machine qui compte des marques), un panneau, un menu, une toolbar, un élément de la status bar, deux raccourcis. Son code est un chunk à part, chargé au premier événement. Un layout et un snapshot qui le référencent se rechargent avec lui (l'outil actif, avec ses marques) et sans lui (le panneau « plugin manquant », l'outil sur `idle`, son état gardé).
- **Les plugins de l'application** sont, pour l'instant, dans son bundle (`EditorHost.plugins`) : le chargement depuis le disque ou une URL vient avec les plugins tiers et l'import map.

## 7. Les risques

| Risque                                                                     | Conséquence                                    | Parade                                                                                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Le viewport démonté par un changement d'onglet ou un déplacement de groupe | Le contexte GPU et les ressources perdus (web) | Le panneau toujours monté (rendu « always » de dockview, confirmé à l'étape 10) ; testé dans Chromium (onglets, docks cachés) |
| Des menus et des flottants sous le viewport natif                          | Interface cachée (Electron)                    | Une région de forme (§3), tranchée à l'étape 10                                                                               |
| La taille du canvas désynchronisée de la zone                              | Rendu déformé ou flou                          | `ResizeObserver`, en pixels physiques (déjà fait pour le viewport natif)                                                      |
| Des re-rendus de React à chaque frame                                      | Éditeur saccadé                                | Panneaux légers ; les valeurs par frame (FPS, transform en cours de drag) écrites dans le DOM directement                     |
| Un plugin avec sa propre copie de React                                    | Hooks cassés                                   | React fourni par l'hôte, déclaré en peer et en externe                                                                        |
| Un plugin tiers non fiable dans le renderer                                | Accès à tout ce que la page peut faire         | Selon la réponse à la question ouverte : process séparé ou worker, API limitée, permissions dans le manifeste                 |
| L'API de plugin qui change                                                 | Plugins cassés à chaque version                | API versionnée (`engine` du manifeste) et petite                                                                              |
| Un layout qui référence un plugin absent                                   | Erreur au chargement                           | Un panneau « plugin manquant » (fait à l'étape 12)                                                                            |
| Les popouts avec Radix                                                     | Menus et infobulles mal placés                 | Container de portal par fenêtre, styles copiés, testé tôt                                                                     |
| Les deux hôtes qui divergent                                               | Une fonction qui ne marche que dans l'un       | Tout le code commun dans `@fdw/editor-ui` ; les tests du shell avec un hôte factice ; l'éditeur web en CI dans Chromium       |

## 8. Les questions ouvertes

- ~~Les plugins tiers seront-ils non fiables (sandbox et permissions dès le départ) ou écrits par des utilisateurs de confiance ?~~ _De confiance à l'étape 12_ : ils tournent dans la page, avec ce qu'elle peut faire. Le sandbox et les permissions viendront avec les plugins tiers (« Ensuite » de P18), l'API restant petite pour le permettre.
- Le drag d'onglets entre instances de dockview est-il possible ? Sinon : accepter la limite, ou passer à une seule instance. dockview 8 a des « edge groups » (des docks sur les bords d'une seule instance, repliables) : écartés à l'étape 10 pour garder les instances imbriquées ; la piste reste si la limite gêne.
- Le layout : par projet, par utilisateur, ou les deux (un layout utilisateur, surchargé par le projet) ? _Par utilisateur à l'étape 12_ (le stockage de l'hôte) ; la surcharge par le projet se tranchera avec l'ouverture d'un niveau (étape 13).
- Un plugin qui agit sur le moteur : dans Electron, le moteur est dans un autre processus. Un plugin aura-t-il une partie « moteur », chargée dans le processus du moteur (ou dans la page sur le web), qui parle à sa partie « interface » par le protocole ? _Pas à l'étape 12_ : un plugin parle au moteur par la connexion (`IEngineConnection`) et le protocole, et modifie le document par les commandes (étape 13). La partie « moteur » se décidera avec les outils du viewport et les gizmos.
