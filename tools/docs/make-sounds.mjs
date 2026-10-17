// Writes apps/docs/public/sounds/, the sounds of the tutorial "Audio": a hum
// that loops, three chimes, two musics. Made by the synthesizer of the demos
// (packages/demo-scenes/src/audio/synth.ts, run by Node 24 as it is), so that
// the documentation ships no third-party sound; encoded in Ogg Vorbis by
// ffmpeg (with libvorbis), which must be in the PATH.
// Usage: node tools/docs/make-sounds.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chimeSound,
  humSound,
  musicLoop,
} from '../../packages/demo-scenes/src/audio/synth.ts';

const out = fileURLToPath(
  new URL('../../apps/docs/public/sounds/', import.meta.url),
);

// A mono WAV of 16-bit samples.
function wav(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) =>
    bytes.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, s)) * 32767),
      44 + i * 2,
    ),
  );
  return bytes;
}

const sounds = {
  'hum.ogg': [humSound(44100), 44100],
  'chime-1.ogg': [chimeSound(44100, [72, 79]), 44100],
  'chime-2.ogg': [chimeSound(44100, [74, 81]), 44100],
  'chime-3.ogg': [chimeSound(44100, [76, 83]), 44100],
  'music-calm.ogg': [
    musicLoop(22050, { tempo: 80, roots: [45, 41, 43, 40] }),
    22050,
  ],
  'music-tense.ogg': [
    musicLoop(22050, {
      tempo: 132,
      roots: [45, 45, 46, 44, 45, 45, 46, 44],
      arpeggio: [0, 2, 1, 3, 0, 2, 4, 3],
    }),
    22050,
  ],
};

mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'fdw-sounds-'));
try {
  for (const [name, [samples, rate]] of Object.entries(sounds)) {
    const source = join(temp, `${name}.wav`);
    writeFileSync(source, wav(samples, rate));
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-c:a',
      'libvorbis',
      '-q:a',
      '3',
      // No metadata: the same bytes at every run.
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      join(out, name),
    ]);
    console.log(`${name}: ${(samples.length / rate).toFixed(2)} s`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
