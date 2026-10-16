import type {
  AnimationChannelData,
  AnimationClipData,
  CameraData,
  ModelNodeData,
  SkinData,
  Vec3Tuple,
  Vec4Tuple,
} from '@fdw/engine-assets';
import { toFloat32 } from './accessors';
import type { GltfAttributeData } from './extension';
import type {
  GltfAnimation,
  GltfCamera,
  GltfJson,
  GltfNode,
  GltfSkin,
} from './types';

export interface Trs {
  readonly translation: Vec3Tuple;
  /** A quaternion, x y z w. */
  readonly rotation: Vec4Tuple;
  readonly scale: Vec3Tuple;
}

/**
 * Splits a column-major 4 × 4 matrix into translation, rotation and scale.
 * The matrix of a glTF node has no shear, so this is exact; a negative
 * determinant (a mirror) goes to the scale on x.
 */
export function decomposeMatrix(m: readonly number[]): Trs {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  // The rotation matrix, by rows: r[row][column].
  const r = [
    [m[0] / sx, m[4] / sy, m[8] / sz],
    [m[1] / sx, m[5] / sy, m[9] / sz],
    [m[2] / sx, m[6] / sy, m[10] / sz],
  ];
  // Quaternion from a rotation matrix, from its largest diagonal term for
  // precision (Shepperd's method).
  const trace = r[0][0] + r[1][1] + r[2][2];
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [
      (r[2][1] - r[1][2]) * s,
      (r[0][2] - r[2][0]) * s,
      (r[1][0] - r[0][1]) * s,
      0.25 / s,
    ];
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = 2 * Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]);
    q = [
      0.25 * s,
      (r[0][1] + r[1][0]) / s,
      (r[0][2] + r[2][0]) / s,
      (r[2][1] - r[1][2]) / s,
    ];
  } else if (r[1][1] > r[2][2]) {
    const s = 2 * Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]);
    q = [
      (r[0][1] + r[1][0]) / s,
      0.25 * s,
      (r[1][2] + r[2][1]) / s,
      (r[0][2] - r[2][0]) / s,
    ];
  } else {
    const s = 2 * Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]);
    q = [
      (r[0][2] + r[2][0]) / s,
      (r[1][2] + r[2][1]) / s,
      0.25 * s,
      (r[1][0] - r[0][1]) / s,
    ];
  }
  const length = Math.hypot(...q);
  // `+ 0` turns -0 into 0.
  return {
    translation: [m[12], m[13], m[14]],
    rotation: [
      q[0] / length + 0,
      q[1] / length + 0,
      q[2] / length + 0,
      q[3] / length + 0,
    ],
    scale: [sx, sy, sz],
  };
}

/** A node of the model, before its extensions. */
export function nodeData(node: GltfNode): ModelNodeData {
  const trs =
    node.matrix && node.matrix.length === 16
      ? decomposeMatrix(node.matrix)
      : node;
  return {
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(trs.translation ? { translation: [...trs.translation] as const } : {}),
    ...(trs.rotation ? { rotation: [...trs.rotation] as const } : {}),
    ...(trs.scale ? { scale: [...trs.scale] as const } : {}),
    children: node.children ?? [],
    ...(node.mesh !== undefined ? { mesh: node.mesh } : {}),
    ...(node.skin !== undefined ? { skin: node.skin } : {}),
    ...(node.camera !== undefined ? { camera: node.camera } : {}),
  };
}

/** The nodes of the default scene (`scene`, else the first), or all the parentless nodes without scenes. */
export function rootNodes(json: GltfJson): number[] {
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) return [...(scene.nodes ?? [])];
  const children = new Set((json.nodes ?? []).flatMap((n) => n.children ?? []));
  return (json.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i));
}

type AccessorFn = (index: number) => Promise<GltfAttributeData>;

export async function skinData(
  skin: GltfSkin,
  accessor: AccessorFn,
): Promise<SkinData> {
  return {
    ...(skin.name !== undefined ? { name: skin.name } : {}),
    joints: skin.joints,
    ...(skin.inverseBindMatrices !== undefined
      ? {
          inverseBindMatrices: toFloat32(
            await accessor(skin.inverseBindMatrices),
          ),
        }
      : {}),
    ...(skin.skeleton !== undefined ? { skeleton: skin.skeleton } : {}),
  };
}

const animatedPaths: ReadonlySet<string> = new Set([
  'translation',
  'rotation',
  'scale',
  'weights',
]);

/**
 * An animation as data: its outputs as floats (quantized rotations and
 * weights dequantized), its duration the last of its times. Channels
 * without a node (`KHR_animation_pointer`) are left out.
 */
export async function animationData(
  animation: GltfAnimation,
  accessor: AccessorFn,
): Promise<AnimationClipData> {
  const channels = await Promise.all(
    animation.channels
      .filter(
        (c) => c.target.node !== undefined && animatedPaths.has(c.target.path),
      )
      .map(async (channel): Promise<AnimationChannelData> => {
        const sampler = animation.samplers[channel.sampler];
        if (!sampler)
          throw new Error(`Missing animation sampler ${channel.sampler}`);
        const [times, values] = await Promise.all([
          accessor(sampler.input),
          accessor(sampler.output),
        ]);
        return {
          node: channel.target.node!,
          path: channel.target.path as AnimationChannelData['path'],
          interpolation: sampler.interpolation ?? 'LINEAR',
          times: toFloat32(times),
          values: toFloat32(values),
        };
      }),
  );
  const duration = channels.reduce(
    (max, c) => Math.max(max, c.times.length ? c.times[c.times.length - 1] : 0),
    0,
  );
  return {
    ...(animation.name !== undefined ? { name: animation.name } : {}),
    duration,
    channels,
  };
}

export function cameraData(camera: GltfCamera): CameraData {
  const name = camera.name !== undefined ? { name: camera.name } : {};
  if (camera.type === 'orthographic') {
    const o = camera.orthographic;
    if (!o) throw new Error('An orthographic camera without its parameters');
    return {
      type: 'orthographic',
      ...name,
      xmag: o.xmag,
      ymag: o.ymag,
      znear: o.znear,
      zfar: o.zfar,
    };
  }
  const p = camera.perspective;
  if (!p) throw new Error('A perspective camera without its parameters');
  return {
    type: 'perspective',
    ...name,
    yfov: p.yfov,
    ...(p.aspectRatio !== undefined ? { aspectRatio: p.aspectRatio } : {}),
    znear: p.znear,
    ...(p.zfar !== undefined ? { zfar: p.zfar } : {}),
  };
}
