import { BuiltinTypes, std } from '@fdw/engine-shader';
import type {
  ConstantValue,
  GraphBuilder,
  PortHandle,
  ShaderType,
} from '@fdw/engine-shader';

/** A value of a graph being built: a port, or a literal. */
export type Value = PortHandle | ConstantValue;

/**
 * Shorthands for the standard functions on a graph builder: `o.add(a, b)`
 * for `g.call(std.add, { a, b })`. The graphs of the ocean are long.
 */
export class Ops {
  constructor(readonly g: GraphBuilder) {}

  add = (a: Value, b: Value) => this.g.call(std.add, { a, b });
  sub = (a: Value, b: Value) => this.g.call(std.sub, { a, b });
  mul = (a: Value, b: Value) => this.g.call(std.mul, { a, b });
  div = (a: Value, b: Value) => this.g.call(std.div, { a, b });
  min = (a: Value, b: Value) => this.g.call(std.min, { a, b });
  max = (a: Value, b: Value) => this.g.call(std.max, { a, b });
  abs = (x: Value) => this.g.call(std.abs, { x });
  floor = (x: Value) => this.g.call(std.floor, { x });
  fract = (x: Value) => this.g.call(std.fract, { x });
  sqrt = (x: Value) => this.g.call(std.sqrt, { x });
  sin = (x: Value) => this.g.call(std.sin, { x });
  cos = (x: Value) => this.g.call(std.cos, { x });
  saturate = (x: Value) => this.g.call(std.saturate, { x });
  pow = (base: Value, exponent: Value) =>
    this.g.call(std.pow, { base, exponent });
  dot = (a: Value, b: Value) => this.g.call(std.dot, { a, b });
  cross = (a: Value, b: Value) => this.g.call(std.cross, { a, b });
  length = (x: Value) => this.g.call(std.length, { x });
  normalize = (x: Value) => this.g.call(std.normalize, { x });
  reflect = (incident: Value, normal: Value) =>
    this.g.call(std.reflect, { incident, normal });
  mix = (a: Value, b: Value, t: Value) => this.g.call(std.mix, { a, b, t });
  clamp = (x: Value, low: Value, high: Value) =>
    this.g.call(std.clamp, { x, low, high });
  smoothstep = (low: Value, high: Value, x: Value) =>
    this.g.call(std.smoothstep, { low, high, x });
  step = (edge: Value, x: Value) => this.g.call(std.step, { edge, x });
  select = (ifFalse: Value, ifTrue: Value, condition: Value) =>
    this.g.call(std.select, { ifFalse, ifTrue, condition });
  less = (a: Value, b: Value) => this.g.call(std.less, { a, b });
  greater = (a: Value, b: Value) => this.g.call(std.greater, { a, b });
  lessEqual = (a: Value, b: Value) => this.g.call(std.lessEqual, { a, b });
  greaterEqual = (a: Value, b: Value) =>
    this.g.call(std.greaterEqual, { a, b });
  equal = (a: Value, b: Value) => this.g.call(std.equal, { a, b });
  notEqual = (a: Value, b: Value) => this.g.call(std.notEqual, { a, b });
  remainder = (a: Value, b: Value) => this.g.call(std.remainder, { a, b });
  or = (a: Value, b: Value) => this.g.call(std.bitOr, { a, b });
  xor = (a: Value, b: Value) => this.g.call(std.bitXor, { a, b });
  shiftRight = (a: Value, b: Value) => this.g.call(std.shiftRight, { a, b });
  and = (a: Value, b: Value) => this.g.call(std.bitAnd, { a, b });
  fwidth = (x: Value) => this.g.call(std.fwidth, { x });
  perFragment = (value: Value) => this.g.call(std.perFragment, { value });
  convert = (value: Value, to: ShaderType) =>
    this.g.call(std.convert, { value }, { params: { to } });
  vec2 = (x: Value, y: Value) => this.g.call(std.vec2, { x, y });
  vec3 = (x: Value, y: Value, z: Value) => this.g.call(std.vec3, { x, y, z });
  vec4 = (x: Value, y: Value, z: Value, w: Value) =>
    this.g.call(std.vec4, { x, y, z, w });
  extend = (xyz: Value, w: Value = 1) => this.g.call(std.extend, { xyz, w });
  /** array[index], of a storage buffer. */
  index = (array: Value, index: Value) =>
    this.g.call(std.index, { array, index });
  u32 = (value: number) => this.g.constant(BuiltinTypes.u32, value);
  /** The same value in the three components of a vec3. */
  splat3 = (x: Value) => this.vec3(x, x, x);
  /** The sum of values, from the first. */
  sum = (values: readonly Value[]) =>
    values.reduce((a, b) => this.add(a, b)) as PortHandle;
  /** e^x, from pow: the standard library has no exp. */
  exp = (x: Value) => this.pow(Math.E, x);
}
