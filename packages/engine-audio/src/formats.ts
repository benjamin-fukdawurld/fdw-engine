/** The audio formats the engines read. */
export type AudioFormat = 'wav' | 'ogg' | 'mp3' | 'flac';

const ascii = (head: Uint8Array, start: number, text: string): boolean =>
  head.length >= start + text.length &&
  [...text].every((c, i) => head[start + i] === c.charCodeAt(0));

/** Recognizes an audio format from its first bytes. */
export function sniffAudioFormat(head: Uint8Array): AudioFormat | undefined {
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'wav';
  if (ascii(head, 0, 'OggS')) return 'ogg';
  if (ascii(head, 0, 'fLaC')) return 'flac';
  // An ID3 tag, or the sync word of an MPEG frame.
  if (ascii(head, 0, 'ID3')) return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  return undefined;
}

/** The MIME type of a format. */
export const audioMimeTypes: Readonly<Record<AudioFormat, string>> = {
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
};

/**
 * A WAV file of 16-bit samples, from one array per channel (from -1 to 1):
 * a sound made by code, saved or decoded like a file.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const data = frames * count * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      bytes[offset + i] = value.charCodeAt(i);
    }
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, Math.round(s * 32767), true);
      offset += 2;
    }
  }
  return bytes;
}
