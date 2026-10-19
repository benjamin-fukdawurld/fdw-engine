import { bench, describe } from 'vitest';
import { BehaviorGraphBuilder } from './BehaviorGraphBuilder';
import { type BehaviorMode, BehaviorSystem } from './BehaviorSystem';
import { actionNode, createBehaviorRegistry, pureNode } from './nodes';

// The cost of the graphs, per run of a system of 1000 instances: the
// decision of an enemy of the TPS (a state machine on a string variable,
// its clock, a distance read from the game, an action), interpreted,
// compiled, and written by hand in TypeScript.
interface Game {
  readonly distances: Float64Array;
  strikes: number;
}
const distance = pureNode<Game>({
  id: 'game.distance',
  output: 'number',
  evaluate: (call) => call.self.host.distances[call.self.entity],
});
const strike = actionNode<Game>({
  id: 'game.strike',
  run: (call) => {
    call.self.host.strikes++;
  },
});
const registry = createBehaviorRegistry([distance, strike]);

const g = new BehaviorGraphBuilder('enemy', registry);
g.variable('state', 'string', 'chase');
g.variable('time', 'number');
g.variable('cooldown', 'number');
const update = g.onUpdate();
const dt = update.value('dt');
const clock = g.sequence(update.then, 2);
const time = g.set(clock.exec('then0'), 'time', g.add(g.get('time'), dt));
g.set(time.then, 'cooldown', g.max(g.sub(g.get('cooldown'), dt), 0));
const state = g.switch(clock.exec('then1'), g.get('state'), [
  'chase',
  'attack',
  'recover',
]);
const enter = (from: ReturnType<typeof g.branch>, to: string) => {
  const set = g.set(from.exec('true'), 'state', to);
  g.set(set.then, 'time', 0);
};
const near = g.and(
  g.compare(g.node('game.distance').value(), '<', 2),
  g.compare(g.get('cooldown'), '<=', 0),
);
enter(g.branch(state.exec('chase'), near), 'attack');
const struck = g.node('game.strike', { from: state.exec('attack') });
const done = g.branch(struck.then, g.compare(g.get('time'), '>', 0.6));
const recover = g.set(done.exec('true'), 'state', 'recover');
const cooled = g.set(recover.then, 'cooldown', 1.3);
g.set(cooled.then, 'time', 0);
enter(
  g.branch(state.exec('recover'), g.compare(g.get('time'), '>', 0.4)),
  'chase',
);
const graph = g.build();

const count = 1000;
const game: Game = {
  distances: Float64Array.from({ length: count }, (_, i) => (i % 7) * 0.5),
  strikes: 0,
};
const system = (mode: BehaviorMode) => {
  const s = new BehaviorSystem(graph, { host: game, registry, mode });
  for (let i = 0; i < count; i++) s.attach(i);
  return s;
};
const interpreted = system('interpret');
const compiled = system('compile');

// The same decision in TypeScript, on columns.
const State = { chase: 0, attack: 1, recover: 2 };
const states = new Uint8Array(count);
const times = new Float64Array(count);
const cooldowns = new Float64Array(count);
const byHand = (step: number) => {
  for (let i = 0; i < count; i++) {
    times[i] += step;
    cooldowns[i] = Math.max(cooldowns[i] - step, 0);
    switch (states[i]) {
      case State.chase:
        if (game.distances[i] < 2 && cooldowns[i] <= 0) {
          states[i] = State.attack;
          times[i] = 0;
        }
        break;
      case State.attack:
        game.strikes++;
        if (times[i] > 0.6) {
          states[i] = State.recover;
          cooldowns[i] = 1.3;
          times[i] = 0;
        }
        break;
      case State.recover:
        if (times[i] > 0.4) {
          states[i] = State.chase;
          times[i] = 0;
        }
        break;
    }
  }
};

describe('the decision of 1000 enemies, per fixed step', () => {
  bench('interpreted', () => {
    interpreted.run(1 / 60);
  });
  bench('compiled to JavaScript', () => {
    compiled.run(1 / 60);
  });
  bench('written in TypeScript', () => {
    byHand(1 / 60);
  });
});
