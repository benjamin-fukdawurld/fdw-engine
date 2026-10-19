# @fdw/engine-behavior

The behavior graphs of FdwEngine, like the blueprints of Unreal: events start chains of nodes (the flow of execution) that read values computed on demand (the data flow), change variables and call the actions of the application. A graph runs as a system, an instance per entity, interpreted or compiled to JavaScript, with a debugger: breakpoints, stepping, the state of each node. Depends only on `@fdw/engine-graph`. See [design/p9-behavior.md](../../design/p9-behavior.md) (in French), the [Behavior graphs guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/behavior-graphs/) and the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/behavior-graphs/).

```ts
import {
  actionNode,
  BehaviorGraphBuilder,
  BehaviorSystem,
  createBehaviorRegistry,
} from '@fdw/engine-behavior';

const roar = actionNode<Game>({
  id: 'game.roar',
  run: (call) => call.self.host.roar(call.self.entity),
});
const registry = createBehaviorRegistry([roar]);

const g = new BehaviorGraphBuilder('orc', registry);
g.variable('anger', 'number');
g.event('hit', { damage: 'number' });
const hit = g.on('hit');
const angry = g.set(
  hit.then,
  'anger',
  g.add(g.get('anger'), hit.value('damage')),
);
const check = g.branch(angry.then, g.compare(angry.value(), '>', 50));
g.node('game.roar', { from: check.exec('true') });

const system = new BehaviorSystem(g.build(), { host: game, registry });
system.attach(entity);
system.install(scheduler); // the fixed step
system.emit(entity, 'hit', { damage: 30 });
system.debug().addBreakpoint(check.id); // interpreted while debugged
```
