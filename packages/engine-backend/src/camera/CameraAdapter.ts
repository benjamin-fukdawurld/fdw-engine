import { CameraSnapshot } from './types';
import { CameraCache } from './CameraCache';
import { SnapshotProvider } from '../utils/types';
import { CachedValue, SnapshotValue } from '../utils';
import { CameraMath, Mat4 } from '../math';
import { GpuBuffer, GpuBufferFactory } from '../gpu';

export class CameraAdapter {
  public readonly cameraCache: CameraCache;

  public readonly positionBuffer: CachedValue<
    GpuBuffer,
    [SnapshotProvider<CameraSnapshot>]
  >;

  public readonly viewMatrixBuffer: CachedValue<
    GpuBuffer,
    [SnapshotProvider<Mat4>]
  >;
  public readonly projectionMatrixBuffer: CachedValue<
    GpuBuffer,
    [SnapshotProvider<Mat4>]
  >;
  public readonly viewProjectionMatrixBuffer: CachedValue<
    GpuBuffer,
    [SnapshotProvider<Mat4>]
  >;

  constructor(options: {
    camera: CameraSnapshot;
    cameraMath: CameraMath;
    bufferFactory: GpuBufferFactory;
  }) {
    this.cameraCache = new CameraCache(options.camera, options.cameraMath);

    this.positionBuffer = new CachedValue<
      GpuBuffer,
      [SnapshotProvider<CameraSnapshot>]
    >({
      initialValue: options.bufferFactory.create({
        size: 3 * 4, // 3 floats, 4 bytes per float
        usage: ['uniform', 'copy-dst'],
      }),
      updateStrategy: (buffer, dependencies) => {
        const position = dependencies[0].value.position;
        buffer.write(
          0,
          new Float32Array([position.x, position.y, position.z]).buffer
        );
        return buffer;
      },
      dependencies: [
        new SnapshotValue<CameraSnapshot>({
          valueGetter: () => options.camera,
          versionGetter: () => options.camera.transformVersion,
        }),
      ],
    });

    this.viewMatrixBuffer = new CachedValue<
      GpuBuffer,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: options.bufferFactory.create({
        size: 16 * 4, // 4x4 matrix, 4 bytes per float
        usage: ['uniform', 'copy-dst'],
      }),
      updateStrategy: (buffer, dependencies) => {
        buffer.write(0, dependencies[0].value.buffer as ArrayBuffer);
        return buffer;
      },
      dependencies: [this.cameraCache.viewMatrix],
    });

    this.projectionMatrixBuffer = new CachedValue<
      GpuBuffer,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: options.bufferFactory.create({
        size: 16 * 4, // 4x4 matrix, 4 bytes per float
        usage: ['uniform', 'copy-dst'],
      }),
      updateStrategy: (buffer, dependencies) => {
        buffer.write(0, dependencies[0].value.buffer as ArrayBuffer);
        return buffer;
      },
      dependencies: [this.cameraCache.projectionMatrix],
    });

    this.viewProjectionMatrixBuffer = new CachedValue<
      GpuBuffer,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: options.bufferFactory.create({
        size: 16 * 4, // 4x4 matrix, 4 bytes per float
        usage: ['uniform', 'copy-dst'],
      }),
      updateStrategy: (buffer, dependencies) => {
        buffer.write(0, dependencies[0].value.buffer as ArrayBuffer);
        return buffer;
      },
      dependencies: [this.cameraCache.viewProjectionMatrix],
    });
  }
}
