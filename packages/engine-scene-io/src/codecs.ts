import type { ProjectionData } from '@fdw/engine-backend';
import {
  BaseLight,
  Camera,
  DirectionalLight,
  PointLight,
  SpotLight,
  type Material,
  type Mesh,
  type ShadowOptions,
} from '@fdw/engine-core';
import type { SceneLods } from '@fdw/engine-scene';
import type { ComponentCodec } from './codec';
import type { ResourceRef, Vec3Tuple } from './data';

// The codecs of the components of engine-scene: what a node draws, its
// light, its camera; and those of SceneLods.

export interface MeshRendererData {
  readonly mesh: ResourceRef;
  readonly material: ResourceRef;
  /** True by default. */
  readonly castShadow?: boolean;
}

/** `mesh renderer`: the mesh and the material, by reference; whether it casts shadows. */
export const meshRendererCodec: ComponentCodec<MeshRendererData> = {
  name: 'mesh renderer',
  version: 1,
  write(entity, ctx) {
    const { MeshRenderer } = ctx.scene;
    const mesh = ctx.mesh(MeshRenderer.mesh[entity] as Mesh);
    const material = ctx.material(MeshRenderer.material[entity] as Material);
    if (mesh === undefined || material === undefined) return undefined;
    return MeshRenderer.noShadow[entity]
      ? { mesh, material, castShadow: false }
      : { mesh, material };
  },
  async read(data, entity, ctx) {
    const [mesh, material] = await Promise.all([
      ctx.mesh(data.mesh),
      ctx.material(data.material),
    ]);
    const { scene } = ctx;
    const had = scene.MeshRenderer.has(entity);
    scene.world.add(entity, scene.MeshRenderer, {
      mesh,
      material,
      noShadow: data.castShadow === false ? 1 : 0,
    });
    if (had) scene.rendererChanged(entity);
    scene.notify(entity, 'modified');
  },
};

export interface LightData {
  readonly type: 'directional' | 'point' | 'spot';
  readonly ambient: Vec3Tuple;
  readonly diffuse: Vec3Tuple;
  readonly specular: Vec3Tuple;
  /** Point and spot lights: 1 / (constant + linear d + quadratic d²). */
  readonly attenuation?: Vec3Tuple;
  /** Spot lights, in degrees. */
  readonly innerCutoff?: number;
  readonly outerCutoff?: number;
  readonly castShadow?: boolean;
  readonly shadow?: ShadowOptions;
}

const tuple = (v: { x: number; y: number; z: number }): Vec3Tuple => [
  v.x,
  v.y,
  v.z,
];
const vec = ([x, y, z]: Vec3Tuple) => ({ x, y, z });

/** `light`: the light of the engine as it is (colors, attenuation, cone, shadows). */
export const lightCodec: ComponentCodec<LightData> = {
  name: 'light',
  version: 1,
  write(entity, ctx) {
    const light = ctx.scene.Light.light[entity] as BaseLight;
    const colors = {
      ambient: tuple(light.ambient),
      diffuse: tuple(light.diffuse),
      specular: tuple(light.specular),
    };
    const shadows = (caster: DirectionalLight | SpotLight) =>
      caster.castShadow
        ? { castShadow: true, shadow: caster.shadow }
        : Object.keys(caster.shadow).length > 0
          ? { shadow: caster.shadow }
          : {};
    if (light instanceof DirectionalLight) {
      return { type: 'directional', ...colors, ...shadows(light) };
    }
    if (light instanceof SpotLight || light instanceof PointLight) {
      const attenuation: Vec3Tuple = [
        light.constantAttenuation,
        light.linearAttenuation,
        light.quadraticAttenuation,
      ];
      return light instanceof SpotLight
        ? {
            type: 'spot',
            ...colors,
            attenuation,
            innerCutoff: light.innerCutoff,
            outerCutoff: light.outerCutoff,
            ...shadows(light),
          }
        : { type: 'point', ...colors, attenuation };
    }
    ctx.warn(`light of entity ${entity}: unknown kind of light`);
    return undefined;
  },
  read(data, entity, ctx) {
    const colors = {
      ambient: vec(data.ambient),
      diffuse: vec(data.diffuse),
      specular: vec(data.specular),
    };
    const [constantAttenuation, linearAttenuation, quadraticAttenuation] =
      data.attenuation ?? [1, 0, 0];
    const attenuation = {
      constantAttenuation,
      linearAttenuation,
      quadraticAttenuation,
    };
    const shadows = { castShadow: data.castShadow, shadow: data.shadow };
    const light =
      data.type === 'directional'
        ? new DirectionalLight({ ...colors, ...shadows })
        : data.type === 'spot'
          ? new SpotLight({
              ...colors,
              ...attenuation,
              ...shadows,
              innerCutoff: data.innerCutoff,
              outerCutoff: data.outerCutoff,
            })
          : new PointLight({ ...colors, ...attenuation });
    ctx.scene.node(entity).setLight(light);
  },
};

export interface CameraViewData {
  readonly projection: ProjectionData;
}

/** `camera view`: the projection of the camera; the node places it. */
export const cameraViewCodec: ComponentCodec<CameraViewData> = {
  name: 'camera view',
  version: 1,
  write(entity, ctx) {
    const camera = ctx.scene.CameraView.camera[entity] as Camera;
    return { projection: { ...camera.projection } };
  },
  read(data, entity, ctx) {
    ctx.scene
      .node(entity)
      .setCamera(new Camera({ projection: data.projection }));
  },
};

export interface LodData {
  /** Finest first: the entities drawn, up to a distance. */
  readonly levels: readonly {
    readonly nodes: readonly number[];
    readonly maxDistance: number;
  }[];
}

interface Levels {
  readonly renderers: readonly Uint32Array[];
  readonly maxDistances: Float64Array;
}

/**
 * `lod`: the levels of detail of a SceneLods, their renderers by index.
 * Read after the other components (phase 1): the levels need the
 * renderers.
 */
export function lodCodec(lods: SceneLods): ComponentCodec<LodData> {
  return {
    name: lods.Lod.name,
    version: 1,
    phase: 1,
    write(entity, ctx) {
      const { renderers, maxDistances } = lods.Lod.levels[entity] as Levels;
      const levels = [];
      for (let level = 0; level < renderers.length; level++) {
        const nodes: number[] = [];
        for (const renderer of renderers[level]) {
          const index = ctx.indexOf(renderer);
          if (index === undefined) {
            ctx.warn(
              `lod of entity ${entity}: renderer ${renderer} not written`,
            );
            continue;
          }
          nodes.push(index);
        }
        levels.push({ nodes, maxDistance: maxDistances[level] });
      }
      return { levels };
    },
    read(data, entity, ctx) {
      lods.add(
        entity,
        data.levels.map(({ nodes, maxDistance }) => ({
          nodes: nodes.flatMap((index) => ctx.entity(index) ?? []),
          maxDistance,
        })),
      );
    },
  };
}

/** The codecs of engine-scene: mesh renderers, lights, cameras. */
export const sceneCodecs: readonly ComponentCodec<any>[] = [
  meshRendererCodec,
  lightCodec,
  cameraViewCodec,
];
