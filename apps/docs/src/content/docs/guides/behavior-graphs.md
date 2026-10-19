---
title: Behavior graphs
description: The model of the behavior graphs, their nodes, how they run as systems — interpreted or compiled to JavaScript — and their debugger.
sidebar:
  order: 15
---

`@fdw/engine-behavior` runs logic written as graphs — the AI of enemies,
the rules of a level, the reactions of an object — like the blueprints of
Unreal: events start chains of nodes, which read values and call the
actions of the game. It depends only on `@fdw/engine-graph`, the graph core
it shares with the material graphs and the animation graphs; its systems
install themselves in the `Scheduler` of `@fdw/engine-scene` without
depending on it.

The tutorial [Behavior graphs](/fdw-engine/tutorials/behavior-graphs/)
builds guards that patrol and chase; the enemies of
[the third-person game](/fdw-engine/game/tps/) are a larger graph.

## The model

A behavior graph is a document of the graph core, of format
`fdw-behavior-graph`: nodes, edges between their ports, and the
**variables** of its instances (a name, a type, a default value).

| Type      | Values                                             |
| --------- | -------------------------------------------------- |
| `exec`    | The flow of execution: no value                    |
| `number`  | A number                                           |
| `boolean` | `true`, `false`                                    |
| `string`  | A text: the name of a state                        |
| `vec3`    | `{ x, y, z }`                                      |
| `entity`  | The number of an entity                            |
| `any`     | Inputs only: takes any value (a log, a comparison) |

An output feeds an input of the same type, or an input `any`. The data
inputs take one edge; an unconnected one takes its default value, given
by the node (`defaults`) or by its type. The **exec** ports reverse it: an
exec output goes on to one node, an exec input is reached from as many as
wanted. The values may not loop (a value computed from itself); the flow
of execution may.

Each node has a kind:

| Kind     | Exec ports   | What it does                                                    |
| -------- | ------------ | --------------------------------------------------------------- |
| `event`  | Outputs only | Starts a chain when its event comes; its fields are its outputs |
| `flow`   | In and out   | Chooses where the chain goes: the executors implement them      |
| `action` | In and out   | Does something, writes its outputs, goes on by an exit          |
| `pure`   | None         | Computes its outputs from its inputs, when they are read        |

## The nodes

| Node                                                          | Ports                                          | Role                                                            |
| ------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `event.start`                                                 | → `then`                                       | Once, at the first run of the instance                          |
| `event.update`                                                | → `then`, `dt`                                 | At each run of the system, with its time step                   |
| `event.on` (`event`, `fields`)                                | → `then`, a port per field                     | When the event is sent to the instance                          |
| `event.emit` (`event`, `fields`)                              | `target`, a port per field → `then`            | Sends an event to this instance, or to the instance of `target` |
| `flow.branch`                                                 | `condition` → `true`, `false`                  | Goes on by one or the other                                     |
| `flow.sequence` (`count`)                                     | → `then0`, `then1`…                            | Runs the chains of its outputs in turn                          |
| `flow.switch` (`cases`)                                       | `value` → a port per case, `default`           | Goes on by the output named after a string                      |
| `flow.doOnce`                                                 | `exec`, `reset` → `then`                       | Goes on the first time only, until `reset` is reached           |
| `flow.forLoop`                                                | `first`, `last` → `body`, `index`, `completed` | `body` for each index, `last` included, then `completed`        |
| `flow.delay`                                                  | `seconds` → `then`                             | Goes on later; reached again while it waits, does nothing       |
| `var.get` (`name`, `type`)                                    | → `value`                                      | A variable of the instance                                      |
| `var.set` (`name`, `type`)                                    | `value` → `then`, `value`                      | Sets it                                                         |
| `value.constant` (`type`, `value`)                            | → `value`                                      | A constant                                                      |
| `value.select` (`type`)                                       | `condition`, `ifTrue`, `ifFalse` → `value`     | One or the other                                                |
| `value.equals`                                                | `a`, `b` → `value`                             | Equality; vectors by their components                           |
| `entity.self`, `time.now`                                     | → `value`                                      | The entity of the instance; its time since it started           |
| `math.add`, `sub`, `mul`, `div`, `min`, `max`                 | `a`, `b` → `value`                             | Arithmetic                                                      |
| `math.abs`, `clamp`, `lerp`                                   | → `value`                                      | `abs(value)`, `value` within [`min`, `max`], `a + (b − a) t`    |
| `math.random`                                                 | `min`, `max` → `value`                         | Drawn from the random source of the system, at each read        |
| `math.compare` (`op`)                                         | `a`, `b` → `value`                             | `<`, `<=`, `>`, `>=`, `==`, `!=`                                |
| `logic.and`, `or`, `not`                                      | → `value`                                      | Logic                                                           |
| `vec3.make`, `vec3.break`                                     | `x`, `y`, `z` ↔ `vector`                       | A vector from its components, and back                          |
| `vec3.add`, `sub`, `scale`, `length`, `distance`, `normalize` | → `value`                                      | Vectors                                                         |
| `debug.log` (`text`)                                          | `value` → `then`                               | A line in the log of the system                                 |

The actions and the flow nodes have an exec input `exec`; the events and
the actions an exec output `then` (an action may have other exits).

## The nodes of an application

An application gives the graphs its own nodes, with their code:

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

`evaluate` and `run` receive the call of the node — `call.self` (the
instance: `entity`, `host`, `variables`, `time`, `random()`, `emit()`),
`call.params`, `call.outputs`, `call.state` (what the node keeps between
two runs) — then the values of the data inputs, in the order of the ports.
A pure node returns its value (an object by output name when it has
several); an action writes its outputs and returns its exit (the first
when it returns anything but a string). A pure node may give the compiler
a JavaScript expression (`inline`); otherwise the compiled code calls
`evaluate`.

## Building, validating, saving

`BehaviorGraphBuilder(name, registry)` adds the nodes through handles:
`variable`, `event`; `onStart`, `onUpdate`, `on`, `emit`; `branch`,
`sequence`, `switch`, `doOnce`, `forLoop`, `delay`, `log`; `get`, `set`;
the values (`add`, `compare`, `select`, `distance`…); `node(type, { from,
inputs, params })` for any type of the registry; `link(from, node,
entry)` for a chain joining another, or looping back. Each impure method
takes first the exec outputs it comes after (`Exec`, an array of them, or
`undefined`); `{ id, label }` names a node, for the debugger.

`validateBehaviorGraph(graph, registry)` checks, besides the core (node
types, parameters, ports, types, cycles of values): the variables (unique,
of a known type, their defaults, read and set with their type), the
events (`start` and `update` reserved, fields well formed; a warning for
an emitted event no node handles), the cases of the switches, the actions
and flow nodes whose exec input is not connected (a warning: they never
run). `build()` and `BehaviorSystem` throw a `GraphError` listing the
errors. `serializeBehaviorGraph` and `parseBehaviorGraph` write and read
JSON.

## Running: `BehaviorSystem`

```ts
const system = new BehaviorSystem(graph, {
  host: game,
  registry,
  mode: 'compile', // or 'interpret'
  maxSteps: 1000,
  random: seeded,
  log: (text, instance) => console.log(text),
});
const orc = system.attach(entity, { health: 60 });
system.install(scheduler, { name: 'enemies', after: ['hero'] });
system.emit(entity, 'hit', { damage: 20 });
system.detach(entity);
```

- **An instance per entity**, made by `attach`: its variables (the
  defaults, then the values given, checked against their types), the
  state of its nodes, its clock (`time`), its delays. `instance.get`,
  `instance.set`, `instance.variables` read and write the variables from
  the application.
- **A run** (`system.run(dt)`, or the system installed in the scheduler,
  in the `fixed` phase by default): for each instance, in the order they
  were attached, `event.start` the first time, then the clock advanced,
  the delays due woken, then `event.update`. The handlers of an event run
  in the order of the graph.
- **The events** sent by the application are handled at once; those sent
  while a chain runs (by `event.emit`, or by an action calling
  `system.emit`), as soon as no chain runs, in order.
- **The values**: a pure node is evaluated when a node of the flow reads
  it, once for that node however many inputs read it, and again for the
  next node (a value that changed in between is seen changed). The
  outputs of the events and of the actions stay those of their last run:
  the nodes after them read them.
- **A detached instance** stops at the next node of its chain: an action
  can detach its own entity (an enemy removed by its graph).
- **A chain** runs at most `maxSteps` nodes (1000): beyond, a flow that
  loops forever, the system throws a `BehaviorError` naming the node and
  the entity.

## Interpreted or compiled

| Mode        | How                                                                                                      | For                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `compile`   | A JavaScript function per exec input of each node, which computes the values it reads and calls the next | The game: about 18 times faster                       |
| `interpret` | The nodes walked one at a time, the continuations on a stack of the instance                             | The debugger: it can stop anywhere, keeps every value |

Both run the same instances: `system.mode` switches at any time, the
variables and the delays kept. The compiled code is made by `new Function`
(`system.compiled.source` shows it); a page whose Content Security Policy
forbids `unsafe-eval` cannot use it, and the system interprets. The graph
cannot inject code: its names and constants enter the source as JSON
strings, the code of the nodes comes from their types.

The cost, measured on the decision of an enemy of the TPS (a switch on a
state, its clocks, a distance, an action; `behavior.bench.ts`, Node 24),
for 1000 instances per step:

| Version                                   | Per step |
| ----------------------------------------- | -------- |
| Interpreted                               | 1.8 ms   |
| Compiled                                  | 0.10 ms  |
| Written in TypeScript, by hand on columns | 0.003 ms |

The hand-written version stays far ahead: no dispatch, no per-instance
object. For a few dozen characters, the compiled graph costs a few
microseconds; the actions it calls (a character controller, a physics
query) cost more.

## Debugging

`system.debug()` opens the debugger of the system (and interprets until
`close()`):

| Member                                                                          | Role                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `addBreakpoint(id)`, `removeBreakpoint`, `toggleBreakpoint`, `clearBreakpoints` | Stops before a node of the flow (an event, an action, a flow node; not a pure node)                                    |
| `entity`                                                                        | Only the instance of this entity stops; all of them when `undefined`                                                   |
| `paused`                                                                        | `{ instance, node, reason }`: where it stopped, and why (`breakpoint`, `step`)                                         |
| `onPause(listener)`                                                             | Called when it stops: pause the scheduler, show the node                                                               |
| `step()`                                                                        | Runs the node it stopped before, and stops before the next one, in this chain or the next to run                       |
| `continue()`                                                                    | Goes on to the next breakpoint                                                                                         |
| `states(entity)`, `state(entity, id)`                                           | Per node: `runs`, `time` of its last run, `outputs`, `active` (ran in the last run), `breakpoint`, `waiting` (a delay) |
| `trace(entity)`                                                                 | The nodes of the flow run during the last run of the system, in order                                                  |
| `close()`                                                                       | No breakpoint, resumed, back to the previous mode                                                                      |

While it is stopped, the system does not run and the events sent to it
wait; the rest of the game goes on unless the application pauses it in
`onPause`.

## Limits

- The nodes of the flow are those of the executors: an application adds
  actions and pure nodes, not new kinds of flow.
- No graph calls another (functions, macros), and no event reaches all
  the instances at once: send it to each.
- No editor yet: the graphs are built in code or written as JSON. The
  states of the nodes and the trace are what the graph editor will show (P19).
