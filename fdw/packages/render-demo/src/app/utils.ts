export function rand(props?: { min?: number; max?: number }): number {
  const min = props?.min ?? 0;
  const max = props?.max ?? 1;

  return min + Math.random() * (max - min);
}

export function createCircleVertices({
  radius = 1,
  numSubdivisions = 24,
  innerRadius = 0,
  startAngle = 0,
  endAngle = Math.PI * 2,
} = {}): {
  vertexData: Float32Array;
  colorData: Uint8Array;
  indexData: Uint32Array;
  numVertices: number;
} {
  // 2 triangles per subdivision, 3 verts per tri
  const numVertices = (numSubdivisions + 1) * 2;
  // 2 32-bit values for position (xy) and 1 32-bit value for color (rgb_)
  // The 32-bit color value will be written/read as 4 8-bit values
  const vertexData = new Float32Array(numVertices * (2 + 1));
  const colorData = new Uint8Array(vertexData.buffer);

  let offset = 0;
  let colorOffset = 8;
  const addVertex = (x: number, y: number, r: number, g: number, b: number) => {
    vertexData[offset++] = x;
    vertexData[offset++] = y;
    offset += 1; // skip the color
    colorData[colorOffset++] = r * 255;
    colorData[colorOffset++] = g * 255;
    colorData[colorOffset++] = b * 255;
    colorOffset += 9; // skip extra byte and the position
  };

  const innerColor: [number, number, number] = [1, 1, 1];
  const outerColor: [number, number, number] = [0.1, 0.1, 0.1];

  // 2 vertices per subdivision
  //
  // 0  2  4  6  8 ...
  //
  // 1  3  5  7  9 ...
  for (let i = 0; i <= numSubdivisions; ++i) {
    const angle =
      startAngle + ((i + 0) * (endAngle - startAngle)) / numSubdivisions;

    const c1 = Math.cos(angle);
    const s1 = Math.sin(angle);

    addVertex(c1 * radius, s1 * radius, ...outerColor);
    addVertex(c1 * innerRadius, s1 * innerRadius, ...innerColor);
  }

  const indexData = new Uint32Array(numSubdivisions * 6);
  let ndx = 0;

  // 0---2---4---...
  // | //| //|
  // |// |// |//
  // 1---3-- 5---...
  for (let i = 0; i < numSubdivisions; ++i) {
    const ndxOffset = i * 2;

    // first triangle
    indexData[ndx++] = ndxOffset;
    indexData[ndx++] = ndxOffset + 1;
    indexData[ndx++] = ndxOffset + 2;

    // second triangle
    indexData[ndx++] = ndxOffset + 2;
    indexData[ndx++] = ndxOffset + 1;
    indexData[ndx++] = ndxOffset + 3;
  }

  return {
    vertexData,
    colorData,
    indexData,
    numVertices: indexData.length,
  };
}

export function createSquareVertices(): {
  vertexData: Float32Array;
  colorData: Uint8Array;
  indexData: Uint32Array;
  numVertices: number;
} {
  const numVertices = 4;

  // 2 32-bit values for position (xy) and 1 32-bit value for color (rgb_)
  // The 32-bit color value will be written/read as 4 8-bit values
  const vertexData = new Float32Array(numVertices * (2 + 1));
  const colorData = new Uint8Array(vertexData.buffer);

  let offset = 0;
  let colorOffset = 8;
  const addVertex = (x: number, y: number, r: number, g: number, b: number) => {
    vertexData[offset++] = x;
    vertexData[offset++] = y;
    offset += 1; // skip the color
    colorData[colorOffset++] = r * 255;
    colorData[colorOffset++] = g * 255;
    colorData[colorOffset++] = b * 255;
    colorOffset += 9; // skip extra byte and the position
  };

  const color: [number, number, number] = [1, 1, 1];

  addVertex(0, 1, ...color);
  addVertex(0, 0, ...color);
  addVertex(1, 1, ...color);
  addVertex(1, 0, ...color);

  const indexData = new Uint32Array([0, 1, 2, 2, 1, 3]);
  return {
    vertexData,
    colorData,
    indexData,
    numVertices: indexData.length,
  };
}
