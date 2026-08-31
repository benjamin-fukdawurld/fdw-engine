import { PrimitiveApi, primitiveApi } from '@fdw/engine-backend';
import { uniformLayout } from './layouts';
import { uniformWriters } from './writers';
import { uniformSerializers } from './serializers';

export const uniformPrimitives: PrimitiveApi = primitiveApi({
  layouts: uniformLayout,
  writers: uniformWriters,
  serializers: uniformSerializers,
});
