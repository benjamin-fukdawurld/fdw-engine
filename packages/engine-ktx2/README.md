# @fdw/engine-ktx2

The KTX2 image codec of FdwEngine: compressed textures with their levels, for `@fdw/engine-assets`. See [design/p5-resources.md](../../design/p5-resources.md) §6.9 (in French).

- **The container**: header, level index, Data Format Descriptor, key/value data and supercompression global data (`parseKtx2`). 2d, cube (the 6 faces as layers), 2d-array and 3d images; the levels come level 0 (the largest) first, each holding its layers (faces) one after the other.
- **Uncompressed formats**: `R8`, `R8G8`, `R8G8B8A8`, `B8G8R8A8` (unorm, uint, sint), `A2B10G10R10`, 16 and 32 bit channels (float, uint, sint). The sRGB formats map to their linear base: the color space is a choice of the `Texture`, which picks the `-srgb` variant.
- **GPU formats**: BC1, BC3, BC4, BC5, BC6H, BC7, ETC2 RGB / RGBA, EAC R11 / RG11, ASTC 4×4, given as they are. A backend that lacks the format cannot sample them: check with `supportsImage(backend.capabilities, image)` / `ensureSupported(…)` (`ResourceError('unsupported')`); they are not decompressed in software.
- **Supercompression**: none, zstd (scheme 2) with the decoder of the application, zlib (scheme 3) with `DecompressionStream('deflate')`.
- **Basis Universal** (BasisLZ / ETC1S, UASTC): the image is `format: 'universal'` and keeps the file; the `Texture` transcodes it for its backend, with the transcoder of the application, to BC7, ASTC 4×4, ETC2 (ETC1 for opaque ETC1S data) or `rgba8unorm`, in this order of preference.
- **No WASM in the engine**: the Basis transcoder and the zstd decoder are supplied by the application, so it picks its binaries. Without them, the files that need them fail with `ResourceError('unsupported')`.

## Usage

```ts
import { installAssets, TextureType } from '@fdw/engine-assets';
import { installKtx2 } from '@fdw/engine-ktx2';

// installAssets returns the codec registry of the store (its ImageCodecsService).
installKtx2(installAssets(store, { backend, codecs }), { transcoder, zstd });

const albedo = store.load(TextureType, 'textures/albedo.ktx2');
```

The zstd decoder, over the `zstddec` package:

```ts
import { ZSTDDecoder } from 'zstddec';

const decoder = new ZSTDDecoder();
await decoder.init();
const zstd = {
  decode: (bytes: Uint8Array, size: number) => decoder.decode(bytes, size),
};
```

The transcoder, over Binomial's `basis_transcoder` (`KTX2File`): one array per level, its layers and faces one after the other.

```ts
const formats = { bc7: 6, 'astc-4x4': 10, etc2: 1, etc1: 0, rgba8: 13 }; // transcoder_texture_format

const transcoder: BasisTranscoder = {
  transcode(ktx2, target) {
    const file = new basis.KTX2File(ktx2);
    try {
      file.startTranscoding();
      const levels = [];
      for (let level = 0; level < file.getLevels(); level++) {
        const images = [];
        for (let layer = 0; layer < Math.max(file.getLayers(), 1); layer++) {
          for (let face = 0; face < file.getFaces(); face++) {
            const size = file.getImageTranscodedSizeInBytes(
              level,
              layer,
              face,
              formats[target],
            );
            const image = new Uint8Array(size);
            file.transcodeImage(
              image,
              level,
              layer,
              face,
              formats[target],
              0,
              -1,
              -1,
            );
            images.push(image);
          }
        }
        levels.push(concat(images));
      }
      return { levels };
    } finally {
      file.close();
      file.delete();
    }
  },
};
```

## Architecture

| Package               | Responsibility                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- |
| `@fdw/engine-assets`  | `ImageAsset`, the `ImageCodec` registry, the `Texture` that uploads and transcodes |
| `@fdw/engine-ktx2`    | The KTX2 codec: the container, the formats, the supercompression, Basis Universal  |
| `@fdw/engine-backend` | The texture formats, `compressedBlock`, `BackendCapabilities.compressedFormats`    |
