import type {
  GpuBottomLevel,
  GpuBuffer,
  GpuTopLevel,
  RenderBackend,
} from '@fdw/engine-backend';
import { ComputeRunner } from '@fdw/engine-core';
import {
  buildInstanceBvh,
  buildTriangleBvh,
  BvhInstance,
  intersectInstances,
} from '@fdw/engine-geometry';
import { compose, random } from '@fdw/engine-geometry/testing';
import {
  arrayType,
  BuiltinTypes,
  compile,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderingFixture } from './suite';

// The rays of the backends with the rayQuery capability (Vulkan in
// hardware, WebGPU in software), against what the CPU finds: the same
// instances, triangles and barycentric coordinates.

// A soup of small random triangles: xyz per vertex, 3 vertices each.
function soup(seed: number, count: number, extent: number, size: number) {
  const next = random(seed);
  const at = () => (next() * 2 - 1) * extent;
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const center = [at(), at(), at()];
    for (let k = 0; k < 9; k++) {
      positions[t * 9 + k] = center[k % 3] + (next() * 2 - 1) * size;
    }
  }
  return positions;
}

const sequence = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);

export function describeRays(
  name: string,
  createFixture: () => Promise<RenderingFixture>,
  options: { skip?: boolean } = {},
): void {
  describe.skipIf(options.skip ?? false)(name, () => {
    let fixture: RenderingFixture;
    let backend: RenderBackend;
    let runner: ComputeRunner;

    beforeAll(async () => {
      fixture = await createFixture();
      backend = fixture.backend;
      runner = new ComputeRunner(backend);
    });

    afterAll(() => {
      runner?.destroy();
      return fixture?.destroy();
    });

    // hits[i] = the hit of the ray i, from vec4 buffers of origins and
    // directions.
    const traceProgram = (mode: 'closest' | 'any') => {
      const g = new GraphBuilder(`trace ${mode}`);
      const index = g.builtin('global-invocation-id').swizzle('x');
      const origins = g.storage('origins', arrayType(BuiltinTypes.vec4f));
      const directions = g.storage('directions', arrayType(BuiltinTypes.vec4f));
      const hits = g.storage('hits', arrayType(BuiltinTypes.vec4u), {
        access: 'read-write',
      });
      const hit = g.traceRay({
        origin: g.call(std.index, { array: origins, index }).swizzle('xyz'),
        direction: g
          .call(std.index, { array: directions, index })
          .swizzle('xyz'),
        tMin: 0.001,
        tMax: 1000,
        mode,
      });
      g.write(hits, { index, value: hit });
      g.compute({
        active: g.call(std.less, {
          a: index,
          b: g.call(std.arrayLength, { array: origins }),
        }),
      });
      return compile(g.build(), { capabilities: backend.capabilities });
    };

    const storage = (data: ArrayBufferView<ArrayBuffer>, copySource = false) =>
      backend.buffers.create({
        size: data.byteLength,
        usage: ['storage', 'copy-dst', ...(copySource ? ['copy-src' as const] : [])],
        initialData: data,
      });

    // Rays from around the scene towards points in it.
    const rays = (seed: number, count: number) => {
      const next = random(seed);
      const origins = new Float32Array(count * 4);
      const directions = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < 3; k++) {
          origins[i * 4 + k] = (next() * 2 - 1) * 14;
          directions[i * 4 + k] = (next() * 2 - 1) * 6 - origins[i * 4 + k];
        }
      }
      return { origins, directions };
    };

    const trace = async (
      top: GpuTopLevel,
      mode: 'closest' | 'any',
      { origins, directions }: ReturnType<typeof rays>,
    ) => {
      const count = origins.length / 4;
      const hits = storage(new Uint32Array(count * 4), true);
      const buffers: GpuBuffer[] = [storage(origins), storage(directions)];
      const encoder = backend.createCommandEncoder();
      encoder.buildTopLevel?.(top);
      const pass = encoder.beginComputePass('trace');
      runner.record(pass, traceProgram(mode), {
        values: {
          origins: buffers[0],
          directions: buffers[1],
          hits,
          scene: top,
        },
        workgroups: [Math.ceil(count / 64)],
      });
      pass.end();
      backend.submit([encoder.finish()]);
      const result = new Uint32Array(await hits.read());
      hits.destroy();
      buffers.forEach((buffer) => buffer.destroy());
      return result;
    };

    it('traces rays in a scene of instances as the CPU does', async () => {
      const meshes = [soup(1, 300, 2, 0.4), soup(2, 500, 3, 0.5)];
      const bottoms: GpuBottomLevel[] = meshes.map((positions, i) =>
        (backend.createBottomLevel as NonNullable<RenderBackend['createBottomLevel']>)({
          positions,
          indices: sequence(positions.length / 3),
          label: `soup ${i}`,
        }),
      );
      const next = random(3);
      const instances = Array.from({ length: 9 }, (_, i) => {
        const axis = [next() - 0.5, next() - 0.5, next() - 0.5];
        const n = Math.hypot(...axis);
        const angle = next() * Math.PI;
        const s = Math.sin(angle / 2) / n;
        return {
          mesh: i % 2,
          world: compose(
            [(next() * 2 - 1) * 8, (next() * 2 - 1) * 8, (next() * 2 - 1) * 8],
            [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)],
            [0.5 + next() * 1.5, 0.5 + next() * 1.5, 0.5 + next() * 1.5],
          ),
          mask: i === 4 ? 0x2 : 0x1,
        };
      });
      const top = (backend.createTopLevel as NonNullable<RenderBackend['createTopLevel']>)({
        capacity: 4,
      });
      top.update(
        instances.map(({ mesh, world, mask }) => ({
          bottom: bottoms[mesh],
          transform: world,
          mask,
        })),
      );
      expect(top.instanceCount).toBe(9);

      const cpuBvhs = meshes.map((positions) => buildTriangleBvh(positions));
      const cpu: BvhInstance[] = instances.map(({ mesh, world, mask }) => ({
        bvh: cpuBvhs[mesh],
        world,
        mask,
      }));
      const cpuTop = buildInstanceBvh(cpu);
      const input = rays(4, 512);
      const hits = await trace(top, 'closest', input);
      const floats = new Float32Array(hits.buffer);
      let hitCount = 0;
      for (let i = 0; i < 512; i++) {
        const origin = input.origins.subarray(i * 4, i * 4 + 3);
        const direction = input.directions.subarray(i * 4, i * 4 + 3);
        const expected = intersectInstances(cpuTop, cpu, origin, direction, {
          tMin: 0.001,
          tMax: 1000,
        });
        if (!expected) {
          expect(hits[i * 4]).toBe(0xffffffff);
          continue;
        }
        hitCount++;
        expect(hits[i * 4]).toBe(expected.instance);
        expect(hits[i * 4 + 1] & 0x7fffffff).toBe(expected.triangle);
        expect(hits[i * 4 + 1] >>> 31).toBe(expected.frontFace ? 0 : 1);
        expect(floats[i * 4 + 2]).toBeCloseTo(expected.u, 3);
        expect(floats[i * 4 + 3]).toBeCloseTo(expected.v, 3);
      }
      expect(hitCount).toBeGreaterThan(100);

      // Any hit: hit or not as the closest one.
      const anyHits = await trace(top, 'any', input);
      for (let i = 0; i < 512; i++) {
        expect(anyHits[i * 4] === 0xffffffff).toBe(hits[i * 4] === 0xffffffff);
      }

      // Fewer instances, updated: the rays see the scene of the update.
      top.update([
        { bottom: bottoms[0], transform: instances[0].world },
      ]);
      const alone = await trace(top, 'closest', input);
      for (let i = 0; i < 512; i++) {
        expect([0, 0xffffffff]).toContain(alone[i * 4]);
      }
      top.update([]);
      const none = await trace(top, 'closest', input);
      expect([...none].filter((_, k) => k % 4 === 0).every((x) => x === 0xffffffff)).toBe(true);
      top.destroy();
      bottoms.forEach((bottom) => bottom.destroy());
    });
  });
}
