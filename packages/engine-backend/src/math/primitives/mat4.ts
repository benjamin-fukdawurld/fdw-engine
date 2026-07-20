export type Mat4Api<TMat4, TMat3, TVec3, TQuat> = {
  identity: (out?: TMat4) => TMat4;
  premultiply: (a: TMat4, b: TMat4, out?: TMat4) => TMat4;
  multiply: (a: TMat4, b: TMat4, out?: TMat4) => TMat4;
  invert: (a: TMat4, out?: TMat4) => TMat4;
  transpose: (a: TMat4, out?: TMat4) => TMat4;

  lookAt: (eye: TVec3, center: TVec3, up: TVec3, out?: TMat4) => TMat4;
  perspective: (
    fovy: number,
    aspect: number,
    near: number,
    far: number,
    out?: TMat4
  ) => TMat4;
  ortho: (
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
    out?: TMat4
  ) => TMat4;

  fromTranslation: (translation: TVec3, out?: TMat4) => TMat4;
  fromAxisAngle: (rad: number, axis: TVec3, out?: TMat4) => TMat4;
  fromScaling: (scale: TVec3, out?: TMat4) => TMat4;
  fromQuat: (q: TQuat, out?: TMat4) => TMat4;
  fromMat3: (m3: TMat3, out?: TMat4) => TMat4;

  getTranslation: (mat: TMat4, out?: TVec3) => TVec3;
  getScaling: (mat: TMat4, out?: TVec3) => TVec3;
  getRotation: (mat: TMat4, out?: TQuat) => TQuat;
  setTranslation: (mat: TMat4, translation: TVec3, out?: TMat4) => TMat4;
  setScaling: (mat: TMat4, scale: TVec3, out?: TMat4) => TMat4;
  setRotation: (mat: TMat4, q: TQuat, out?: TMat4) => TMat4;
  getMat3: (mat: TMat4, out?: TMat3) => TMat3;

  translate: (mat: TMat4, translation: TVec3, out?: TMat4) => TMat4;
  rotateAxisAngle: (mat: TMat4, rad: number, axis: TVec3, out?: TMat4) => TMat4;
  scale: (mat: TMat4, scale: TVec3, out?: TMat4) => TMat4;
  rotateQuat: (mat: TMat4, q: TQuat, out?: TMat4) => TMat4;

  determinant: (mat: TMat4) => number;

  create(): TMat4;
  copy: (mat: TMat4, out: TMat4) => TMat4;
  clone: (mat: TMat4) => TMat4;
  equals: (a: TMat4, b: TMat4, epsilon?: number) => boolean;
  zero: (out?: TMat4) => TMat4;
  one: (out?: TMat4) => TMat4;
  toArray: (mat: TMat4, out?: number[]) => number[];
  fromArray: (arr: number[], out?: TMat4) => TMat4;

  isIdentity: (mat: TMat4, epsilon?: number) => boolean;
  isFinite: (mat: TMat4) => boolean;
  isNaN: (mat: TMat4) => boolean;

  str: (mat: TMat4) => string;
};
