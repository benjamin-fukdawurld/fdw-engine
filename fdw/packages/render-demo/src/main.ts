import { vec3 } from 'wgpu-matrix';
import App from './app/App';

const canvas = document.getElementById(
  'main-canvas'
) as HTMLCanvasElement | null;

if (!canvas) {
  throw new Error('Canvas cannot be found');
}

const app = new App(canvas);

function initInput() {
  canvas!.addEventListener('mousedown', (event) => {
    switch (event.button) {
      case 1:
        app.scene.camera.fov = Math.PI / 3;
        break;

      default:
        break;
    }
  });

  canvas!.addEventListener('mouseup', (event) => {
    switch (event.button) {
      case 1:
        app.scene.camera.fov = Math.PI / 2;
        break;

      default:
        break;
    }
  });

  canvas!.addEventListener('mousemove', (event) => {
    const dx = event.movementX;
    const dy = event.movementY;

    app.scene.camera.target = vec3.add(
      app.scene.camera.target,
      app.scene.camera.target,
      [dx / 10, -dy / 10, 0]
    );
  });

  window.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowUp':
        app.scene.camera.position = vec3.add(
          app.scene.camera.position,
          app.scene.camera.position,
          [0, 0, -1]
        );
        app.scene.camera.target = vec3.add(
          app.scene.camera.target,
          app.scene.camera.target,
          [0, 0, -1]
        );
        break;

      case 'ArrowDown':
        app.scene.camera.position = vec3.add(
          app.scene.camera.position,
          app.scene.camera.position,
          [0, 0, 1]
        );
        app.scene.camera.target = vec3.add(
          app.scene.camera.target,
          app.scene.camera.target,
          [0, 0, 1]
        );
        break;

      case 'ArrowLeft':
        app.scene.camera.position = vec3.add(
          app.scene.camera.position,
          app.scene.camera.position,
          [-1, 0, 0]
        );
        app.scene.camera.target = vec3.add(
          app.scene.camera.target,
          app.scene.camera.target,
          [-1, 0, 0]
        );
        break;

      case 'ArrowRight':
        app.scene.camera.position = vec3.add(
          app.scene.camera.position,
          app.scene.camera.position,
          [1, 0, 0]
        );
        app.scene.camera.target = vec3.add(
          app.scene.camera.target,
          app.scene.camera.target,
          [1, 0, 0]
        );
        break;

      case 'o':
        app.scene.camera.projection = 'ortho';
        break;

      case 'p':
        app.scene.camera.projection = 'perspective';
        break;

      default:
        console.log(event.key);
        break;
    }
  });
}

async function start() {
  await app.init();
  initInput();

  app.engine.surface.onResize = () => {
    const screen = app.scene.camera.screen;
    screen.width = app.engine.surface.canvas.clientWidth;
    screen.height = app.engine.surface.canvas.clientHeight;

    app.scene.camera.screen = screen;
    app.render();
  };

  const loop = () => {
    app.render();
    requestAnimationFrame(loop);
  };

  loop();
}

start();
