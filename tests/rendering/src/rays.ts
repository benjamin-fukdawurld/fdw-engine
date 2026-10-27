import type {
  GpuBottomLevel,
  GpuBuffer,
  GpuTopLevel,
  RenderBackend,
} from '@fdw/engine-backend';
import {
  Camera,
  ComputeRunner,
  DirectionalLight,
  Material,
  Mesh,
  RenderGraph,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import {
  PathTracer,
  RayOcclusion,
  RayReflections,
  RayScene,
  reflectionOutputs,
} from '@fdw/engine-raytracing';
import {
  Aabb,
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
  PortHandle,
  std,
  stdRays,
} from '@fdw/engine-shader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectColor, RenderingFixture, size } from './suite';

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

// A square of the given half size facing +z at depth z, with normals and
// uvs (v down).
const square = (half: number, z = 0) =>
  new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 32,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
            { semantic: 'uv', format: 'float32x2', offset: 24 },
          ],
        },
      ],
      vertexCount: 4,
      indexBuffer: { format: 'uint16', count: 6 },
    },
    vertices: [
      new Float32Array(
        [
          [-1, -1, 0, 1],
          [1, -1, 1, 1],
          [1, 1, 1, 0],
          [-1, 1, 0, 0],
        ].flatMap(([x, y, u, v]) => [x * half, y * half, z, 0, 0, 1, u, v]),
      ),
    ],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

// White, diffuse only.
const white = () => {
  const g = new GraphBuilder('white');
  g.surface({
    shadingModel: 'phong',
    baseColor: [1, 1, 1],
    specular: [0, 0, 0],
  });
  return new Material({ graph: g.build() });
};

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
    const traceProgram = (mode: 'closest' | 'any', alphaTest = false) => {
      const g = new GraphBuilder(`trace ${mode}${alphaTest ? ' alpha' : ''}`);
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
        alphaTest,
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
        usage: [
          'storage',
          'copy-dst',
          ...(copySource ? ['copy-src' as const] : []),
        ],
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
      by: ComputeRunner = runner,
    ) => {
      const count = origins.length / 4;
      const hits = storage(new Uint32Array(count * 4), true);
      const buffers: GpuBuffer[] = [storage(origins), storage(directions)];
      const encoder = backend.createCommandEncoder();
      encoder.buildTopLevel?.(top);
      const pass = encoder.beginComputePass('trace');
      by.record(pass, traceProgram(mode), {
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
        (
          backend.createBottomLevel as NonNullable<
            RenderBackend['createBottomLevel']
          >
        )({
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
      const top = (
        backend.createTopLevel as NonNullable<RenderBackend['createTopLevel']>
      )({
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

      // The same rays as a ray tracing pipeline (where the backend has
      // them): the same hits, to the bit; any hit, hit or not.
      const pipelines = new ComputeRunner(backend, { rayTracing: true });
      expect([...(await trace(top, 'closest', input, pipelines))]).toEqual([
        ...hits,
      ]);
      const anyTraced = await trace(top, 'any', input, pipelines);
      for (let i = 0; i < 512; i++) {
        expect(anyTraced[i * 4] === 0xffffffff).toBe(
          hits[i * 4] === 0xffffffff,
        );
      }
      pipelines.destroy();

      // Fewer instances, updated: the rays see the scene of the update.
      top.update([{ bottom: bottoms[0], transform: instances[0].world }]);
      const alone = await trace(top, 'closest', input);
      for (let i = 0; i < 512; i++) {
        expect([0, 0xffffffff]).toContain(alone[i * 4]);
      }
      top.update([]);
      const none = await trace(top, 'closest', input);
      expect(
        [...none].filter((_, k) => k % 4 === 0).every((x) => x === 0xffffffff),
      ).toBe(true);
      top.destroy();
      bottoms.forEach((bottom) => bottom.destroy());
    });

    it('follows the vertices moved on the GPU and traces the ray meshes', async () => {
      // A program writing the point hit by each ray (w: whether it hit).
      const g = new GraphBuilder('points hit');
      const index = g.builtin('global-invocation-id').swizzle('x');
      const origins = g.storage('origins', arrayType(BuiltinTypes.vec4f));
      const points = g.storage('points', arrayType(BuiltinTypes.vec4f), {
        access: 'read-write',
      });
      const hit = g.traceRay({
        origin: g.call(std.index, { array: origins, index }).swizzle('xyz'),
        direction: [0, 0, -1],
        tMin: 0.001,
        tMax: 100,
      });
      g.write(points, {
        index,
        value: g.call(std.extend, {
          xyz: g.call(stdRays.hitPosition, { hit }),
          w: g.call(std.select, {
            ifFalse: 0,
            ifTrue: 1,
            condition: g.call(stdRays.hit, { hit }),
          }),
        }),
      });
      g.compute({
        active: g.call(std.less, {
          a: index,
          b: g.call(std.arrayLength, { array: origins }),
        }),
      });
      const program = compile(g.build(), {
        capabilities: backend.capabilities,
      });
      const pointsHit = async (scene: RayScene, xs: readonly number[]) => {
        const origins = storage(
          new Float32Array(xs.flatMap((x) => [x, 0.1, 5, 1])),
        );
        const output = storage(new Float32Array(xs.length * 4), true);
        runner.dispatch(program, {
          values: {
            origins,
            points: output,
            scene: scene.topLevel,
            rayInstances: scene.resource('rayInstances') as GpuBuffer,
            rayGeometry: scene.resource('rayGeometry') as GpuBuffer,
          },
          workgroups: [1],
        });
        const result = new Float32Array(await output.read());
        origins.destroy();
        output.destroy();
        return [...xs.keys()].map((i) => [
          ...result.subarray(i * 4, i * 4 + 4),
        ]);
      };

      // A square whose vertices a skinning would move: 2 vec4 each, the
      // position and the normal; moved 2 to the right and 0.5 back.
      const mesh = square(0.5);
      const rest = [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ];
      const deformed = (dx: number, z: number) =>
        new Float32Array(
          rest.flatMap(([x, y]) => [x + dx, y, z, 1, 0, 0, 1, 0]),
        );
      const vertices = storage(deformed(2, -0.5));
      const g2 = new GraphBuilder('moved');
      g2.surface({ baseColor: [1, 1, 1] });
      const material = new Material({
        graph: g2.build(),
        deformedVertices: { buffer: vertices, stride: 2, normal: 1 },
      });
      const moved = {
        mesh,
        material,
        transform: new Transform(),
        // Where the vertices are: the box the source knows.
        bounds: new Aabb([1, -1, -1], [3, 1, 1]),
      };
      // A material making its vertices in the vertex stage, traced with
      // its ray mesh: a square at z = 1, left.
      const generated = new GraphBuilder('generated');
      generated.vertexAttribute(
        'position',
        generated.call(std.vec3, {
          x: generated.call(
            std.convert,
            { value: generated.builtin('vertex-index') },
            {
              params: { to: BuiltinTypes.f32 },
            },
          ),
        }),
      );
      generated.surface({ baseColor: [1, 1, 1] });
      const patches = {
        mesh: square(0.1),
        material: new Material({ graph: generated.build() }),
        transform: new Transform({ position: { x: -2 } }),
        rayMesh: square(0.5, 1),
      };
      const scene = new RayScene(backend).update({ items: [moved, patches] });
      expect(scene.instances).toHaveLength(2);
      let hits = await pointsHit(scene, [0, 2, -2]);
      expect(hits[0][3]).toBe(0);
      expect(hits[1][3]).toBe(1);
      expect(hits[1][2]).toBeCloseTo(-0.5, 4);
      expect(hits[2][3]).toBe(1);
      expect(hits[2][2]).toBeCloseTo(1, 4);
      // Moved again on the GPU (here written): the next update follows.
      vertices.write(0, deformed(2.2, 0.25).buffer);
      scene.update({ items: [moved, patches] });
      hits = await pointsHit(scene, [2, 2.65]);
      expect(hits[0][2]).toBeCloseTo(0.25, 4);
      expect(hits[1][3]).toBe(1);
      scene.destroy();
      vertices.destroy();
    });

    it('reads the points hit: positions, normals, uvs, objects, materials', async () => {
      const materials = [white(), white()];
      // A square turned a quarter around y (facing +x), scaled, moved; and
      // one facing +z behind it.
      const turned = new Transform({
        position: { x: 1, y: 0.5, z: 0 },
        rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
        scale: { x: 2, y: 2, z: 2 },
      });
      const scene = new RayScene(backend).update({
        items: [
          {
            mesh: square(0.5),
            material: materials[0],
            transform: turned,
            id: 7,
          },
          {
            mesh: square(4, -3),
            material: materials[1],
            transform: new Transform(),
            id: 9,
          },
        ],
      });
      expect(scene.materials).toEqual(materials);
      expect(scene.instances.map((instance) => instance.material)).toEqual([
        0, 1,
      ]);

      const g = new GraphBuilder('hits');
      const index = g.builtin('global-invocation-id').swizzle('x');
      const origins = g.storage('origins', arrayType(BuiltinTypes.vec4f));
      const directions = g.storage('directions', arrayType(BuiltinTypes.vec4f));
      const out = g.storage('out', arrayType(BuiltinTypes.vec4f), {
        access: 'read-write',
      });
      const hit = g.traceRay({
        origin: g.call(std.index, { array: origins, index }).swizzle('xyz'),
        direction: g
          .call(std.index, { array: directions, index })
          .swizzle('xyz'),
      });
      const base = g.call(std.mul, { a: index, b: 4 });
      const record = (k: number, value: PortHandle) =>
        g.write(out, { index: g.call(std.add, { a: base, b: k }), value });
      const extend = (xyz: PortHandle, w: PortHandle | number) =>
        g.call(std.extend, { xyz, w });
      const f32 = (value: PortHandle) =>
        g.call(std.convert, { value }, { params: { to: BuiltinTypes.f32 } });
      record(
        0,
        extend(
          g.call(stdRays.hitPosition, { hit }),
          f32(g.call(stdRays.hitObject, { hit })),
        ),
      );
      record(
        1,
        extend(
          g.call(stdRays.hitNormal, { hit }),
          f32(g.call(stdRays.hitMaterial, { hit })),
        ),
      );
      const uv = g.call(stdRays.hitUv, { hit });
      record(
        2,
        g.call(std.vec4, {
          x: uv.swizzle('x'),
          y: uv.swizzle('y'),
          z: g.call(std.select, {
            ifFalse: 0,
            ifTrue: 1,
            condition: g.call(stdRays.hitFrontFacing, { hit }),
          }),
          w: g.call(std.select, {
            ifFalse: 0,
            ifTrue: 1,
            condition: g.call(stdRays.hit, { hit }),
          }),
        }),
      );
      record(3, extend(g.call(stdRays.hitGeometricNormal, { hit }), 0));
      // The threads past the rays write nothing (no robust accesses).
      g.compute({
        active: g.call(std.less, {
          a: index,
          b: g.call(std.arrayLength, { array: origins }),
        }),
      });
      const program = compile(g.build(), {
        capabilities: backend.capabilities,
      });

      // Towards the turned square, from +x; towards the back one, from +z
      // (beside the first); and nowhere.
      const buffers = [
        storage(new Float32Array([5, 0.7, 0.4, 0, -2, 2, 5, 0, 0, 0, 5, 0])),
        storage(new Float32Array([-1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1, 0])),
      ];
      const output = storage(new Float32Array(3 * 16), true);
      const values: Record<string, never> = {
        origins: buffers[0] as never,
        directions: buffers[1] as never,
        out: output as never,
      };
      for (const name of ['scene', 'rayInstances', 'rayGeometry']) {
        values[name] = scene.resource(name) as never;
      }
      runner.dispatch(program, { values, workgroups: [1] });
      const result = new Float32Array(await output.read());
      const ray = (i: number, k: number) => [
        ...result.subarray(i * 16 + k * 4, i * 16 + k * 4 + 4),
      ];
      const close = (actual: number[], expected: number[]) =>
        expected.forEach((value, k) => expect(actual[k]).toBeCloseTo(value, 3));
      // The turned square: its +z is +x, its x is -z; at x = 1.
      close(ray(0, 0), [1, 0.7, 0.4, 7]);
      close(ray(0, 1), [1, 0, 0, 0]);
      // Local (x, y) = (-0.2, 0.1) on a square of half 0.5: uv (0.3, 0.4).
      close(ray(0, 2), [0.3, 0.4, 1, 1]);
      close(ray(0, 3), [1, 0, 0, 0]);
      close(ray(1, 0), [-2, 2, -3, 9]);
      close(ray(1, 1), [0, 0, 1, 1]);
      close(ray(1, 2), [0.25, 0.25, 1, 1]);
      expect(ray(2, 2)[3]).toBe(0);
      buffers.forEach((buffer) => buffer.destroy());
      output.destroy();
      scene.destroy();
    });

    it('converges to the light of the scene with the path tracer', async () => {
      const renderer = new Renderer(backend, {
        output: { encoding: 'linear', toneMapping: 'none' },
      });
      // Looking down at a gray floor, lit by a sun straight above; an
      // unlit square, and a blocker casting a shadow.
      const camera = new Camera({
        // Turned down: the top of the image towards -z.
        position: { x: 0, y: 5, z: 0 },
        rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
        projection: {
          type: 'orthographic',
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 100,
        },
      });
      const floorGraph = new GraphBuilder('floor');
      floorGraph.surface({
        shadingModel: 'pbr',
        baseColor: [0.5, 0.5, 0.5],
        roughness: 1,
      });
      const unlitGraph = new GraphBuilder('lamp');
      unlitGraph.surface({ baseColor: [1, 0.5, 0.25] });
      // Squares facing +y: turned from +z.
      const facingUp = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
      const items = [
        {
          mesh: square(1),
          material: new Material({ graph: floorGraph.build() }),
          transform: new Transform({ rotation: facingUp }),
        },
        {
          mesh: square(0.2),
          material: new Material({ graph: unlitGraph.build() }),
          transform: new Transform({
            position: { x: -0.6, y: 0.5, z: -0.6 },
            rotation: facingUp,
          }),
        },
        {
          mesh: square(0.15),
          material: new Material({ graph: floorGraph.build() }),
          transform: new Transform({
            position: { x: 0.5, y: 0.5, z: 0.5 },
            rotation: facingUp,
          }),
        },
      ];
      const scene = new RayScene(backend).update({ items });
      const black = { x: 0, y: 0, z: 0 };
      const tracer = new PathTracer(renderer, scene, {
        bounces: 2,
        sky: { zenith: black, horizon: black, ground: black },
      });
      const sun = new DirectionalLight({
        direction: { x: 0, y: -1, z: 0 },
        diffuse: { x: 1, y: 1, z: 1 },
      });
      let pixels: Uint8Array<ArrayBufferLike> = new Uint8Array();
      for (let frame = 0; frame < 24; frame++) {
        tracer.render({ camera, surface: fixture.surface, lights: [sun] });
        if (frame === 23) {
          pixels = await fixture.readPixels();
        }
      }
      expect(tracer.frames).toBe(24);
      const pixel = (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
      ];
      // The floor: base / π × π × 1, plus a little of the specular lobe
      // and of the light bounced off the blocker.
      const floor = pixel(16, 48)[0];
      expect(floor).toBeGreaterThan(125);
      expect(floor).toBeLessThan(145);
      // The lamp, its color.
      // (Within the filtering of its edges.)
      pixel(12, 12).forEach((value, k) =>
        expect(Math.abs(value - [255, 128, 64, 255][k])).toBeLessThanOrEqual(5),
      );
      // Under the blocker, at (0.5, 0.5): its top side lit; the floor
      // around it in its shadow: dark (only the light of the blocker).
      expect(pixel(48, 48)[0]).toBeGreaterThan(120);
      expect(pixel(36, 48)[0]).toBeGreaterThan(120);
      tracer.destroy();
      renderer.destroy();
      scene.destroy();
    });

    it('keeps the history of the points seen when the camera moves', async () => {
      const renderer = new Renderer(backend, {
        output: { encoding: 'linear', toneMapping: 'none' },
      });
      // A gray floor under a sky brighter at the zenith: the light of the
      // sky sampled at random, noisy at first.
      const floorGraph = new GraphBuilder('floor');
      floorGraph.surface({
        shadingModel: 'pbr',
        baseColor: [0.6, 0.6, 0.6],
        roughness: 1,
      });
      const items = [
        {
          mesh: square(4),
          material: new Material({ graph: floorGraph.build() }),
          transform: new Transform({
            rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
          }),
        },
      ];
      const scene = new RayScene(backend).update({ items });
      const camera = (x: number) =>
        new Camera({
          position: { x, y: 5, z: 0 },
          rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
          projection: {
            type: 'orthographic',
            left: -1,
            right: 1,
            bottom: -1,
            top: 1,
            near: 0.1,
            far: 100,
          },
        });
      const sky = {
        zenith: { x: 2, y: 2, z: 2 },
        horizon: { x: 0, y: 0, z: 0 },
        ground: { x: 0, y: 0, z: 0 },
      };
      // The spread of the values of the pixels of the middle of the image.
      const spread = async () => {
        const pixels = await fixture.readPixels();
        const values: number[] = [];
        for (let y = 16; y < 48; y++) {
          for (let x = 16; x < 48; x++) {
            values.push(pixels[(y * size + x) * 4]);
          }
        }
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(
          values.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
            values.length,
        );
      };
      const tracer = new PathTracer(renderer, scene, {
        bounces: 1,
        denoise: false,
        sky,
      });
      for (let frame = 0; frame < 32; frame++) {
        tracer.render({ camera: camera(0), surface: fixture.surface });
      }
      // Moved by a few pixels: the history of the floor follows.
      tracer.render({ camera: camera(0.1), surface: fixture.surface });
      expect(tracer.frames).toBe(1);
      const followed = await spread();
      tracer.destroy();
      const fresh = new PathTracer(renderer, scene, {
        bounces: 1,
        denoise: false,
        sky,
      });
      fresh.render({ camera: camera(0.1), surface: fixture.surface });
      const noisy = await spread();
      expect(noisy).toBeGreaterThan(4);
      expect(followed).toBeLessThan(noisy * 0.5);
      fresh.destroy();
      renderer.destroy();
      scene.destroy();
    });

    // A camera above the floor (y = 0), looking down at 45° towards -z.
    const tilted = () =>
      new Camera({
        position: { x: 0, y: 2, z: 2 },
        rotation: {
          x: -Math.sin(Math.PI / 8),
          y: 0,
          z: 0,
          w: Math.cos(Math.PI / 8),
        },
        projection: {
          type: 'perspective',
          fov: 60,
          aspect: 1,
          near: 0.1,
          far: 100,
        },
      });
    const facingUp = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    // The scene passes writing the G-buffer of the passes of rays.
    const gbufferPasses = (
      renderer: Renderer,
      graph: RenderGraph,
      items: Parameters<Renderer['addScenePasses']>[1]['items'],
      camera: Camera,
      lights: DirectionalLight[],
      rays?: RayScene,
    ) =>
      renderer.addScenePasses(graph, {
        items,
        camera,
        lights,
        target: graph.createTexture('color', { format: 'rgba16float' }),
        format: 'rgba16float',
        linear: true,
        samples: 1,
        ...(rays ? { rays: { scene: rays, shadows: true } } : {}),
        outputs: reflectionOutputs(),
      });
    const present = async (
      renderer: Renderer,
      graph: RenderGraph,
      image: ReturnType<RenderGraph['createTexture']>,
    ) => {
      const target = graph.importTexture(
        'surface',
        fixture.surface.getCurrentTarget(),
      );
      renderer.addToneMappingPass(graph, {
        hdr: image,
        target,
        format: fixture.surface.format,
      });
      renderer.executeGraph(graph);
      fixture.surface.present();
      const pixels = await fixture.readPixels();
      return (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
      ];
    };

    it('reflects the scene in the smooth surfaces', async () => {
      const renderer = new Renderer(backend, {
        output: { encoding: 'linear', toneMapping: 'none' },
      });
      const mirror = new GraphBuilder('mirror');
      mirror.surface({
        shadingModel: 'pbr',
        baseColor: [1, 1, 1],
        metallic: 1,
        roughness: 0,
      });
      const lamp = new GraphBuilder('red lamp');
      lamp.surface({ baseColor: [1, 0, 0] });
      const items = [
        {
          mesh: square(4),
          material: new Material({ graph: mirror.build() }),
          transform: new Transform({ rotation: facingUp }),
        },
        // A large red square standing at the back, facing the camera.
        {
          mesh: square(10),
          material: new Material({ graph: lamp.build() }),
          transform: new Transform({ position: { x: 0, y: 5, z: -4 } }),
        },
      ];
      const scene = new RayScene(backend).update({ items });
      const camera = tilted();
      const reflections = new RayReflections(renderer, scene, {
        sky: {
          zenith: { x: 0, y: 0, z: 0 },
          horizon: { x: 0, y: 0, z: 0 },
          ground: { x: 0, y: 0, z: 0 },
        },
      });
      const render = async (reflected: boolean) => {
        const graph = new RenderGraph({ size: { width: size, height: size } });
        const passes = gbufferPasses(renderer, graph, items, camera, []);
        const image = reflected
          ? reflections.addPasses(graph, {
              camera,
              color: passes.color,
              position: passes.outputs.position,
              normal: passes.outputs.normal,
              baseColor: passes.outputs.baseColor,
            })
          : passes.color;
        return present(renderer, graph, image);
      };
      // The floor near the bottom of the image: the red square mirrored.
      const plain = await render(false);
      const mirrored = await render(true);
      expect(plain(32, 52)[0]).toBeLessThan(40);
      expect(mirrored(32, 52)[0]).toBeGreaterThan(200);
      expect(mirrored(32, 52)[1]).toBeLessThan(40);
      reflections.destroy();
      renderer.destroy();
      scene.destroy();
    });

    it('darkens the ambient light where the scene hides the sky', async () => {
      const renderer = new Renderer(backend, {
        output: { encoding: 'linear', toneMapping: 'none' },
      });
      const items = [
        {
          mesh: square(4),
          material: white(),
          transform: new Transform({ rotation: facingUp }),
        },
        // A wall standing on the floor, across the view.
        {
          mesh: square(0.6),
          material: white(),
          transform: new Transform({ position: { x: 0, y: 0.6, z: 0 } }),
        },
      ];
      const scene = new RayScene(backend).update({ items });
      const camera = tilted();
      const occlusion = new RayOcclusion(renderer, scene, {
        radius: 0.5,
        samples: 8,
      });
      const graph = new RenderGraph({ size: { width: size, height: size } });
      const passes = gbufferPasses(renderer, graph, items, camera, []);
      const open = occlusion.addPasses(graph, {
        position: passes.outputs.position,
        normal: passes.outputs.normal,
      });
      const pixel = await present(renderer, graph, open);
      // Far from the wall, open; at its foot, half hidden.
      expect(pixel(32, 60)[0]).toBeGreaterThan(240);
      const foot = [...Array(12)].map((_, k) => pixel(32, 30 + k)[0]);
      expect(Math.min(...foot)).toBeLessThan(200);
      renderer.destroy();
      scene.destroy();
    });

    it('traces the shadows of the lights in the materials', async () => {
      const renderer = new Renderer(backend, {
        output: { encoding: 'linear', toneMapping: 'none' },
      });
      const camera = new Camera({
        position: { x: 0, y: 0, z: 5 },
        projection: {
          type: 'orthographic',
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 100,
        },
      });
      const ambient = 0.1;
      const sun = new DirectionalLight({
        direction: { x: 1, y: 0, z: -1 },
        ambient: { x: ambient, y: ambient, z: ambient },
        diffuse: { x: 1, y: 1, z: 1 },
        specular: { x: 0, y: 0, z: 0 },
        castShadow: true,
      });
      // A ground, and a blocker 0.5 in front of it, left of the center:
      // its shadow falls 0.5 to the right, on the center.
      const blocker = {
        mesh: square(0.25, 0.5),
        material: white(),
        transform: new Transform({ position: { x: -0.5 } }),
      };
      const items = [
        { mesh: square(1), material: white(), transform: new Transform() },
        blocker,
      ];
      const scene = new RayScene(backend).update({ items });
      const render = async (shadows: boolean | { samples: number }) => {
        renderer.render({
          items,
          camera,
          surface: fixture.surface,
          lights: [sun],
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
          rays: { scene, shadows },
        });
        const pixels = await fixture.readPixels();
        return (x: number, y: number) => [
          ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
        ];
      };
      const byte = (value: number) => Math.round(Math.min(value, 1) * 255);
      const gray = (value: number) => [
        byte(value),
        byte(value),
        byte(value),
        255,
      ];
      const lit = gray(ambient + Math.SQRT1_2);
      const shadowed = gray(ambient);
      let pixel = await render(true);
      expectColor(pixel(32, 32), shadowed);
      expectColor(pixel(28, 36), shadowed);
      for (const [x, y] of [
        [16, 32],
        [48, 32],
        [32, 8],
        [56, 56],
      ]) {
        expectColor(pixel(x, y), lit);
      }
      // The blocker moved: the shadow follows at the next update.
      blocker.transform.position = { x: 0.5 };
      scene.update({ items });
      pixel = await render(true);
      expectColor(pixel(32, 32), lit);
      expectColor(pixel(60, 32), shadowed);
      // Soft: several rays, the edge of the shadow in between.
      sun.shadow = { softness: 0.05 };
      pixel = await render({ samples: 4 });
      expectColor(pixel(62, 32), shadowed);
      // The edge of the shadow at x = 0.75 (pixel 56), blurred over a few
      // pixels: values in between.
      const between = [53, 54, 55, 56, 57, 58].map((x) => pixel(x, 32)[0]);
      expect(
        between.filter(
          (value) => value > shadowed[0] + 10 && value < lit[0] - 10,
        ).length,
      ).toBeGreaterThan(0);
      renderer.destroy();
      scene.destroy();
    });

    it('lets the rays through the cut parts of the masked materials', async () => {
      const renderer = new Renderer(backend, {
        output: { encoding: 'linear', toneMapping: 'none' },
      });
      const camera = new Camera({
        position: { x: 0, y: 0, z: 5 },
        projection: {
          type: 'orthographic',
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 100,
        },
      });
      const ambient = 0.1;
      const sun = new DirectionalLight({
        direction: { x: 1, y: 0, z: -1 },
        ambient: { x: ambient, y: ambient, z: ambient },
        diffuse: { x: 1, y: 1, z: 1 },
        specular: { x: 0, y: 0, z: 0 },
        castShadow: true,
      });
      // A leaf: its left half (u < 0.5) cut by its alpha.
      const leaf = new GraphBuilder('leaf');
      leaf.surface({
        shadingModel: 'phong',
        baseColor: [1, 1, 1],
        specular: [0, 0, 0],
        alpha: leaf.call(std.step, {
          edge: 0.5,
          x: leaf
            .call(std.perFragment, {
              value: leaf.attribute('uv', BuiltinTypes.vec2f),
            })
            .swizzle('x'),
        }),
      });
      const items = [
        { mesh: square(1), material: white(), transform: new Transform() },
        // 0.5 in front of the ground, left of the center: its shadow falls
        // 0.5 to the right, from x = -0.25 to 0.25, its left half cut.
        {
          mesh: square(0.25, 0.5),
          material: new Material({
            graph: leaf.build(),
            renderState: { alphaMode: 'mask', doubleSided: true },
          }),
          transform: new Transform({ position: { x: -0.5 } }),
        },
      ];
      const scene = new RayScene(backend).update({ items });
      renderer.render({
        items,
        camera,
        surface: fixture.surface,
        lights: [sun],
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        rays: { scene, shadows: true },
      });
      const pixels = await fixture.readPixels();
      const pixel = (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
      ];
      const byte = (value: number) => Math.round(Math.min(value, 1) * 255);
      const gray = (value: number) => [
        byte(value),
        byte(value),
        byte(value),
        255,
      ];
      // The shadow of the kept half; the light through the cut one.
      expectColor(pixel(36, 32), gray(ambient));
      expectColor(pixel(27, 32), gray(ambient + Math.SQRT1_2));
      // The cut half of the leaf itself is not drawn: the ground behind,
      // lit (x = -0.7, pixel 9).
      expectColor(pixel(9, 32), gray(ambient + Math.SQRT1_2));

      // The path tracer sees the ground through the cut half, without a
      // bounce through it: traced from the camera, the leaf is in the way
      // only on its right half. With ray queries, and ray tracing
      // pipelines (their any-hit shader) where the backend has them.
      const sky = { x: 0, y: 0, z: 0 };
      expect(scene.instances.length).toBe(2);
      // Rays straight through the leaf (z = 0.5), from the front: through
      // its cut half, onto the ground; on its kept half.
      const origins = new Float32Array([-0.6, 0, 2, 0, -0.4, 0, 2, 0]);
      const directions = new Float32Array([0, 0, -1, 0, 0, 0, -1, 0]);
      for (const rayTracing of [false, true]) {
        const by = new ComputeRunner(backend, { rayTracing });
        for (const mode of ['closest', 'any'] as const) {
          const hits = storage(new Uint32Array(8), true);
          const buffers = [storage(origins), storage(directions)];
          by.dispatch(traceProgram(mode, true), {
            values: {
              origins: buffers[0],
              directions: buffers[1],
              hits,
              scene: scene.topLevel,
              rayInstances: scene.resource('rayInstances') as GpuBuffer,
              rayGeometry: scene.resource('rayGeometry') as GpuBuffer,
            },
            workgroups: [1],
          });
          const found = new Uint32Array(await hits.read());
          expect(
            [found[0], found[4]],
            `${mode}, pipeline ${rayTracing}`,
          ).toEqual([0, 1]);
          hits.destroy();
          buffers.forEach((buffer) => buffer.destroy());
        }
        by.destroy();
      }
      for (const rayTracingPipeline of [false, true]) {
        const tracer = new PathTracer(renderer, scene, {
          bounces: 1,
          denoise: false,
          sky: { zenith: sky, horizon: sky, ground: sky },
          rayTracingPipeline,
        });
        for (let frame = 0; frame < 4; frame++) {
          tracer.render({ camera, surface: fixture.surface, lights: [sun] });
        }
        const traced = await fixture.readPixels();
        const tracedPixel = (x: number, y: number) =>
          traced[(y * size + x) * 4];
        // In the shadow of the kept half, and in the light of the cut one.
        expect(tracedPixel(36, 32)).toBeLessThan(40);
        expect(tracedPixel(27, 32)).toBeGreaterThan(120);
        tracer.destroy();
      }
      renderer.destroy();
      scene.destroy();
    });
  });
}
