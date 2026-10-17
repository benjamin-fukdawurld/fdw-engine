import { encodeWav, FakeAudioEngine } from '@fdw/engine-audio';
import { afterEach, describe, expect, it } from 'vitest';
import { unlockAudio, WebAudioEngine } from './WebAudioEngine';

const rate = 48000;
const constant = (value: number, seconds: number, sampleRate = rate) =>
  new Float32Array(Math.round(seconds * sampleRate)).fill(value);
// The sound files of engine-audio/testing, served at the root.
const [oggUrl, mp3Url, flacUrl] = ['/tone.ogg', '/tone.mp3', '/tone.flac'];
const fixture = async (url: string) =>
  new Uint8Array(await (await fetch(url)).arrayBuffer());

// An engine on an offline context of `seconds` seconds, stereo.
const offline = (seconds: number) =>
  new WebAudioEngine({
    context: new OfflineAudioContext(2, Math.round(seconds * rate), rate),
  });

// The mean of a channel between two times.
const mean = (
  buffer: AudioBuffer,
  channel: number,
  from: number,
  to: number,
) => {
  const data = buffer.getChannelData(channel);
  let sum = 0;
  const [a, b] = [Math.round(from * rate), Math.round(to * rate)];
  for (let i = a; i < b; i++) {
    sum += data[i];
  }
  return sum / (b - a);
};
const energy = (
  buffer: AudioBuffer,
  channel: number,
  from: number,
  to: number,
) => {
  const data = buffer.getChannelData(channel);
  let sum = 0;
  const [a, b] = [Math.round(from * rate), Math.round(to * rate)];
  for (let i = a; i < b; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / (b - a));
};
const render = (engine: WebAudioEngine) =>
  (engine.context as OfflineAudioContext).startRendering();
// Runs `then` at `time` of the rendering.
const at = (engine: WebAudioEngine, time: number, then: () => void) => {
  const context = engine.context as OfflineAudioContext;
  void context.suspend(time).then(() => {
    then();
    void context.resume();
  });
};

describe('WebAudioEngine', () => {
  let engine: WebAudioEngine | undefined;
  afterEach(() => engine?.destroy());

  it('mixes a clip at its volume and the one of its bus', async () => {
    const e = (engine = offline(0.3));
    const clip = e.createClip([constant(0.5, 1)], rate);
    expect(clip).toMatchObject({ duration: 1, channels: 1, frames: rate });
    const sfx = e.createBus('sfx', { volume: 0.5 });
    e.play(clip, { bus: sfx, volume: 0.8 });
    at(e, 0.1, () => (sfx.muted = true));
    at(e, 0.2, () => {
      sfx.muted = false;
      e.master.volume = 0.5;
    });
    const out = await render(e);
    // A mono source on both ears, at full gain.
    expect(mean(out, 0, 0.01, 0.09)).toBeCloseTo(0.2, 3);
    expect(mean(out, 1, 0.01, 0.09)).toBeCloseTo(0.2, 3);
    expect(mean(out, 0, 0.11, 0.19)).toBeCloseTo(0, 5);
    expect(mean(out, 0, 0.21, 0.29)).toBeCloseTo(0.1, 3);
  });

  it('ends a voice at the end of its clip', async () => {
    const e = (engine = offline(0.3));
    const voice = e.play(e.createClip([constant(0.5, 0.1)], rate));
    expect(voice.state).toBe('playing');
    const out = await render(e);
    expect(voice.state).toBe('stopped');
    expect(e.voices).toEqual([voice]);
    e.update();
    expect(e.voices).toEqual([]);
    await voice.ended;
    expect(energy(out, 0, 0.11, 0.3)).toBe(0);
  });

  it('loops, pauses where it is, resumes, at its pitch', async () => {
    const e = (engine = offline(0.6));
    const clip = e.createClip([constant(0.5, 0.1)], rate);
    const voice = e.play(clip, { loop: true, pitch: 2 });
    const times: number[] = [];
    at(e, 0.125, () => {
      times.push(voice.time);
      voice.pause();
      times.push(voice.time);
    });
    at(e, 0.25, () => {
      voice.resume();
      voice.pitch = 1;
    });
    at(e, 0.275, () => times.push(voice.time));
    const out = await render(e);
    // 0.25 s of the clip at twice its speed: 0.05 in its third loop.
    expect(times[0]).toBeCloseTo(0.05, 2);
    expect(times[1]).toBeCloseTo(0.05, 2);
    expect(times[2]).toBeCloseTo(0.075, 2);
    expect(voice.state).toBe('playing');
    expect(energy(out, 0, 0.13, 0.24)).toBe(0);
    expect(mean(out, 0, 0.26, 0.6)).toBeCloseTo(0.5, 3);
  });

  it('pans a voice that is not spatial', async () => {
    const e = (engine = offline(0.1));
    e.play(e.createClip([constant(0.5, 1)], rate), { pan: -1 });
    const out = await render(e);
    // Both sides in the left ear.
    expect(mean(out, 1, 0, 0.1)).toBeCloseTo(0, 5);
    expect(mean(out, 0, 0, 0.1)).toBeCloseTo(1, 3);
  });

  it('places a spatial voice around the listener, softer far away', async () => {
    const e = (engine = offline(0.3));
    const clip = e.createClip([constant(0.5, 1)], rate);
    e.listener.setPose(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 1, z: 0 },
    );
    const voice = e.play(clip, { spatial: { position: { x: 1 } } });
    expect(voice.spatial).toBe(true);
    at(e, 0.1, () => voice.setPosition(4, 0, 0));
    at(e, 0.2, () => voice.setPosition(0, 0, -1));
    const out = await render(e);
    // On the right only, with equal power panning.
    expect(mean(out, 0, 0.01, 0.09)).toBeCloseTo(0, 3);
    const near = mean(out, 1, 0.01, 0.09);
    expect(near).toBeCloseTo(0.5, 2);
    expect(mean(out, 1, 0.11, 0.19) / near).toBeCloseTo(0.25, 2);
    expect(mean(out, 0, 0.21, 0.29)).toBeCloseTo(mean(out, 1, 0.21, 0.29), 3);
  });

  it('fades in, fades out then stops', async () => {
    const e = (engine = offline(0.5));
    const voice = e.play(e.createClip([constant(0.5, 1)], rate), {
      fadeIn: 0.1,
    });
    at(e, 0.2, () => voice.stop(0.1));
    const out = await render(e);
    expect(mean(out, 0, 0, 0.01)).toBeLessThan(0.05);
    expect(mean(out, 0, 0.1, 0.2)).toBeCloseTo(0.5, 3);
    expect(mean(out, 0, 0.24, 0.26)).toBeCloseTo(0.25, 1);
    expect(energy(out, 0, 0.31, 0.5)).toBe(0);
    e.update();
    expect(voice.state).toBe('stopped');
    await voice.ended;
  });

  it('decodes the files: WAV, Ogg Vorbis, MP3, FLAC', async () => {
    const e = (engine = offline(0.1));
    const wav = await e.decodeClip(
      encodeWav(
        [constant(0.25, 0.5, 22050), constant(-0.5, 0.5, 22050)],
        22050,
      ),
    );
    // Resampled to the rate of the context.
    expect(wav).toMatchObject({ channels: 2, sampleRate: rate });
    expect(wav.duration).toBeCloseTo(0.5, 3);
    for (const url of [oggUrl, mp3Url, flacUrl]) {
      const clip = await e.decodeClip(await fixture(url));
      expect(clip.duration).toBeCloseTo(0.5, 1);
    }
    e.play(wav);
    const out = await render(e);
    expect(mean(out, 0, 0.01, 0.09)).toBeCloseTo(0.25, 2);
    expect(mean(out, 1, 0.01, 0.09)).toBeCloseTo(-0.5, 2);
    await expect(e.decodeClip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });

  it('decodes a stream at once without media elements', async () => {
    const e = (engine = offline(0.2));
    const stream = await e.createStream(await fixture(oggUrl));
    expect(stream.kind).toBe('stream');
    expect(stream.duration).toBeCloseTo(0.5, 1);
    e.play(stream);
    const out = await render(e);
    expect(energy(out, 0, 0.05, 0.15)).toBeGreaterThan(0.05);
  });

  it('streams a file through a media element', async () => {
    const e = (engine = new WebAudioEngine());
    await e.resume();
    expect(e.state).toBe('running');
    const stream = await e.createStream(await fixture(oggUrl));
    expect(stream.duration).toBeCloseTo(0.5, 1);
    expect(stream.byteLength).toBe(5021);
    const voice = e.play(stream, { loop: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    e.update();
    expect(voice.state).toBe('playing');
    expect(voice.time).toBeGreaterThan(0);
    voice.stop();
    e.update();
    await voice.ended;
    stream.dispose();
    expect(() => e.play(stream)).toThrow(/disposed/);
    await expect(e.createStream(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      /cannot play/,
    );
  });

  it('stops the voices of a bus and of the buses under it', () => {
    const e = (engine = offline(0.1));
    const clip = e.createClip([constant(0.5, 1)], rate);
    const sfx = e.createBus('sfx');
    const steps = e.createBus('steps', { parent: sfx });
    const a = e.play(clip, { bus: steps });
    const b = e.play(clip, { bus: e.createBus('music') });
    sfx.stopAll();
    expect(a.state).toBe('stopped');
    expect(b.state).toBe('playing');
    expect(e.bus('steps')).toBe(steps);
  });

  it('refuses the sounds of another kind of engine and the disposed ones', () => {
    const e = (engine = offline(0.1));
    const fake = new FakeAudioEngine();
    const clip = fake.createClip([constant(0.5, 1)], rate);
    expect(() => e.play(clip)).toThrow(/another/);
    const own = e.createClip([constant(0.5, 1)], rate);
    own.dispose();
    expect(() => e.play(own)).toThrow(/disposed/);
  });

  it('resumes at the first gesture', async () => {
    const e = (engine = new WebAudioEngine());
    await e.suspend();
    expect(e.state).toBe('suspended');
    const target = new EventTarget();
    unlockAudio(e, target);
    target.dispatchEvent(new Event('pointerdown'));
    await expect.poll(() => e.state).toBe('running');
  });
});
