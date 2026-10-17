# @fdw/engine-audio-native

The audio engine of the native platforms for `@fdw/engine-audio`: [miniaudio](https://miniaud.io), compiled into the addon of `@fdw/engine-native`. It mixes on its own thread on the default device (a null device when there is none); the clips decode on the thread pool of libuv (WAV, FLAC, MP3, Ogg Vorbis); a stream keeps the encoded bytes, decoded by each voice as it plays.

```ts
import { NativeAudioEngine } from '@fdw/engine-audio-native';

const engine = new NativeAudioEngine();
const clip = await engine.decodeClip(await readFile('shot.wav'));
engine.play(clip);
// At each frame (SceneAudio does it):
engine.update();
```

- `offline: true`: no device, `render(out)` mixes the next frames into an array (tests, a sound rendered to a file).
- Needs the addon: `npx nx run engine-native:build-native`.
