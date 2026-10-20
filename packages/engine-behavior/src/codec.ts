import type { ComponentCodec } from '@fdw/engine-scene-io';
import type { BehaviorSystem } from './BehaviorSystem';
import type { BehaviorValue } from './data';

/** The data of the behaviors of an entity: per graph, its variables. */
export type BehaviorData = readonly {
  /** The key of the system in the codec: the name of its graph by default. */
  readonly graph: string;
  readonly variables: Readonly<Record<string, BehaviorValue>>;
}[];

/**
 * The codec of the behaviors of the entities (`behavior`): for each
 * system, the entities it runs for and their variables, the `entity`
 * variables written as indices of the scene. Read, the entities are
 * attached again, from the start of their graph.
 *
 * @param systems - The systems, by key: an array uses the names of their graphs.
 *
 * @group Execution
 */
export function behaviorCodec(
  systems:
    | readonly BehaviorSystem<any>[]
    | Readonly<Record<string, BehaviorSystem<any>>>,
): ComponentCodec<BehaviorData> {
  const entries: [string, BehaviorSystem<any>][] = Array.isArray(systems)
    ? systems.map((system) => [system.graph.name, system])
    : Object.entries(systems);
  const typeOf = (system: BehaviorSystem<any>, name: string) =>
    system.graph.variables?.find((v) => v.name === name)?.type;
  return {
    name: 'behavior',
    version: 1,
    has: (entity) => entries.some(([, system]) => system.instance(entity)),
    write(entity, ctx) {
      const data = [];
      for (const [graph, system] of entries) {
        const instance = system.instance(entity);
        if (!instance) continue;
        const variables: Record<string, BehaviorValue> = {};
        for (const [name, value] of Object.entries(instance.variables)) {
          if (typeOf(system, name) !== 'entity') {
            variables[name] = value;
            continue;
          }
          const index = ctx.indexOf(value as number);
          if (index === undefined)
            ctx.warn(
              `behavior ${graph} of entity ${entity}: ${name} not written`,
            );
          else variables[name] = index;
        }
        data.push({ graph, variables });
      }
      return data;
    },
    read(data, entity, ctx) {
      for (const { graph, variables } of data) {
        const system = entries.find(([key]) => key === graph)?.[1];
        if (!system) {
          ctx.warn(`behavior of entity ${entity}: no system for ${graph}`);
          continue;
        }
        const values: Record<string, BehaviorValue> = {};
        for (const [name, value] of Object.entries(variables)) {
          if (typeOf(system, name) !== 'entity') {
            values[name] = value;
            continue;
          }
          const target = ctx.entity(value as number);
          if (target !== undefined) values[name] = target;
        }
        system.attach(entity, values);
      }
    },
  };
}
