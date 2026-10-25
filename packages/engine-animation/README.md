# @fdw/engine-animation

The animation of FdwEngine, on the CPU, without the GPU nor the scene: skeletons, clips (the animations of glTF, sampled with their interpolations), poses, blends, masks and additive layers, and the animation graphs (blend spaces, state machines, layers, events) with the `Animator` that runs them for a character. See [design/p6-animation.md](../../design/p6-animation.md) (in French), the [Animation guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/animation/) and the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/character-animation/).

```ts
import { AnimationGraphBuilder, Animator } from '@fdw/engine-animation';

const g = new AnimationGraphBuilder('character');
g.parameter('speed', 'number');
g.parameter('jump', 'trigger');
const locomotion = g.blend1d(
  [g.clip('Idle'), g.clip('Walk'), g.clip('Run')],
  [0, 1.3, 3.6],
  g.param('speed'),
);
g.output(
  g.stateMachine({
    states: { locomotion, jump: g.clip('Jump', { loop: false }) },
    transitions: [
      { from: 'locomotion', to: 'jump', trigger: 'jump', duration: 0.1 },
      { from: 'jump', to: 'locomotion', exitTime: 1 },
    ],
  }),
);

const animator = new Animator(g.build(), { skeleton, clips });
animator.set('speed', 2).update(dt); // a Pose, and animator.events
```

Since P19, for the editor of graphs: `animator.setGraph(graph)` plays another graph (the parameters of the same name and type kept, the machines in their initial states; a graph that does not play throws and changes nothing), `animator.graph`, and `animator.inspect()`: the weight and the phase of each node in the pose of the last update, the state of each machine, the parameters.
