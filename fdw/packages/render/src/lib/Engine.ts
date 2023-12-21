import Gpu from './Gpu';
import Surface from './Surface';
import TextureLoader from './TextureLoader';

export type EngineProps = {
  label?: string;
  canvas: HTMLCanvasElement;
};

export class Engine {
  public readonly gpu: Gpu;
  public readonly texLoader: TextureLoader;
  public readonly surface: Surface;

  constructor({ label, canvas }: EngineProps) {
    this.gpu = new Gpu(`${label}/gpu`);
    this.texLoader = new TextureLoader();
    this.surface = new Surface(canvas);
  }

  async init(): Promise<this> {
    await this.gpu.init();
    await this.surface.init(this.gpu);
    await this.texLoader.init(this.gpu);

    return this;
  }
}

export default Engine;
