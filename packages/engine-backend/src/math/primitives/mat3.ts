export type Mat3Api<TMat3, TMat2, TVec3> = {
  identity: (out?: TMat3) => TMat3;
  premultiply: (a: TMat3, b: TMat3, out?: TMat3) => TMat3;
  multiply: (a: TMat3, b: TMat3, out?: TMat3) => TMat3;
  invert: (a: TMat3, out?: TMat3) => TMat3;
  transpose: (a: TMat3, out?: TMat3) => TMat3;

  fromMat2: (m2: TMat2, out?: TMat3) => TMat3;
  getMat2: (mat: TMat3, out?: TMat2) => TMat2;

  rotateAxisAngle: (mat: TMat3, rad: number, axis: TVec3, out?: TMat3) => TMat3;
  scale: (mat: TMat3, scale: TVec3, out?: TMat3) => TMat3;

  determinant: (mat: TMat3) => number;

  create(): TMat3;
  copy: (mat: TMat3, out: TMat3) => TMat3;
  clone: (mat: TMat3) => TMat3;
  equals: (a: TMat3, b: TMat3, epsilon?: number) => boolean;
  zero: (out?: TMat3) => TMat3;
  one: (out?: TMat3) => TMat3;
  toArray: (mat: TMat3, out?: number[]) => number[];
  fromArray: (arr: number[], out?: TMat3) => TMat3;

  isIdentity: (mat: TMat3, epsilon?: number) => boolean;
  isFinite: (mat: TMat3) => boolean;
  isNaN: (mat: TMat3) => boolean;

  str: (mat: TMat3) => string;
};
