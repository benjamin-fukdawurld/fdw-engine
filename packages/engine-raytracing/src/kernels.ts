import {
  arrayType,
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  PortHandle,
  RayMasks,
  RaySurfaceVec4s,
  stdRays,
} from '@fdw/engine-shader';
import { Bsdf, Shading } from './shading';

// The compute graphs of the path tracer and of the passes tracing rays
// from the pixels. One thread per ray, and a ray per pixel: the paths are
// in a buffer, PathVec4s vec4 each (the origin and whether the path goes
// on, the direction, the throughput, the radiance gathered); each bounce
// reads one buffer and writes the other. A kernel binds at most the 8
// storage buffers WebGPU guarantees.

/** vec4 per path: origin and alive, direction, throughput, radiance. */
export const PathVec4s = 4;

const vec4f = arrayType(BuiltinTypes.vec4f);

/** vec4 per light in the lights buffer (see packLights). */
export const LightVec4s = 4;

// A kernel: the thread, its pixel, and the guard of the rays out of the
// image.
function kernel(name: string) {
  const g = new GraphBuilder(name);
  const s = new Shading(g);
  const index = g.builtin('global-invocation-id').swizzle('x');
  const count = g.uniform('pixelCount', BuiltinTypes.u32);
  const read = (name: string, type = vec4f) => g.storage(name, type);
  const write = (name: string, type = vec4f) =>
    g.storage(name, type, { access: 'read-write' });
  const finish = () => {
    g.compute({ workgroupSize: [64, 1, 1], active: s.less(index, count) });
    return g.build();
  };
  return { g, s, index, read, write, finish };
}

/**
 * The rays of the camera: through each pixel, at a random point of it
 * (the antialiasing), from the near plane. The throughput 1, nothing
 * gathered yet.
 */
export function cameraKernel(): MaterialGraphData {
  const { g, s, index, write, finish } = kernel('camera rays');
  const width = g.uniform('width', BuiltinTypes.u32);
  const height = g.uniform('height', BuiltinTypes.u32);
  const frame = g.uniform('frame', BuiltinTypes.u32);
  const inverse = g.uniform('inverseViewProjection', BuiltinTypes.mat4f);
  const [jx, jy] = s.random(index, s.mul(frame, s.u32(16)), 2);
  const x = s.convert(s.remainder(index, width), BuiltinTypes.f32);
  const y = s.convert(s.div(index, width), BuiltinTypes.f32);
  const fw = s.convert(width, BuiltinTypes.f32);
  const fh = s.convert(height, BuiltinTypes.f32);
  // Clip space: y up, the rows from the top.
  const ndc = s.vec2(
    s.sub(s.mul(s.div(s.add(x, jx), fw), 2), 1),
    s.sub(1, s.mul(s.div(s.add(y, jy), fh), 2)),
  );
  const unproject = (z: number) => {
    const point = s.transform(
      inverse,
      s.vec4(ndc.swizzle('x'), ndc.swizzle('y'), z, 1),
    );
    return s.div(point.swizzle('xyz'), point.swizzle('w'));
  };
  const near = unproject(0);
  const direction = s.normalize(s.sub(unproject(1), near));
  writePath(g, s, index, write('pathsOut'), [
    s.extend(near, 1),
    s.extend(direction, 0),
    [1, 1, 1, 0],
    [0, 0, 0, 0],
  ]);
  return finish();
}

// The vec4 k of the path of a thread.
const pathVec = (s: Shading, paths: PortHandle, index: PortHandle, k: number) =>
  s.index(paths, s.add(s.mul(index, s.u32(PathVec4s)), s.u32(k)));

// Writes the vec4 of the path of a thread.
function writePath(
  g: GraphBuilder,
  s: Shading,
  index: PortHandle,
  paths: PortHandle,
  values: readonly (PortHandle | number[])[],
): void {
  values.forEach((value, k) =>
    g.write(paths, {
      index: s.add(s.mul(index, s.u32(PathVec4s)), s.u32(k)),
      value,
    }),
  );
}

/**
 * The closest hit of each ray alive (the others hit nothing): the rays of
 * `stride` vec4 each in `rays`, the origin (w: alive) then the direction.
 * The point of the surface of each ray (raySurfaces) is cleared: the hit
 * programs write it for the rays that hit their material, its w is 0 for
 * the others (see RaySurfaceVec4s).
 */
export function traceKernel(): MaterialGraphData {
  const { g, s, index, read, write, finish } = kernel('trace rays');
  const rays = read('rays');
  const stride = g.uniform('stride', BuiltinTypes.u32);
  const origin = s.index(rays, s.mul(index, stride));
  const direction = s.index(rays, s.add(s.mul(index, stride), s.u32(1)));
  const alive = s.greater(origin.swizzle('w'), 0.5);
  const hit = g.traceRay({
    origin: origin.swizzle('xyz'),
    direction: direction.swizzle('xyz'),
    tMin: 0,
    tMax: s.select(-1, 1e30, alive),
    mask: RayMasks.visible,
    alphaTest: true,
  });
  g.write(write('rayHits', arrayType(BuiltinTypes.vec4u)), {
    index,
    value: hit,
  });
  g.write(write('raySurfaces'), {
    index: s.add(s.mul(index, s.u32(RaySurfaceVec4s)), s.u32(4)),
    value: [0, 0, 0, 0],
  });
  return finish();
}

/** vec4 per pixel of the guides of the denoiser (see guidesKernel). */
export const GuideVec4s = 3;

/**
 * The guides of the denoiser, from the first hits of the camera rays (their
 * surfaces): the albedo (the base color, or the emission of the unlit
 * materials, or the sky) and the distance; the normal (the direction back
 * for the sky: the same for the neighbors); the point hit, w 1 (0 for the
 * sky). A pixel follows its point from frame to frame (accumulateKernel).
 */
export function guidesKernel(): MaterialGraphData {
  const { g, s, index, read, write, finish } = kernel('guides');
  const zenith = g.uniform('skyZenith', BuiltinTypes.vec3f);
  const horizon = g.uniform('skyHorizon', BuiltinTypes.vec3f);
  const ground = g.uniform('skyGround', BuiltinTypes.vec3f);
  const paths = read('paths');
  const surfaces = read('raySurfaces');
  const surface = (k: number) =>
    s.index(surfaces, s.add(s.mul(index, s.u32(RaySurfaceVec4s)), s.u32(k)));
  const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map(surface);
  const origin = pathVec(s, paths, index, 0).swizzle('xyz');
  const dir = s.normalize(pathVec(s, paths, index, 1).swizzle('xyz'));
  const hitSomething = s.greater(s4.swizzle('w'), 0.5);
  const position = s4.swizzle('xyz');
  const metallic = s.saturate(s2.swizzle('w'));
  const albedo = s.select(
    skyColor(s, dir, { zenith, horizon, ground }),
    s.select(
      s.add(
        s.mul(s0.swizzle('xyz'), s.sub(1, metallic)),
        s.mix(s.splat3(0.04), s0.swizzle('xyz'), metallic),
      ),
      s2.swizzle('xyz'),
      s.greater(s3.swizzle('y'), 0.5),
    ),
    hitSomething,
  );
  const depth = s.select(1e6, s.length(s.sub(position, origin)), hitSomething);
  const guides = write('guides');
  const at = (k: number) => s.add(s.mul(index, s.u32(GuideVec4s)), s.u32(k));
  g.write(guides, { index: at(0), value: s.extend(albedo, depth) });
  g.write(guides, {
    index: at(1),
    value: s.extend(
      s.select(s.mul(dir, -1), s.normalize(s1.swizzle('xyz')), hitSomething),
      0,
    ),
  });
  g.write(guides, {
    index: at(2),
    value: s.extend(position, s.select(0, 1, hitSomething)),
  });
  return finish();
}

// The sky of the rays lost, a gradient from the ground to the zenith.
function skyColor(
  s: Shading,
  dir: PortHandle,
  {
    zenith,
    horizon,
    ground,
  }: Record<'zenith' | 'horizon' | 'ground', PortHandle>,
): PortHandle {
  const up = dir.swizzle('y');
  return s.select(
    s.mix(horizon, ground, s.saturate(s.mul(up, -4))),
    s.mix(horizon, zenith, s.saturate(up)),
    s.greater(up, 0),
  );
}

/**
 * A bounce: what the rays hit (the surfaces written by the hit programs of
 * the materials) gives its emission, the light of a light chosen at random
 * (a shadow ray towards it), and the next direction, sampled from the
 * BSDF; the rays that hit nothing gather the sky. Whether a ray hit is
 * the w of its point in raySurfaces (see traceKernel).
 */
export function bounceKernel(): MaterialGraphData {
  const { g, s, index, read, write, finish } = kernel('bounce');
  const frame = g.uniform('frame', BuiltinTypes.u32);
  const bounce = g.uniform('bounce', BuiltinTypes.u32);
  const lightCount = g.uniform('lightCount', BuiltinTypes.u32);
  const zenith = g.uniform('skyZenith', BuiltinTypes.vec3f);
  const horizon = g.uniform('skyHorizon', BuiltinTypes.vec3f);
  const ground = g.uniform('skyGround', BuiltinTypes.vec3f);
  const paths = read('paths');
  const surfaces = read('raySurfaces');
  const lights = read('lights');

  const ray0 = pathVec(s, paths, index, 0);
  const ray1 = pathVec(s, paths, index, 1);
  const alive = s.greater(ray0.swizzle('w'), 0.5);
  const dir = s.normalize(ray1.swizzle('xyz'));
  const throughput = pathVec(s, paths, index, 2).swizzle('xyz');
  const radiance = pathVec(s, paths, index, 3).swizzle('xyz');
  const surface = (k: number) =>
    s.index(surfaces, s.add(s.mul(index, s.u32(RaySurfaceVec4s)), s.u32(k)));
  const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map(surface);
  const baseColor = s0.swizzle('xyz');
  const alpha = s0.swizzle('w');
  const normal = s.normalize(s1.swizzle('xyz'));
  const emissive = s2.swizzle('xyz');
  const unlit = s.greater(s3.swizzle('y'), 0.5);
  const cutoff = s3.swizzle('z');
  const hitSomething = s.greater(s4.swizzle('w'), 0.5);
  // Written by the hit program: the geometry of the scene is not read.
  const position = s4.swizzle('xyz');

  const u = s.random(
    index,
    s.add(s.mul(frame, s.u32(16)), s.add(bounce, s.u32(1))),
    8,
  );

  const sky = skyColor(s, dir, { zenith, horizon, ground });

  // Through the transparent pixels of masked and blended materials.
  const through = s.or(
    s.and(s.greater(cutoff, 0), s.less(alpha, cutoff)),
    s.and(s.less(cutoff, 0), s.greater(u[7], alpha)),
  );

  // A light chosen at random: its direction, distance and radiance.
  const fCount = s.convert(lightCount, BuiltinTypes.f32);
  const chosen = s.min(
    s.convert(s.floor(s.mul(u[3], fCount)), BuiltinTypes.u32),
    s.sub(s.max(lightCount, s.u32(1)), s.u32(1)),
  );
  const light = (k: number) =>
    s.index(lights, s.add(s.mul(chosen, s.u32(LightVec4s)), s.u32(k)));
  const [l0, l1, l2, l3] = [0, 1, 2, 3].map(light);
  const toLight = s.sub(l0.swizzle('xyz'), s.mul(position, l0.swizzle('w')));
  const distance = s.length(toLight);
  const l = s.div(toLight, s.max(distance, 1e-6));
  const attenuation = s.select(
    1,
    s.div(
      1,
      s.max(
        s.sum([
          l3.swizzle('x'),
          s.mul(l3.swizzle('y'), distance),
          s.mul(l3.swizzle('z'), s.mul(distance, distance)),
        ]),
        1e-6,
      ),
    ),
    s.greater(l0.swizzle('w'), 0.5),
  );
  const spot = s.saturate(
    s.div(
      s.sub(s.dot(s.mul(l, -1), l2.swizzle('xyz')), l3.swizzle('w')),
      s.max(s.sub(l2.swizzle('w'), l3.swizzle('w')), 1e-4),
    ),
  );
  const bsdf = new Bsdf(
    s,
    {
      baseColor,
      normal,
      roughness: s.clamp(s1.swizzle('w'), 0.02, 1),
      metallic: s.saturate(s2.swizzle('w')),
    },
    s.mul(dir, -1),
  );
  // The shadow ray, from the point moved off the surface.
  const offset = s.mul(normal, 1e-3);
  const lit = s.and(
    s.greater(lightCount, s.u32(0)),
    s.greater(s.dot(normal, l), 0),
  );
  const shadowOrigin = s.add(position, offset);
  const shadow = g.traceRay({
    origin: shadowOrigin,
    direction: s.sub(s.add(position, toLight), shadowOrigin),
    tMax: s.select(
      -1,
      s.select(1e30, 0.999, s.greater(l0.swizzle('w'), 0.5)),
      s.and(lit, s.and(alive, s.and(hitSomething, s.not(through)))),
    ),
    mask: RayMasks.shadow,
    mode: 'any',
    alphaTest: true,
  });
  const visible = s.and(lit, s.not(g.call(stdRays.hit, { hit: shadow })));
  const direct = s.select(
    [0, 0, 0],
    s.mul(
      s.mul(
        bsdf.evaluate(l),
        s.mul(l1.swizzle('xyz'), s.mul(attenuation, spot)),
      ),
      fCount,
    ),
    visible,
  );

  // The next direction, and its weight.
  const wi = s.normalize(bsdf.sample([u[0], u[1], u[2]]));
  const pdf = bsdf.density(wi);
  const weight = s.div(bsdf.evaluate(wi), s.max(pdf, 1e-6));
  const below = s.lessEqual(s.dot(normal, wi), 0);
  let nextThroughput = s.mul(throughput, weight);
  // Russian roulette after two bounces.
  const survive = s.clamp(
    s.max(
      s.max(nextThroughput.swizzle('x'), nextThroughput.swizzle('y')),
      nextThroughput.swizzle('z'),
    ),
    0.05,
    0.95,
  );
  const roulette = s.greaterEqual(bounce, s.u32(2));
  const killed = s.and(roulette, s.greater(u[4], survive));
  nextThroughput = s.select(
    nextThroughput,
    s.div(nextThroughput, survive),
    roulette,
  );

  const gathered = s.add(
    radiance,
    s.select(
      [0, 0, 0],
      s.select(
        s.mul(throughput, sky),
        s.mul(throughput, s.add(emissive, s.select(direct, [0, 0, 0], unlit))),
        hitSomething,
      ),
      s.and(alive, s.not(s.and(hitSomething, through))),
    ),
  );
  const continues = s.and(
    alive,
    s.and(
      hitSomething,
      s.or(through, s.and(s.not(unlit), s.and(s.not(below), s.not(killed)))),
    ),
  );
  const nextDirection = s.select(wi, dir, through);
  const nextOrigin = s.add(
    position,
    s.select(s.mul(normal, 1e-3), s.mul(dir, 1e-3), through),
  );
  writePath(g, s, index, write('pathsOut'), [
    s.extend(nextOrigin, s.select(0, 1, continues)),
    s.extend(nextDirection, 0),
    s.extend(s.select(nextThroughput, throughput, through), 0),
    s.extend(gathered, 0),
  ]);
  return finish();
}

/**
 * The radiance of the frame blended into the history of its pixel: the
 * average of the frames since the last reset (the lights or the materials
 * changed) while the camera and the scene do not move, an average of the
 * last `maxHistory` frames otherwise. The history of a pixel is that of
 * the point it saw in the previous frame (its guides): where that point
 * was in the image (`previousViewProjection`), read between the four
 * pixels around it, those that saw the same surface (a point and a normal
 * close to it); a pixel without history starts again (what was hidden, a
 * moving object). Fireflies (a radiance far above the rest, from rare
 * paths) are clamped. The accumulation holds the average and the number
 * of frames.
 */
export function accumulateKernel(): MaterialGraphData {
  const { g, s, index, read, write, finish } = kernel('accumulate');
  const width = g.uniform('width', BuiltinTypes.u32);
  const height = g.uniform('height', BuiltinTypes.u32);
  const reset = g.uniform('reset', BuiltinTypes.u32);
  const maxHistory = g.uniform('maxHistory', BuiltinTypes.f32);
  const previousViewProjection = g.uniform(
    'previousViewProjection',
    BuiltinTypes.mat4f,
  );
  // The camera did not move: each pixel keeps its own history.
  const still = s.greater(g.uniform('still', BuiltinTypes.u32), s.u32(0));
  const clampTo = g.uniform('maxRadiance', BuiltinTypes.f32);
  const sample = pathVec(s, read('paths'), index, 3).swizzle('xyz');
  const luminance = s.luminance(sample);
  const clamped = s.mul(
    sample,
    s.min(1, s.div(clampTo, s.max(luminance, 1e-6))),
  );
  const guides = read('guides');
  const previousGuides = read('previousGuides');
  const accumulation = read('accumulation');
  const guide = (buffer: PortHandle, pixel: PortHandle, k: number) =>
    s.index(buffer, s.add(s.mul(pixel, s.u32(GuideVec4s)), s.u32(k)));
  const depth = guide(guides, index, 0).swizzle('w');
  const normal = guide(guides, index, 1).swizzle('xyz');
  const point = guide(guides, index, 2);
  // Where the point was in the previous image, in pixels (centers at .5).
  const clip = s.transform(
    previousViewProjection,
    s.extend(point.swizzle('xyz'), 1),
  );
  const ndc = s.div(clip.swizzle('xy'), s.max(clip.swizzle('w'), 1e-6));
  const fw = s.convert(width, BuiltinTypes.f32);
  const fh = s.convert(height, BuiltinTypes.f32);
  const px = s.select(
    s.sub(s.mul(s.add(s.mul(ndc.swizzle('x'), 0.5), 0.5), fw), 0.5),
    s.convert(s.remainder(index, width), BuiltinTypes.f32),
    still,
  );
  const py = s.select(
    s.sub(s.mul(s.sub(0.5, s.mul(ndc.swizzle('y'), 0.5)), fh), 0.5),
    s.convert(s.div(index, width), BuiltinTypes.f32),
    still,
  );
  const x0 = s.floor(px);
  const y0 = s.floor(py);
  const fx = s.sub(px, x0);
  const fy = s.sub(py, y0);
  // The four pixels around, weighted, those of the same surface only.
  const tolerance = s.max(s.mul(depth, 0.02), 0.01);
  let sum: PortHandle | undefined;
  let total: PortHandle | undefined;
  let frames: PortHandle | undefined;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const tx = s.add(x0, dx);
    const ty = s.add(y0, dy);
    const inside = s.and(
      s.and(s.greaterEqual(tx, 0), s.less(tx, fw)),
      s.and(s.greaterEqual(ty, 0), s.less(ty, fh)),
    );
    const pixel = s.add(
      s.mul(s.convert(s.clamp(ty, 0, s.sub(fh, 1)), BuiltinTypes.u32), width),
      s.convert(s.clamp(tx, 0, s.sub(fw, 1)), BuiltinTypes.u32),
    );
    const before = guide(previousGuides, pixel, 2);
    const same = s.and(
      s.and(
        inside,
        s.greater(s.mul(before.swizzle('w'), point.swizzle('w')), 0.5),
      ),
      s.and(
        s.less(
          s.length(s.sub(before.swizzle('xyz'), point.swizzle('xyz'))),
          tolerance,
        ),
        s.greater(
          s.dot(guide(previousGuides, pixel, 1).swizzle('xyz'), normal),
          0.9,
        ),
      ),
    );
    const weight = s.select(
      0,
      s.mul(dx === 0 ? s.sub(1, fx) : fx, dy === 0 ? s.sub(1, fy) : fy),
      same,
    );
    const history = s.index(accumulation, pixel);
    sum = sum ? s.add(sum, s.mul(history, weight)) : s.mul(history, weight);
    total = total ? s.add(total, weight) : weight;
    frames = frames
      ? s.max(frames, s.select(0, history.swizzle('w'), same))
      : s.select(0, history.swizzle('w'), same);
  }
  const found = s.and(
    s.greater(total as PortHandle, 1e-3),
    s.equal(reset, s.u32(0)),
  );
  const previous = s.div(sum as PortHandle, s.max(total as PortHandle, 1e-6));
  const count = s.select(
    1,
    s.add(s.min(frames as PortHandle, s.sub(maxHistory, 1)), 1),
    found,
  );
  const average = s.select(
    clamped,
    s.mix(previous.swizzle('xyz'), clamped, s.div(1, count)),
    found,
  );
  g.write(write('accumulationOut'), { index, value: s.extend(average, count) });
  g.write(write('color'), { index, value: s.extend(average, 1) });
  return finish();
}

/**
 * A pass of the à-trous filter (Dammertz et al.): the 5 × 5 B3 spline at a
 * step of `step` pixels, each neighbor weighted by how close its normal,
 * its depth and its color are; on the color divided by the albedo (the
 * textures stay sharp), multiplied back by the last pass. Less blur
 * across colors as the frames of the history of the pixel add up (the w of
 * its accumulation).
 */
export function denoiseKernel(): MaterialGraphData {
  const { g, s, index, read, write, finish } = kernel('denoise');
  const width = g.uniform('width', BuiltinTypes.u32);
  const height = g.uniform('height', BuiltinTypes.u32);
  const step = g.uniform('step', BuiltinTypes.i32);
  const colorPhi = g.uniform('colorPhi', BuiltinTypes.f32);
  const first = g.uniform('first', BuiltinTypes.u32);
  const last = g.uniform('last', BuiltinTypes.u32);
  const colors = read('input');
  const guides = read('guides');
  const frames = s.index(read('accumulation'), index).swizzle('w');
  const phi = s.div(colorPhi, s.sqrt(s.max(frames, 1)));
  const x = s.convert(s.remainder(index, width), BuiltinTypes.i32);
  const y = s.convert(s.div(index, width), BuiltinTypes.i32);
  const w = s.convert(width, BuiltinTypes.i32);
  const h = s.convert(height, BuiltinTypes.i32);
  const albedoOf = (pixel: PortHandle) =>
    s.max(
      s.index(guides, s.mul(pixel, s.u32(GuideVec4s))).swizzle('xyz'),
      s.splat3(0.02),
    );
  // The illumination: the color over the albedo, on the first pass.
  const illumination = (pixel: PortHandle) => {
    const color = s.index(colors, pixel).swizzle('xyz');
    return s.select(
      color,
      s.div(color, albedoOf(pixel)),
      s.greater(first, s.u32(0)),
    );
  };
  const center = illumination(index);
  const centerGuide = s.index(guides, s.mul(index, s.u32(GuideVec4s)));
  const centerNormal = s
    .index(guides, s.add(s.mul(index, s.u32(GuideVec4s)), s.u32(1)))
    .swizzle('xyz');
  const kernelWeights = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];
  let sum: PortHandle | undefined;
  let total: PortHandle | undefined;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = s.clamp(s.add(x, s.mul(step, dx)), 0, s.sub(w, 1));
      const py = s.clamp(s.add(y, s.mul(step, dy)), 0, s.sub(h, 1));
      const pixel = s.convert(s.add(s.mul(py, w), px), BuiltinTypes.u32);
      const value = illumination(pixel);
      const guide = s.index(guides, s.mul(pixel, s.u32(GuideVec4s)));
      const normal = s
        .index(guides, s.add(s.mul(pixel, s.u32(GuideVec4s)), s.u32(1)))
        .swizzle('xyz');
      const normalWeight = s.pow(s.max(s.dot(centerNormal, normal), 0), 32);
      const depthWeight = s.exp(
        s.mul(
          -1,
          s.div(
            s.abs(s.sub(guide.swizzle('w'), centerGuide.swizzle('w'))),
            s.max(s.mul(centerGuide.swizzle('w'), 0.02), 1e-3),
          ),
        ),
      );
      const difference = s.sub(value, center);
      const colorWeight = s.exp(
        s.mul(-1, s.div(s.dot(difference, difference), s.max(phi, 1e-6))),
      );
      const weight = s.mul(
        kernelWeights[dx + 2] * kernelWeights[dy + 2],
        s.mul(normalWeight, s.mul(depthWeight, colorWeight)),
      );
      sum = sum ? s.add(sum, s.mul(value, weight)) : s.mul(value, weight);
      total = total ? s.add(total, weight) : weight;
    }
  }
  const filtered = s.div(sum as PortHandle, s.max(total as PortHandle, 1e-6));
  const output = s.select(
    filtered,
    s.mul(filtered, albedoOf(index)),
    s.greater(last, s.u32(0)),
  );
  g.write(write('output'), { index, value: s.extend(output, 1) });
  return finish();
}

/**
 * The image of a buffer of a color per pixel, in a full screen pass: the
 * linear colors, for the tone mapping that follows.
 */
export function presentGraph(): MaterialGraphData {
  const g = new GraphBuilder('present rays');
  const s = new Shading(g);
  const width = g.uniform('width', BuiltinTypes.u32);
  const height = g.uniform('height', BuiltinTypes.u32);
  const uv = g.builtin('screen-uv');
  const column = s.min(
    s.convert(
      s.mul(uv.swizzle('x'), s.convert(width, BuiltinTypes.f32)),
      BuiltinTypes.u32,
    ),
    s.sub(width, s.u32(1)),
  );
  const row = s.min(
    s.convert(
      s.mul(uv.swizzle('y'), s.convert(height, BuiltinTypes.f32)),
      BuiltinTypes.u32,
    ),
    s.sub(height, s.u32(1)),
  );
  const color = s.index(
    g.storage('color', vec4f),
    s.add(s.mul(row, width), column),
  );
  g.fullscreen({ color: s.extend(color.swizzle('xyz'), 1) });
  return g.build();
}
