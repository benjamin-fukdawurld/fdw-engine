---
title: Animation
description: Skeletons, clips, poses and blends, animation graphs and their animators, and the skinning on the GPU.
sidebar:
  order: 12
---

The animation of a character goes through three packages:

- `@fdw/engine-animation`, on the CPU, without the GPU nor the scene:
  skeletons, clips, poses, blends and masks, the animation graphs and the
  `Animator` that runs them;
- `@fdw/engine-skinning`: the skinning of the meshes on the GPU, in a
  compute pass or in the vertex stage, and its glue with the models and
  the scene;
- `@fdw/engine-graph`: the graph core that the animation graphs share with
  the material graphs.

The tutorial [An animated character](/fdw-engine/tutorials/character-animation/)
puts them together.

## Skeletons and poses

A `Skeleton` is a list of joints, each after its parent, with its rest
pose. `Skeleton.fromHierarchy(model.data)` takes the nodes of a model,
depth first (`skeletonOf(model)` keeps one per model); each joint knows its
node (`skeleton.jointOf(node)`), which the channels of the glTF animations
target.

A `Pose` holds the local transform of each joint (relative to its parent):
three flat arrays, `translations`, `rotations` (quaternions x y z w) and
`scales`. The blends work joint by joint:

| Function                                 | Result                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `Pose.blend(a, b, w, out, mask?)`        | a(1 − w) + bw; the rotations along the shortest arc               |
| `Pose.difference(pose, reference, out)`  | What brings `reference` to `pose`: for the additive layers        |
| `Pose.add(base, difference, w, out, m?)` | The difference added by w: translations added, rotations composed |
| `pose.modelMatrices(parents)`            | The matrix of each joint in the space of the skeleton             |

A `BoneMask` gives a weight per joint: `BoneMask.branches(skeleton, {
'upperArm.R': 1, head: 0.5 })` takes the branches of the joints named,
each with its weight.

## Clips

An `AnimationClip` is a set of tracks (a channel of a joint: translation,
rotation or scale) and of events. `AnimationClip.fromData(data, skeleton)`
reads an animation of a model (`clipsOf(model)` reads them all, by name);
the weights of the morph targets are left out.

```ts
const clip = clips['Walk'].withEvents([
  { time: 0.22, name: 'step' },
  { time: 0.77, name: 'step' },
]);
clip.sample(0.5, pose); // the tracks at 0.5 s
```

The keys follow the interpolations of glTF: `STEP`, `LINEAR` (the
rotations spherically) and `CUBICSPLINE` (Hermite, the tangents scaled by
the time between the keys). `sample` writes only the channels with a
track: start from the rest pose. `additiveClip(clip, skeleton)` gives the
difference with its first pose.

## Animation graphs

An animation graph is data, like a material graph: typed nodes and edges,
serialized as JSON (`serializeAnimationGraph`, `parseAnimationGraph`),
validated before it runs (`validateAnimationGraph`). Its ports carry
poses, numbers and booleans; its parameters are set by the application.

| Node                | Builder                                   | Does                                                       |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `anim.clip`         | `g.clip(name, { loop, speed, rate })`     | Plays a clip of the animator; `rate` multiplies the speed  |
| `anim.parameter`    | `g.param(name)`                           | The value of a parameter                                   |
| `anim.blend`        | `g.blend(a, b, weight)`                   | Two poses blended                                          |
| `anim.blend1d`      | `g.blend1d(poses, points, value)`         | A blend space: the two poses around the value              |
| `anim.layer`        | `g.layer(base, layer, { mask, weight })`  | A pose over another, on a mask; `mode: 'additive'` adds it |
| `anim.stateMachine` | `g.stateMachine({ states, transitions })` | States, a pose each, and cross-fades between them          |
| `anim.output`       | `g.output(pose)`                          | The pose of the graph                                      |

The parameters are declared with their type: `g.parameter('speed',
'number')`, `'boolean'`, or `'trigger'`, a boolean set by
`animator.trigger(name)` and consumed by the transition it starts.

A transition goes from a state (or `*`, any other) to another when all of
its `conditions` hold (`{ parameter, op, value }`), its `trigger` is set
and its `exitTime` is reached (in cycles of the state: `1` waits for the
end of a clip that does not loop), with a cross-fade of `duration`
seconds. The transitions are chosen at the start of an update, in their
order; a state is restarted when entered (`resetOnEnter: false` keeps its
clips where they were).

The blend spaces are **synchronized** by default: their poses share a
phase, which advances by their blended duration; the feet of a walk and a
run blended stay in step. `sync: false` lets each clip keep its own time.

## The animator

```ts
const animator = new Animator(graph, { skeleton, clips, masks });
animator.set('speed', 2.4).trigger('jump');
const pose = animator.update(dt);
animator.events; // the events reached by the update
animator.state('body'); // { state, next?, progress, time }
```

An animator runs a graph for one character: the time of its clips, its
parameters, its state machines. The graph, the clips and the masks are
shared. A node feeding two inputs is advanced once per update.

**The events.** An update reaches the events of the clips it plays
(`onEvent(listener)` too). A blend, a blend space and a cross-fade keep
the events of their heavier input: one footstep, not one per blended clip.
A layer keeps those of both.

## Skinning

```ts
const instance = instantiate(model, scene);
const skinning = new Skinning(backend, instance, model);
// Each frame, after the animation, before rendering:
skinning.applyPose(animator.pose).update();
renderer.render({
  source: scene,
  camera,
  surface,
  prepare: (graph) => skinning.addPass(graph),
});
```

`Skinning` gives each skinned primitive of an instance a material of its
own: the graph of the model's material with the skinning added. Its
`update` computes the joint matrices (inverse(node) × joint × inverse
bind matrix), sends them to the GPU and updates the bounds of the
primitives, from a sphere around each joint.

| Mode      | Where                                                                                 | Backends       |
| --------- | ------------------------------------------------------------------------------------- | -------------- |
| `compute` | A compute pass writes the skinned vertices into a buffer, read by every pass by index | WebGPU, Vulkan |
| `vertex`  | The vertex stage of each pass skins its vertex, from the joint matrices in a texture  | All, WebGL2    |

The mode is `compute` where the backend has compute shaders and storage
buffers, `vertex` elsewhere; `{ mode }` chooses. In `compute` mode, the
camera, the shadow maps and later the ray tracing read the same vertices,
skinned once per frame.

In `compute` mode, `skinning.addPass(graph)` adds one compute pass to a
render graph, recording the kernels of all the primitives: give it to
`render` with `prepare`, or call it before `addScenePasses` in a graph of
your own. It returns the versions of the skinned vertex buffers it writes,
for the passes that read them. Outside of a graph, `skinning.dispatch()`
records them in one submission. In `vertex` mode, both do nothing.

The meshes need `joints` (`uint8x4` or `uint16x4`) and `weights`; their
position, normal and tangent are skinned. `skinPositions(MeshSkin.of(mesh),
matrices)` skins on the CPU, for a raycast against a character.

## Limits

- No morph targets, no root motion, no inverse kinematics yet.
- A character is skinned with linear blending: the joints twisted far
  (a forearm turned half a turn) lose some volume.
- The animation graphs have no events of their states nor nodes of
  computation on the parameters yet.
