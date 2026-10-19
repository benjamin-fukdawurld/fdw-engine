---
title: Les graphs de comportement
description: Le modèle des graphs de comportement, leurs nœuds, leur exécution comme systèmes — interprétés ou compilés en JavaScript — et leur débogueur.
sidebar:
  order: 15
---

`@fdw/engine-behavior` exécute une logique écrite en graphs — l'IA des
ennemis, les règles d'un niveau, les réactions d'un objet — comme les
blueprints d'Unreal : des événements lancent des chaînes de nœuds, qui
lisent des valeurs et appellent les actions du jeu. Il ne dépend que de
`@fdw/engine-graph`, le cœur de graph qu'il partage avec les material
graphs et les animation graphs ; ses systèmes s'installent dans le
`Scheduler` de `@fdw/engine-scene` sans en dépendre.

Le tutoriel [Les graphs de comportement](/fdw-engine/fr/tutorials/behavior-graphs/)
construit des gardes qui patrouillent et poursuivent ; les ennemis du
[jeu à la troisième personne](/fdw-engine/fr/game/tps/) sont un graph plus
grand.

## Le modèle

Un graph de comportement est un document du cœur de graph, au format
`fdw-behavior-graph` : des nœuds, des arêtes entre leurs ports, et les
**variables** de ses instances (un nom, un type, une valeur par défaut).

| Type      | Valeurs                                                          |
| --------- | ---------------------------------------------------------------- |
| `exec`    | Le flux d'exécution : aucune valeur                              |
| `number`  | Un nombre                                                        |
| `boolean` | `true`, `false`                                                  |
| `string`  | Un texte : le nom d'un état                                      |
| `vec3`    | `{ x, y, z }`                                                    |
| `entity`  | Le numéro d'une entité                                           |
| `any`     | En entrée seulement : accepte toute valeur (un log, une égalité) |

Une sortie alimente une entrée du même type, ou une entrée `any`. Les
entrées de données reçoivent une arête ; non connectée, une entrée prend sa
valeur par défaut, donnée par le nœud (`defaults`) ou par son type. Les
ports **exec** font l'inverse : une sortie d'exécution mène à un seul
nœud, une entrée d'exécution est atteinte depuis autant de nœuds qu'on
veut. Les valeurs ne peuvent pas boucler (une valeur calculée à partir
d'elle-même) ; le flux d'exécution le peut.

Chaque nœud a une sorte :

| Sorte    | Ports exec          | Ce qu'il fait                                                              |
| -------- | ------------------- | -------------------------------------------------------------------------- |
| `event`  | En sortie seulement | Lance une chaîne quand son événement arrive ; ses champs sont ses sorties  |
| `flow`   | En entrée et sortie | Choisit où va la chaîne : les exécuteurs les implémentent                  |
| `action` | En entrée et sortie | Fait quelque chose, écrit ses sorties, continue par une sortie d'exécution |
| `pure`   | Aucun               | Calcule ses sorties à partir de ses entrées, quand on les lit              |

## Les nœuds

| Nœud                                                          | Ports                                          | Rôle                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `event.start`                                                 | → `then`                                       | Une fois, à la première exécution de l'instance                            |
| `event.update`                                                | → `then`, `dt`                                 | À chaque exécution du système, avec la durée de son pas                    |
| `event.on` (`event`, `fields`)                                | → `then`, un port par champ                    | Quand l'événement est envoyé à l'instance                                  |
| `event.emit` (`event`, `fields`)                              | `target`, un port par champ → `then`           | Envoie un événement à cette instance, ou à l'instance de `target`          |
| `flow.branch`                                                 | `condition` → `true`, `false`                  | Continue par l'une ou l'autre                                              |
| `flow.sequence` (`count`)                                     | → `then0`, `then1`…                            | Exécute tour à tour les chaînes de ses sorties                             |
| `flow.switch` (`cases`)                                       | `value` → un port par cas, `default`           | Continue par la sortie nommée d'après un texte                             |
| `flow.doOnce`                                                 | `exec`, `reset` → `then`                       | Ne continue que la première fois, jusqu'à ce que `reset` soit atteint      |
| `flow.forLoop`                                                | `first`, `last` → `body`, `index`, `completed` | `body` pour chaque indice, `last` compris, puis `completed`                |
| `flow.delay`                                                  | `seconds` → `then`                             | Continue plus tard ; atteint de nouveau pendant qu'il attend, ne fait rien |
| `var.get` (`name`, `type`)                                    | → `value`                                      | Une variable de l'instance                                                 |
| `var.set` (`name`, `type`)                                    | `value` → `then`, `value`                      | La modifie                                                                 |
| `value.constant` (`type`, `value`)                            | → `value`                                      | Une constante                                                              |
| `value.select` (`type`)                                       | `condition`, `ifTrue`, `ifFalse` → `value`     | L'une ou l'autre                                                           |
| `value.equals`                                                | `a`, `b` → `value`                             | L'égalité ; les vecteurs par leurs composantes                             |
| `entity.self`, `time.now`                                     | → `value`                                      | L'entité de l'instance ; son temps depuis son démarrage                    |
| `math.add`, `sub`, `mul`, `div`, `min`, `max`                 | `a`, `b` → `value`                             | L'arithmétique                                                             |
| `math.abs`, `clamp`, `lerp`                                   | → `value`                                      | `abs(value)`, `value` dans [`min`, `max`], `a + (b − a) t`                 |
| `math.random`                                                 | `min`, `max` → `value`                         | Tiré de la source aléatoire du système, à chaque lecture                   |
| `math.compare` (`op`)                                         | `a`, `b` → `value`                             | `<`, `<=`, `>`, `>=`, `==`, `!=`                                           |
| `logic.and`, `or`, `not`                                      | → `value`                                      | La logique                                                                 |
| `vec3.make`, `vec3.break`                                     | `x`, `y`, `z` ↔ `vector`                       | Un vecteur de ses composantes, et l'inverse                                |
| `vec3.add`, `sub`, `scale`, `length`, `distance`, `normalize` | → `value`                                      | Les vecteurs                                                               |
| `debug.log` (`text`)                                          | `value` → `then`                               | Une ligne dans le journal du système                                       |

Les actions et les nœuds du flux ont une entrée d'exécution `exec` ; les
événements et les actions une sortie d'exécution `then` (une action peut
en avoir d'autres).

## Les nœuds d'une application

Une application donne aux graphs ses propres nœuds, avec leur code :

```ts
const heroDistance = pureNode<Game>({
  id: 'enemy.heroDistance',
  output: 'number',
  evaluate: (call) => call.self.host.heroDistance(call.self.entity),
});
const strike = actionNode<Game>({
  id: 'enemy.strike',
  inputs: { damage: { type: 'number', default: 10 } },
  outputs: { hit: 'boolean' },
  exits: ['then', 'missed'],
  run: (call, damage: number) => {
    const hit = call.self.host.strike(call.self.entity, damage);
    call.outputs['hit'] = hit;
    return hit ? 'then' : 'missed';
  },
});
const registry = createBehaviorRegistry([heroDistance, strike]);
```

`evaluate` et `run` reçoivent l'appel du nœud — `call.self` (l'instance :
`entity`, `host`, `variables`, `time`, `random()`, `emit()`),
`call.params`, `call.outputs`, `call.state` (ce que le nœud garde d'une
exécution à l'autre) —, puis les valeurs des entrées de données, dans
l'ordre des ports. Un nœud pur renvoie sa valeur (un objet par nom de
sortie quand il en a plusieurs) ; une action écrit ses sorties et renvoie
sa sortie d'exécution (la première quand elle renvoie autre chose qu'un
texte). Un nœud pur peut donner au compilateur une expression JavaScript
(`inline`) ; sinon le code compilé appelle `evaluate`.

## Construire, valider, enregistrer

`BehaviorGraphBuilder(name, registry)` ajoute les nœuds par des poignées :
`variable`, `event` ; `onStart`, `onUpdate`, `on`, `emit` ; `branch`,
`sequence`, `switch`, `doOnce`, `forLoop`, `delay`, `log` ; `get`, `set` ;
les valeurs (`add`, `compare`, `select`, `distance`…) ; `node(type, { from,
inputs, params })` pour tout type du registre ; `link(from, node, entry)`
pour une chaîne qui en rejoint une autre, ou qui revient en arrière.
Chaque méthode d'un nœud du flux prend d'abord les sorties d'exécution
après lesquelles il vient (un `Exec`, un tableau, ou `undefined`) ;
`{ id, label }` nomme un nœud, pour le débogueur.

`validateBehaviorGraph(graph, registry)` vérifie, en plus du cœur (types
de nœuds, paramètres, ports, types, cycles de valeurs) : les variables
(uniques, d'un type connu, leurs valeurs par défaut, lues et modifiées
avec leur type), les événements (`start` et `update` réservés, des champs
bien formés ; un avertissement pour un événement envoyé qu'aucun nœud ne
traite), les cas des switches, les actions et les nœuds du flux dont
l'entrée d'exécution n'est pas connectée (un avertissement : ils ne
s'exécutent jamais). `build()` et `BehaviorSystem` lèvent une `GraphError`
qui liste les erreurs. `serializeBehaviorGraph` et `parseBehaviorGraph`
écrivent et lisent le JSON.

## L'exécution : `BehaviorSystem`

```ts
const system = new BehaviorSystem(graph, {
  host: game,
  registry,
  mode: 'compile', // ou 'interpret'
  maxSteps: 1000,
  random: seeded,
  log: (text, instance) => console.log(text),
});
const orc = system.attach(entity, { health: 60 });
system.install(scheduler, { name: 'enemies', after: ['hero'] });
system.emit(entity, 'hit', { damage: 20 });
system.detach(entity);
```

- **Une instance par entité**, créée par `attach` : ses variables (les
  valeurs par défaut, puis celles données, vérifiées selon leur type),
  l'état de ses nœuds, son horloge (`time`), ses délais.
  `instance.get`, `instance.set`, `instance.variables` lisent et écrivent
  les variables depuis l'application.
- **Une exécution** (`system.run(dt)`, ou le système installé dans
  l'ordonnanceur, dans la phase `fixed` par défaut) : pour chaque instance,
  dans l'ordre où elles ont été attachées, `event.start` la première fois,
  puis l'horloge avancée, les délais échus réveillés, puis `event.update`.
  Les gestionnaires d'un événement s'exécutent dans l'ordre du graph.
- **Les événements** envoyés par l'application sont traités aussitôt ;
  ceux envoyés pendant qu'une chaîne s'exécute (par `event.emit`, ou par
  une action qui appelle `system.emit`), dès qu'aucune chaîne ne
  s'exécute, dans l'ordre.
- **Les valeurs** : un nœud pur est évalué quand un nœud du flux le lit,
  une fois pour ce nœud quel que soit le nombre d'entrées qui le lisent,
  et de nouveau pour le nœud suivant (une valeur qui a changé entre-temps
  est vue changée). Les sorties des événements et des actions restent
  celles de leur dernière exécution : les nœuds qui les suivent les
  lisent.
- **Une instance détachée** s'arrête au nœud suivant de sa chaîne : une
  action peut détacher sa propre entité (un ennemi retiré par son graph).
- **Une chaîne** exécute au plus `maxSteps` nœuds (1000) : au-delà, un
  flux qui boucle sans fin, le système lève une `BehaviorError` qui nomme
  le nœud et l'entité.

## Interprété ou compilé

| Mode        | Comment                                                                                                         | Pour                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `compile`   | Une fonction JavaScript par entrée d'exécution de chaque nœud, qui calcule les valeurs lues et appelle la suite | Le jeu : environ 18 fois plus rapide                          |
| `interpret` | Les nœuds parcourus un par un, les continuations sur une pile de l'instance                                     | Le débogueur : il peut s'arrêter partout, garde chaque valeur |

Les deux exécutent les mêmes instances : `system.mode` bascule à tout
moment, les variables et les délais gardés. Le code compilé est créé par
`new Function` (`system.compiled.source` le montre) ; une page dont la
Content Security Policy interdit `unsafe-eval` ne peut pas l'utiliser, et
le système interprète. Le graph ne peut pas injecter de code : ses noms et
ses constantes entrent dans le source comme des textes JSON, le code des
nœuds vient de leurs types.

Le coût, mesuré sur la décision d'un ennemi du TPS (un switch sur un état,
ses horloges, une distance, une action ; `behavior.bench.ts`, Node 24),
pour 1000 instances par pas :

| Version                                      | Par pas  |
| -------------------------------------------- | -------- |
| Interprétée                                  | 1,8 ms   |
| Compilée                                     | 0,10 ms  |
| Écrite en TypeScript, à la main, en colonnes | 0,003 ms |

La version écrite à la main reste loin devant : pas d'aiguillage, pas
d'objet par instance. Pour quelques dizaines de personnages, le graph
compilé coûte quelques microsecondes ; les actions qu'il appelle (un
contrôleur de personnage, une requête de physique) coûtent davantage.

## Déboguer

`system.debug()` ouvre le débogueur du système (et interprète jusqu'à
`close()`) :

| Membre                                                                          | Rôle                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `addBreakpoint(id)`, `removeBreakpoint`, `toggleBreakpoint`, `clearBreakpoints` | S'arrête avant un nœud du flux (un événement, une action, un nœud du flux ; pas un nœud pur)                                                  |
| `entity`                                                                        | Seule l'instance de cette entité s'arrête ; toutes quand `undefined`                                                                          |
| `paused`                                                                        | `{ instance, node, reason }` : où il s'est arrêté, et pourquoi (`breakpoint`, `step`)                                                         |
| `onPause(listener)`                                                             | Appelé quand il s'arrête : mettre l'ordonnanceur en pause, montrer le nœud                                                                    |
| `step()`                                                                        | Exécute le nœud devant lequel il s'est arrêté, et s'arrête avant le suivant, dans cette chaîne ou la prochaine à s'exécuter                   |
| `continue()`                                                                    | Continue jusqu'au prochain point d'arrêt                                                                                                      |
| `states(entity)`, `state(entity, id)`                                           | Par nœud : `runs`, `time` de sa dernière exécution, `outputs`, `active` (exécuté à la dernière exécution), `breakpoint`, `waiting` (un délai) |
| `trace(entity)`                                                                 | Les nœuds du flux exécutés pendant la dernière exécution du système, dans l'ordre                                                             |
| `close()`                                                                       | Plus de point d'arrêt, repris, retour au mode précédent                                                                                       |

Pendant qu'il est arrêté, le système ne s'exécute pas et les événements
qu'on lui envoie attendent ; le reste du jeu continue, sauf si
l'application le met en pause dans `onPause`.

## Limites

- Les nœuds du flux sont ceux des exécuteurs : une application ajoute des
  actions et des nœuds purs, pas de nouvelles sortes de flux.
- Un graph n'en appelle pas un autre (fonctions, macros), et aucun
  événement n'atteint toutes les instances à la fois : on l'envoie à
  chacune.
- Pas encore d'éditeur : les graphs se construisent en code ou s'écrivent
  en JSON. Les états des nœuds et la trace sont ce qu'un éditeur montrera
  (P13).
