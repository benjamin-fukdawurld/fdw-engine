import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import type { Material, MaterialValue } from '@fdw/engine-core';
import {
  compile,
  CompiledProgram,
  GraphBuilder,
  HitResources,
  MaterialGraphData,
  NodeRegistry,
} from '@fdw/engine-shader';
import type { RayScene } from './RayScene';

/** The resources of the scene, by their names in the programs. */
export function sceneValues(scene: RayScene): Record<string, MaterialValue> {
  const values: Record<string, MaterialValue> = {};
  for (const name of ['scene', 'rayInstances', 'rayGeometry']) {
    values[name] = scene.resource(name) as MaterialValue;
  }
  return values;
}

/**
 * The surfaces of the materials of a scene at the points hit by rays: the
 * hit program of each material (compiled once per graph and features), and
 * its dispatches, one per material, each thread writing the surface of its
 * ray when the ray hit that material.
 */
export class MaterialHits {
  private readonly _programs = new WeakMap<
    MaterialGraphData,
    Map<string, CompiledProgram>
  >();

  constructor(
    readonly backend: RenderBackend,
    readonly registry?: NodeRegistry,
  ) {}

  /** The hit program of a material. */
  program(material: Material): CompiledProgram {
    const features = {
      ...material.features,
      alphaMode: material.renderState.alphaMode,
    };
    const key = JSON.stringify(features);
    let byFeatures = this._programs.get(material.graph);
    if (!byFeatures) {
      byFeatures = new Map();
      this._programs.set(material.graph, byFeatures);
    }
    let program = byFeatures.get(key);
    if (!program) {
      const options = {
        target: 'hit',
        features,
        capabilities: this.backend.capabilities,
        ...(this.registry ? { registry: this.registry } : {}),
      } as const;
      try {
        program = compile(material.graph, options);
      } catch (error) {
        // What has no value at the points hit (a material drawing raw
        // stages): a gray surface instead, the error reported once.
        console.warn(
          `Material "${material.label ?? material.graph.name}" has no surface at the points hit by rays: ${String(error)}`,
        );
        program = compile(fallbackGraph(), options);
      }
      byFeatures.set(key, program);
    }
    return program;
  }

  /**
   * Calls `dispatch` for each material of the scene: its hit program and
   * the values of its dispatch (those of the material, the scene, the
   * frame, the buffers of the rays).
   */
  forEach(
    scene: RayScene,
    {
      hits,
      surfaces,
      count,
      frame,
    }: {
      readonly hits: GpuBuffer;
      readonly surfaces: GpuBuffer;
      readonly count: number;
      // The values of the frame block (the camera, the time…).
      readonly frame: Readonly<Record<string, MaterialValue>>;
    },
    // `material`: the owner of the dispatch (see ComputeDispatch.owner).
    dispatch: (
      program: CompiledProgram,
      values: Record<string, MaterialValue>,
      material: Material,
    ) => void,
  ): void {
    const shared = {
      ...frame,
      ...sceneValues(scene),
      [HitResources.hits]: hits,
      [HitResources.surfaces]: surfaces,
      [HitResources.count]: count,
    };
    scene.materials.forEach((material, index) => {
      const program = this.program(material);
      dispatch(program, {
        ...shared,
        ...materialValues(material, program),
        [HitResources.material]: index,
      }, material);
    });
  }
}

// A gray surface, for the materials without one at the points hit.
let fallback: MaterialGraphData | undefined;
function fallbackGraph(): MaterialGraphData {
  if (!fallback) {
    const g = new GraphBuilder('gray');
    g.surface({ shadingModel: 'pbr', baseColor: [0.5, 0.5, 0.5], roughness: 0.8 });
    fallback = g.build();
  }
  return fallback;
}

/** The values of the material slots of a program: those of the material. */
export function materialValues(
  material: Material,
  program: CompiledProgram,
): Record<string, MaterialValue> {
  const values: Record<string, MaterialValue> = {};
  for (const group of program.layout.groups) {
    if (group.slot === 'frame' || group.slot === HitResources.slot) {
      continue;
    }
    for (const binding of group.bindings) {
      const names =
        binding.kind === 'uniform-block'
          ? binding.members.map((member) => member.name)
          : [binding.name];
      for (const name of names) {
        const value = material.getValue(name);
        if (value !== undefined) {
          values[name] = value;
        }
      }
    }
  }
  return values;
}
