import {
  alphaBlending,
  CameraCache,
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBuffer,
  GpuRenderPassEncoder,
  GpuRenderPipeline,
  GpuRenderTarget,
  IColor,
  meshSemantics,
  PhysicalBindGroup,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  RenderBackend,
  Surface,
  TransformCache,
  UniformValue,
} from '@fdw/engine-backend';
import {
  compile,
  CompiledProgram,
  MaterialGraphData,
  NodeRegistry,
} from '@fdw/engine-shader';
import type { Camera } from '../Camera';
import type { Transform } from '../Transform';
import { Material, MaterialValue } from './Material';
import type { Mesh } from './Mesh';

export interface RenderItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly transform: Transform;
}

export interface RenderOptions {
  readonly items: Iterable<RenderItem>;
  readonly camera: Camera;
  readonly surface: Surface;
  readonly clearColor?: IColor;
  // Seconds, exposed to the materials as the 'time' engine value.
  readonly time?: number;
}

interface GpuMesh {
  version: number;
  vertexBuffers: GpuBuffer[];
  indexBuffer?: GpuBuffer;
}

interface UniformGroup {
  buffer?: GpuBuffer;
  block?: PhysicalUniformBlock;
  // Bind groups by layout key: programs with equal layouts share them.
  bindGroups: Map<string, GpuBindGroup>;
}

interface ObjectState extends UniformGroup {
  cache: TransformCache;
  // Version of the world matrix last uploaded.
  version: number;
}

interface MaterialGroupState {
  buffer?: GpuBuffer;
  bindGroup?: GpuBindGroup;
  version: number;
  // Textures and samplers of the bind group, to rebuild it when one changes.
  resources: readonly unknown[];
}

interface PreparedItem {
  readonly item: RenderItem;
  readonly program: CompiledProgram;
  readonly layout: PhysicalProgramLayout;
  readonly pipelineKey: string;
  readonly object: ObjectState;
}

const isHandle = (value: MaterialValue | undefined): boolean =>
  typeof value === 'object' && value !== null && !('length' in value);

// Draws render items with their materials, on any backend. Programs,
// pipelines, buffers and bind groups are created on first use and cached;
// uniform buffers are only rewritten when their values change.
export class Renderer {
  readonly backend: RenderBackend;
  private readonly _registry?: NodeRegistry;

  private readonly _programs = new WeakMap<
    MaterialGraphData,
    Map<string, CompiledProgram>
  >();
  private readonly _pipelines = new Map<string, GpuRenderPipeline>();
  private readonly _meshes = new WeakMap<Mesh, GpuMesh>();
  private readonly _objects = new WeakMap<Transform, ObjectState>();
  private readonly _materials = new WeakMap<
    Material,
    Map<string, MaterialGroupState>
  >();
  private readonly _cameras = new WeakMap<Camera, CameraCache>();
  private readonly _frame: UniformGroup = { bindGroups: new Map() };
  private _depth?: GpuRenderTarget & { destroy(): void };

  constructor(
    backend: RenderBackend,
    options: { registry?: NodeRegistry } = {}
  ) {
    this.backend = backend;
    this._registry = options.registry;
  }

  render({
    items,
    camera,
    surface,
    clearColor,
    time = 0,
  }: RenderOptions): void {
    const target = surface.getCurrentTarget();
    const depth = this.depthTarget(target);

    const prepared = [...items].map((item) => this.prepare(item, surface));
    const cameraCache = this.cameraCache(camera);
    const ordered = this.sort(prepared, cameraCache);

    const encoder = this.backend.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      label: 'main pass',
      colorAttachments: [{ target, load: 'clear', clearValue: clearColor }],
      depthAttachment: { target: depth, load: 'clear', clearValue: 1 },
    });

    if (ordered.length > 0) {
      this.updateFrame(ordered[0].layout, cameraCache, time);
    }
    for (const entry of ordered) {
      this.draw(pass, entry);
    }

    pass.end();
    this.backend.submit([encoder.finish()]);
    surface.present();
  }

  destroy(): void {
    this._frame.buffer?.destroy();
    this._depth?.destroy();
    this._pipelines.clear();
  }

  // --- Programs and pipelines --------------------------------------------------

  private program(material: Material, mesh: Mesh): CompiledProgram {
    const semantics = meshSemantics(mesh.description);
    const key = [...semantics].sort().join(',');
    let byAttributes = this._programs.get(material.graph);
    if (!byAttributes) {
      byAttributes = new Map();
      this._programs.set(material.graph, byAttributes);
    }
    let program = byAttributes.get(key);
    if (!program) {
      program = compile(material.graph, {
        vertexAttributes: semantics,
        ...(this._registry ? { registry: this._registry } : {}),
      });
      byAttributes.set(key, program);
    }
    return program;
  }

  private prepare(item: RenderItem, surface: Surface): PreparedItem {
    const program = this.program(item.material, item.mesh);
    const layout = this.backend.pipelines.resolveLayout(program);
    const state = item.material.renderState;
    const vertexKey = JSON.stringify(item.mesh.description.vertexBuffers);
    const stateKey = JSON.stringify(state);
    const pipelineKey = `${program.programKey}|${vertexKey}|${stateKey}|${surface.format}|${this.backend.depthFormat}`;

    if (!this._pipelines.has(pipelineKey)) {
      this._pipelines.set(
        pipelineKey,
        this.backend.pipelines.createRenderPipeline({
          label: item.material.label ?? program.name,
          program,
          vertex: item.mesh.description,
          primitive: {
            topology: 'triangle-list',
            cullMode: state.doubleSided ? 'none' : 'back',
            frontFace: 'ccw',
          },
          depthStencil: {
            format: this.backend.depthFormat,
            depthWrite: state.depthTest && state.depthWrite,
            depthCompare: state.depthTest ? 'less' : 'always',
          },
          targets: [
            {
              format: surface.format,
              ...(state.alphaMode === 'blend' ? { blend: alphaBlending } : {}),
            },
          ],
        })
      );
    }

    return {
      item,
      program,
      layout,
      pipelineKey,
      object: this.objectState(item.transform),
    };
  }

  // Opaque items first, grouped by pipeline then material to limit state
  // changes; then transparent items, back to front.
  private sort(items: PreparedItem[], camera: CameraCache): PreparedItem[] {
    const opaque = items.filter(
      (entry) => entry.item.material.renderState.alphaMode === 'opaque'
    );
    const transparent = items.filter(
      (entry) => entry.item.material.renderState.alphaMode === 'blend'
    );
    const materialOrder = new Map<Material, number>();
    const materialIndex = (material: Material) => {
      if (!materialOrder.has(material)) {
        materialOrder.set(material, materialOrder.size);
      }
      return materialOrder.get(material) as number;
    };

    opaque.sort(
      (a, b) =>
        a.pipelineKey.localeCompare(b.pipelineKey) ||
        materialIndex(a.item.material) - materialIndex(b.item.material)
    );

    const position = camera.camera.position;
    const distance = (entry: PreparedItem) => {
      const world = entry.object.cache.worldMatrix.value;
      return Math.hypot(
        world[12] - position.x,
        world[13] - position.y,
        world[14] - position.z
      );
    };
    transparent.sort((a, b) => distance(b) - distance(a));

    return [...opaque, ...transparent];
  }

  // --- Uniforms ------------------------------------------------------------------

  private cameraCache(camera: Camera): CameraCache {
    let cache = this._cameras.get(camera);
    if (!cache) {
      cache = new CameraCache(camera, this.backend.cameraMath);
      this._cameras.set(camera, cache);
    }
    return cache;
  }

  private objectState(transform: Transform): ObjectState {
    let state = this._objects.get(transform);
    if (!state) {
      state = {
        cache: new TransformCache({
          transform,
          transformMath: this.backend.transformMath,
        }),
        version: -1,
        bindGroups: new Map(),
      };
      this._objects.set(transform, state);
    }
    return state;
  }

  private writeBlock(
    block: PhysicalUniformBlock,
    valueOf: (name: string) => UniformValue | undefined
  ): ArrayBuffer {
    const data = new ArrayBuffer(block.size);
    const view = new DataView(data);
    for (const member of block.members) {
      const value = valueOf(member.name);
      if (value === undefined) {
        // Uniforms without value nor default stay at zero.
        continue;
      }
      this.backend.pipelines.layoutStrategy.writeUniform(view, member, value);
    }
    return data;
  }

  // Uploads a uniform block, creating its buffer on first use. Returns true
  // when the buffer was (re)created: the bind groups using it are stale.
  private upload(
    group: { buffer?: GpuBuffer; bindGroups?: Map<string, GpuBindGroup> },
    block: PhysicalUniformBlock,
    data: ArrayBuffer,
    label: string
  ): boolean {
    const created = !group.buffer || group.buffer.size !== block.size;
    if (created) {
      group.buffer?.destroy();
      group.buffer = this.backend.buffers.create({
        label,
        size: block.size,
        usage: ['uniform', 'copy-dst'],
      });
      group.bindGroups?.clear();
    }
    (group.buffer as GpuBuffer).write(0, data);
    return created;
  }

  private updateFrame(
    layout: PhysicalProgramLayout,
    camera: CameraCache,
    time: number
  ): void {
    const group = layout.groups.find((candidate) => candidate.slot === 'frame');
    const block = group?.bindings[0]?.block;
    if (!block) {
      return;
    }
    const position = camera.camera.position;
    const values: Record<string, UniformValue> = {
      viewProjection: camera.viewProjectionMatrix.value,
      view: camera.viewMatrix.value,
      projection: camera.projectionMatrix.value,
      cameraPosition: [position.x, position.y, position.z],
      time,
    };
    this._frame.block = block;
    this.upload(
      this._frame,
      block,
      this.writeBlock(block, (name) => values[name]),
      'frame uniforms'
    );
  }

  private updateObject(state: ObjectState, block: PhysicalUniformBlock): void {
    // Reading the version recomputes the matrices if the transform changed.
    const version = state.cache.worldMatrix.version;
    if (state.buffer && state.version === version) {
      return;
    }
    const values: Record<string, UniformValue> = {
      world: state.cache.worldMatrix.value,
      normalMatrix: state.cache.worldNormalMatrix.value,
    };
    this.upload(
      state,
      block,
      this.writeBlock(block, (name) => values[name]),
      'object uniforms'
    );
    state.version = version;
  }

  // --- Bind groups -----------------------------------------------------------------

  private sharedBindGroup(
    state: UniformGroup,
    group: PhysicalBindGroup
  ): GpuBindGroup {
    const layout = this.backend.pipelines.createBindGroupLayout(group);
    let bindGroup = state.bindGroups.get(layout.key);
    if (!bindGroup) {
      bindGroup = this.backend.pipelines.createBindGroup(layout, [
        { binding: 0, resource: state.buffer as GpuBuffer },
      ]);
      state.bindGroups.set(layout.key, bindGroup);
    }
    return bindGroup;
  }

  // Material and custom slots: uniforms, textures and samplers come from the
  // material values.
  private materialBindGroup(
    material: Material,
    program: CompiledProgram,
    group: PhysicalBindGroup
  ): GpuBindGroup | undefined {
    if (group.bindings.length === 0) {
      return undefined;
    }
    let groups = this._materials.get(material);
    if (!groups) {
      groups = new Map();
      this._materials.set(material, groups);
    }
    const key = `${program.programKey}:${group.index}`;
    let state = groups.get(key);
    if (!state) {
      state = { version: -1, resources: [] };
      groups.set(key, state);
    }
    if (state.bindGroup && state.version === material.version) {
      return state.bindGroup;
    }

    const name = material.label ?? material.graph.name;
    const resources: unknown[] = [];
    const entries: GpuBindGroupEntry[] = [];
    let bufferCreated = false;
    for (const binding of group.bindings) {
      const { resource } = binding;
      if (resource.kind === 'uniform-block') {
        const block = binding.block as PhysicalUniformBlock;
        const data = this.writeBlock(block, (member) => {
          const value = material.getValue(member);
          if (isHandle(value)) {
            throw new Error(
              `Material "${name}": "${member}" is a uniform, not a texture or sampler`
            );
          }
          return value as UniformValue | undefined;
        });
        bufferCreated =
          this.upload(state, block, data, `${name} uniforms`) || bufferCreated;
        entries.push({
          binding: binding.binding,
          resource: state.buffer as GpuBuffer,
        });
        continue;
      }
      const value = material.getValue(resource.name);
      if (!isHandle(value)) {
        throw new Error(
          `Material "${name}": no ${resource.kind} set for "${resource.name}"`
        );
      }
      resources.push(value);
      entries.push({
        binding: binding.binding,
        resource: value as GpuBindGroupEntry['resource'],
      });
    }

    const resourcesChanged =
      resources.length !== state.resources.length ||
      resources.some((resource, i) => resource !== state?.resources[i]);
    if (!state.bindGroup || resourcesChanged || bufferCreated) {
      state.bindGroup = this.backend.pipelines.createBindGroup(
        this.backend.pipelines.createBindGroupLayout(group),
        entries
      );
      state.resources = resources;
    }
    state.version = material.version;
    return state.bindGroup;
  }

  // --- Drawing -----------------------------------------------------------------------

  private gpuMesh(mesh: Mesh): GpuMesh {
    let gpu = this._meshes.get(mesh);
    if (gpu && gpu.version === mesh.version) {
      return gpu;
    }
    gpu?.vertexBuffers.forEach((buffer) => buffer.destroy());
    gpu?.indexBuffer?.destroy();

    const label = mesh.label ?? 'mesh';
    gpu = {
      version: mesh.version,
      vertexBuffers: mesh.vertices.map((data, i) =>
        this.backend.buffers.create({
          label: `${label} vertices ${i}`,
          size: data.byteLength,
          usage: ['vertex', 'copy-dst'],
          initialData: data,
        })
      ),
      ...(mesh.indices
        ? {
            indexBuffer: this.backend.buffers.create({
              label: `${label} indices`,
              size: mesh.indices.byteLength,
              usage: ['index', 'copy-dst'],
              initialData: mesh.indices,
            }),
          }
        : {}),
    };
    this._meshes.set(mesh, gpu);
    return gpu;
  }

  private draw(
    pass: GpuRenderPassEncoder,
    { item, program, layout, pipelineKey, object }: PreparedItem
  ): void {
    const pipeline = this._pipelines.get(pipelineKey) as GpuRenderPipeline;
    pass.setPipeline(pipeline);

    for (const group of layout.groups) {
      let bindGroup: GpuBindGroup | undefined;
      if (group.slot === 'frame') {
        bindGroup = this.sharedBindGroup(this._frame, group);
      } else if (group.slot === 'object') {
        this.updateObject(
          object,
          group.bindings[0].block as PhysicalUniformBlock
        );
        bindGroup = this.sharedBindGroup(object, group);
      } else {
        bindGroup = this.materialBindGroup(item.material, program, group);
      }
      if (bindGroup) {
        pass.setBindGroup(group.index, bindGroup);
      }
    }

    const mesh = this.gpuMesh(item.mesh);
    pipeline.vertexBuffers.forEach((meshBuffer, slot) =>
      pass.setVertexBuffer(slot, mesh.vertexBuffers[meshBuffer])
    );
    if (mesh.indexBuffer && item.mesh.indices) {
      pass.setIndexBuffer(
        mesh.indexBuffer,
        item.mesh.description.indexBuffer?.format ?? 'uint32'
      );
      pass.drawIndexed(item.mesh.indices.length);
    } else {
      pass.draw(item.mesh.description.vertexCount);
    }
  }

  private depthTarget(color: GpuRenderTarget): GpuRenderTarget {
    if (
      !this._depth ||
      this._depth.width !== color.width ||
      this._depth.height !== color.height
    ) {
      this._depth?.destroy();
      this._depth = this.backend.createRenderTarget({
        label: 'depth',
        width: color.width,
        height: color.height,
        format: this.backend.depthFormat,
      });
    }
    return this._depth;
  }
}
