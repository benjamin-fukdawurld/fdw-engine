import {
  type BehaviorDebugger,
  type BehaviorGraphData,
  type BehaviorSystem,
  callType,
} from '@fdw/engine-behavior';
import type { NodeId } from '@fdw/engine-graph';
import type { BehaviorDebugState, BehaviorNodeLive } from '../protocol';

/**
 * The prefixes of the ids, in the program, of the nodes of a function: one
 * per call, through the calls of the functions calling it (`c3/` for a
 * call `c3` of the graph, `c3/c7/` for a call `c7` in the body of the
 * function `c3` calls). The graph itself: the empty prefix.
 */
export function callPrefixes(
  graph: BehaviorGraphData,
  scope: string | undefined,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  if (scope === undefined) return [''];
  if (seen.has(scope)) return [];
  const type = callType(scope);
  const prefixes: string[] = [];
  for (const node of graph.nodes) {
    if (node.type === type) prefixes.push(`${node.id}/`);
  }
  for (const fn of graph.functions ?? []) {
    const calls = fn.nodes.filter((node) => node.type === type);
    if (calls.length === 0) continue;
    for (const outer of callPrefixes(
      graph,
      fn.name,
      new Set([...seen, scope]),
    )) {
      for (const call of calls) prefixes.push(`${outer}${call.id}/`);
    }
  }
  return prefixes;
}

// The id of a node of the program in a scope shown at a prefix: the rest
// of its id when it starts with the prefix and names a node of the body
// (not one of a function it calls), else undefined.
const localId = (id: NodeId, prefix: string): NodeId | undefined => {
  if (!id.startsWith(prefix)) return undefined;
  const rest = id.slice(prefix.length);
  return rest.includes('/') ? undefined : rest;
};

/**
 * What the debugger of a system tells of an instance, for the scope an
 * editor shows: the ids of the program brought back to those of the body
 * shown, at one of its calls (the one paused in, else the first).
 */
export function debugState(
  system: BehaviorSystem<unknown>,
  debug: BehaviorDebugger<unknown> | undefined,
  options: {
    readonly entity?: number;
    readonly scope?: string;
    readonly name?: (entity: number) => string;
  },
): BehaviorDebugState {
  const instances = [...system.instances].map((instance) => ({
    entity: instance.entity,
    name: options.name?.(instance.entity) ?? `#${instance.entity}`,
  }));
  const entity =
    options.entity !== undefined && system.instance(options.entity)
      ? options.entity
      : instances[0]?.entity;
  const prefixes = callPrefixes(system.graph, options.scope);
  const paused = debug?.paused;
  const prefix =
    (paused && prefixes.find((p) => localId(paused.node, p) !== undefined)) ??
    prefixes[0];
  const nodes: Record<NodeId, BehaviorNodeLive> = {};
  let trace: NodeId[] = [];
  let variables: Record<string, unknown> = {};
  let time = 0;
  const instance = entity === undefined ? undefined : system.instance(entity);
  if (instance && prefix !== undefined) {
    variables = { ...instance.variables };
    time = instance.time;
    if (debug) {
      for (const state of debug.states(instance.entity)) {
        const local = localId(state.id, prefix);
        if (local === undefined) continue;
        nodes[local] = {
          runs: state.runs,
          outputs: state.outputs,
          active: state.active,
          waiting: state.waiting,
        };
      }
      trace = debug
        .trace(instance.entity)
        .map((id) => localId(id, prefix))
        .filter((id): id is NodeId => id !== undefined);
    }
  }
  const breakpoints = new Set<NodeId>();
  for (const id of debug?.breakpoints ?? []) {
    for (const p of prefixes) {
      const local = localId(id, p);
      if (local !== undefined) breakpoints.add(local);
    }
  }
  const pausedHere =
    paused && prefix !== undefined ? localId(paused.node, prefix) : undefined;
  return {
    attached: debug !== undefined,
    instances,
    ...(entity !== undefined && { entity }),
    ...(paused &&
      pausedHere !== undefined && {
        paused: {
          entity: paused.instance.entity,
          node: pausedHere,
          reason: paused.reason,
        },
      }),
    breakpoints: [...breakpoints],
    nodes,
    trace,
    variables,
    time,
    ...(prefix && { call: prefix.slice(0, -1) }),
  };
}

/**
 * Sets or removes a breakpoint on a node of a scope: on each of its calls
 * for a node of a function. Returns whether it is on now.
 *
 * @throws for a node of the program that cannot stop (a pure node).
 */
export function setBreakpoint(
  system: BehaviorSystem<unknown>,
  debug: BehaviorDebugger<unknown>,
  scope: string | undefined,
  node: NodeId,
  on: boolean,
): boolean {
  const ids = callPrefixes(system.graph, scope)
    .map((prefix) => `${prefix}${node}`)
    .filter((id) => system.program.byId.has(id));
  if (ids.length === 0) {
    throw new Error(
      scope === undefined
        ? `No node "${node}" runs`
        : `"${scope}" is not called: its nodes never run`,
    );
  }
  for (const id of ids) {
    if (on) debug.addBreakpoint(id);
    else debug.removeBreakpoint(id);
  }
  return on;
}
