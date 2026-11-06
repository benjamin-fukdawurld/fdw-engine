# @fdw/engine-ragdoll

Ragdolls for FdwEngine: bodies on the bones of a skeleton of `@fdw/engine-animation`, linked by ball joints and hinges, put in a physics world at the pose of the moment, and the pose they make read back for the skinning. Written against the abstract API of `@fdw/engine-physics`: any physics engine behind it (Rapier in the demos). See [design/p25-gameplay.md](../../design/p25-gameplay.md) (in French), the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/ragdolls/) and the [physics guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/physics/#ragdolls).

```ts
import { Ragdoll } from '@fdw/engine-ragdoll';

const ragdoll = new Ragdoll(world, skeleton, {
  bones: [
    { joint: 'hips', to: 'spine', radius: 0.13 },
    { joint: 'upperLeg.L', to: 'lowerLeg.L', radius: 0.075 },
    {
      joint: 'lowerLeg.L',
      to: 'foot.L',
      radius: 0.06,
      link: 'hinge',
      limits: [0, 2.4],
    },
    // …
  ],
  groups: 2,
  mask: 1,
});
ragdoll.activate(animator.pose, skeletonNode.worldMatrix, { z: -4 });
// Each frame, after the step of the world:
skinning.applyPose(ragdoll.readPose(pose));
```

## Public API

| Export           | Description                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ragdoll`        | `activate(pose, matrix, velocity)`, `deactivate()`, `readPose(out)`, `active`, `bodies`, `bodyOf(joint)`                                                                      |
| `RagdollBone`    | A body on a joint: a capsule to the joint `to` or a sphere, its radius and density, a `ball` link (cone, twist) or a `hinge` (axis, limits), the joint it hangs on (`attach`) |
| `RagdollOptions` | The bones, the collision groups, the material, the damping                                                                                                                    |
