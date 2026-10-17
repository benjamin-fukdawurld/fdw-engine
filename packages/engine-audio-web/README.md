# @fdw/engine-audio-web

The audio engine of a page for `@fdw/engine-audio`: WebAudio. The clips are `AudioBuffer`s, the streams media elements reading the bytes from an object URL, the buses gain nodes, the spatial voices panner nodes.

```ts
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';

const engine = new WebAudioEngine({ panningModel: 'equalpower' });
unlockAudio(engine, canvas); // resumes at the first click, key or touch
```

- The browser starts the audio only after a gesture: `resume()` from one, or `unlockAudio`. The voices played before are heard from then.
- `context`: an `OfflineAudioContext` renders the mix into a buffer (tests); the streams are decoded at once there.
- The tests run in headless Chromium (Vitest browser mode, Playwright).
