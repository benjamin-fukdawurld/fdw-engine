import {
  BuiltinTypes,
  GraphBuilder,
  Ops,
  PortHandle,
  Value,
} from '@fdw/engine-shader';

// What the passes tracing rays compute in their graphs: random numbers, the
// frame of a normal, the BSDF of the surfaces (that of the pbr shading
// model: Lambert and GGX, metalness and roughness), its sampling.

/** The graph being built, with the shorthands of the functions. */
export class Shading extends Ops {
  constructor(readonly g: GraphBuilder) {
    super(g);
  }

  /** A hash of a u32 (PCG): well spread bits. */
  hash(value: Value): PortHandle {
    const state = this.add(this.mul(value, this.u32(747796405)), this.u32(2891336453));
    const shift = this.add(this.shr(state, this.u32(28)), this.u32(4));
    const word = this.mul(this.xor(this.shr(state, shift), state), this.u32(277803737));
    return this.xor(this.shr(word, this.u32(22)), word);
  }

  /** A number in [0, 1) from a hash. */
  unit(hash: Value): PortHandle {
    return this.mul(
      this.convert(this.shr(hash, this.u32(8)), BuiltinTypes.f32),
      1 / 16777216,
    );
  }

  /**
   * `count` random numbers in [0, 1) for a pixel: different for each
   * pixel, `seed` (the frame and the bounce) and dimension.
   */
  random(pixel: Value, seed: Value, count: number): PortHandle[] {
    const base = this.hash(this.xor(this.hash(pixel), this.hash(seed)));
    return Array.from({ length: count }, (_, k) =>
      this.unit(k === 0 ? base : this.hash(this.add(base, this.u32(k)))),
    );
  }

  /** Two vectors across a unit normal: the tangent and the bitangent. */
  frame(n: Value): [PortHandle, PortHandle] {
    const up = this.select(
      [0, 1, 0],
      [1, 0, 0],
      this.greater(this.abs(this.swizzle(n, 'y')), 0.99),
    );
    const t = this.normalize(this.cross(up, n));
    return [t, this.cross(n, t)];
  }

  /** a.x × t + a.y × b + a.z × n. */
  toWorld(local: PortHandle, [t, b]: [Value, Value], n: Value): PortHandle {
    return this.sum([
      this.mul(t, local.swizzle('x')),
      this.mul(b, local.swizzle('y')),
      this.mul(n, local.swizzle('z')),
    ]);
  }

  swizzle(value: Value, mask: string): PortHandle {
    if (!(value instanceof PortHandle)) {
      throw new Error('Only the ports have components');
    }
    return value.swizzle(mask);
  }

  /** The luminance of a linear color. */
  luminance(color: Value): PortHandle {
    return this.dot(color, [0.2126, 0.7152, 0.0722]);
  }

  /** e^x, from pow: the standard library has no exp. */
  exp(x: Value): PortHandle {
    return this.pow(Math.E, x);
  }
}

/** The parameters of the BSDF of a surface. */
export interface Surface {
  readonly baseColor: PortHandle;
  readonly normal: PortHandle;
  readonly roughness: PortHandle;
  readonly metallic: PortHandle;
}

/** The BSDF of a surface, from the direction to the viewer. */
export class Bsdf {
  readonly alpha: PortHandle;
  readonly f0: PortHandle;
  readonly diffuse: PortHandle;
  readonly nv: PortHandle;
  // The probability of sampling the specular lobe.
  readonly specularChance: PortHandle;

  constructor(
    private readonly s: Shading,
    readonly surface: Surface,
    readonly wo: PortHandle,
  ) {
    const { roughness, metallic, baseColor, normal } = surface;
    this.alpha = s.max(s.mul(roughness, roughness), 0.002);
    this.f0 = s.mix(s.splat3(0.04), baseColor, metallic);
    this.diffuse = s.mul(baseColor, s.sub(1, metallic));
    this.nv = s.max(s.dot(normal, wo), 1e-4);
    const specular = s.luminance(this.fresnel(this.nv));
    const diffuse = s.luminance(this.diffuse);
    this.specularChance = s.clamp(
      s.div(specular, s.max(s.add(specular, diffuse), 1e-4)),
      0.1,
      1,
    );
  }

  /** Schlick's Fresnel at a cosine. */
  fresnel(cosine: Value): PortHandle {
    const s = this.s;
    const k = s.pow(s.sub(1, s.saturate(cosine)), 5);
    return s.add(this.f0, s.mul(s.sub(s.splat3(1), this.f0), k));
  }

  /** The GGX distribution at a cosine between the normal and the half vector. */
  distribution(nh: Value): PortHandle {
    const s = this.s;
    const a2 = s.mul(this.alpha, this.alpha);
    const d = s.add(s.mul(s.mul(nh, nh), s.sub(a2, 1)), 1);
    return s.div(a2, s.max(s.mul(Math.PI, s.mul(d, d)), 1e-8));
  }

  // Smith-Schlick: the shadowing of one direction.
  private visibility(cosine: Value): PortHandle {
    const s = this.s;
    const k = s.mul(this.alpha, 0.5);
    return s.div(cosine, s.add(s.mul(cosine, s.sub(1, k)), k));
  }

  /** The BSDF times the cosine of the light, for a direction wi. */
  evaluate(wi: PortHandle): PortHandle {
    const s = this.s;
    const n = this.surface.normal;
    const nl = s.max(s.dot(n, wi), 0);
    const h = s.normalize(s.add(this.wo, wi));
    const nh = s.max(s.dot(n, h), 0);
    const vh = s.max(s.dot(this.wo, h), 0);
    const specular = s.div(
      s.mul(
        s.mul(this.distribution(nh), s.mul(this.visibility(nl), this.visibility(this.nv))),
        this.fresnel(vh),
      ),
      s.max(s.mul(4, s.mul(nl, this.nv)), 1e-4),
    );
    return s.mul(s.add(s.mul(this.diffuse, 1 / Math.PI), specular), nl);
  }

  /** The density of the sampling of a direction wi (both lobes). */
  density(wi: PortHandle): PortHandle {
    const s = this.s;
    const n = this.surface.normal;
    const nl = s.max(s.dot(n, wi), 0);
    const h = s.normalize(s.add(this.wo, wi));
    const nh = s.max(s.dot(n, h), 0);
    const vh = s.max(s.dot(this.wo, h), 1e-4);
    const specular = s.div(s.mul(this.distribution(nh), nh), s.mul(4, vh));
    const diffuse = s.mul(nl, 1 / Math.PI);
    return s.mix(diffuse, specular, this.specularChance);
  }

  /**
   * A direction sampled from the BSDF with three random numbers: the
   * specular lobe (GGX, a half vector reflected) with specularChance,
   * else the diffuse one (cosine weighted).
   */
  sample(u: readonly PortHandle[]): PortHandle {
    const s = this.s;
    const n = this.surface.normal;
    const frame = s.frame(n);
    const phi = s.mul(u[1], 2 * Math.PI);
    // Cosine weighted.
    const r = s.sqrt(u[2]);
    const cosine = s.toWorld(
      s.vec3(
        s.mul(r, s.cos(phi)),
        s.mul(r, s.sin(phi)),
        s.sqrt(s.max(s.sub(1, u[2]), 0)),
      ),
      frame,
      n,
    );
    // GGX: the half vector, then the reflection of wo.
    const a2 = s.mul(this.alpha, this.alpha);
    const cosTheta = s.sqrt(
      s.div(s.sub(1, u[2]), s.add(1, s.mul(s.sub(a2, 1), u[2]))),
    );
    const sinTheta = s.sqrt(s.max(s.sub(1, s.mul(cosTheta, cosTheta)), 0));
    const h = s.toWorld(
      s.vec3(s.mul(sinTheta, s.cos(phi)), s.mul(sinTheta, s.sin(phi)), cosTheta),
      frame,
      n,
    );
    const reflected = s.reflect(s.mul(this.wo, -1), h);
    return s.select(cosine, reflected, s.less(u[0], this.specularChance));
  }
}
