# L'éditeur : l'état et les services

Le design de l'état de l'éditeur, pour la phase P18 de la [roadmap](roadmap.md#p18-léditeur--electron-et-web) : ses niveaux, la machine de l'éditeur et son extension par les plugins, les outils actifs en parallèle, le registre des services. L'interface est dans [editor-ui.md](editor-ui.md) ; les deux documents seront fusionnés une fois le socle fait.

Contraintes :

- Une partie de l'état est sérialisable (layout, préférences, sélection par identifiants), une partie ne l'est pas (la connexion au moteur, le viewport, les services des plugins), mais doit rester accessible partout.
- Les plugins étendent l'éditeur sans toucher à son cœur.
- Le même code dans les deux hôtes (Electron, web) : tout ce qui suit vit dans `@fdw/editor-ui`.

## 1. Les choix

| Question                  | Choix                                                                                                                           | Écartés, et pourquoi                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Les modes et interactions | **XState v5** : la machine de l'éditeur, le focus, les modes, les outils ; états exclusifs, régions parallèles, acteurs enfants | Des booléens dans un store : les combinaisons interdites ne se voient pas ; une machine maison : XState a déjà les acteurs, l'inspection, les snapshots                          |
| L'état sérialisable       | **`@xstate/store`** : un store par événements, pour le document et l'éditeur                                                    | Zustand : aussi simple, mais un second modèle à côté de XState ; Redux : trop de cérémonie                                                                                       |
| L'état non sérialisable   | **Un registre de services maison**, sur le modèle de VS Code (§5)                                                               | InversifyJS, tsyringe, TypeDI, awilix : ni portée par plugin, ni nettoyage à la désactivation, ni identifiants typés comme on les veut ; le registre fait une centaine de lignes |
| Les mutations du document | **Les commandes de P15** (`engine-editing`), seul chemin d'écriture                                                             | Des écritures directes dans le store : ni journal, ni annuler et refaire                                                                                                         |

_Vérifié à l'étape 11_ (XState 5.33, `@xstate/store` 4.3) :

- **Les implémentations** : `setup()` déclare les gardes et les actions nommées (avec leurs paramètres typés), `machine.provide()` les remplace par celles du runtime ; `provide` copie les implémentations, il n'y a donc pas de registre vivant derrière la machine.
- **Les acteurs enfants** : `invoke.src` est un nom ou une logique, jamais calculé à partir de l'événement. Un outil est donc créé par une action (`enqueueActions` et `spawnChild`), avec la logique prise dans le registre ; pour qu'XState accepte un identifiant d'enfant avec une logique en ligne, le setup déclare `actors` comme un `Record<string, AnyActorLogic>` vide.
- **La persistance** : XState ne persiste pas un enfant en ligne (une erreur dans sa version de développement) et ne restaure que les enfants dont la source est un nom de ses `actors`, sans erreur pour les autres. Le runtime persiste donc chaque enfant lui-même, avec l'identifiant de l'outil comme source, et le restaure avec la logique du registre : un outil absent se replie sur `idle` (§6).
- **Les transitions des régions parallèles** : une transition `reenter` posée sur une région (et non sur ses états) a pour domaine le premier ancêtre composé, au-dessus des états parallèles : elle sort de toutes les régions et y rentre. Les transitions des emplacements et du mode sont donc sur leurs états.
- **`@xstate/store`** : un store par événements (`trigger`), observable (`subscribe`, `select`), sans React (`useSyncExternalStore` suffit) ; il a une extension d'annulation (`@xstate/store/undo`, par événements ou par snapshots), que le document n'utilisera pas : l'annulation reste aux commandes de P15.

## 2. Les trois niveaux

| Niveau   | Contenu                                                                                                                                    | Sérialisable | Persistance                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------- |
| Document | La scène, les ressources, les métadonnées du projet                                                                                        | Oui          | Le fichier du projet (P16), avec annuler et refaire   |
| Éditeur  | Le layout, la visibilité des docks, des toolbars, de la menu bar et de la status bar ; la sélection ; les préférences ; l'état des plugins | Oui          | Le document de layout (par projet ou par utilisateur) |
| Runtime  | La connexion au moteur, le viewport, l'`EditorHost`, l'outil en cours de drag, les poignées de gizmo, les services des plugins             | Non          | Aucune : recréé au démarrage                          |

**Le store sérialisable ne tient que des identifiants** (l'objet sélectionné, la vue active), jamais une référence à un objet du moteur : il se sauvegarde, se restaure et s'inspecte. Le runtime n'est pas dans un store réactif : il vit dans le registre de services, accessible hors de React.

**L'interface ne tient jamais le moteur**, seulement une connexion ([editor-ui.md §2](editor-ui.md#2-deux-hôtes-une-interface)) : dans Electron, le moteur est dans un autre processus. Le document vit côté moteur ; l'interface en garde une projection (l'arbre de la scène, les propriétés de la sélection) mise à jour par les messages du moteur, et le modifie en lui envoyant des commandes.

## 3. La machine de l'éditeur

Une machine XState est une définition statique : on n'y ajoute pas d'états pendant qu'elle tourne. La machine du cœur reste donc **fixe et minimale**, et offre des emplacements où se branchent des sous-machines fournies par les plugins.

```
editor (parallèle)
├── focus      quelle vue est active, quelle zone reçoit le clavier (recopié de dockview)
├── mode       le mode d'édition (objet, puis ceux des plugins)
├── slot 1     idle | outil actif (sous-machine d'un plugin)
├── slot 2     idle | outil actif
└── …
```

**Les plugins l'étendent de trois façons :**

| Mécanisme               | Usage                                                                                             | Notes                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Sous-machine invoquée   | Un outil ou un mode de plugin devient un acteur enfant, créé à l'activation                       | L'emplacement invoque l'acteur dont l'identifiant vient du registre ; le plugin fournit toute sa machine |
| Implémentations nommées | Le cœur référence des actions et des gardes par leur nom, le registre fournit les implémentations | Seuls les noms que le cœur expose                                                                        |
| Événements              | Le plugin écoute les événements de l'éditeur et en émet, préfixés par son identifiant             | Pas de transition modifiée, mais le cœur peut réagir à des événements prévus                             |

**Règle** : un plugin qui veut une transition entre deux états du cœur passe par un événement et un garde nommé que le cœur expose. Il ne modifie jamais la définition du cœur.

Le manifeste déclare les sous-machines :

```json
"contributes": {
  "tools": [{ "id": "acme.sculpt", "title": "Sculpter", "slot": "primary", "machine": "./machines/sculpt.js" }],
  "modes": [{ "id": "acme.paint", "machine": "./machines/paint.js", "when": "scene.hasMesh" }]
}
```

**Le contrat d'une sous-machine :**

- **Entrée** : les services de son plugin, une lecture du snapshot de l'éditeur, une fonction pour envoyer des événements au cœur. Jamais la machine racine.
- **Sortie** : un état final, ou un événement convenu (`EDITOR.TOOL_DONE`, `EDITOR.TOOL_CANCEL`) ; le cœur décide de la transition.
- **Événements réservés** : Échap, la perte du focus et le changement de vue passent d'abord par le cœur ; un plugin ne peut pas bloquer l'éditeur.
- **Le document** : modifié par des commandes seulement ; une sous-machine n'écrit pas dans le store.

## 4. Les outils actifs en parallèle

Certains outils sont actifs ensemble (par exemple un gizmo de transformation et un outil d'accrochage). Le modèle : **des emplacements d'outils**.

- Un emplacement est une région parallèle du cœur, avec son hôte d'outil.
- Dans un emplacement, un seul outil à la fois : en activer un autre termine le précédent.
- Entre emplacements, les outils sont indépendants.
- Un outil déclare son emplacement dans son manifeste : deux outils du même emplacement s'excluent, sans autre règle.
- Les emplacements sont définis par le cœur.

**Le routage des entrées** : la souris et le clavier vont aux outils actifs dans l'ordre de priorité des emplacements ; le premier qui consomme l'événement l'arrête. Un outil en cours de drag capture le routage jusqu'à la validation ou l'annulation (Échap). Les context keys exposent l'outil de chaque emplacement (`tool.primary`) pour les clauses `when`.

## 5. Le registre de services

Tout ce qui n'est pas sérialisable : la connexion au moteur, le viewport, l'`EditorHost`, les services des plugins. Accessible hors de React.

- **Des identifiants typés** : la récupération est typée, sans cast.
- **L'instanciation paresseuse** : un service est créé à sa première utilisation.
- **La portée par plugin** : un plugin voit ses propres services et ceux que l'hôte lui donne.
- **Le nettoyage** : ce qu'un plugin a enregistré est détruit à sa désactivation (`dispose()`).
- **Jamais sérialisé** : rien du registre n'entre dans les snapshots ni dans le layout.

```ts
const IEngineConnection = serviceId<EngineConnection>('engine');
services.register(IEngineConnection, () => host.connectEngine(), {
  lazy: true,
});
const engine = services.get(IEngineConnection); // typé
const scoped = services.createScope(pluginId); // visibilité limitée, dispose()
```

Les valeurs qui changent à chaque frame (le transform en cours de drag, le FPS) ne passent ni par le registre ni par le store : elles restent dans le runtime, et le store ne reçoit que la valeur finale à la validation.

## 6. La persistance et les plugins absents

- **Sauvegardés** : le store sérialisable et les snapshots des machines (avec ceux des acteurs enfants, si XState le permet).
- **Jamais sauvegardé** : le registre, recréé au démarrage ; les plugins réenregistrent leurs services à l'activation.
- **Un plugin absent** : un snapshot qui référence un outil ou un mode d'un plugin désinstallé ou désactivé se replie sur `idle`, comme le panneau « plugin manquant » du layout.
- **Une référence perdue** : la sélection et la vue active sont des identifiants ; un objet ou une vue disparus sont ignorés à la restauration.
- **L'état des plugins** : un espace nommé par plugin (`ctx.state`), sérialisable, sauvegardé avec le layout ou le projet ; gardé quand le plugin est absent.
- **Un plugin présent mais pas encore actif** (étape 12) : le code des plugins des outils et du mode du snapshot est chargé avant le runtime, et leur `activate` enregistre leurs outils avant que la machine ne se restaure ; un outil retrouve ainsi son état (son contexte, persisté par le runtime).

## 7. Les liens avec le reste

- **Les commandes** : seul chemin de mutation du document ; un plugin enregistre ou appelle des commandes. Le journal, l'annulation et les raccourcis viennent avec.
- **Les context keys** se dérivent de l'état (`editor.focusedView`, `tool.primary`, `scene.hasSelection`, `engine.backend`) : les plugins lisent un contexte calculé, sans connaître la machine.
- **Les popouts** partagent le renderer et donc le store ; les écouteurs (clavier, focus) doivent être posés sur la bonne fenêtre.

## 8. Les risques

| Risque                                                        | Conséquence                                                  | Parade                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Un plugin qui veut modifier le cœur                           | Conflits entre plugins, couplage                             | Aucun accès à la définition : événements et gardes nommés     |
| Deux outils actifs sur le même événement                      | Comportement imprévisible                                    | Routage par priorité d'emplacement (§4)                       |
| Une sous-machine qui bloque l'éditeur                         | Éditeur inutilisable                                         | Événements réservés traités d'abord par le cœur               |
| Un snapshot qui référence un plugin absent                    | Erreur au chargement                                         | Repli sur `idle`, référence ignorée                           |
| Des objets du moteur dans le store                            | Sauvegarde impossible ; faux dans Electron (autre processus) | Des identifiants seulement ; le moteur derrière une connexion |
| Des valeurs par frame dans le store                           | Re-rendus constants                                          | Dans le runtime, valeur finale à la validation                |
| Des services qui fuient après la désactivation d'un plugin    | Mémoire et ressources non libérées                           | Portée par plugin, `dispose()` systématique                   |
| XState ou `@xstate/store` différents de ce qui est décrit ici | Design à reprendre                                           | Vérifier la version installée avant d'écrire le code          |

## 9. Les questions ouvertes

- ~~Combien d'emplacements d'outils au départ ?~~ _Deux à l'étape 11_ : `primary` (les outils de transformation, de sélection), puis `secondary` (l'accrochage, les aides), dans cet ordre de priorité. Un plugin peut-il en demander un nouveau ? Non pour l'instant : la machine est fixe.
- Annuler et refaire : les commandes de P15 seules, ou des patches sur le document ?
- L'état des plugins : dans le layout, dans le projet, ou selon son type ? _Dans le layout à l'étape 12_ ; le projet viendra avec l'étape 13.
- La projection du document dans l'interface : un message par changement, ou des différences groupées par frame ?
