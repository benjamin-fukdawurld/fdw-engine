export type ImageFormat =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'bmp'
  | 'ktx2'
  | 'hdr';

const ascii = (head: Uint8Array, start: number, text: string): boolean =>
  head.length >= start + text.length &&
  [...text].every((c, i) => head[start + i] === c.charCodeAt(0));

/** Recognizes an image format from its first bytes, for loaders' and codecs' `sniff`. */
export function sniffImageFormat(head: Uint8Array): ImageFormat | undefined {
  if (head[0] === 0x89 && ascii(head, 1, 'PNG')) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(head, 0, 'GIF8')) return 'gif';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'webp';
  if (ascii(head, 4, 'ftypavif') || ascii(head, 4, 'ftypavis')) return 'avif';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  if (head[0] === 0xab && ascii(head, 1, 'KTX 20')) return 'ktx2';
  if (ascii(head, 0, '#?RADIANCE') || ascii(head, 0, '#?RGBE')) return 'hdr';
  return undefined;
}
