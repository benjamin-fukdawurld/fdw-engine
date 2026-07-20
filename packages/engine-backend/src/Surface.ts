import { Engine } from './Engine';

export interface Surface {
  width: number;
  height: number;
  init(engine: Engine): Promise<void>;
}
