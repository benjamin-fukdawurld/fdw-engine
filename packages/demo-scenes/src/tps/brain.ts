import {
  actionNode,
  BehaviorGraphBuilder,
  createBehaviorRegistry,
  type ExecFrom,
  pureNode,
  type BehaviorGraphData,
} from '@fdw/engine-behavior';

// The mind of the enemies of the TPS, as a behavior graph: what they decide
// at each fixed step, and how they take a blow. The graph decides; the
// game does the work its nodes ask for (moving around the trunks, testing a
// blow against the hero): the nodes below.

/** What the graph of an enemy asks the game, for its entity. */
export interface EnemyHost {
  /** At most this many strike at once: the others wait around. */
  readonly maxAttackers: number;
  readonly heroAlive: boolean;
  /** How many enemies strike now. */
  attackers(): number;
  heroDistance(entity: number): number;
  /** A blow begins: what it will hit, once each. */
  startAttack(entity: number): void;
  /** The sound of the blow, just before it strikes. */
  swing(entity: number): void;
  /** Tests the blow in front of the enemy against the hero. */
  strike(entity: number): void;
  /** Moves for a step: to the hero or around it, turned towards it, or not at all. */
  steer(
    entity: number,
    step: number,
    state: string,
    time: number,
    cooldown: number,
  ): void;
  /** A blow that did not fell it: its sound. */
  hurt(entity: number): void;
  /** Felled: its body no longer blocks nor takes blows; its sound. */
  die(entity: number): void;
  /** The body of the fallen, sunk into the ground. */
  sink(entity: number, time: number): void;
  /** Gone. */
  remove(entity: number): void;
}

const self = (call: { self: { entity: number } }) => call.self.entity;

/** The nodes of the game, for the graph of the enemies. */
export const enemyNodes = [
  pureNode<EnemyHost>({
    id: 'enemy.heroDistance',
    category: 'enemy',
    description: 'The distance to the hero, on the ground.',
    output: 'number',
    evaluate: (call) => call.self.host.heroDistance(self(call)),
  }),
  pureNode<EnemyHost>({
    id: 'enemy.heroAlive',
    category: 'enemy',
    output: 'boolean',
    evaluate: (call) => call.self.host.heroAlive,
  }),
  pureNode<EnemyHost>({
    id: 'enemy.canAttack',
    category: 'enemy',
    description: 'Whether fewer enemies than allowed strike now.',
    output: 'boolean',
    evaluate: (call) =>
      call.self.host.attackers() < call.self.host.maxAttackers,
  }),
  actionNode<EnemyHost>({
    id: 'enemy.startAttack',
    category: 'enemy',
    run: (call) => call.self.host.startAttack(self(call)),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.swing',
    category: 'enemy',
    run: (call) => call.self.host.swing(self(call)),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.strike',
    category: 'enemy',
    run: (call) => call.self.host.strike(self(call)),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.steer',
    category: 'enemy',
    inputs: {
      step: 'number',
      state: 'string',
      time: 'number',
      cooldown: 'number',
    },
    run: (call, step: number, state: string, time: number, cooldown: number) =>
      call.self.host.steer(self(call), step, state, time, cooldown),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.hurt',
    category: 'enemy',
    run: (call) => call.self.host.hurt(self(call)),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.die',
    category: 'enemy',
    run: (call) => call.self.host.die(self(call)),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.sink',
    category: 'enemy',
    inputs: { time: 'number' },
    run: (call, time: number) => call.self.host.sink(self(call), time),
  }),
  actionNode<EnemyHost>({
    id: 'enemy.remove',
    category: 'enemy',
    run: (call) => call.self.host.remove(self(call)),
  }),
];

/** The node types of the graph: the standard ones and those of the game. */
export const enemyRegistry = createBehaviorRegistry(enemyNodes);

/** The states of an enemy, the values of its `state` variable. */
export const EnemyStates = [
  'spawn',
  'chase',
  'attack',
  'recover',
  'hurt',
  'dead',
] as const;
export type EnemyActivity = (typeof EnemyStates)[number];

/**
 * The graph of the enemies: the same for the orcs and the demon, their
 * differences in variables given at attach (reach, poise, cooldown, the
 * window of the blow).
 *
 * - `event.update`: the clocks; then, by state: `spawn` (a roar) → `chase`;
 *   `chase` → `attack` when the hero is within reach, the cooldown over and
 *   fewer than two strike; `attack`: the swing, then `recover` with a new
 *   cooldown; `recover`, `hurt` → `chase`; `dead`: sinks, then is removed.
 *   Then it moves (`enemy.steer`), then strikes in the window of its blow.
 * - `event.on hit`: the health; felled, or staggered when the blow beats
 *   its poise.
 */
export function enemyGraph(): BehaviorGraphData {
  const g = new BehaviorGraphBuilder('enemies', enemyRegistry);
  g.variable('state', 'string', 'spawn');
  g.variable('time', 'number');
  g.variable('health', 'number', 60);
  g.variable('cooldown', 'number');
  // What the kind gives.
  g.variable('reach', 'number', 1.9);
  g.variable('poise', 'number');
  g.variable('rest', 'number', 1.3);
  g.variable('strikeStart', 'number', 0.28);
  g.variable('strikeEnd', 'number', 0.45);
  g.variable('attackLength', 'number', 1);
  g.event('hit', { damage: 'number' });

  const time = g.get('time');
  const state = g.get('state');
  // Into a state, its clock from zero.
  const enter = (from: ExecFrom, to: EnemyActivity, id?: string) => {
    const set = g.set(from, 'state', to, id ? { id } : {});
    return g.set(set.then, 'time', 0);
  };
  const after = (from: ExecFrom, seconds: number | ReturnType<typeof g.get>) =>
    g.branch(from, g.compare(time, '>', seconds)).exec('true');

  // --- Each fixed step ---------------------------------------------------
  const update = g.onUpdate({ id: 'update' });
  const dt = update.value('dt');
  const steps = g.sequence(update.then, 4);
  const clock = g.set(steps.exec('then0'), 'time', g.add(time, dt));
  g.set(clock.then, 'cooldown', g.max(g.sub(g.get('cooldown'), dt), 0));

  const decide = g.switch(steps.exec('then1'), state, EnemyStates, {
    id: 'decide',
  });
  enter(after(decide.exec('spawn'), 0.8), 'chase');

  const ready = g.and(
    g.and(
      g.node('enemy.heroAlive').value(),
      g.compare(
        g.node('enemy.heroDistance').value(),
        '<',
        g.add(g.get('reach'), 0.3),
      ),
    ),
    g.and(
      g.compare(g.get('cooldown'), '==', 0),
      g.node('enemy.canAttack').value(),
    ),
  );
  const engage = g.branch(decide.exec('chase'), ready, { id: 'engage' });
  const attack = enter(engage.exec('true'), 'attack', 'attack');
  g.node('enemy.startAttack', { from: attack.then });

  // The swing a tenth of a second before the blow, once.
  const attacking = g.sequence(decide.exec('attack'), 2);
  const swingAt = g.sub(g.get('strikeStart'), 0.1);
  const swing = g.branch(
    attacking.exec('then0'),
    g.and(
      g.compare(time, '>=', swingAt),
      g.compare(g.sub(time, dt), '<', swingAt),
    ),
  );
  g.node('enemy.swing', { from: swing.exec('true') });
  const over = g.branch(
    attacking.exec('then1'),
    g.compare(time, '>=', g.get('attackLength')),
  );
  const rest = g.set(
    over.exec('true'),
    'cooldown',
    g.mul(g.get('rest'), g.random(0.8, 1.2)),
  );
  enter(rest.then, 'recover');

  enter(after(decide.exec('recover'), 0.4), 'chase');
  enter(after(decide.exec('hurt'), 0.45), 'chase');

  // Fallen, then sunk into the ground, then gone.
  const fallen = g.sequence(decide.exec('dead'), 2);
  g.node('enemy.sink', {
    from: after(fallen.exec('then0'), 2.5),
    inputs: { time },
  });
  g.node(
    'enemy.remove',
    { from: after(fallen.exec('then1'), 4) },
    { id: 'remove' },
  );

  g.node('enemy.steer', {
    from: steps.exec('then2'),
    inputs: { step: dt, state, time, cooldown: g.get('cooldown') },
  });

  const window = g.and(
    g.equals(state, 'attack'),
    g.and(
      g.compare(time, '>=', g.get('strikeStart')),
      g.compare(time, '<=', g.get('strikeEnd')),
    ),
  );
  const striking = g.branch(steps.exec('then3'), window, { id: 'striking' });
  g.node('enemy.strike', { from: striking.exec('true') });

  // --- A blow of the hero ------------------------------------------------
  const hit = g.on('hit', { id: 'hit' });
  const damage = hit.value('damage');
  const standing = g.branch(hit.then, g.not(g.equals(state, 'dead')));
  const health = g.set(
    standing.exec('true'),
    'health',
    g.sub(g.get('health'), damage),
  );
  const felled = g.branch(health.then, g.compare(health.value(), '<=', 0), {
    id: 'felled',
  });
  const die = g.node('enemy.die', { from: felled.exec('true') });
  enter(die.then, 'dead');
  const hurt = g.node('enemy.hurt', { from: felled.exec('false') });
  const staggered = g.branch(
    hurt.then,
    g.compare(damage, '>=', g.get('poise')),
  );
  enter(staggered.exec('true'), 'hurt');

  return g.build();
}
