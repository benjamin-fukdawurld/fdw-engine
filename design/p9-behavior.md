# P9 : les graphs de comportement

Le design de la phase P9 de la [roadmap](roadmap.md#p9-graphs-de-comportement) : des graphs de comportement sur le cœur de graph de P6, un flux d'exécution déclenché par des événements et un flux de données, comme les blueprints d'Unreal ; leur exécution, interprétée ou compilée en JavaScript, comparées, intégrée à l'ordonnanceur ECS (un graph est un système) ; leur débogage (l'état des nœuds pendant l'exécution, des points d'arrêt) ; la validation : l'IA des ennemis du TPS réécrite en graph.

Contraintes : un package indépendant (le cœur de graph seulement, pas la scène ni le rendu) ; le même graph sur le web et en natif ; des graphs qui restent des données JSON, pour les éditeurs de P13 ; pas de code injectable par un graph chargé d'un fichier ; le TPS au même coût et au même comportement qu'avec ses systèmes écrits à la main.

## 1. Aujourd'hui

| Ce qui existe                                                                                             | Ce qui manque                                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Le cœur de graph (P6) : nœuds, ports typés, registres, diagnostics, sérialisation, `validateDocument`     | Des ports d'exécution : une sortie vers un seul nœud, une entrée atteinte de plusieurs |
| `validateDocument` refuse tout cycle                                                                      | Un flux d'exécution qui peut boucler, des valeurs qui ne le peuvent pas                |
| L'animation graph et son `Animator` : un graph interprété, un objet par nœud                              | Un graph qui exécute des actions, dans l'ordre, et qu'on arrête au milieu              |
| L'ordonnanceur (P4) : un système est une fonction `(dt) => void`, « un graph de comportement en sera un » | Le système qui exécute un graph pour chaque entité                                     |
| L'IA du TPS (P8) : un composant `enemy` et trois systèmes, `decide`, `steer`, `strike`                    | La même IA en graph                                                                    |

## 2. Les options

### 2.1 Le modèle d'exécution

| Option                                                                                  | Intérêt                                                                                                     | Coût                                                                     |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A. Des arbres de comportement (behavior trees)                                          | Le standard de l'IA de jeu ; des succès et des échecs, des nœuds qui durent                                 | Un modèle de plus, qui ne sert qu'à l'IA ; pas ce que demande la roadmap |
| **B. Des blueprints : un flux d'exécution (événements, chaînes) et un flux de données** | **Généraux (IA, règles, objets) ; le modèle que connaissent les utilisateurs d'Unreal ; sur le cœur de P6** | Deux sortes de fils, des nœuds qui durent (délais) à prévoir             |
| C. Des machines à états en graph                                                        | Proches de l'IA du TPS                                                                                      | Un cas particulier : un switch sur une variable d'état dans B le fait    |

**Choix : B.** Une machine à états s'y écrit avec une variable `state` et un `flow.switch` (l'IA du TPS) ; un arbre de comportement pourra se construire dessus plus tard (des actions qui durent, un résultat).

### 2.2 L'évaluation des valeurs

| Option                                                             | Intérêt                                                                                                                       | Coût                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A. Tous les nœuds purs évalués au début de l'événement             | Simple                                                                                                                        | Faux : une valeur lue après une action qui l'a changée serait l'ancienne            |
| **B. À la demande, une fois par nœud du flux qui la lit (Unreal)** | **Une variable relue après `var.set` est la nouvelle ; un nœud lu par deux entrées d'un même nœud n'est calculé qu'une fois** | Une époque par nœud du flux, une comparaison par lecture                            |
| C. À chaque lecture                                                | Le plus simple                                                                                                                | `math.random` lu deux fois par un nœud donnerait deux valeurs ; des calculs refaits |

**Choix : B.** Les sorties des événements et des actions, elles, restent celles de leur dernière exécution : les nœuds qui les suivent les lisent (le `value` de `var.set`, les champs d'un événement).

### 2.3 Interpréter ou compiler

| Option                                                                                                                        | Intérêt                                                                                        | Coût                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A. Interprété : les nœuds parcourus un par un, les continuations sur une pile                                                 | Partout ; **s'arrête avant n'importe quel nœud et reprend** ; garde les valeurs de chaque nœud | Un aiguillage par nœud : 1,8 µs par instance et par pas pour l'IA du TPS (§8)                                         |
| B. Compilé en JavaScript (`new Function`) : une fonction par entrée d'exécution de chaque nœud, les nœuds purs en expressions | **Environ 18 fois plus rapide** (§8) ; le source se lit                                        | Interdit par une Content Security Policy sans `unsafe-eval` ; ne s'arrête pas au milieu d'une chaîne (code synchrone) |
| C. Compilé à la construction, en TypeScript généré                                                                            | Typé, sans `eval`                                                                              | Une étape de construction pour chaque graph ; pas de graph chargé à l'exécution                                       |
| D. Les deux, A et B, sur les mêmes instances                                                                                  | **B pour le jeu, A pour le débogueur ; l'un se remplace par l'autre à chaud**                  | Deux exécuteurs à tenir d'accord : les mêmes tests pour les deux                                                      |

**Choix : D.** Le graph est validé et résolu une fois (`prepareBehavior` : les nœuds, leurs sources de valeurs et leurs cibles d'exécution par indices), puis exécuté par l'`Interpreter` ou par le `CompiledBehavior`. L'état est dans l'instance, commun aux deux : les variables, les sorties et l'état de chaque nœud (`doOnce`, les délais), l'horloge, les délais en attente (un nœud et une heure : l'interpréteur empile son nœud, le code compilé appelle sa fonction de réveil). `system.mode` bascule à tout moment ; ouvrir le débogueur passe en `interpret`, le fermer revient au mode d'avant. Sans `new Function` (une `EvalError`), le système reste en `interpret`.

**La sûreté du code compilé.** Les noms (variables, événements, cas, ids) et les constantes du graph entrent dans le source par `JSON.stringify` ; les fonctions s'appellent par l'indice des nœuds ; le code des nœuds vient de leurs types (le registre de l'application), jamais du document. Un graph chargé d'un fichier ne peut pas injecter de code (testé).

### 2.4 Le graph dans l'ordonnanceur

| Option                                                                          | Intérêt                                                                                          | Coût                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| A. Un système par instance                                                      | Rien à écrire                                                                                    | Des centaines de systèmes, l'ordre entre eux sans intérêt               |
| **B. Un `BehaviorSystem` par graph, une instance par entité attachée**          | **Un graph est un système ; ses instances avancent ensemble, dans l'ordre où elles sont venues** | Les événements envoyés pendant une chaîne attendent la fin de la chaîne |
| C. Le graph comme composant de la scène, ses instances trouvées par une requête | L'ECS au complet                                                                                 | Le package dépendrait de `engine-scene`, et de son `World`              |

**Choix : B**, sans dépendre d'`engine-scene` : `install(scheduler)` prend tout objet qui a `add` et `remove` (le `Scheduler` en est un), dans la phase `fixed` par défaut. L'entité n'est qu'un numéro : l'application attache les siennes, et retrouve ses composants depuis ses nœuds (`call.self.entity`).

### 2.5 Le débogage

| Option                                                                            | Intérêt                                                                                                            | Coût                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| A. Des traces seulement (les nœuds exécutés, leurs valeurs)                       | Marche compilé                                                                                                     | Pas de point d'arrêt                                   |
| **B. L'interpréteur suspendu : la pile des continuations gardée dans l'instance** | **Des points d'arrêt et un pas à pas sur n'importe quel nœud du flux ; les états de tous les nœuds, purs compris** | Le système interprète tant que le débogueur est ouvert |
| C. Le débogueur de JavaScript (`debugger;` dans le code généré)                   | Rien à écrire                                                                                                      | Arrête toute la page ; les nœuds ne s'y voient pas     |

**Choix : B.** Pendant la pause, le système ne s'exécute plus et les événements attendent ; le reste du jeu continue sauf si l'application le met en pause (`onPause`). Les points d'arrêt sont sur les nœuds du flux (un nœud pur est évalué au milieu du nœud qui le lit : il n'a pas de moment à lui). `entity` restreint l'arrêt à une instance : parmi dix orcs, celui qu'on observe.

## 3. Le cœur de graph

Deux ajouts à `@fdw/engine-graph`, sans rien changer pour les graphs existants (les 186 tests du material graph et ceux de l'animation passent tels quels) :

- **`PortSpec.connections`** (`'one'`, `'many'`) : une entrée prend une arête et une sortie plusieurs par défaut ; les ports d'exécution font l'inverse. `resolveEdges` les vérifie (« output "then" can only feed one edge »).
- **`ValidationRules.flow`** : les types de ports dont les arêtes portent le flux de contrôle ; elles peuvent boucler et ne comptent pas dans l'ordre topologique. Une boucle de valeurs reste refusée.

## 4. Le modèle

`@fdw/engine-behavior`, qui ne dépend que du cœur de graph. Un document `fdw-behavior-graph` : des nœuds, des arêtes, des **variables** (nom, type, valeur par défaut). Les types : `exec`, `number`, `boolean`, `string`, `vec3`, `entity`, et `any` (en entrée seulement). Quatre sortes de nœuds : `event`, `flow`, `action`, `pure`.

| Famille    | Nœuds                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Événements | `event.start`, `event.update` (`dt`), `event.on` (des champs déclarés), `event.emit` (à soi ou à `target`)            |
| Flux       | `flow.branch`, `flow.sequence`, `flow.switch` (sur un texte : un état), `flow.doOnce`, `flow.forLoop`, `flow.delay`   |
| Variables  | `var.get`, `var.set`                                                                                                  |
| Valeurs    | `value.constant`, `value.select`, `value.equals`, `entity.self`, `time.now`                                           |
| Nombres    | `math.add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `clamp`, `lerp`, `random`, `compare` ; `logic.and`, `or`, `not` |
| Vecteurs   | `vec3.make`, `break`, `add`, `sub`, `scale`, `length`, `distance`, `normalize`                                        |
| Débogage   | `debug.log`                                                                                                           |

**Les nœuds d'une application** : `actionNode` (des entrées, des sorties, des sorties d'exécution, `run` qui renvoie celle par laquelle continuer) et `pureNode` (`evaluate`, et `inline`, une expression pour le compilateur), ajoutés au registre par `createBehaviorRegistry(nodes)`. Ils reçoivent l'appel du nœud (`call.self` : l'entité, l'hôte donné au système, les variables, l'horloge ; `call.params`, `call.outputs`, `call.state`) puis les valeurs de leurs entrées. Les nœuds du flux sont ceux des exécuteurs : une application n'en ajoute pas.

**La validation** (`validateBehaviorGraph`), en plus du cœur : les variables (uniques, de types connus, leurs valeurs par défaut, lues et écrites avec leur type), les événements (`start` et `update` réservés, les champs ; un avertissement pour un événement envoyé que rien ne traite), les cas des switches, les actions et nœuds du flux jamais atteints (un avertissement). **Le builder** (`BehaviorGraphBuilder`) construit par des poignées : chaque méthode d'un nœud du flux prend d'abord les sorties d'exécution après lesquelles il vient, `link` relie après coup (une jonction, une boucle).

## 5. L'exécution

- **`BehaviorSystem`** : une instance par entité attachée (`attach(entity, variables)`), `run(dt)` ou `install(scheduler)`. Une exécution : pour chaque instance, `event.start` la première fois, l'horloge avancée, les délais échus réveillés, `event.update`.
- **Les événements** envoyés par l'application sont traités aussitôt ; ceux envoyés pendant une chaîne (par `event.emit` ou par une action), dès qu'aucune chaîne ne s'exécute.
- **Les délais** : une heure de l'instance et le nœud à réveiller ; atteint de nouveau pendant qu'il attend, le délai ne fait rien.
- **Les garde-fous** : au plus `maxSteps` nœuds par chaîne (1000 : une boucle du flux sans fin lève une `BehaviorError` qui nomme le nœud et l'entité) ; une action qui renvoie une sortie qu'elle n'a pas ; une instance détachée par sa propre action s'arrête au nœud suivant.
- **Le code compilé** : une fonction `f<nœud>_<entrée>` par entrée d'exécution, qui déclare en constantes les valeurs que lit son nœud (les nœuds purs `inline` en expressions, les autres par `evaluate`), fait son travail et appelle la suivante ; un `switch` de JavaScript pour `flow.switch`, une boucle `for` pour `flow.forLoop`. Les chaînes sont des appels imbriqués : `maxSteps` borne aussi leur profondeur.

## 6. L'IA du TPS en graph

Le même graph pour les orcs et le démon (`enemyGraph`, `demo-scenes/src/tps/brain.ts`), leurs différences dans les variables données à l'attache (vie, portée, `poise`, recharge, fenêtre du coup, durée du clip d'attaque). Le graph décide ; le jeu fait ce que demandent ses nœuds (`enemyNodes`, implémentés par `Enemies`, l'hôte du graph) :

| Avant (P8)                                         | Maintenant                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Le composant `enemy` : état, temps, vie, recharge… | Les variables du graph ; le composant ne garde que la place autour du héros                                                      |
| Le système `decide`                                | `event.update` : les horloges, puis un `flow.switch` sur `state` ; les transitions, des `var.set`                                |
| `Enemies.hit` (dégâts, chute, vacillement)         | L'événement `hit` et sa chaîne                                                                                                   |
| Le système `steer`                                 | L'action `enemy.steer`, appelée par le graph à chaque pas : le pilotage reste du code (une boucle sur les voisins et les troncs) |
| Le système `strike`                                | L'action `enemy.strike`, dans la fenêtre du coup                                                                                 |
| Trois systèmes du pas fixe                         | Un : `enemies.behavior.install(scheduler, { name: 'enemies', after: ['hero'] })`                                                 |

Le partage suit celui des blueprints : la décision en graph, ce qui est calcul (le pilotage, les requêtes de la physique) en nœuds écrits dans le code. L'ordre change un peu : chaque ennemi décide, se déplace et frappe avant le suivant, au lieu de tous décider, puis tous se déplacer ; rien ne se voit en jeu. `createTpsScene({ behavior: 'interpret' })` fait interpréter le graph.

## 7. Ce qu'il a fallu ajouter

- **`engine-graph`** : `PortSpec.connections`, `ValidationRules.flow` (§3).
- **`engine-behavior`** : le package (§4, §5), son débogueur (§2.5).
- **`demo-scenes`** : `brain.ts` (le graph, les nœuds du jeu, `EnemyHost`) ; `Enemies` hôte du graph ; l'option `behavior` de `createTpsScene`.

## 8. Mesures

`behavior.bench.ts` (Node 24, la machine de mesure de P8) : la décision d'un ennemi du TPS (horloges, un switch sur l'état, une distance lue au jeu, une action, des transitions), 1000 instances, un pas :

| Version                                           | Par pas  | Par instance |
| ------------------------------------------------- | -------- | ------------ |
| Interprétée                                       | 1,77 ms  | 1,8 µs       |
| Compilée en JavaScript                            | 0,100 ms | 0,10 µs      |
| Écrite en TypeScript, à la main, sur des colonnes | 0,003 ms | 3 ns         |

Le code compilé est environ 18 fois plus rapide que l'interpréteur ; la version écrite à la main reste 30 fois devant (ni aiguillage, ni objet par instance, des colonnes typées). Un millier d'instances tient en 0,1 ms par pas : le coût est ailleurs. Dans le TPS (Dawn dans Node, la clairière, une vague de trois orcs), le système des ennemis coûte **0,20 ms par image compilé, 0,23 ms interprété**, comme les trois systèmes de P8 (0,2 ms) : l'essentiel est le déplacement des contrôleurs de personnage. Une partie sans fenêtre (le héros immobile qui frappe) suit le même cours avant et après : le premier orc tombe vers 15 s, le héros vers 30 s.

## 9. Tests

- **`engine-graph`** : les connexions par port (une sortie d'exécution utilisée deux fois refusée, une entrée atteinte de plusieurs acceptée), une boucle du flux acceptée, la même refusée sans `flow`.
- **`engine-behavior`**, chaque test d'exécution dans les deux modes : `event.start` une fois puis `event.update` ; branches, séquences, switches et leur `default` ; `doOnce` et `reset`, `forLoop`, les sorties d'une action et ses données ; les délais (réveillés à l'heure, atteints de nouveau sans effet) ; un nœud pur évalué une fois par nœud qui le lit ; les événements de l'application et des graphs (à une autre instance, après la chaîne) ; la boucle sans fin arrêtée ; une sortie inconnue ; une instance détachée par sa propre action ; l'aléatoire, le journal, les variables données à l'attache. Le système : le changement de mode qui garde les délais, l'installation dans un ordonnanceur, des noms hostiles compilés comme des textes. Le débogueur : le mode pendant et après, le point d'arrêt, les états et la trace, le pas à pas, `continue`, l'entité observée, les événements qui attendent la reprise, l'instance détachée pendant la pause. La validation : boucles du flux et jonctions, cycle de valeurs, variables, événements, switches ; l'aller-retour JSON ; les erreurs du builder.
- **`demo-scenes`** : le graph des ennemis sur un faux jeu, dans les deux modes : le grognement puis la poursuite, l'attaque à portée, le son du coup une fois, les coups dans la fenêtre, la recharge ; deux qui frappent à la fois ; la `poise` (le démon ne vacille pas à 20, l'orc si), la chute, l'enfoncement puis le retrait.
- **Documentation** : le tutoriel « Les graphs de comportement » (EN, FR), son exemple vivant et ses captures (WebGPU, WebGL2), un test interactif (un point d'arrêt atteint, le pas à pas) ; le guide « Les graphs de comportement » ; la page du TPS.

## 10. Décisions

Prises pour la réalisation (18 octobre 2026), à revoir avec P13 :

1. **Le modèle des blueprints** : un flux d'exécution et un flux de données ; une machine à états est un switch sur une variable (§2.1).
2. **Les valeurs à la demande, une fois par nœud du flux** qui les lit (§2.2).
3. **Les deux exécuteurs sur les mêmes instances** : compilé par défaut, interprété pour le débogueur, l'un remplaçant l'autre à chaud ; le repli sans `new Function` (§2.3).
4. **Un `BehaviorSystem` par graph**, sans dépendre d'`engine-scene` (§2.4).
5. **Le débogueur sur l'interpréteur suspendu** ; les points d'arrêt sur les nœuds du flux (§2.5).
6. **Les nœuds du flux fermés** : une application ajoute des actions et des nœuds purs (§4).
7. **L'IA du TPS : la décision en graph, le pilotage et les coups en actions** (§6).

## 11. État

**Faite** (18 octobre 2026) : `PortSpec.connections` et `ValidationRules.flow` dans `engine-graph` ; `engine-behavior` (le modèle, 40 nœuds, la validation, le builder, `prepareBehavior`, l'`Interpreter`, `CompiledBehavior`, `BehaviorSystem`, `BehaviorDebugger`, le bench) ; l'IA du TPS en graph (`brain.ts`), dans la démo web et native ; le tutoriel « Les graphs de comportement » (EN, FR) et son exemple vivant, le guide « Les graphs de comportement », la page du TPS, les guides du material graph et du graphe de scène.

## 12. La suite

1. **L'éditeur de graphs** (P13) : les états des nœuds et la trace dessinés sur les fils, les points d'arrêt posés à la souris, sur le cœur de graph commun aux matériaux et aux animations.
2. **Des fonctions et des macros** : un graph appelé par un autre, ses entrées et ses sorties déclarées.
3. **Un événement pour toutes les instances** (`broadcast`), et des événements entre systèmes (un graph de niveau qui réveille les ennemis).
4. **Des nœuds qui durent** au-delà du délai (aller quelque part, jouer une animation jusqu'au bout), et un arbre de comportement construit dessus.
5. **Le code compilé plus proche de l'écrit à la main** : les variables d'un graph en colonnes typées de l'ECS, les instances parcourues dans une boucle générée, si une scène de centaines d'agents le demande.
6. **Le débogage du code compilé** par des traces générées (`debug: true`), sans revenir à l'interpréteur.
7. **Les nœuds de l'animation graph** : des événements des états qui déclenchent des chaînes (P6 §10.4).
