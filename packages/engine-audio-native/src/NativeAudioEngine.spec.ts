import { encodeWav, type Voice } from '@fdw/engine-audio';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAudioEngine } from './NativeAudioEngine';

const addon = new URL(
  '../../engine-native/build/fdw_native.node',
  import.meta.url,
);
const fixture = async (name: string) =>
  new Uint8Array(
    await readFile(
      new URL(`../../engine-audio/testing/${name}`, import.meta.url),
    ),
  );

const rate = 48000;
// A constant signal: what reaches each ear is its gain.
const constant = (value: number, seconds: number, sampleRate = rate) =>
  new Float32Array(Math.round(seconds * sampleRate)).fill(value);

describe.skipIf(!existsSync(addon))('NativeAudioEngine', () => {
  let engine: NativeAudioEngine;
  // The next `seconds` of the mix, interleaved stereo.
  const render = (seconds: number) => {
    const out = new Float32Array(Math.round(seconds * rate) * 2);
    expect(engine.render(out)).toBe(out.length / 2);
    engine.update();
    return out;
  };
  // The mean of a channel over the frames of `out` past the first ones (the
  // resampler takes a few to settle).
  const mean = (out: Float32Array, channel: number) => {
    let sum = 0;
    let count = 0;
    for (let i = 2 * 16 + channel; i < out.length; i += 2) {
      sum += out[i];
      count++;
    }
    return sum / count;
  };
  const energy = (out: Float32Array, channel: number) => {
    let sum = 0;
    for (let i = channel; i < out.length; i += 2) {
      sum += out[i] * out[i];
    }
    return Math.sqrt(sum / (out.length / 2));
  };

  afterEach(() => engine?.destroy());

  const create = () =>
    (engine = new NativeAudioEngine({
      offline: true,
      sampleRate: rate,
      channels: 2,
    }));

  it('mixes a clip into both ears, at its volume and the one of its bus', () => {
    create();
    expect(engine.sampleRate).toBe(rate);
    expect(engine.channels).toBe(2);
    const clip = engine.createClip([constant(0.5, 1)], rate);
    expect(clip.duration).toBe(1);
    expect(clip.byteLength).toBe(rate * 4);
    const sfx = engine.createBus('sfx', { volume: 0.5 });
    engine.play(clip, { bus: sfx, volume: 0.8 });
    const out = render(0.1);
    expect(mean(out, 0)).toBeCloseTo(0.5 * 0.8 * 0.5, 3);
    expect(mean(out, 1)).toBeCloseTo(0.2, 3);
    sfx.muted = true;
    expect(mean(render(0.1), 0)).toBeCloseTo(0, 5);
    sfx.muted = false;
    engine.master.volume = 0.5;
    expect(mean(render(0.1), 0)).toBeCloseTo(0.1, 3);
  });

  it('ends a voice at the end of its clip', async () => {
    create();
    const clip = engine.createClip([constant(0.5, 0.2)], rate);
    const voice = engine.play(clip);
    expect(voice.state).toBe('playing');
    expect(engine.voices).toEqual([voice]);
    render(0.1);
    // The sound reads ahead of the mix by a block (a few milliseconds).
    expect(voice.time).toBeGreaterThanOrEqual(0.1);
    expect(voice.time).toBeLessThan(0.11);
    render(0.15);
    expect(voice.state).toBe('stopped');
    expect(engine.voices).toEqual([]);
    await expect(voice.ended).resolves.toBeUndefined();
    // Silent after the end.
    expect(energy(render(0.05), 0)).toBe(0);
  });

  it('loops, pauses where it is, resumes', () => {
    create();
    const clip = engine.createClip([constant(0.5, 0.1)], rate);
    const voice = engine.play(clip, { loop: true });
    render(0.25);
    expect(voice.state).toBe('playing');
    expect(Math.abs(voice.time - 0.05)).toBeLessThan(0.01);
    voice.pause();
    expect(voice.state).toBe('paused');
    // Silent from the next block of the mix.
    expect(energy(render(0.2).subarray(2 * 960), 0)).toBe(0);
    expect(Math.abs(voice.time - 0.05)).toBeLessThan(0.01);
    voice.resume();
    expect(mean(render(0.05), 0)).toBeCloseTo(0.5, 2);
    voice.loop = false;
    render(0.2);
    expect(voice.state).toBe('stopped');
  });

  it('plays faster and higher at a higher pitch, resampled', () => {
    create();
    // A clip at half the rate of the engine: 1 s long.
    const clip = engine.createClip([constant(0.5, 1, rate / 2)], rate / 2);
    expect(clip.duration).toBe(1);
    const voice = engine.play(clip, { pitch: 2 });
    render(0.4);
    expect(voice.time).toBeCloseTo(0.8, 1);
    render(0.15);
    expect(voice.state).toBe('stopped');
  });

  it('pans a voice that is not spatial', () => {
    create();
    const clip = engine.createClip([constant(0.5, 1)], rate);
    const voice = engine.play(clip, { pan: -1 });
    // Both sides in the left ear, as in WebAudio.
    const out = render(0.1);
    expect(mean(out, 1)).toBeCloseTo(0, 3);
    expect(mean(out, 0)).toBeCloseTo(1, 3);
    voice.pan = 1;
    const right = render(0.1);
    expect(mean(right.subarray(2 * 480), 0)).toBeCloseTo(0, 3);
    expect(mean(right.subarray(2 * 480), 1)).toBeCloseTo(1, 3);
  });

  it('places a spatial voice around the listener, softer far away', () => {
    create();
    const clip = engine.createClip([constant(0.5, 2)], rate);
    // The listener at the origin, looking along -z: +x is on its right.
    engine.listener.setPose(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 1, z: 0 },
    );
    const voice = engine.play(clip, { spatial: { position: { x: 1 } } });
    const near = render(0.1);
    expect(mean(near, 1)).toBeGreaterThan(mean(near, 0) * 2);
    // Inverse: four times the distance, a quarter of the gain.
    voice.setPosition(4, 0, 0);
    render(0.05);
    const far = render(0.1);
    expect(energy(far, 1) / energy(near, 1)).toBeCloseTo(0.25, 1);
    // In front: both ears alike.
    voice.setPosition(0, 0, -1);
    render(0.05);
    const front = render(0.1);
    expect(mean(front, 0)).toBeCloseTo(mean(front, 1), 3);
    // Behind the listener turned around: in front again.
    engine.listener.setMatrix([
      -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1,
    ]);
    expect(engine.listener.forward).toEqual({ x: -0, y: -0, z: 1 });
  });

  it('falls silent past the maximum distance of the linear model', () => {
    create();
    const clip = engine.createClip([constant(0.5, 1)], rate);
    engine.play(clip, {
      spatial: {
        position: { x: 30 },
        distanceModel: 'linear',
        maxDistance: 20,
      },
    });
    expect(energy(render(0.1), 1)).toBe(0);
  });

  it('fades in, fades to a gain, fades out then stops', async () => {
    create();
    const clip = engine.createClip([constant(0.5, 10)], rate);
    const voice = engine.play(clip, { fadeIn: 0.1 });
    const rising = render(0.1);
    expect(rising[2 * 100]).toBeLessThan(0.05);
    expect(rising[2 * 4700]).toBeGreaterThan(0.45);
    voice.fadeTo(0.5, 0);
    render(0.01);
    expect(mean(render(0.05), 0)).toBeCloseTo(0.25, 2);
    voice.stop(0.1);
    render(0.05);
    expect(voice.state).toBe('playing');
    render(0.1);
    expect(voice.state).toBe('stopped');
    await voice.ended;
  });

  it('decodes the files: WAV, Ogg Vorbis, MP3, FLAC', async () => {
    create();
    const wav = await engine.decodeClip(
      encodeWav(
        [constant(0.25, 0.5, 22050), constant(-0.5, 0.5, 22050)],
        22050,
      ),
    );
    expect(wav).toMatchObject({
      channels: 2,
      sampleRate: 22050,
      frames: 11025,
    });
    const voice = engine.play(wav);
    const out = render(0.1);
    expect(mean(out, 0)).toBeCloseTo(0.25, 2);
    expect(mean(out, 1)).toBeCloseTo(-0.5, 2);
    voice.stop();

    const ogg = await engine.decodeClip(await fixture('tone.ogg'));
    expect(ogg).toMatchObject({ channels: 2, sampleRate: 44100 });
    expect(ogg.duration).toBeCloseTo(0.5, 1);
    const mp3 = await engine.decodeClip(await fixture('tone.mp3'));
    expect(mp3.sampleRate).toBe(44100);
    expect(mp3.duration).toBeCloseTo(0.5, 1);
    const flac = await engine.decodeClip(await fixture('tone.flac'));
    expect(flac).toMatchObject({ channels: 1, sampleRate: 22050 });
    expect(flac.duration).toBeCloseTo(0.5, 2);
    // A sine of amplitude 1/8: its energy is 1/8 over √2.
    engine.play(flac);
    expect(energy(render(0.2), 0)).toBeCloseTo(0.125 / Math.SQRT2, 2);
  });

  it('rejects what does not decode', async () => {
    create();
    await expect(
      engine.decodeClip(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow(/format/);
    await expect(
      engine.createStream(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow(/format/);
    const aborted = AbortSignal.abort();
    await expect(
      engine.decodeClip(await fixture('tone.ogg'), { signal: aborted }),
    ).rejects.toThrow();
  });

  it('streams a file, decoded while it plays, and loops it', async () => {
    create();
    const ogg = await engine.createStream(await fixture('tone.ogg'));
    expect(ogg.kind).toBe('stream');
    expect(ogg.duration).toBeCloseTo(0.5, 1);
    expect(ogg.byteLength).toBe(5021);
    const mp3 = await engine.createStream(await fixture('tone.mp3'));
    expect(mp3.duration).toBeCloseTo(0.5, 1);
    const voice = engine.play(ogg, { loop: true });
    // Two streams of one file, each with its decoder.
    const other = engine.play(ogg, { volume: 0 });
    render(0.7);
    expect(voice.state).toBe('playing');
    expect(voice.time).toBeCloseTo(0.2, 1);
    expect(other.state).toBe('stopped');
    expect(energy(render(0.1), 0)).toBeGreaterThan(0.05);
    const wav = await engine.createStream(
      encodeWav([constant(0.5, 0.25, 8000)], 8000),
    );
    expect(wav.duration).toBe(0.25);
  });

  it('keeps a clip playing once disposed, and refuses to play it again', () => {
    create();
    const clip = engine.createClip([constant(0.5, 1)], rate);
    const voice = engine.play(clip);
    clip.dispose();
    expect(clip.disposed).toBe(true);
    expect(mean(render(0.1), 0)).toBeCloseTo(0.5, 3);
    expect(voice.state).toBe('playing');
    expect(() => engine.play(clip)).toThrow(/disposed/);
  });

  it('stops the voices of a bus and of the buses under it', () => {
    create();
    const clip = engine.createClip([constant(0.5, 1)], rate);
    const sfx = engine.createBus('sfx');
    const steps = engine.createBus('steps', { parent: sfx });
    const music = engine.createBus('music');
    const a = engine.play(clip, { bus: steps });
    const b = engine.play(clip, { bus: music });
    sfx.stopAll();
    render(0.01);
    expect(a.state).toBe('stopped');
    expect(b.state).toBe('playing');
  });

  it('frees hundreds of voices ended in one frame', () => {
    create();
    const clip = engine.createClip([constant(0.001, 0.01)], rate);
    const voices: Voice[] = [];
    for (let i = 0; i < 300; i++) {
      voices.push(engine.play(clip));
    }
    render(0.05);
    expect(engine.voices.length).toBe(0);
    expect(voices.every((voice) => voice.state === 'stopped')).toBe(true);
  });

  it('starts paused, and resolves the voices when destroyed', async () => {
    create();
    const clip = engine.createClip([constant(0.5, 1)], rate);
    const voice = engine.play(clip, { paused: true, offset: 0.5 });
    expect(voice.state).toBe('paused');
    expect(energy(render(0.1), 0)).toBe(0);
    voice.resume();
    render(0.1);
    expect(Math.abs(voice.time - 0.6)).toBeLessThan(0.01);
    engine.destroy();
    expect(engine.state).toBe('closed');
    await voice.ended;
    expect(() => engine.play(clip)).toThrow(/destroyed/);
  });

  it('opens the default device, or the null one', async () => {
    engine = new NativeAudioEngine();
    expect(engine.sampleRate).toBeGreaterThan(0);
    await engine.suspend();
    expect(engine.state).toBe('suspended');
    await engine.resume();
    expect(engine.state).toBe('running');
    expect(() => engine.render(new Float32Array(2))).toThrow(/offline/);
  });
});
