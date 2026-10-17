import { MemorySource, ResourceStore } from '@fdw/engine-resources';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  AudioClipType,
  AudioStreamType,
  encodeWav,
  FakeAudioEngine,
  installAudio,
  isUnder,
  MusicPlayer,
  poseOfMatrix,
  resolvePlay,
  SceneAudio,
  sniffAudioFormat,
  SoundEffect,
  type AudioEngine,
  type FakeVoice,
} from './index';

// A clip of `seconds` seconds of silence at 1000 Hz.
const silence = (engine: AudioEngine, seconds: number) =>
  engine.createClip([new Float32Array(Math.round(seconds * 1000))], 1000);

// A sequence of draws, for Math.random.
const draws = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('the API', () => {
  it('resolves the options of play', () => {
    const o = resolvePlay();
    expect(o).toMatchObject({
      volume: 1,
      pitch: 1,
      pan: 0,
      loop: false,
      isSpatial: false,
    });
    const s = resolvePlay({ spatial: { position: { x: 2 }, rolloff: 3 } });
    expect(s.isSpatial).toBe(true);
    expect(s.spatial).toEqual({
      position: { x: 2, y: 0, z: 0 },
      refDistance: 1,
      maxDistance: 100,
      rolloff: 3,
      distanceModel: 'inverse',
    });
  });

  it('reads the pose of a camera in its world matrix', () => {
    // Turned a quarter around y: looking along -x, at (1, 2, 3).
    const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1];
    const [position, forward, up] = poseOfMatrix(m);
    expect(position).toEqual({ x: 1, y: 2, z: 3 });
    expect(forward).toEqual({ x: -1, y: -0, z: -0 });
    expect(up).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('normalizes the pose of the listener', () => {
    const engine = new FakeAudioEngine();
    engine.listener.setPose(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: -4 },
      { x: 0, y: 0, z: 0 },
    );
    expect(engine.listener.forward).toEqual({ x: 0, y: 0, z: -1 });
    // A null up falls back to y.
    expect(engine.listener.up).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('tells whether a bus is under another', () => {
    const engine = new FakeAudioEngine();
    const sfx = engine.createBus('sfx');
    const steps = engine.createBus('steps', { parent: sfx });
    expect(isUnder(steps, engine.master)).toBe(true);
    expect(isUnder(steps, sfx)).toBe(true);
    expect(isUnder(sfx, steps)).toBe(false);
    expect(engine.bus('steps')).toBe(steps);
    expect(() => engine.createBus('sfx')).toThrow(/exists/);
  });
});

describe('the formats', () => {
  it('writes a WAV file and recognizes the formats', () => {
    const left = new Float32Array([0, 1, -1, 2]);
    const right = new Float32Array([0.5, 0, 0, 0]);
    const wav = encodeWav([left, right], 22050);
    const view = new DataView(wav.buffer);
    expect(wav.byteLength).toBe(44 + 4 * 2 * 2);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(22050);
    // Interleaved, clamped.
    expect(view.getInt16(44 + 2, true)).toBe(16384);
    expect(view.getInt16(44 + 12, true)).toBe(32767);
    expect(sniffAudioFormat(wav)).toBe('wav');
    const ascii = (text: string) =>
      new Uint8Array([...text].map((c) => c.charCodeAt(0)));
    expect(sniffAudioFormat(ascii('OggS\0\x02'))).toBe('ogg');
    expect(sniffAudioFormat(ascii('fLaC'))).toBe('flac');
    expect(sniffAudioFormat(ascii('ID3\x04'))).toBe('mp3');
    expect(sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90]))).toBe('mp3');
    expect(sniffAudioFormat(ascii('PK\x03\x04'))).toBeUndefined();
  });
});

describe('the fake engine', () => {
  it('ends the voices at the end of their source, at their pitch', async () => {
    const engine = new FakeAudioEngine();
    const clip = silence(engine, 1);
    const normal = engine.play(clip);
    const fast = engine.play(clip, { pitch: 2 });
    const looped = engine.play(clip, { loop: true });
    engine.advance(0.6);
    engine.update();
    expect(fast.state).toBe('stopped');
    expect(engine.voices).toEqual([normal, looped]);
    engine.advance(0.6);
    engine.update();
    expect(normal.state).toBe('stopped');
    expect(looped.time).toBeCloseTo(0.2);
    await expect(normal.ended).resolves.toBeUndefined();
  });

  it('stops the voices of a bus and of the buses under it', () => {
    const engine = new FakeAudioEngine();
    const clip = silence(engine, 1);
    const sfx = engine.createBus('sfx');
    const steps = engine.createBus('steps', { parent: sfx });
    const music = engine.createBus('music');
    const a = engine.play(clip, { bus: steps });
    const b = engine.play(clip, { bus: music });
    sfx.stopAll();
    expect(a.state).toBe('stopped');
    expect(b.state).toBe('playing');
  });

  it('fades, then stops after the fade', () => {
    const engine = new FakeAudioEngine();
    const voice = engine.play(silence(engine, 10), { fadeIn: 1 });
    engine.advance(0.5);
    expect(voice.fade).toBeCloseTo(0.5);
    engine.advance(0.5);
    voice.stop(2);
    expect(voice.stopping).toBe(true);
    engine.advance(1);
    expect(voice.fade).toBeCloseTo(0.5);
    expect(voice.state).toBe('playing');
    engine.advance(1);
    expect(voice.state).toBe('stopped');
  });
});

describe('SoundEffect', () => {
  it('draws another variation than the last one', () => {
    const engine = new FakeAudioEngine();
    const clips = [silence(engine, 1), silence(engine, 1), silence(engine, 1)];
    const effect = new SoundEffect(engine, clips, {
      maxVoices: 10,
      random: draws(0, 0, 0.99, 0.99, 0.4, 0.4),
    });
    const picked = Array.from({ length: 6 }, () => {
      const voice = effect.play();
      return clips.indexOf(voice?.source as (typeof clips)[number]);
    });
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i]).not.toBe(picked[i - 1]);
    }
    expect(new Set(picked).size).toBe(3);
  });

  it('varies the volume and the pitch around theirs', () => {
    const engine = new FakeAudioEngine();
    const effect = new SoundEffect(engine, silence(engine, 1), {
      volume: 0.5,
      pitch: 2,
      volumeVariation: 0.2,
      pitchVariation: 0.1,
      random: draws(0, 1),
    });
    const voice = effect.play() as FakeVoice;
    // random 0 for the volume (the low end), 1 for the pitch (the high one).
    expect(voice.volume).toBeCloseTo(0.4);
    expect(voice.pitch).toBeCloseTo(2.2);
  });

  it('stops the oldest voice past its maximum', () => {
    const engine = new FakeAudioEngine();
    const effect = new SoundEffect(engine, silence(engine, 1), {
      maxVoices: 2,
      stealFade: 0,
    });
    const [a, b, c] = [effect.play(), effect.play(), effect.play()];
    expect(a?.state).toBe('stopped');
    expect(b?.state).toBe('playing');
    expect(effect.voices).toEqual([b, c]);
  });

  it('drops the plays within its cooldown', () => {
    const engine = new FakeAudioEngine();
    const effect = new SoundEffect(engine, silence(engine, 1), {
      cooldown: 0.1,
    });
    expect(effect.play()).toBeDefined();
    engine.advance(0.05);
    expect(effect.play()).toBeUndefined();
    engine.advance(0.06);
    expect(effect.play()).toBeDefined();
  });

  it('plays in the world', () => {
    const engine = new FakeAudioEngine();
    const effect = new SoundEffect(engine, silence(engine, 1), {
      spatial: { refDistance: 2 },
    });
    const voice = effect.playAt({ x: 3, z: -1 }) as FakeVoice;
    expect(voice.spatial).toBe(true);
    expect(voice.position).toEqual({ x: 3, y: 0, z: -1 });
    expect(voice.options.spatial.refDistance).toBe(2);
  });
});

describe('MusicPlayer', () => {
  it('crossfades from a track to the next one', () => {
    const engine = new FakeAudioEngine();
    const music = engine.createBus('music');
    const explore = silence(engine, 60);
    const fight = silence(engine, 60);
    const player = new MusicPlayer(engine, { bus: music, crossfade: 2 });
    const first = player.play(explore) as FakeVoice;
    // The first one starts at once, in a loop.
    expect(first.loop).toBe(true);
    expect(first.fade).toBe(1);
    expect(first.bus).toBe(music);
    engine.advance(5);
    const second = player.play(fight) as FakeVoice;
    expect(player.track).toBe(fight);
    engine.advance(1);
    expect(first.fade).toBeCloseTo(0.5);
    expect(second.fade).toBeCloseTo(0.5);
    engine.advance(1);
    engine.update();
    expect(first.state).toBe('stopped');
    expect(second.fade).toBe(1);
  });

  it('keeps the track playing, unless told to restart it', () => {
    const engine = new FakeAudioEngine();
    const track = silence(engine, 60);
    const player = new MusicPlayer(engine);
    const voice = player.play(track);
    expect(player.play(track)).toBe(voice);
    expect(player.play(track, { restart: true })).not.toBe(voice);
  });

  it('fades the music out', () => {
    const engine = new FakeAudioEngine();
    const player = new MusicPlayer(engine, { crossfade: 1 });
    const voice = player.play(silence(engine, 60));
    player.stop();
    expect(player.track).toBeUndefined();
    engine.advance(1);
    expect(voice.state).toBe('stopped');
  });
});

describe('SceneAudio', () => {
  it('moves the listener and the voices with their nodes', () => {
    const scene = new Scene();
    const engine = new FakeAudioEngine();
    const audio = new SceneAudio(scene, engine);
    const eye = scene.root.add({ position: { x: 1, y: 2, z: 3 } });
    audio.listener = eye;
    const drone = scene.root.add({ position: { x: 5 } });
    const voice = audio.play(drone, silence(engine, 10), {
      spatial: { rolloff: 2 },
    }) as FakeVoice;
    expect(voice.spatial).toBe(true);
    expect(voice.position).toEqual({ x: 5, y: 0, z: 0 });
    expect(voice.options.spatial.rolloff).toBe(2);
    expect(audio.voicesOf(drone)).toEqual([voice]);
    drone.transform.position = { x: 6, y: 1, z: 0 };
    audio.update();
    expect(voice.position).toEqual({ x: 6, y: 1, z: 0 });
    expect(engine.listener.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(engine.listener.forward).toEqual({ x: -0, y: -0, z: -1 });
  });

  it('stops the voices of a node removed', () => {
    const scene = new Scene();
    const engine = new FakeAudioEngine();
    const audio = new SceneAudio(scene, engine, { removeFade: 0 });
    const drone = scene.root.add();
    const voice = audio.play(drone, silence(engine, 10), { loop: true });
    drone.remove();
    expect(voice.state).toBe('stopped');
  });

  it('lets the node go once its voices ended', () => {
    const scene = new Scene();
    const engine = new FakeAudioEngine();
    const audio = new SceneAudio(scene, engine);
    const node = scene.root.add();
    audio.play(node, silence(engine, 0.5));
    engine.advance(1);
    audio.update();
    expect(audio.voicesOf(node)).toEqual([]);
    expect(engine.voices).toEqual([]);
  });

  it('refuses a voice that is not spatial', () => {
    const scene = new Scene();
    const engine = new FakeAudioEngine();
    const audio = new SceneAudio(scene, engine);
    const voice = engine.play(silence(engine, 1));
    expect(() => audio.attach(scene.root.add(), voice)).toThrow(/spatial/);
  });

  it('is a system of the render phase', () => {
    const scene = new Scene();
    const engine = new FakeAudioEngine();
    const audio = new SceneAudio(scene, engine);
    const scheduler = new Scheduler();
    audio.install(scheduler);
    const system = scheduler.system('audio');
    expect(system?.phase).toBe('render');
  });
});

describe('the resources', () => {
  it('loads clips and streams through the engine of the store', async () => {
    const engine = new FakeAudioEngine({ decodedDuration: 2 });
    const store = new ResourceStore();
    const wav = encodeWav([new Float32Array(100)], 8000);
    store.mount(
      'mem',
      new MemorySource({ 'shot.wav': wav, 'theme.ogg': wav }),
      {
        default: true,
      },
    );
    installAudio(store, engine);
    const clip = await store.load(AudioClipType, 'shot.wav').ready;
    expect(clip.kind).toBe('clip');
    expect(clip.duration).toBe(2);
    const stream = await store.load(AudioStreamType, 'theme.ogg').ready;
    expect(stream.kind).toBe('stream');
    expect(stream.byteLength).toBe(wav.byteLength);
  });

  it('reports a sound that does not decode', async () => {
    const engine = new FakeAudioEngine();
    engine.decodeClip = () => Promise.reject(new Error('bad header'));
    const store = new ResourceStore();
    store.mount('mem', new MemorySource({ 'bad.wav': 'nope' }), {
      default: true,
    });
    installAudio(store, engine);
    await expect(
      store.load(AudioClipType, 'bad.wav').ready,
    ).rejects.toMatchObject({
      code: 'decode',
      message: expect.stringContaining('bad header'),
    });
  });
});
