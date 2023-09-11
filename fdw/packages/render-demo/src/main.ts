import { render } from '@fdw/render';

console.log(render());

const canvas = document.getElementById('main-canvas');

if (!canvas) {
  throw new Error('Canvas cannot be found');
}
