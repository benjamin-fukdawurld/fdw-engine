import {
  Camera,
  DirectionalLight,
  Material,
  Mesh,
  Renderer,
} from '@fdw/engine-core';
import { Aabb, Obb, Ray } from '@fdw/engine-geometry';
import {
  buildNavMesh,
  NavAgent,
  type NavPoint,
  sceneVolumes,
} from '@fdw/engine-navigation';
import { SceneCharacter } from '@fdw/engine-physics';
import { Scene, type Node } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCapsule,
  createCube,
  followAspect,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Agents finding their way through a small level: a navigation mesh built
// from the volumes of the scene (walls, steps, a ramp to a platform), the
// paths found on it, followed by character controllers that walk against
// the same volumes. No physics engine. A click sends the agents where it
// points; N hides or shows the navigation mesh.
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
  const wall = material([0.75, 0.55, 0.38]);
  const raised = material([0.45, 0.58, 0.68]);

  // The level: boxes from min to max, and a ramp, an oriented box given
  // to the scene as the volume of its renderer.
  const level: Node[] = [];
  const box = (
    min: [number, number, number],
    max: [number, number, number],
    look = wall,
  ) => {
    const node = scene.root
      .add({
        position: {
          x: (min[0] + max[0]) / 2,
          y: (min[1] + max[1]) / 2,
          z: (min[2] + max[2]) / 2,
        },
        scale: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
      })
      .setMesh(cube, look);
    level.push(node);
  };
  box([-10, -1, -10], [10, 0, 10], stone);
  // Walls: a room with two doors, a wall across the way.
  box([-10, 0, -10], [10, 1.5, -9.6]);
  box([-10, 0, 9.6], [10, 1.5, 10]);
  box([-10, 0, -9.6], [-9.6, 1.5, 9.6]);
  box([9.6, 0, -9.6], [10, 1.5, 9.6]);
  box([-6, 0, -2], [3, 1.5, -1.6]);
  box([5, 0, -2], [9.6, 1.5, -1.6]);
  box([-2, 0, 2], [-1.6, 1.5, 9.6]);
  // Steps up to a platform, and a ramp down from it.
  box([3, 0, 4], [4, 0.25, 7], raised);
  box([4, 0, 4], [5, 0.5, 7], raised);
  box([5, 0, 4], [8, 0.75, 7], raised);
  // The ramp: from the ground at z = 0 up to the platform at z = 4, 20 cm
  // thick, its top surface rising along +z.
  const angle = Math.atan2(0.75, 4);
  const length = Math.hypot(0.75, 4);
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const ramp = new Obb(
    [6.5, 0.375 - 0.1 * c, 2 + 0.1 * s],
    [1.5, 0.1, length / 2],
    [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c],
    ],
  );
  // The mesh of the ramp: the cube turned and scaled as its volume.
  const rampNode = scene.root
    .add({
      position: { x: 6.5, y: ramp.center[1], z: ramp.center[2] },
      rotation: axisAngle(1, 0, 0, -angle),
      scale: { x: 3, y: 0.2, z: length },
    })
    .setMesh(cube, raised, { volume: ramp });
  level.push(rampNode);
  scene.root.add({ rotation: axisAngle(1, 0.3, 0.2, -1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.35, y: 0.36, z: 0.4 },
      diffuse: { x: 1.3, y: 1.25, z: 1.15 },
    }),
  );

  // The navigation mesh of the level, for agents of radius 0.35.
  const levelEntities = new Set(level.map((node) => node.entity));
  const navMesh = buildNavMesh({
    bounds: new Aabb([-10, -1, -10], [10, 3, 10]),
    volumes: sceneVolumes(scene, {
      filter: (node) => levelEntities.has(node.entity),
    }),
    cellSize: 0.2,
    agentRadius: 0.35,
    agentHeight: 1.6,
    maxClimb: 0.3,
  });

  // Its outline, in lines; and the paths of the agents.
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
  navLines.setMesh(
    lineMesh(navMesh.lines(0.03), [0.1, 0.6, 1, 1]),
    linesMaterial,
    {
      castShadow: false,
    },
  );

  // The agents: a capsule, a controller, an agent each.
  const capsule = createCapsule(0.6, 0.3);
  const colors: [number, number, number][] = [
    [0.9, 0.3, 0.2],
    [0.25, 0.7, 0.35],
    [0.25, 0.5, 0.9],
    [0.95, 0.75, 0.2],
  ];
  const starts = [
    { x: -8, z: -8 },
    { x: -7, z: 8 },
    { x: 8, z: -8 },
    { x: 0, z: 0 },
  ];
  const agents = starts.map((start, i) => {
    const node = scene.root.add({ position: { ...start, y: 0.92 } });
    node.setMesh(capsule, material(colors[i]));
    const controller = new SceneCharacter(scene, {
      radius: 0.3,
      height: 1.8,
      position: { ...start, y: 0.92 },
      stepHeight: 0.3,
      ignore: (entity) => !levelEntities.has(entity),
    });
    const agent = new NavAgent(navMesh, { speed: 2.2 + i * 0.3 });
    const path = scene.root.add({ name: `path ${i}` });
    return { node, controller, agent, path, fall: 0 };
  });
  // The places they walk between, by turns.
  const goals: NavPoint[] = [
    { x: 7, y: 0.75, z: 5.5 },
    { x: -8, y: 0, z: 8 },
    { x: 8, y: 0, z: -8 },
    { x: -8, y: 0, z: -8 },
  ];
  let round = 0;
  const send = (goal?: NavPoint) => {
    agents.forEach((a, i) => {
      const p = a.controller.position;
      const target = goal ?? goals[(i + round) % goals.length];
      a.agent.setDestination({ x: p.x, y: p.y - 0.92, z: p.z }, target);
      drawPath(a);
    });
    round++;
  };
  const drawPath = (a: (typeof agents)[number]) => {
    const corners = a.agent.path;
    if (corners.length < 2) {
      a.path.visible = false;
      return;
    }
    const segments = new Float32Array((corners.length - 1) * 6);
    for (let i = 1; i < corners.length; i++) {
      const p = corners[i - 1];
      const q = corners[i];
      segments.set([p.x, p.y + 0.05, p.z, q.x, q.y + 0.05, q.z], (i - 1) * 6);
    }
    a.path.setMesh(lineMesh(segments, [1, 1, 1, 1]), linesMaterial, {
      castShadow: false,
    });
    a.path.visible = true;
  };
  send();

  const pitch = -0.95;
  const eye = { x: 0, y: 17, z: 13 };
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

  // A click sends everyone to the ground under the pointer.
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus();
    // From the eye through the pointer (the camera turned around x).
    const rect = canvas.getBoundingClientRect();
    const t = Math.tan((50 * Math.PI) / 360);
    const x =
      (((event.clientX - rect.left) / rect.width) * 2 - 1) *
      t *
      (rect.width / rect.height);
    const y = (1 - ((event.clientY - rect.top) / rect.height) * 2) * t;
    const [pc, ps] = [Math.cos(pitch), Math.sin(pitch)];
    const ray = new Ray([eye.x, eye.y, eye.z], [x, y * pc + ps, y * ps - pc]);
    let hit: NavPoint | undefined;
    scene.raycast(ray, (node, distance) => {
      if (!levelEntities.has(node.entity)) return true;
      const p = ray.at(distance);
      hit = { x: p[0], y: p[1], z: p[2] };
      return false;
    });
    if (hit) send(hit);
  });
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'KeyN') {
      navLines.visible = !navLines.visible;
      event.preventDefault();
    }
  });

  const renderer = new Renderer(backend);
  let previous: number | undefined;
  onFrame((time) => {
    let dt = previous === undefined ? time : time - previous;
    previous = time;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 60);
      dt -= h;
      for (const a of agents) {
        const p = a.controller.position;
        const feet = { x: p.x, y: p.y - 0.92, z: p.z };
        const step = a.agent.update(feet, h);
        a.fall = a.controller.grounded ? 0 : a.fall + 9.81 * h;
        a.controller.move({ x: step.x, y: -a.fall * h, z: step.z });
        if (a.agent.idle) a.path.visible = false;
      }
      // Everyone arrived: the next round.
      if (agents.every((a) => a.agent.idle)) send();
    }
    for (const a of agents) {
      a.node.transform.position = a.controller.position;
    }
    followAspect(camera, surface);
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.6, g: 0.72, b: 0.86, a: 1 },
    });
    info(
      `${navMesh.polygonCount} polygons · ${agents.filter((a) => !a.agent.idle).length} walking · click: go there · N: navigation mesh`,
    );
  });
};

export default example;
