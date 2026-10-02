import { ShaderType, T, TextureType } from '../types/ShaderType';

// Logical layout of the resources of a program: which resources, of which
// type, grouped by update frequency. Memory offsets and binding numbers are
// physical concerns, resolved by each backend.

export type LogicalBinding =
  | {
      readonly kind: 'uniform-block';
      readonly name: string;
      readonly members: readonly {
        readonly name: string;
        readonly type: ShaderType;
      }[];
    }
  | {
      readonly kind: 'texture';
      readonly name: string;
      readonly type: TextureType;
    }
  | {
      readonly kind: 'sampler';
      readonly name: string;
      readonly comparison: boolean;
    };

export interface ProgramLayoutGroup {
  readonly slot: string;
  readonly bindings: readonly LogicalBinding[];
}

export interface ProgramLayout {
  readonly groups: readonly ProgramLayoutGroup[];
}

// Fixed slots, always present and in this order, so that their group index
// is the same in every program. Custom slots follow, sorted by name.
export const BuiltinSlots = ['frame', 'material', 'object'] as const;

// The 'frame' and 'object' slots hold values provided by the engine. Their
// layout is a fixed contract shared by every program, so that their bind
// groups can be shared by every draw.
export const EngineSlots = ['frame', 'object'] as const;

export const uniformBlockName = (slot: string): string => `${slot}Uniforms`;

export const engineUniformBlocks: Readonly<
  Record<
    (typeof EngineSlots)[number],
    readonly { name: string; type: ShaderType }[]
  >
> = {
  frame: [
    { name: 'viewProjection', type: T.mat4f },
    { name: 'view', type: T.mat4f },
    { name: 'projection', type: T.mat4f },
    { name: 'cameraPosition', type: T.vec3f },
    { name: 'time', type: T.f32 },
  ],
  object: [
    { name: 'world', type: T.mat4f },
    { name: 'normalMatrix', type: T.mat3f },
  ],
};

// Where each 'input.engine' value lives.
export const engineValueLocations: Readonly<
  Record<
    string,
    { readonly slot: (typeof EngineSlots)[number]; readonly member: string }
  >
> = {
  'camera.viewProjection': { slot: 'frame', member: 'viewProjection' },
  'camera.view': { slot: 'frame', member: 'view' },
  'camera.projection': { slot: 'frame', member: 'projection' },
  'camera.position': { slot: 'frame', member: 'cameraPosition' },
  time: { slot: 'frame', member: 'time' },
  'object.world': { slot: 'object', member: 'world' },
  'object.normalMatrix': { slot: 'object', member: 'normalMatrix' },
};

export function slotOrder(slots: Iterable<string>): string[] {
  const custom = [...new Set(slots)]
    .filter((slot) => !(BuiltinSlots as readonly string[]).includes(slot))
    .sort();
  return [...BuiltinSlots, ...custom];
}
