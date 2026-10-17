# @fdw/engine-audio

The audio of FdwEngine, without an audio library: the abstract API an audio engine implements (engines, buses, clips, streams, voices, a listener), short sound effects (`SoundEffect`: variations, random pitch and volume, bounded voices, cooldown), music (`MusicPlayer`: one track at a time, crossfaded), the binding to the scene (`SceneAudio`: the listener follows a node, the voices played at a node follow it) and the loaders of the resource system. `@fdw/engine-audio-web` implements it on WebAudio, `@fdw/engine-audio-native` on miniaudio. See [design/p7-audio.md](../../design/p7-audio.md) (in French), the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/audio/) and the [guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/audio/).

```ts
import {
  AudioClipType,
  AudioStreamType,
  installAudio,
  MusicPlayer,
  SceneAudio,
  SoundEffect,
} from '@fdw/engine-audio';
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';

const engine = new WebAudioEngine(); // or new NativeAudioEngine() in Node
unlockAudio(engine); // a page starts its sound at the first gesture
const sfx = engine.createBus('sfx');

installAudio(resources, engine);
const shot = await resources.load(AudioClipType, 'shot.ogg').ready;
const theme = await resources.load(AudioStreamType, 'theme.ogg').ready;

new SoundEffect(engine, shot, { bus: sfx, pitchVariation: 0.08 }).play();
new MusicPlayer(engine, { crossfade: 2 }).play(theme);

const audio = new SceneAudio(scene, engine);
audio.listener = cameraNode;
audio.play(drone, hum, { loop: true }); // follows the drone
audio.install(scheduler); // the `audio` system, in the render phase
```

- **The API** (`AudioEngine`, `AudioBus`, `AudioClip`, `AudioStream`, `Voice`, `AudioListener`): linear gains, seconds, meters, y up; `play(source, options)` makes a voice, `engine.update()` at each frame frees the ended ones.
- **Clips and streams**: a clip holds decoded samples (short sounds, played often), a stream the encoded bytes, decoded while playing (music).
- **Spatial voices**: a position, the distance models of WebAudio (`inverse`, `linear`, `exponential`).
- **`FakeAudioEngine`**: an engine without sound for the tests, moved by `advance(seconds)`.
- `encodeWav`, `sniffAudioFormat`.
