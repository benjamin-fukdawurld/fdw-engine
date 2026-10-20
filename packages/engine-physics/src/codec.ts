import type { ComponentCodec } from '@fdw/engine-scene-io';
import type { CharacterDesc, ColliderDesc } from './api';
import type { NodeBodyDesc, ScenePhysics } from './ScenePhysics';

/**
 * The data of the `physics body` of a node: what it was made from, without
 * the `userData` (objects of the application, not saved).
 */
export type PhysicsBodyData =
  | { readonly body: NodeBodyDesc }
  | { readonly character: Omit<CharacterDesc, 'position'> };

const withoutUserData = <T extends { userData?: unknown }>(
  desc: T,
): Omit<T, 'userData'> => {
  const { userData: _, ...rest } = desc;
  return rest;
};

/**
 * The codec of the bodies of a ScenePhysics: their descriptions (type,
 * colliders and their shapes, materials, groups), made again by `add` or
 * `addCharacter` when read. A node following its body must be under the
 * root of the scene: give `parent: scene.root` and no wrapping node to
 * instantiateScene for the dynamic bodies (see ScenePhysics.add).
 */
export function physicsCodec(
  physics: ScenePhysics,
): ComponentCodec<PhysicsBodyData> {
  return {
    name: physics.Body.name,
    version: 1,
    write(entity, ctx) {
      const desc = physics.descOf(entity);
      if (!desc) return undefined;
      if (physics.characterOf(entity)) {
        return {
          character: desc as Omit<CharacterDesc, 'position'>,
        };
      }
      const body = desc as NodeBodyDesc;
      if (
        body.userData !== undefined ||
        body.colliders?.some((c) => c.userData !== undefined)
      )
        ctx.warn(`physics body of entity ${entity}: its userData is not saved`);
      return {
        body: {
          ...withoutUserData(body),
          colliders: body.colliders?.map(
            (collider) => withoutUserData(collider) as ColliderDesc,
          ),
        },
      };
    },
    read(data, entity, ctx) {
      const node = ctx.scene.node(entity);
      try {
        if ('character' in data) physics.addCharacter(node, data.character);
        else physics.add(node, data.body);
      } catch (e) {
        ctx.warn(`physics body of entity ${entity}: ${(e as Error).message}`);
      }
    },
  };
}
