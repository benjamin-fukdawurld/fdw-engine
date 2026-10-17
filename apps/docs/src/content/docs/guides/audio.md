---
title: Audio
description: The abstract audio API, its buses, voices and listener, the effects and the music, its binding to the scene, WebAudio and miniaudio, and how to plug another audio engine.
sidebar:
  order: 14
---

The engine does not mix sound itself: it defines what it asks of an audio
engine, and plays on the one of the platform.

- `@fdw/engine-audio`: the **abstract API** (engine, buses, clips, streams,
  voices, listener), the **effects** (`SoundEffect`) and the **music**
  (`MusicPlayer`), the **binding to the scene** (`SceneAudio`), the
  **loaders** of the resource system, and a `FakeAudioEngine` for the
  tests. It depends on no audio library.
- `@fdw/engine-audio-web`: the API on **WebAudio**, in a page.
- `@fdw/engine-audio-native`: the API on **miniaudio**, in Node (the native
  demos), through the addon of `@fdw/engine-native`.

The tutorial [Audio](/fdw-engine/tutorials/audio/) puts them together.

## The API

| Interface       | What it is                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `AudioEngine`   | An implementation: decodes, mixes, plays; its buses, its listener, its voices, `update()`      |
| `AudioBus`      | A mix at a volume: `volume`, `muted`, `stopAll(fadeOut)`; the master bus is the output         |
| `AudioClip`     | Decoded samples: `duration`, `sampleRate`, `channels`, `frames`, `byteLength`, `dispose()`     |
| `AudioStream`   | Encoded bytes, decoded while playing: `duration` (NaN when unknown), `byteLength`, `dispose()` |
| `Voice`         | A source playing: `state`, `time`, `volume`, `pitch`, `pan`, `loop`, fades, `stop`, `ended`    |
| `AudioListener` | Where the sound is heard from: `setPose(position, forward, up)`, `setMatrix(worldMatrix)`      |

Volumes are linear gains (1 is unchanged, 0.5 about 6 dB lower); times are
seconds; positions are meters, y up, as in the scene.

### The engine

| Member                                | Use                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `createBus(name, { parent, volume })` | A bus, under the master unless told; `bus(name)` finds it                 |
| `createClip(channels, sampleRate)`    | A clip from samples, one `Float32Array` per channel: a sound made by code |
| `decodeClip(bytes, { signal })`       | A clip from a WAV, Ogg Vorbis, MP3 or FLAC file                           |
| `createStream(bytes, { signal })`     | A stream of such a file, kept encoded                                     |
| `play(source, options)`               | A new voice                                                               |
| `voices`                              | The voices alive: playing, paused or fading out                           |
| `state`, `resume()`, `suspend()`      | `running`, `suspended` (a page before a gesture) or `closed`              |
| `time`, `sampleRate`                  | The clock of the mix                                                      |
| `update()`                            | At each frame: the voices that ended are freed, their `ended` resolved    |
| `destroy()`                           | Stops everything, frees the engine                                        |

### Playing

```ts
const voice = engine.play(source, {
  bus: sfx, // default the master
  volume: 1,
  pitch: 1, // the playback rate: 2 is an octave up, twice faster
  pan: 0, // -1 left, 1 right, for a voice that is not spatial
  loop: false,
  offset: 0, // starts at, in seconds
  fadeIn: 0, // rises from silence in, seconds
  paused: false, // resume() starts it
  spatial: {
    // only for a voice placed in the world
    position: { x: 0, y: 0, z: 0 },
    refDistance: 1,
    maxDistance: 100,
    rolloff: 1,
    distanceModel: 'inverse', // 'linear', 'exponential'
  },
});
```

A voice has two gains, multiplied: its `volume`, set at once, and its
**fade**, moved over time by `fadeTo(gain, seconds)`, `fadeIn` and
`stop(fadeOut)`. A voice stopped or at its end is gone: playing the source
again makes a new voice.

**Panning**: a mono source goes to both ears at full gain; `pan` moves one
side into the other — at -1, everything is in the left ear. A stereo source
keeps its sides at 0.

**Distance**, for a spatial voice at `d` meters, `r` its `refDistance`,
`f` its `rolloff`, `m` its `maxDistance` (the models of WebAudio):

| Model         | Gain                                   |
| ------------- | -------------------------------------- |
| `inverse`     | `r / (r + f (max(d, r) - r))`          |
| `linear`      | `1 - f (clamp(d, r, m) - r) / (m - r)` |
| `exponential` | `(max(d, r) / r)^-f`                   |

There is no Doppler effect.

### Effects and music

`SoundEffect` plays a short sound often: variations (one drawn per play,
never the same twice in a row), `volumeVariation` and `pitchVariation`
(`± fraction`), `maxVoices` (the oldest stops for the newest, faded in
`stealFade` seconds), `cooldown`; `play(overrides)`, `playAt(position)`,
`voices`, `stop(fadeOut)`. A `random` function makes it deterministic.

`MusicPlayer` plays one track at a time, looped by default, crossfading
from one to the next (`crossfade` seconds); `track`, `voice`,
`play(track, { crossfade, volume, loop, offset, restart })`,
`stop(fadeOut)`, `pause()`, `resume()`.

### The scene

`SceneAudio(scene, engine)`:

- `listener`: the node the listener follows (its world matrix, looking
  along -z);
- `play(node, source, options)`: a spatial voice at the node, which follows
  it; `attach(node, voice)` for a voice played elsewhere; `voicesOf(node)`;
- `update()`: the listener and the voices where their nodes are, then
  `engine.update()`; `install(scheduler)` makes it the `audio` system of the
  `render` phase;
- the voices of a node are a component of its entity (`audio emitter`):
  they stop, faded in `removeFade` seconds, when the node is removed.

### Resources

`installAudio(store, engine)` registers two loaders and the
`AudioEngineService`:

| Type              | Value         | Loader                      |
| ----------------- | ------------- | --------------------------- |
| `AudioClipType`   | `AudioClip`   | `decodeClip` of the bytes   |
| `AudioStreamType` | `AudioStream` | `createStream` of the bytes |

Both recognize `.wav`, `.ogg`, `.oga`, `.mp3`, `.flac`, their MIME types,
and the first bytes of the files (`sniffAudioFormat`). Their size, for the
budget of the cache, is their `byteLength`; a released entry disposes of
its sound. `encodeWav(channels, sampleRate)` writes a WAV file from
samples.

## WebAudio

```ts
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';

const engine = new WebAudioEngine({ panningModel: 'HRTF' });
unlockAudio(engine); // resumes at the first gesture on the window
```

- The clips are `AudioBuffer`s, resampled to the rate of the context by
  `decodeAudioData`; the buses are `GainNode`s; a voice is a source, a
  gain, a fade gain, and a `StereoPannerNode` or a `PannerNode`.
- The **streams** are media elements reading the bytes from an object URL
  (`MediaElementAudioSourceNode`): the browser decodes them as they play.
  The duration comes from the metadata of the file.
- **The gesture**: a page cannot start its sound by itself. The context
  starts suspended; `resume()` from a click or a key starts it, and
  `unlockAudio(engine, target)` does it at the first one. The voices played
  before are kept: they are heard from then.
- `panningModel`: `equalpower` by default; `HRTF` places the sounds better
  with headphones, for more work.
- `context`: an `OfflineAudioContext` renders the mix into a buffer, faster
  than real time (the tests). Without media elements there, the streams are
  decoded at once.

## miniaudio

```ts
import { NativeAudioEngine } from '@fdw/engine-audio-native';

const engine = new NativeAudioEngine();
```

- [miniaudio](https://miniaud.io) (0.11, public domain or MIT-0) is
  compiled into the addon of `@fdw/engine-native`, with its decoders (WAV,
  FLAC, MP3) and `stb_vorbis` (Ogg Vorbis). It mixes on its own thread, on
  the default device: PulseAudio or ALSA on Linux, CoreAudio on macOS,
  WASAPI on Windows — and a null device when there is none, so the code runs
  the same on a server.
- The **clips** are decoded on the thread pool of libuv, never on the
  JavaScript thread, at the rate of the file; a voice resamples. A clip is
  shared by its voices, and freed once the last one is done.
- A **stream** keeps the bytes of the file in native memory; each voice has
  its own decoder, run by the mixing thread.
- `offline: true`: no device; `render(out)` mixes the next frames into an
  array (the tests, or a sound rendered to a file).
- The library has a C API (`native/include/fdw/audio.h`), usable by another
  host.

## Differences between the engines

They follow the same contract, checked by the same kinds of tests (the
voices end, loop, pause, fade; the buses; the distance models; the
decoders). What differs:

- **The panning between the ears** of a spatial voice: equal power in
  WebAudio, the spatializer of miniaudio natively (it keeps a little of the
  sound in the far ear). The distance attenuation is the same.
- **The start**: immediate natively; after a gesture in a page.
- **The time of a voice** natively runs a few milliseconds ahead: the mixer
  reads its sources by blocks.

## Plugging another engine

Implement `AudioEngine` (FMOD, Wwise, OpenAL, a mixer of yours), with its
`AudioBus`, `AudioClip`, `AudioStream` and `Voice`. `resolvePlay(options)`
gives the defaults of `play`, `AudioListenerPose` keeps the pose of the
listener and hands it to you. `SoundEffect`, `MusicPlayer`, `SceneAudio` and
the loaders are written against the API: they work as they are.

`FakeAudioEngine` is such an engine, without sound: `advance(seconds)`
moves its clock and its voices, which keep what they were told (positions,
fades, volumes). The tests of a game use it.
