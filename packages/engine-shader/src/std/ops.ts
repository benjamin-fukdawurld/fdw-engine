import type { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type { ConstantValue } from '../types/ConstantValue';
import { BuiltinTypes, ShaderType } from '../types/ShaderType';
import * as functions from './functions';

/** A value of a graph being built: a port, or a literal. */
export type Value = PortHandle | ConstantValue;

/**
 * Shorthands for the standard functions on a graph builder, for the long
 * function graphs of the standard library (noises, patterns): `o.add(a,
 * b)` for `f.call(std.add, { a, b })`.
 */
export class Ops {
  constructor(readonly f: GraphBuilder) {}

  add = (a: Value, b: Value) => this.f.call(functions.add, { a, b });
  sub = (a: Value, b: Value) => this.f.call(functions.sub, { a, b });
  mul = (a: Value, b: Value) => this.f.call(functions.mul, { a, b });
  div = (a: Value, b: Value) => this.f.call(functions.div, { a, b });
  min = (a: Value, b: Value) => this.f.call(functions.min, { a, b });
  max = (a: Value, b: Value) => this.f.call(functions.max, { a, b });
  abs = (x: Value) => this.f.call(functions.abs, { x });
  floor = (x: Value) => this.f.call(functions.floor, { x });
  fract = (x: Value) => this.f.call(functions.fract, { x });
  sqrt = (x: Value) => this.f.call(functions.sqrt, { x });
  saturate = (x: Value) => this.f.call(functions.saturate, { x });
  pow = (base: Value, exponent: Value) =>
    this.f.call(functions.pow, { base, exponent });
  dot = (a: Value, b: Value) => this.f.call(functions.dot, { a, b });
  length = (x: Value) => this.f.call(functions.length, { x });
  step = (edge: Value, x: Value) => this.f.call(functions.step, { edge, x });
  mix = (a: Value, b: Value, t: Value) =>
    this.f.call(functions.mix, { a, b, t });
  clamp = (x: Value, low: Value, high: Value) =>
    this.f.call(functions.clamp, { x, low, high });
  smoothstep = (low: Value, high: Value, x: Value) =>
    this.f.call(functions.smoothstep, { low, high, x });
  select = (ifFalse: Value, ifTrue: Value, condition: Value) =>
    this.f.call(functions.select, { ifFalse, ifTrue, condition });
  less = (a: Value, b: Value) => this.f.call(functions.less, { a, b });
  dpdx = (x: Value) => this.f.call(functions.dpdx, { x });
  dpdy = (x: Value) => this.f.call(functions.dpdy, { x });
  xor = (a: Value, b: Value) => this.f.call(functions.bitXor, { a, b });
  shr = (value: Value, amount: Value) =>
    this.f.call(functions.shiftRight, { value, amount });
  remainder = (a: Value, b: Value) =>
    this.f.call(functions.remainder, { a, b });
  convert = (value: Value, to: ShaderType) =>
    this.f.call(functions.convert, { value }, { params: { to } });
  vec2 = (x: Value, y: Value) => this.f.call(functions.vec2, { x, y });
  vec3 = (x: Value, y: Value, z: Value) =>
    this.f.call(functions.vec3, { x, y, z });
  vec4 = (x: Value, y: Value, z: Value, w: Value) =>
    this.f.call(functions.vec4, { x, y, z, w });
  /** A vector of 2 to 4 components. */
  vec = (components: readonly Value[]): PortHandle => {
    const [x, y, z, w] = components;
    switch (components.length) {
      case 2:
        return this.vec2(x, y);
      case 3:
        return this.vec3(x, y, z);
      case 4:
        return this.vec4(x, y, z, w);
      default:
        throw new Error(`no vector of ${components.length} components`);
    }
  };
  /** A u32 constant: literals are floats where nothing else types them. */
  u32 = (value: number) => this.f.constant(BuiltinTypes.u32, value);
  /** A f32 constant. */
  f32 = (value: number) => this.f.constant(BuiltinTypes.f32, value);
}

/** The components of a vector of n components, by name. */
export const components = (n: number) => 'xyzw'.slice(0, n).split('');
