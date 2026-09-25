import { Camera } from '@fdw/engine-core';
import {
  CameraAdapter,
  GpuBufferFactory,
  CachedValue,
  SnapshotProvider,
  SnapshotValue,
} from '@fdw/engine-backend';
import {
  cameraMath,
  uniformPrimitives,
  WebGpuSurface,
} from '@fdw/engine-webgpu';
import { MaterialAdapter } from './Material';
import { Mesh, MeshRenderData } from './Mesh';

export class Scene {
  cameras: Camera[];
  meshes: Mesh[];

  private _activeCameraIndex: number;

  constructor(props: {
    cameras?: Camera[];
    activeCameraIndex?: number;
    meshes?: Mesh[];
    bufferFactory: GpuBufferFactory;
  }) {
    this.cameras = props.cameras ?? [new Camera()];
    this._activeCameraIndex = props.activeCameraIndex ?? 0;

    this.meshes = props.meshes ?? [];
  }

  get activeCameraIndex(): number {
    return this._activeCameraIndex;
  }

  set activeCameraIndex(index: number) {
    if (index < 0 || index >= this.cameras.length) {
      throw new Error('Invalid camera index');
    }

    this._activeCameraIndex = index;
  }

  get camera(): Camera {
    if (
      this.activeCameraIndex < 0 ||
      this.activeCameraIndex >= this.cameras.length
    ) {
      throw new Error('No active camera');
    }
    return this.cameras[this.activeCameraIndex];
  }
}

export default Scene;

export class SceneAdapter {
  public scene: Scene;
  public readonly bufferFactory: GpuBufferFactory;

  private readonly _cameraAdapter: CachedValue<
    CameraAdapter,
    [SnapshotProvider<Scene>]
  >;

  constructor({
    scene,
    bufferFactory,
  }: {
    scene: Scene;
    bufferFactory: GpuBufferFactory;
  }) {
    this.scene = scene;
    this.bufferFactory = bufferFactory;

    this._cameraAdapter = new CachedValue<
      CameraAdapter,
      [SnapshotProvider<Scene>]
    >({
      initialValue: new CameraAdapter({
        camera: scene.camera!,
        cameraMath: cameraMath,
        bufferFactory,
      }),
      updateStrategy: (adapter, dependencies) => {
        adapter.cameraCache.camera = dependencies[0].value.camera!;
        return adapter;
      },
      dependencies: [
        new SnapshotValue<Scene>({
          valueGetter: () => scene,
          versionGetter: () => scene.activeCameraIndex,
        }),
      ],
    });
  }

  get cameraAdapter(): CameraAdapter {
    return this._cameraAdapter.value;
  }

  setupMesh({
    mesh,
    device,
  }: {
    mesh: Mesh;
    device: GPUDevice;
  }): MeshRenderData {
    const material = mesh.material;
    material.frameUniforms.push(
      {
        name: 'cameraPosition',
        type: uniformPrimitives.vec3,
        value: this.cameraAdapter.positionBuffer.value!,
        stages: ['fragment'],
      },
      {
        name: 'viewMatrix',
        type: uniformPrimitives.mat4,
        value: this.cameraAdapter.viewMatrixBuffer.value!,
        stages: ['vertex'],
      },
      {
        name: 'projectionMatrix',
        type: uniformPrimitives.mat4,
        value: this.cameraAdapter.projectionMatrixBuffer.value!,
        stages: ['vertex'],
      },
      {
        name: 'lightPosition',
        type: uniformPrimitives.vec3,
        value: this.bufferFactory.create({
          size: 3 * 4, // 3 floats, 4 bytes each
          usage: ['uniform', 'copy-dst'],
          initialData: new Float32Array([-10.0, 10.0, 10.0]),
          label: 'Light Position Data Buffer',
        }),
        stages: ['fragment'],
      },
      {
        name: 'lightDirection',
        type: uniformPrimitives.vec3,
        value: this.bufferFactory.create({
          size: 3 * 4, // 3 floats, 4 bytes each
          usage: ['uniform', 'copy-dst'],
          initialData: new Float32Array([0.0, -1.0, -1.0]),
          label: 'Light Direction Data Buffer',
        }),
        stages: ['fragment'],
      },
      {
        name: 'ambientLightColor',
        type: uniformPrimitives.vec3,
        value: this.bufferFactory.create({
          size: 3 * 4, // 3 floats, 4 bytes each
          usage: ['uniform', 'copy-dst'],
          initialData: new Float32Array([0.1, 0.1, 0.1]),
          label: 'Ambient Light Color Data Buffer',
        }),
        stages: ['fragment'],
      },
      {
        name: 'diffuseLightColor',
        type: uniformPrimitives.vec3,
        value: this.bufferFactory.create({
          size: 3 * 4, // 3 floats, 4 bytes each
          usage: ['uniform', 'copy-dst'],
          initialData: new Float32Array([1.0, 1.0, 1.0]),
          label: 'Diffuse Light Color Data Buffer',
        }),
        stages: ['fragment'],
      },
      {
        name: 'specularLightColor',
        type: uniformPrimitives.vec3,
        value: this.bufferFactory.create({
          size: 3 * 4, // 3 floats, 4 bytes each
          usage: ['uniform', 'copy-dst'],
          initialData: new Float32Array([1.0, 1.0, 1.0]),
          label: 'Specular Light Color Data Buffer',
        }),
        stages: ['fragment'],
      }
    );

    material.objectUniforms.push(
      {
        name: 'modelMatrix',
        type: uniformPrimitives.mat4,
        value: mesh.transformAdapter.worldMatrixBuffer.value,
        stages: ['vertex'],
      },
      {
        name: 'normalMatrix',
        type: uniformPrimitives.mat3,
        value: mesh.transformAdapter.worldNormalMatrixBuffer.value,
        stages: ['vertex'],
      }
    );

    const diffuseColorBuffer = this.bufferFactory.create({
      size: 3 * 4, // 3 floats, 4 bytes each
      usage: ['uniform', 'copy-dst'],
      initialData: new Float32Array([1.0, 1.0, 1.0]),
      label: 'Diffuse Color Data Buffer',
    });

    const specularColorBuffer = this.bufferFactory.create({
      size: 3 * 4, // 3 floats, 4 bytes each
      usage: ['uniform', 'copy-dst'],
      initialData: new Float32Array([1.0, 1.0, 1.0]),
      label: 'Specular Color Data Buffer',
    });

    material.materialUniforms.push(
      {
        name: 'diffuseColor',
        type: uniformPrimitives.vec3,
        value: diffuseColorBuffer,
        stages: ['fragment'],
      },
      {
        name: 'specularColor',
        type: uniformPrimitives.vec3,
        value: specularColorBuffer,
        stages: ['fragment'],
      },
      {
        name: 'shininess',
        type: uniformPrimitives.float32,
        value: this.bufferFactory.create({
          size: 4, // 1 float, 4 bytes
          usage: ['uniform', 'copy-dst'],
          initialData: new Float32Array([64.0]),
          label: 'Shininess Data Buffer',
        }),
        stages: ['fragment'],
      }
    );

    const {
      bindgroup: frameUniformBindGroup,
      layout: frameUniformBindGroupLayout,
    } = MaterialAdapter.createBindGroup(device, material.frameUniforms, []);

    const { bindgroup: objectBindGroup, layout: objectBindGroupLayout } =
      MaterialAdapter.createBindGroup(device, material.objectUniforms, []);

    const { bindgroup: materialBindGroup, layout: materialBindGroupLayout } =
      MaterialAdapter.createBindGroup(
        device,
        material.materialUniforms,
        material.textures
      );

    const shaderModule = MaterialAdapter.getShaderModule(device, material);

    return {
      mesh,
      material,
      shaderModule,
      pipelineLayout: device.createPipelineLayout({
        bindGroupLayouts: [
          frameUniformBindGroupLayout,
          materialBindGroupLayout,
          objectBindGroupLayout,
        ],
      }),
      frameUniformBindGroup,
      objectBindGroup,
      materialBindGroup,
    };
  }

  renderMesh({
    meshRenderData,
    device,
    surface,
    passEncoder,
  }: {
    meshRenderData: MeshRenderData;
    device: GPUDevice;
    surface: WebGpuSurface;
    passEncoder: GPURenderPassEncoder;
  }) {
    const mesh = meshRenderData.mesh;
    const shaderModule = meshRenderData.shaderModule;
    const material = meshRenderData.material;
    material.frameUniforms[0].value = this.cameraAdapter.positionBuffer.value!;
    material.frameUniforms[1].value =
      this.cameraAdapter.viewMatrixBuffer.value!;

    const pipeline = device.createRenderPipeline({
      layout: meshRenderData.pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [material.getVertexBufferLayout()],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: surface.textureFormat!,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: 'ccw',
        cullMode: 'none',
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus-stencil8',
      },
    });

    passEncoder.setPipeline(pipeline);
    passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
    passEncoder.setIndexBuffer(mesh.indexBuffer!.buffer, 'uint16');
    passEncoder.setBindGroup(0, meshRenderData.frameUniformBindGroup);
    passEncoder.setBindGroup(1, meshRenderData.materialBindGroup);
    passEncoder.setBindGroup(2, meshRenderData.objectBindGroup);
    passEncoder.drawIndexed(mesh.numberOfIndices, 1, 0, 0, 0);
  }
}
