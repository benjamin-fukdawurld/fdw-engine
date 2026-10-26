import { describe, expect, it } from 'vitest';
import {
  DirectionalLight,
  Mesh,
  PointLight,
  SpotLight,
} from '@fdw/engine-core';
import {
  BuiltinTypes,
  compile,
  GraphBuilder,
  RayVertexVec4s,
  std,
} from '@fdw/engine-shader';
import { alphaMaskKernel } from './alphaMasks';
import { rayMeshData } from './meshData';
import { countLights, packLights } from './PathTracer';
import {
  accumulateKernel,
  bounceKernel,
  cameraKernel,
  denoiseKernel,
  guidesKernel,
  LightVec4s,
  traceKernel,
} from './kernels';

const triangle = (attributes: 'position' | 'all', indexed = true) =>
  new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: attributes === 'all' ? 32 : 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            ...(attributes === 'all'
              ? [
                  { semantic: 'normal', format: 'float32x3' as const, offset: 12 },
                  { semantic: 'uv', format: 'float32x2' as const, offset: 24 },
                ]
              : []),
          ],
        },
      ],
      vertexCount: 3,
      ...(indexed ? { indexBuffer: { format: 'uint16', count: 3 } } : {}),
    },
    vertices: [
      new Float32Array(
        attributes === 'all'
          ? [0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1]
          : [0, 0, 0, 1, 0, 0, 0, 1, 0],
      ),
    ],
    ...(indexed ? { indices: new Uint16Array([0, 1, 2]) } : {}),
  });

describe('rayMeshData', () => {
  it('gives the triangles and the vertices of the hits', () => {
    const data = rayMeshData(triangle('all')) as NonNullable<
      ReturnType<typeof rayMeshData>
    >;
    expect([...data.indices]).toEqual([0, 1, 2]);
    expect([...data.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const vertex = (v: number) =>
      [...data.vertices.subarray(v * RayVertexVec4s * 4, (v + 1) * RayVertexVec4s * 4)];
    // Position and u, normal and v, tangent.
    expect(vertex(1)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
  });

  it('computes the normals of the meshes without, and indexes the others', () => {
    const data = rayMeshData(triangle('position', false)) as NonNullable<
      ReturnType<typeof rayMeshData>
    >;
    expect([...data.indices]).toEqual([0, 1, 2]);
    expect([...data.vertices.subarray(4, 7)]).toEqual([0, 0, 1]);
  });

  it('leaves out what rays cannot hit', () => {
    const lines = new Mesh({
      description: {
        vertexBuffers: [
          {
            stride: 12,
            stepMode: 'vertex',
            attributes: [{ semantic: 'position', format: 'float32x3', offset: 0 }],
          },
        ],
        vertexCount: 2,
        topology: 'line-list',
      },
      vertices: [new Float32Array(6)],
    });
    expect(rayMeshData(lines)).toBeUndefined();
  });
});

describe('packLights', () => {
  it('packs the lights for the kernels', () => {
    const lights = [
      new DirectionalLight({ direction: { x: 0, y: -2, z: 0 }, diffuse: { x: 1, y: 0.5, z: 0 } }),
      new PointLight({ position: { x: 1, y: 2, z: 3 } }),
      new SpotLight({ position: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } }),
    ];
    const data = packLights(lights);
    expect(countLights(lights)).toBe(3);
    expect(data.length).toBe(3 * LightVec4s * 4);
    // Towards the sun, its radiance (diffuse × π).
    expect([...data.subarray(0, 4)].map((v) => v + 0)).toEqual([0, 1, 0, 0]);
    expect(data[4]).toBeCloseTo(Math.PI);
    // A point light: positional, every direction.
    expect([...data.subarray(16, 20)]).toEqual([1, 2, 3, 1]);
    expect(data[16 + 11]).toBe(-1);
    // A spot: its direction and cone.
    expect([...data.subarray(32 + 8, 32 + 11)]).toEqual([0, -1, 0]);
    expect(data[32 + 11]).toBeGreaterThan(data[32 + 15]);
  });
});

describe('the kernels', () => {
  it('bind at most the 8 storage buffers WebGPU guarantees', () => {
    const material = (() => {
      const g = new GraphBuilder('textured');
      g.surface({
        shadingModel: 'pbr',
        baseColor: g
          .call(std.textureSample, {
            texture: g.texture('map'),
            sampler: g.sampler('mapSampler'),
            uv: g.attribute('uv', BuiltinTypes.vec2f),
          })
          .swizzle('rgb'),
      });
      return g.build();
    })();
    const capabilities = { rayQuery: true } as const;
    const programs = [
      ...[
        cameraKernel,
        traceKernel,
        guidesKernel,
        bounceKernel,
        accumulateKernel,
        denoiseKernel,
        alphaMaskKernel,
      ].map(
        (kernel) => compile(kernel(), { capabilities }),
      ),
      compile(material, { capabilities, target: 'hit' }),
    ];
    for (const program of programs) {
      // The software structure of WebGPU: two storage buffers.
      const count = program.layout.groups
        .flatMap((group) => group.bindings)
        .reduce(
          (sum, binding) =>
            sum +
            (binding.kind === 'storage-buffer'
              ? 1
              : binding.kind === 'acceleration-structure'
                ? 2
                : 0),
          0,
        );
      expect(count, program.name).toBeLessThanOrEqual(8);
    }
  });
});
