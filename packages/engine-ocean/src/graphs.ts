import { arrayType, BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { MaterialGraphData, PortHandle } from '@fdw/engine-shader';
import { Ops } from './ops';

// The compute graphs of the ocean spectrum, one thread per wave or per
// point of the grids (x, z along the grid, the cascade in z), in
// workgroups of 8 × 8. The complex numbers are vec2 (re, im); the four
// complex fields go two by two in vec4 buffers: one texel per element in
// WebGL2, a single draw per write.

const vec4Array = arrayType(BuiltinTypes.vec4f);
const workgroupSize = [8, 8, 1] as const;

// The thread, and the index of its point in the grids.
function thread(o: Ops, n: number) {
  const id = o.g.builtin('global-invocation-id');
  const index = o.add(
    o.add(o.mul(id.swizzle('z'), n * n), o.mul(id.swizzle('y'), n)),
    id.swizzle('x'),
  );
  return { id, index };
}

// Complex products: w × z, and i × z = (-im, re).
const complexMul = (o: Ops, w: PortHandle, z: PortHandle) =>
  o.vec2(
    o.sub(
      o.mul(w.swizzle('x'), z.swizzle('x')),
      o.mul(w.swizzle('y'), z.swizzle('y')),
    ),
    o.add(
      o.mul(w.swizzle('x'), z.swizzle('y')),
      o.mul(w.swizzle('y'), z.swizzle('x')),
    ),
  );
const timesI = (o: Ops, z: PortHandle) =>
  o.vec2(o.mul(z.swizzle('y'), -1), z.swizzle('x'));
// Two complex numbers in a vec4.
const pair = (o: Ops, a: PortHandle, b: PortHandle) =>
  o.vec4(a.swizzle('x'), a.swizzle('y'), b.swizzle('x'), b.swizzle('y'));

/**
 * The spectrum at a time: h = h0 e^(iωt) + conj(h0(-k)) e^(-iωt), then the
 * spectra of the eight fields, packed by two (a + ib) into four complex
 * fields: `fieldsA` holds (dx + i dz, h + i ∂dx/∂z), `fieldsB` (∂h/∂x + i
 * ∂h/∂z, ∂dx/∂x + i ∂dz/∂z).
 */
export function spectrumGraph(n: number): MaterialGraphData {
  const g = new GraphBuilder('ocean spectrum');
  const o = new Ops(g);
  const { index } = thread(o, n);
  const amplitude = o.index(g.storage('amplitudes', vec4Array), index);
  const wave = o.index(g.storage('waves', vec4Array), index);
  const phase = o.mul(wave.swizzle('z'), g.uniform('time', BuiltinTypes.f32));
  const rotation = o.vec2(o.cos(phase), o.sin(phase));
  // e^(-iωt) is the conjugate of e^(iωt).
  const back = o.vec2(rotation.swizzle('x'), o.mul(rotation.swizzle('y'), -1));
  const h = o.add(
    complexMul(o, amplitude.swizzle('xy'), rotation),
    complexMul(o, amplitude.swizzle('zw'), back),
  );
  const kx = wave.swizzle('x');
  const kz = wave.swizzle('y');
  const inverse = wave.swizzle('w');
  const ih = timesI(o, h);
  // -i k/|k| h, the horizontal motion.
  const dx = o.mul(ih, o.mul(o.mul(kx, inverse), -1));
  const dz = o.mul(ih, o.mul(o.mul(kz, inverse), -1));
  const pack = (a: PortHandle, b: PortHandle) => o.add(a, timesI(o, b));
  const fieldsA = g.storage('fieldsA', vec4Array, { access: 'read-write' });
  const fieldsB = g.storage('fieldsB', vec4Array, { access: 'read-write' });
  g.write(fieldsA, {
    index,
    value: pair(
      o,
      pack(dx, dz),
      pack(h, o.mul(h, o.mul(o.mul(kx, kz), inverse))),
    ),
  });
  g.write(fieldsB, {
    index,
    value: pair(
      o,
      pack(o.mul(ih, kx), o.mul(ih, kz)),
      pack(
        o.mul(h, o.mul(o.mul(kx, kx), inverse)),
        o.mul(h, o.mul(o.mul(kz, kz), inverse)),
      ),
    ),
  });
  g.compute({ workgroupSize });
  return g.build();
}

/**
 * A stage of the inverse FFT along the rows (x) or the columns (z) of the
 * grids: out[i] = in[a] + w × in[b], the butterflies of the stage read from
 * the `butterflies` buffer, for the two complex fields of each element.
 */
export function butterflyGraph(
  n: number,
  along: 'rows' | 'columns',
): MaterialGraphData {
  const g = new GraphBuilder(`ocean fft ${along}`);
  const o = new Ops(g);
  const { id, index } = thread(o, n);
  const rows = along === 'rows';
  const butterfly = o.index(
    g.storage('butterflies', vec4Array),
    rows ? id.swizzle('x') : id.swizzle('y'),
  );
  const a = o.convert(butterfly.swizzle('x'), BuiltinTypes.u32);
  const b = o.convert(butterfly.swizzle('y'), BuiltinTypes.u32);
  const w = butterfly.swizzle('zw');
  const grid = o.mul(id.swizzle('z'), n * n);
  const at = (k: PortHandle) =>
    rows
      ? o.add(o.add(grid, o.mul(id.swizzle('y'), n)), k)
      : o.add(o.add(grid, o.mul(k, n)), id.swizzle('x'));
  for (const name of ['A', 'B']) {
    const input = g.storage(`input${name}`, vec4Array);
    const first = o.index(input, at(a));
    const second = o.index(input, at(b));
    g.write(g.storage(`output${name}`, vec4Array, { access: 'read-write' }), {
      index,
      value: o.add(
        first,
        pair(
          o,
          complexMul(o, w, second.swizzle('xy')),
          complexMul(o, w, second.swizzle('zw')),
        ),
      ),
    });
  }
  g.compute({ workgroupSize });
  return g.build();
}

/**
 * The fields of the sea from the transformed ones: the sign (-1)^(x + z)
 * of the waves centered on k = 0, the horizontal motion scaled by the
 * `choppiness`. `displacement`: dx, h, dz, ∂dx/∂z; `derivatives`: ∂h/∂x,
 * ∂h/∂z, ∂dx/∂x, ∂dz/∂z.
 */
export function resolveGraph(n: number): MaterialGraphData {
  const g = new GraphBuilder('ocean resolve');
  const o = new Ops(g);
  const { id, index } = thread(o, n);
  const parity = o.and(o.add(id.swizzle('x'), id.swizzle('y')), 1);
  const sign = o.sub(1, o.mul(o.convert(parity, BuiltinTypes.f32), 2));
  const a = o.mul(o.index(g.storage('inputA', vec4Array), index), sign);
  const b = o.mul(o.index(g.storage('inputB', vec4Array), index), sign);
  const choppiness = g.uniform('choppiness', BuiltinTypes.f32, { default: 1 });
  const chop = (value: PortHandle) => o.mul(value, choppiness);
  g.write(g.storage('displacement', vec4Array, { access: 'read-write' }), {
    index,
    value: o.vec4(
      chop(a.swizzle('x')),
      a.swizzle('z'),
      chop(a.swizzle('y')),
      chop(a.swizzle('w')),
    ),
  });
  g.write(g.storage('derivatives', vec4Array, { access: 'read-write' }), {
    index,
    value: o.vec4(
      b.swizzle('x'),
      b.swizzle('y'),
      chop(b.swizzle('z')),
      chop(b.swizzle('w')),
    ),
  });
  g.compute({ workgroupSize });
  return g.build();
}
