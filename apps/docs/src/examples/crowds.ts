import {
  Camera,
  DirectionalLight,
  Material,
  Mesh,
  Renderer,
} from '@fdw/engine-core';
import { Aabb, Ray } from '@fdw/engine-geometry';
import {
  type CrowdAgent,
  NavAgent,
  NavCrowd,
  type NavObstacle,
  type NavPoint,
  TiledNavMesh,
} from '@fdw/engine-navigation';
import { Scene, type Node } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCapsule,
  createCube,
  followAspect,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Two groups crossing a square, back and forth: their paths on a navigation
// mesh built by tiles, a cart going to and fro carving it as it moves, the
// agents making way for each other and for the cart (a crowd). A click
// drops a crate on the ground, or takes one away; N hides or shows the
// navigation mesh.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  const scene = new Scene();
  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.9,
  });
  const graph = g.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph, values: { color } });
  const cube = createCube();
  const stone = material([0.62, 0.6, 0.56]);
  const wood = material([0.7, 0.5, 0.3]);
  const box = (min: number[], max: number[], look: Material): Node =>
    scene.root
      .add({
        position: {
          x: (min[0] + max[0]) / 2,
          y: (min[1] + max[1]) / 2,
          z: (min[2] + max[2]) / 2,
        },
        scale: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
      })
      .setMesh(cube, look);

  // The square: a floor, low walls around, two pillars.
  const solids = [
    new Aabb([-12, -1, -8], [12, 0, 8]),
    new Aabb([-12, 0, -8], [12, 0.6, -7.6]),
    new Aabb([-12, 0, 7.6], [12, 0.6, 8]),
    new Aabb([-12, 0, -7.6], [-11.6, 0.6, 7.6]),
    new Aabb([11.6, 0, -7.6], [12, 0.6, 7.6]),
    new Aabb([-4, 0, -3.5], [-3, 2, -2.5]),
    new Aabb([3, 0, 2.5], [4, 2, 3.5]),
  ];
  solids.forEach((solid) => box(solid.min, solid.max, stone));
  scene.root.add({ rotation: axisAngle(1, 0.3, 0.2, -1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.35, y: 0.36, z: 0.4 },
      diffuse: { x: 1.3, y: 1.25, z: 1.15 },
    }),
  );

  // The mesh, in tiles of 16 cells (4 m): an obstacle builds again the
  // tiles it touches only.
  const tiles = new TiledNavMesh({
    bounds: new Aabb([-12, -1, -8], [12, 3, 8]),
    volumes: solids,
    cellSize: 0.25,
    agentRadius: 0.3,
    tileCells: 16,
  });

  // The cart: across the middle, to and fro along z; an obstacle of the
  // mesh, and an agent of the crowd that makes way for nobody.
  const cartSize = { x: 1.6, y: 1, z: 1 };
  const cartBox = (z: number) =>
    new Aabb(
      [-cartSize.x / 2, 0, z - cartSize.z / 2],
      [cartSize.x / 2, cartSize.y, z + cartSize.z / 2],
    );
  const cartAt = (time: number) => 5 * Math.sin(time * 0.6);
  const cart = box(cartBox(0).min, cartBox(0).max, wood);
  const cartObstacle = tiles.addObstacle(cartBox(cartAt(0)));
  const crowd = new NavCrowd({ timeHorizon: 1.5 });
  const cartAgent = crowd.add({ radius: 0.9, maxSpeed: 4, avoids: false });

  // The crates dropped by a click.
  const crates: { node: Node; obstacle: NavObstacle; box: Aabb }[] = [];

  // The lines of the mesh, made again when it changes.
  const lines = new GraphBuilder('lines');
  lines.surface({
    shadingModel: 'unlit',
    baseColor: lines.attribute('color', BuiltinTypes.vec4f).swizzle('rgb'),
  });
  const linesMaterial = new Material({ graph: lines.build() });
  const lineMesh = (positions: Float32Array<ArrayBuffer>, color: number[]) => {
    const colors = new Float32Array((positions.length / 3) * 4);
    for (let i = 0; i < colors.length; i += 4) colors.set(color, i);
    return new Mesh({
      description: {
        vertexBuffers: [
          {
            stride: 12,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float32x3', offset: 0 },
            ],
          },
          {
            stride: 16,
            stepMode: 'vertex',
            attributes: [{ semantic: 'color', format: 'float32x4', offset: 0 }],
          },
        ],
        vertexCount: positions.length / 3,
        topology: 'line-list',
      },
      vertices: [positions, colors],
    });
  };
  const navLines = scene.root.add({ name: 'navigation mesh' });
  let drawn = -1;
  let showLines = true;
  const drawMesh = () => {
    if (drawn === tiles.version) return;
    drawn = tiles.version;
    navLines.setMesh(
      lineMesh(tiles.navMesh.lines(0.03), [0.1, 0.6, 1, 1]),
      linesMaterial,
      { castShadow: false },
    );
    navLines.visible = showLines;
  };

  // The walkers: two groups of six, each to the other side, and back.
  const capsule = createCapsule(0.6, 0.3);
  const groups = [
    { color: [0.9, 0.3, 0.2] as [number, number, number], x: -10 },
    { color: [0.25, 0.5, 0.9] as [number, number, number], x: 10 },
  ];
  interface Walker {
    readonly node: Node;
    readonly agent: NavAgent;
    readonly member: CrowdAgent;
    readonly home: NavPoint;
    readonly away: NavPoint;
    outbound: boolean;
  }
  const walkers: Walker[] = [];
  groups.forEach(({ color, x }) => {
    const look = material(color);
    for (let i = 0; i < 6; i++) {
      const z = -5 + i * 2;
      const node = scene.root.add({ position: { x, y: 0.9, z } });
      node.setMesh(capsule, look);
      const walker: Walker = {
        node,
        agent: new NavAgent(tiles.navMesh, { speed: 1.6 + (i % 3) * 0.2 }),
        member: crowd.add({ radius: 0.32, maxSpeed: 2, position: { x, z } }),
        home: { x, y: 0, z },
        // To the other side, a row further: the groups cross.
        away: { x: -x, y: 0, z: -z },
        outbound: true,
      };
      walker.agent.setDestination(walker.home, walker.away);
      walkers.push(walker);
    }
  });

  const pitch = -1;
  const eye = { x: 0, y: 19, z: 12 };
  const camera = new Camera({
    position: eye,
    rotation: axisAngle(1, 0, 0, pitch),
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });

  // A click drops a crate on the floor, or takes away the one under it.
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const t = Math.tan((50 * Math.PI) / 360);
    const x =
      (((event.clientX - rect.left) / rect.width) * 2 - 1) *
      t *
      (rect.width / rect.height);
    const y = (1 - ((event.clientY - rect.top) / rect.height) * 2) * t;
    const [pc, ps] = [Math.cos(pitch), Math.sin(pitch)];
    const ray = new Ray([eye.x, eye.y, eye.z], [x, y * pc + ps, y * ps - pc]);
    // Where it meets the floor (y = 0).
    const distance = -eye.y / ray.direction[1];
    const p = ray.at(distance);
    const hit = crates.findIndex(
      ({ box }) =>
        p[0] >= box.min[0] - 0.2 &&
        p[0] <= box.max[0] + 0.2 &&
        p[2] >= box.min[2] - 0.2 &&
        p[2] <= box.max[2] + 0.2,
    );
    if (hit >= 0) {
      const [crate] = crates.splice(hit, 1);
      tiles.removeObstacle(crate.obstacle);
      crate.node.remove();
    } else if (Math.abs(p[0]) < 11 && Math.abs(p[2]) < 7) {
      const crate = new Aabb(
        [p[0] - 0.6, 0, p[2] - 0.6],
        [p[0] + 0.6, 1.2, p[2] + 0.6],
      );
      crates.push({
        node: box(crate.min, crate.max, wood),
        obstacle: tiles.addObstacle(crate),
        box: crate,
      });
    }
  });
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'KeyN') {
      showLines = !showLines;
      navLines.visible = showLines;
      event.preventDefault();
    }
  });

  const renderer = new Renderer(backend);
  let previous: number | undefined;
  let clock = 0;
  // The cart moves its obstacle 10 times a second.
  let carve = 0;
  onFrame((time) => {
    let dt = previous === undefined ? time : time - previous;
    previous = time;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 60);
      dt -= h;
      clock += h;
      const z = cartAt(clock);
      cartAgent.moveTo(0, z);
      cartAgent.prefer(0, (cartAt(clock + h) - z) / h);
      cart.transform.position = { x: 0, y: cartSize.y / 2, z };
      carve -= h;
      if (carve <= 0) {
        carve = 0.1;
        tiles.moveObstacle(cartObstacle, cartBox(z));
      }
      // The mesh changed: the walkers find their ways on the new one.
      if (tiles.update()) {
        for (const w of walkers) w.agent.navMesh = tiles.navMesh;
      }
      for (const w of walkers) {
        const p = w.node.transform.position;
        const feet = { x: p.x, y: 0, z: p.z };
        w.member.moveTo(p.x, p.z);
        if (w.agent.idle) {
          // Arrived: back the other way.
          w.outbound = !w.outbound;
          w.agent.setDestination(feet, w.outbound ? w.away : w.home);
        }
        const step = w.agent.update(feet, h);
        w.member.prefer(step.x / h, step.z / h);
      }
      crowd.update(h);
      // No character controller here: the walkers kept on the mesh, out
      // of the way of the cart and the crates.
      for (const w of walkers) {
        const p = w.node.transform.position;
        const v = w.member.velocity;
        const next = { x: p.x + v.x * h, y: 0, z: p.z + v.z * h };
        const on = tiles.navMesh.closestPoint(next, 2)?.point ?? next;
        w.node.transform.position = { x: on.x, y: 0.9, z: on.z };
      }
    }
    drawMesh();
    followAspect(camera, surface);
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.6, g: 0.72, b: 0.86, a: 1 },
    });
    info(
      `${tiles.navMesh.polygonCount} polygons in ${tiles.tilesX * tiles.tilesZ} tiles · ${crates.length} crates · click: drop or take a crate · N: navigation mesh`,
    );
  });
};

export default example;
