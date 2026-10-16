import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { defineFunction } from '../graph/functions';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile, CompileOptions } from './compile';
import type { IrEntryPoint } from './ir';
import type { SurfaceOutput } from './lowering';

const stage = (
  program: ReturnType<typeof compile>,
  name: IrEntryPoint['stage'],
) =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === name,
  ) as IrEntryPoint;

const pbr = () => {
  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f, { default: [1, 0, 0] }),
    roughness: g.uniform('roughness', BuiltinTypes.f32, { default: 0.25 }),
  });
  return g;
};

const options = (
  outputs: readonly SurfaceOutput[],
  color = true,
): CompileOptions => ({
  vertexAttributes: ['position', 'normal', 'uv'],
  capabilities: { objectTable: true },
  outputs,
  color,
});

const errors = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as GraphError).diagnostics.map((d) => d.message);
  }
  return [];
};

describe('surface outputs', () => {
  it('writes values of the surface and of the engine, in the types of their formats', () => {
    const program = compile(
      pbr().build(),
      options([
        {
          name: 'normal',
          location: 1,
          value: 'view-normal',
          channels: 4,
          scalar: 'f32',
        },
        {
          name: 'depth',
          location: 2,
          value: 'view-depth',
          channels: 1,
          scalar: 'f32',
        },
        {
          name: 'id',
          location: 3,
          value: 'object-id',
          channels: 1,
          scalar: 'u32',
        },
        {
          name: 'rough',
          location: 4,
          value: 'roughness',
          channels: 1,
          scalar: 'f32',
        },
      ]),
    );
    const fragment = stage(program, 'fragment');
    expect(
      fragment.outputs.map(({ name, type, location }) => [
        name,
        type,
        location,
      ]),
    ).toEqual([
      ['color', BuiltinTypes.vec4f, 0],
      ['normal', BuiltinTypes.vec4f, 1],
      ['depth', BuiltinTypes.f32, 2],
      ['id', BuiltinTypes.u32, 3],
      ['rough', BuiltinTypes.f32, 4],
    ]);
    // The identifier comes from the object table, as a flat integer.
    expect(fragment.inputs).toContainEqual(
      expect.objectContaining({
        type: BuiltinTypes.u32,
        interpolation: 'flat',
      }),
    );
  });

  it('leaves the shading model out without color', () => {
    const lit = compile(pbr().build(), options([]));
    const gbuffer = compile(
      pbr().build(),
      options(
        [
          {
            name: 'normal',
            location: 0,
            value: 'world-normal',
            channels: 4,
            scalar: 'f32',
          },
        ],
        false,
      ),
    );
    const fragment = stage(gbuffer, 'fragment');
    expect(fragment.outputs.map((output) => output.name)).toEqual(['normal']);
    // No light loop, no frame light uniform read.
    const loops = (program: ReturnType<typeof compile>) =>
      stage(program, 'fragment').body.filter(
        (instruction) => instruction.op.kind === 'loop-sum',
      ).length;
    expect(loops(lit)).toBeGreaterThan(0);
    expect(loops(gbuffer)).toBe(0);
    expect(gbuffer.programKey).not.toBe(lit.programKey);
    expect(gbuffer.variantKey['outputs']).toBeDefined();
  });

  it('calls the output functions of the application on the values of the surface', () => {
    const f = new GraphBuilder('properties');
    const roughness = f.functionInput('roughness', BuiltinTypes.f32);
    const metallic = f.functionInput('metallic', BuiltinTypes.f32);
    f.functionOutput(
      'value',
      f.call(std.vec4, { x: roughness, y: metallic, z: 0, w: 1 }),
    );
    const properties = defineFunction(f.build(), { id: 'test.properties' });
    const program = compile(
      pbr().build(),
      options([
        {
          name: 'properties',
          location: 1,
          value: properties,
          channels: 4,
          scalar: 'f32',
        },
      ]),
    );
    expect(stage(program, 'fragment').outputs[1]).toEqual({
      name: 'properties',
      type: BuiltinTypes.vec4f,
      location: 1,
    });

    // An input that is not a value of the surface.
    const g = new GraphBuilder('unknown');
    g.functionOutput('value', g.functionInput('velocity', BuiltinTypes.vec2f));
    const unknown = defineFunction(g.build(), { id: 'test.unknown' });
    expect(
      errors(() =>
        compile(
          pbr().build(),
          options([
            {
              name: 'v',
              location: 1,
              value: unknown,
              channels: 2,
              scalar: 'f32',
            },
          ]),
        ),
      )[0],
    ).toMatch(
      /the input "velocity" of the output function "test.unknown" is not a value of the surface: normal, worldNormal, viewNormal/,
    );
  });

  it('writes the output values of the materials, or the default', () => {
    const velocity: SurfaceOutput = {
      name: 'velocity',
      location: 1,
      value: 'material',
      channels: 2,
      scalar: 'f32',
      default: [0, 0],
    };
    const g = pbr();
    g.output('velocity', g.uniform('speed', BuiltinTypes.vec2f));
    const program = compile(g.build(), options([velocity]));
    expect(stage(program, 'fragment').outputs[1].name).toBe('velocity');
    expect(program.layout.groups[1].bindings[0]).toEqual(
      expect.objectContaining({
        members: expect.arrayContaining([
          { name: 'speed', type: BuiltinTypes.vec2f },
        ]),
      }),
    );
    // Without output.value: the default, a constant.
    const plain = compile(pbr().build(), options([velocity]));
    expect(stage(plain, 'fragment').outputs[1].name).toBe('velocity');
    // Ignored by the passes without the output.
    const ignored = compile(g.build(), options([]));
    expect(stage(ignored, 'fragment').outputs).toHaveLength(1);
  });

  it('refuses values that do not fit the format', () => {
    const g = pbr();
    g.output('velocity', g.uniform('speed', BuiltinTypes.vec3f));
    expect(
      errors(() =>
        compile(
          g.build(),
          options([
            {
              name: 'velocity',
              location: 1,
              value: 'material',
              channels: 2,
              scalar: 'f32',
            },
          ]),
        ),
      ),
    ).toEqual([
      'the output "velocity" is a vec3<f32>, its format takes a vec2<f32>',
    ]);
    expect(
      errors(() =>
        compile(
          pbr().build(),
          options([
            {
              name: 'n',
              location: 1,
              value: 'view-normals',
              channels: 4,
              scalar: 'f32',
            },
          ]),
        ),
      )[0],
    ).toMatch(/unknown output value "view-normals"/);
    expect(
      errors(() =>
        compile(
          pbr().build(),
          options([
            {
              name: 'n',
              location: 1,
              value: 'view-normal',
              channels: 4,
              scalar: 'u32',
            },
          ]),
        ),
      )[0],
    ).toMatch(/cannot hold "view-normal" in a format of 4 u32 components/);
  });

  it('reads the identifier of the object from the object table only', () => {
    const g = new GraphBuilder('id');
    g.surface({
      baseColor: g.call(std.vec3, {
        x: g.call(
          std.convert,
          {
            value: g.engine('object.id'),
          },
          { params: { to: BuiltinTypes.f32 } },
        ),
      }),
    });
    expect(errors(() => compile(g.build()))).toEqual([
      'object.id needs the objectTable capability',
    ]);
    expect(() =>
      compile(g.build(), { capabilities: { objectTable: true } }),
    ).not.toThrow();
  });

  it('only takes output.value nodes with a surface', () => {
    const g = new GraphBuilder('fullscreen');
    g.fullscreen({ color: [1, 1, 1, 1] });
    expect(() => {
      g.output('velocity', [0, 0]);
      g.build();
    }).toThrow(
      /output.value nodes belong to graphs ending with output.surface/,
    );
  });
});
