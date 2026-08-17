export * from './primitives';

import * as primitives from './primitives';
import { CameraMath, TransformMath } from '@fdw/engine-backend';

export const transformMath = new TransformMath(primitives);

export const cameraMath = new CameraMath(primitives);
