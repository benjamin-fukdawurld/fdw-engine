import App from './app/App';

const canvas = document.getElementById(
  'main-canvas'
) as HTMLCanvasElement | null;

if (!canvas) {
  throw new Error('Canvas cannot be found');
}

const app = new App(canvas);

async function start() {
  await app.init();

  app.engine.surface.onResize = () => {
    app.render();
  };
}

start();
