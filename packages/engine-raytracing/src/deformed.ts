import {
  arrayType,
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  Ops,
  PortHandle,
  RayVertexVec4s,
} from '@fdw/engine-shader';

// The vertices of the meshes moved on the GPU (Material.deformedVertices):
// copied each frame into their records in the geometry of the scene, where
// the hits read them, over their records at rest (the uv, and the normal
// and tangent the deformed vertices do not have).

/** The flag of an absent attribute (deformedNormal, deformedTangent). */
export const NoAttribute = 0xffffffff;

/**
 * The kernel copying deformed vertices (`deformed`, `deformedStride` vec4
 * each, the normal and the tangent at their vec4) into their records
 * (`records`, from `firstRecord`), over their records at rest (`rest`,
 * RayVertexVec4s vec4 each), a vertex per thread.
 */
export function deformedVerticesKernel(): MaterialGraphData {
  const g = new GraphBuilder('deformed vertices');
  const s = new Ops(g);
  const index = g.builtin('global-invocation-id').swizzle('x');
  const count = g.uniform('vertexCount', BuiltinTypes.u32);
  const first = g.uniform('firstRecord', BuiltinTypes.u32);
  const stride = g.uniform('deformedStride', BuiltinTypes.u32);
  const normal = g.uniform('deformedNormal', BuiltinTypes.u32);
  const tangent = g.uniform('deformedTangent', BuiltinTypes.u32);
  const deformed = g.storage('deformed', arrayType(BuiltinTypes.vec4f));
  const rest = g.storage('rest', arrayType(BuiltinTypes.vec4f));
  const records = g.storage('records', arrayType(BuiltinTypes.vec4f), {
    access: 'read-write',
  });
  const source = s.mul(index, stride);
  const restAt = (k: number) =>
    s.index(rest, s.add(s.mul(index, s.u32(RayVertexVec4s)), s.u32(k)));
  const record = s.add(first, s.mul(index, s.u32(RayVertexVec4s)));
  const at = (k: number) => s.add(record, s.u32(k));
  const has = (offset: PortHandle) => s.notEqual(offset, s.u32(NoAttribute));
  // An attribute of the vertex; the position when absent (read in bounds).
  const attribute = (offset: PortHandle) =>
    s.index(
      deformed,
      s.add(
        source,
        s.select(offset, s.u32(0), s.equal(offset, s.u32(NoAttribute))),
      ),
    );
  g.write(records, {
    index: at(0),
    value: s.extend(
      s.index(deformed, source).swizzle('xyz'),
      restAt(0).swizzle('w'),
    ),
  });
  g.write(records, {
    index: at(1),
    value: s.extend(
      s.select(
        restAt(1).swizzle('xyz'),
        attribute(normal).swizzle('xyz'),
        has(normal),
      ),
      restAt(1).swizzle('w'),
    ),
  });
  g.write(records, {
    index: at(2),
    value: s.select(restAt(2), attribute(tangent), has(tangent)),
  });
  g.compute({ workgroupSize: [64, 1, 1], active: s.less(index, count) });
  return g.build();
}
