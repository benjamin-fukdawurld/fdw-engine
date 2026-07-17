import type {
  GpuBackend,
  GpuBuffer,
  GpuRenderPipeline,
  GpuBindGroup,
  GpuBindGroupLayout,
} from '@fdw/engine-backend';
import { BufferUsage, TextureUsage } from '@fdw/engine-backend';
import type {
  SceneRenderer,
  Scene,
  MeshInstance,
  Camera,
} from '@fdw/engine-core';
import { MESH_SHADER_CODE, LINE_SHADER_CODE } from './shaders';

interface GpuMeshEntry {
  vertexBuffer: GpuBuffer;
  indexBuffer: GpuBuffer;
  indexCount: number;
  materialBindGroup: GpuBindGroup;
  transformBuffer: GpuBuffer;
}

/**
 * A pre-tessellated mesh with separate position and normal GPU buffers.
 * Produced by gpu-tessellation compute shaders — buffers already on GPU.
 */
export interface TessellatedMeshEntry {
  positionBuffer: GpuBuffer;
  normalBuffer: GpuBuffer;
  indexBuffer: GpuBuffer;
  indexCount: number;
  color: { r: number; g: number; b: number; a: number };
  worldTransform: Float64Array | Float32Array;
}

/**
 * Edge wireframe entry: a line-list vertex buffer for rendering B-Rep edges.
 */
export interface EdgeOverlayEntry {
  positions: Float32Array;
  color: { r: number; g: number; b: number; a: number };
  worldTransform: Float64Array | Float32Array;
}

/**
 * WebGpuSceneRenderer — WebGPU implementation of the SceneRenderer interface.
 * Iterates over the generic Scene.meshes() and issues draw calls via the GpuBackend.
 * Has no knowledge of domain-specific types (CadScene, BodyNode, etc.).
 *
 * Also supports rendering pre-tessellated GPU buffers via {@link addTessellatedMesh}.
 */
export class WebGpuSceneRenderer implements SceneRenderer {
  private _backend: GpuBackend;
  private _scene: Scene | null = null;
  private _pipeline: GpuRenderPipeline | null = null;
  private _separatePipeline: GpuRenderPipeline | null = null;
  private _linePipeline: GpuRenderPipeline | null = null;
  private _cameraBuffer: GpuBuffer | null = null;
  private _cameraBindGroup: GpuBindGroup | null = null;
  private _bindGroupLayout: GpuBindGroupLayout | null = null;
  private _materialBindGroupLayout: GpuBindGroupLayout | null = null;
  private _depthTexture: { texture: unknown; view: unknown } | null = null;
  private _gpuMeshes: GpuMeshEntry[] = [];
  private _tessellatedMeshes: {
    entry: TessellatedMeshEntry;
    materialBindGroup: GpuBindGroup;
    transformBuffer: GpuBuffer;
  }[] = [];
  private _edgeOverlays: {
    vertexBuffer: GpuBuffer;
    vertexCount: number;
    materialBindGroup: GpuBindGroup;
    transformBuffer: GpuBuffer;
  }[] = [];
  private _dirty = true;
  private _initialized = false;
  private _width = 0;
  private _height = 0;

  constructor(backend: GpuBackend) {
    this._backend = backend;
  }

  setScene(scene: Scene): void {
    this._scene = scene;
    this._dirty = true;
  }

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this._recreateDepthTexture();
  }

  /**
   * Adds a pre-tessellated mesh with separate GPU buffers (from compute shader output).
   * Call after init (i.e., after at least one render frame or explicit init).
   */
  addTessellatedMesh(entry: TessellatedMeshEntry): void {
    if (!this._initialized) {
      this._initPipeline();
      this._initialized = true;
    }

    const transformData = new Float32Array(24);
    for (let i = 0; i < 16; i++) {
      transformData[i] = entry.worldTransform[i];
    }
    transformData[16] = entry.color.r;
    transformData[17] = entry.color.g;
    transformData[18] = entry.color.b;
    transformData[19] = entry.color.a;

    const transformBuffer = this._backend.createBuffer({
      label: 'tess-tf',
      size: 96,
      usage: BufferUsage.Uniform,
    });
    transformBuffer.write(transformData);

    if (!this._materialBindGroupLayout) {
      throw new Error('Renderer not initialized');
    }

    const materialBindGroup = this._backend.createBindGroup({
      label: 'tess-mat-bg',
      layout: this._materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: transformBuffer } }],
    });

    this._tessellatedMeshes.push({ entry, materialBindGroup, transformBuffer });
  }

  /**
   * Removes all tessellated meshes added via {@link addTessellatedMesh}.
   */
  clearTessellatedMeshes(): void {
    for (const m of this._tessellatedMeshes) {
      m.transformBuffer.destroy();
    }
    this._tessellatedMeshes = [];
  }

  /**
   * Adds edge wireframe overlay for line rendering.
   */
  addEdgeOverlay(entry: EdgeOverlayEntry): void {
    if (!this._initialized) {
      this._initPipeline();
      this._initialized = true;
    }
    if (!this._materialBindGroupLayout) {
      throw new Error('Renderer not initialized');
    }

    const vertexBuffer = this._backend.createBuffer({
      label: 'edge-vb',
      size: entry.positions.byteLength,
      usage: BufferUsage.Vertex,
    });
    vertexBuffer.write(entry.positions);

    const transformData = new Float32Array(24);
    for (let i = 0; i < 16; i++) {
      transformData[i] = entry.worldTransform[i];
    }
    transformData[16] = entry.color.r;
    transformData[17] = entry.color.g;
    transformData[18] = entry.color.b;
    transformData[19] = entry.color.a;

    const transformBuffer = this._backend.createBuffer({
      label: 'edge-tf',
      size: 96,
      usage: BufferUsage.Uniform,
    });
    transformBuffer.write(transformData);

    const materialBindGroup = this._backend.createBindGroup({
      label: 'edge-mat-bg',
      layout: this._materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: transformBuffer } }],
    });

    this._edgeOverlays.push({
      vertexBuffer,
      vertexCount: entry.positions.length / 3,
      materialBindGroup,
      transformBuffer,
    });
  }

  /**
   * Removes all edge overlays.
   */
  clearEdgeOverlays(): void {
    for (const e of this._edgeOverlays) {
      e.vertexBuffer.destroy();
      e.transformBuffer.destroy();
    }
    this._edgeOverlays = [];
  }

  render(camera: Camera): void {
    if (
      !this._scene &&
      this._tessellatedMeshes.length === 0 &&
      this._edgeOverlays.length === 0
    )
      return;

    if (!this._initialized) {
      this._initPipeline();
      this._initialized = true;
    }

    if (!this._pipeline || !this._cameraBindGroup) return;

    if (this._dirty) {
      this._uploadScene();
      this._dirty = false;
    }

    this._updateCameraUniform(camera);

    const colorView = this._backend.getCurrentTextureView();
    if (!this._depthTexture) {
      this._recreateDepthTexture();
    }

    const encoder = this._backend.createCommandEncoder('frame');
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.15, g: 0.15, b: 0.2, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: this._depthTexture
        ? {
            view: this._depthTexture.view,
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          }
        : undefined,
    });

    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._cameraBindGroup);

    for (const entry of this._gpuMeshes) {
      pass.setBindGroup(1, entry.materialBindGroup);
      pass.setVertexBuffer(0, entry.vertexBuffer);
      pass.setIndexBuffer(entry.indexBuffer, 'uint32');
      pass.drawIndexed(entry.indexCount);
    }

    // Draw tessellated meshes (separate position/normal buffers)
    if (this._tessellatedMeshes.length > 0 && this._separatePipeline) {
      pass.setPipeline(this._separatePipeline);
      pass.setBindGroup(0, this._cameraBindGroup);
      for (const m of this._tessellatedMeshes) {
        pass.setBindGroup(1, m.materialBindGroup);
        pass.setVertexBuffer(0, m.entry.positionBuffer);
        pass.setVertexBuffer(1, m.entry.normalBuffer);
        pass.setIndexBuffer(m.entry.indexBuffer, 'uint32');
        pass.drawIndexed(m.entry.indexCount);
      }
    }

    // Draw edge wireframe overlays (line-list)
    if (this._edgeOverlays.length > 0 && this._linePipeline) {
      pass.setPipeline(this._linePipeline);
      pass.setBindGroup(0, this._cameraBindGroup);
      for (const e of this._edgeOverlays) {
        pass.setBindGroup(1, e.materialBindGroup);
        pass.setVertexBuffer(0, e.vertexBuffer);
        pass.draw(e.vertexCount);
      }
    }

    pass.end();
    this._backend.submit([encoder.finish()]);
  }

  destroy(): void {
    for (const entry of this._gpuMeshes) {
      entry.vertexBuffer.destroy();
      entry.indexBuffer.destroy();
      entry.transformBuffer.destroy();
    }
    this._gpuMeshes = [];
    this._cameraBuffer?.destroy();
  }

  private _initPipeline(): void {
    const shaderModule = this._backend.createShaderModule({
      label: 'mesh-shader',
      code: MESH_SHADER_CODE,
    });

    this._bindGroupLayout = this._backend.createBindGroupLayout({
      label: 'camera-bind-group-layout',
      entries: [{ binding: 0, visibility: 1 | 2, type: 'uniform-buffer' }],
    });

    this._materialBindGroupLayout = this._backend.createBindGroupLayout({
      label: 'material-bind-group-layout',
      entries: [{ binding: 0, visibility: 1, type: 'uniform-buffer' }],
    });

    this._pipeline = this._backend.createRenderPipeline({
      label: 'mesh-pipeline',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { format: 'float32x3', offset: 0, shaderLocation: 0 },
              { format: 'float32x3', offset: 12, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this._backend.getPreferredFormat() }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      layout: [this._bindGroupLayout, this._materialBindGroupLayout],
    });

    // Pipeline for tessellated meshes — same shader, separate position/normal buffers
    this._separatePipeline = this._backend.createRenderPipeline({
      label: 'tessellated-mesh-pipeline',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
          },
          {
            arrayStride: 12,
            attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 1 }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this._backend.getPreferredFormat() }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      layout: [this._bindGroupLayout, this._materialBindGroupLayout],
    });

    // Pipeline for edge wireframe — line-list topology, position only, no lighting
    const lineShaderModule = this._backend.createShaderModule({
      label: 'line-shader',
      code: LINE_SHADER_CODE,
    });

    this._linePipeline = this._backend.createRenderPipeline({
      label: 'edge-line-pipeline',
      vertex: {
        module: lineShaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
          },
        ],
      },
      fragment: {
        module: lineShaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this._backend.getPreferredFormat() }],
      },
      primitive: {
        topology: 'line-list',
        cullMode: 'none',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
      layout: [this._bindGroupLayout, this._materialBindGroupLayout],
    });

    this._cameraBuffer = this._backend.createBuffer({
      label: 'camera-uniform',
      size: 128,
      usage: BufferUsage.Uniform,
    });

    this._cameraBindGroup = this._backend.createBindGroup({
      label: 'camera-bind-group',
      layout: this._bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this._cameraBuffer } }],
    });
  }

  private _updateCameraUniform(camera: Camera): void {
    if (!this._cameraBuffer) return;
    const view = camera.getViewMatrix();
    const proj = camera.getProjectionMatrix();
    this._cameraBuffer.write(view, 0);
    this._cameraBuffer.write(proj, 64);
  }

  private _uploadScene(): void {
    for (const entry of this._gpuMeshes) {
      entry.vertexBuffer.destroy();
      entry.indexBuffer.destroy();
      entry.transformBuffer.destroy();
    }
    this._gpuMeshes = [];

    if (!this._scene) return;

    let meshIdx = 0;
    for (const instance of this._scene.meshes()) {
      this._uploadMeshInstance(instance, meshIdx++);
    }
  }

  private _uploadMeshInstance(instance: MeshInstance, idx: number): void {
    const { geometry, material, worldTransform } = instance;

    const vertexCount = geometry.positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 6);
    for (let i = 0; i < vertexCount; i++) {
      interleavedData[i * 6 + 0] = geometry.positions[i * 3 + 0];
      interleavedData[i * 6 + 1] = geometry.positions[i * 3 + 1];
      interleavedData[i * 6 + 2] = geometry.positions[i * 3 + 2];
      if (geometry.normals) {
        interleavedData[i * 6 + 3] = geometry.normals[i * 3 + 0];
        interleavedData[i * 6 + 4] = geometry.normals[i * 3 + 1];
        interleavedData[i * 6 + 5] = geometry.normals[i * 3 + 2];
      } else {
        interleavedData[i * 6 + 3] = 0;
        interleavedData[i * 6 + 4] = 1;
        interleavedData[i * 6 + 5] = 0;
      }
    }

    const vertexBuffer = this._backend.createBuffer({
      label: `vb-${idx}`,
      size: interleavedData.byteLength,
      usage: BufferUsage.Vertex,
    });
    vertexBuffer.write(interleavedData);

    const indexBuffer = this._backend.createBuffer({
      label: `ib-${idx}`,
      size: geometry.indices.byteLength,
      usage: BufferUsage.Index,
    });
    indexBuffer.write(geometry.indices);

    const transformData = new Float32Array(24);
    for (let i = 0; i < 16; i++) {
      transformData[i] = worldTransform[i];
    }
    transformData[16] = material?.diffuse.r ?? 0.8;
    transformData[17] = material?.diffuse.g ?? 0.8;
    transformData[18] = material?.diffuse.b ?? 0.8;
    transformData[19] = material?.diffuse.a ?? 1.0;

    const transformBuffer = this._backend.createBuffer({
      label: `tf-${idx}`,
      size: 96,
      usage: BufferUsage.Uniform,
    });
    transformBuffer.write(transformData);

    if (!this._materialBindGroupLayout) {
      throw new Error('Renderer not initialized');
    }

    const materialBindGroup = this._backend.createBindGroup({
      label: `mat-bg-${idx}`,
      layout: this._materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: transformBuffer } }],
    });

    this._gpuMeshes.push({
      vertexBuffer,
      indexBuffer,
      indexCount: geometry.indices.length,
      materialBindGroup,
      transformBuffer,
    });
  }

  private _recreateDepthTexture(): void {
    if (this._width === 0 || this._height === 0) return;
    const tex = this._backend.createTexture({
      label: 'depth',
      width: this._width,
      height: this._height,
      format: 'depth24plus',
      usage: TextureUsage.RenderAttachment,
    });
    this._depthTexture = { texture: tex, view: tex.createView() };
  }
}
