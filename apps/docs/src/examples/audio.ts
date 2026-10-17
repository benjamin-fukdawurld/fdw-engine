import {
  AudioClipType,
  AudioStreamType,
  installAudio,
  MusicPlayer,
  SceneAudio,
  SoundEffect,
} from '@fdw/engine-audio';
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCube,
  createSphere,
  multiplyQuat,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Three speakers turn around a head, each humming: the hum moves from an
// ear to the other, softer far away. A click or Space rings a chime at a
// speaker, M crossfades the music, S mutes the effects. The browser starts
// the sound at the first click or key.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  canvas.addEventListener('pointerdown', () => canvas.focus());
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
    }
  });

  // The engine, WebAudio: suspended until a gesture on the canvas. A bus for
  // the effects, one for the music, under the master.
  const engine = new WebAudioEngine();
  unlockAudio(engine, canvas);
  const sfx = engine.createBus('sfx');
  const music = engine.createBus('music', { volume: 0.5 });

  // The sounds, through the resource system: the short ones decoded at
  // their load (clips), the musics kept encoded and streamed.
  const resources = new ResourceStore();
  resources.mount('http', new HttpSource({ base: '/fdw-engine/sounds/' }), {
    default: true,
  });
  installAudio(resources, engine);
  // The handles are kept (the systems below use them): a handle forgotten
  // lets the store free its sound.
  const handles = {
    hum: resources.load(AudioClipType, 'hum.ogg'),
    chimes: ['chime-1.ogg', 'chime-2.ogg', 'chime-3.ogg'].map((uri) =>
      resources.load(AudioClipType, uri),
    ),
    calm: resources.load(AudioStreamType, 'music-calm.ogg'),
    tense: resources.load(AudioStreamType, 'music-tense.ogg'),
  };
  info('loading the sounds');
  const [hum, chimes, calm] = await Promise.all([
    handles.hum.ready,
    Promise.all(handles.chimes.map((handle) => handle.ready)),
    handles.calm.ready,
    handles.tense.ready,
  ]);

  // The scene: a floor, a head looking along -z (its nose), three speakers.
  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.5,
  });
  const graph = g.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph, values: { color } });
  const cube = createCube();
  const sphere = createSphere(24, 12);
  const scene = new Scene();
  scene.root
    .add({ position: { y: -0.05 }, scale: { x: 9, y: 0.1, z: 9 } })
    .setMesh(cube, material([0.3, 0.32, 0.36]));
  const head = scene.root.add({ position: { y: 0.5 } });
  head
    .add({ scale: { x: 0.7, y: 0.8, z: 0.7 } })
    .setMesh(sphere, material([0.85, 0.75, 0.65]));
  head
    .add({ position: { z: -0.38 }, scale: { x: 0.12, y: 0.15, z: 0.2 } })
    .setMesh(cube, material([0.85, 0.6, 0.5]));
  const colors: [number, number, number][] = [
    [0.9, 0.3, 0.2],
    [0.95, 0.75, 0.2],
    [0.25, 0.5, 0.9],
  ];
  const speakers = colors.map((color) =>
    scene.root.add().setMesh(sphere, material(color)),
  );

  // The audio of the scene: the listener follows the head, each hum its
  // speaker; each its pitch.
  const audio = new SceneAudio(scene, engine);
  audio.listener = head;
  speakers.forEach((speaker, i) =>
    audio.play(speaker, hum, {
      bus: sfx,
      loop: true,
      volume: 0.4,
      pitch: [0.8, 1, 1.26][i],
      spatial: { refDistance: 1.5 },
    }),
  );
  // A chime: one of three, a pitch a little different each time.
  const chime = new SoundEffect(engine, chimes, {
    bus: sfx,
    pitchVariation: 0.05,
    maxVoices: 4,
    spatial: { refDistance: 2 },
  });
  // The music, crossfaded from a track to the other; it starts with the
  // sound.
  const player = new MusicPlayer(engine, { bus: music, crossfade: 2 });
  player.play(calm);

  scene.root.add({ rotation: axisAngle(1, 0.4, 0, -1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      diffuse: { x: 1.2, y: 1.15, z: 1.1 },
      ambient: { x: 0.18, y: 0.19, z: 0.22 },
    }),
  );
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  scene.root
    .add({
      // From the front right, to see the nose of the head.
      position: { x: -5, y: 4.5, z: -5 },
      rotation: multiplyQuat(
        axisAngle(0, 1, 0, (-3 * Math.PI) / 4),
        axisAngle(1, 0, 0, -0.55),
      ),
    })
    .setCamera(camera);
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  const input = new Input(new WebInputSource(canvas));
  const button = (...bindings: string[]) => ({
    type: 'button' as const,
    bindings,
  });
  const actions = new ActionMap(input, {
    chime: button('pointer:0', 'key:Space'),
    music: button('key:KeyM'),
    mute: button('key:KeyS'),
  });

  // The flash of a speaker that rang, in seconds.
  const flashes = speakers.map(() => 0);
  let rung = 0;
  let time = 0;
  const scheduler = new Scheduler();
  scheduler.add(
    'input',
    () => {
      input.update();
      if (actions.button('chime').pressed) {
        // In turn, at the place of the speaker.
        const index = rung++ % speakers.length;
        chime.playAt(speakers[index].worldPosition);
        flashes[index] = 0.3;
      }
      if (actions.button('music').pressed) {
        // The current values of the resources: a reload changes them.
        const { calm, tense } = handles;
        player.play(
          player.track === calm.value ? tense.require() : calm.require(),
        );
      }
      if (actions.button('mute').pressed) {
        sfx.muted = !sfx.muted;
      }
    },
    { phase: 'begin' },
  );
  // update: the speakers turn around the head, at their own speed.
  scheduler.add('speakers', (dt) => {
    speakers.forEach((speaker, i) => {
      const angle = time * (0.5 + 0.25 * i) + (i * 2 * Math.PI) / 3;
      const radius = 1.6 + 0.9 * i;
      flashes[i] = Math.max(0, flashes[i] - dt);
      const size = 0.7 + flashes[i];
      speaker.transform.position = {
        x: Math.sin(angle) * radius,
        y: 0.6 + 0.2 * Math.sin(time * 2 + i),
        z: -Math.cos(angle) * radius,
      };
      speaker.transform.scale = { x: size, y: size, z: size };
    });
  });
  // render: the listener and the hums where the nodes are, then the view.
  audio.install(scheduler);
  scheduler.add(
    'render',
    () => {
      renderer.render({
        source: scene,
        camera,
        surface,
        clearColor: { r: 0.08, g: 0.09, b: 0.11, a: 1 },
      });
      info(
        engine.state === 'running'
          ? `music: ${player.track === handles.calm.value ? 'calm' : 'tense'} · effects ${
              sfx.muted ? 'muted' : 'on'
            } · ${engine.voices.length} voices · click or Space: chime, M: music, S: mute`
          : 'click the canvas to start the sound',
      );
    },
    { phase: 'render', after: ['audio'] },
  );

  let last = 0;
  onFrame((now) => {
    time = now;
    scheduler.update(Math.min(now - last, 0.1));
    last = now;
  });
};

export default example;
