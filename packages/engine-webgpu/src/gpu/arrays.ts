import { ArrayApi, arrayApi } from '@fdw/engine-backend';

import { uniformLayout } from './layouts';
import { uniformWriters } from './writers';

export const uniformArrays: ArrayApi = arrayApi({
  layouts: uniformLayout,
  writers: uniformWriters,
});
