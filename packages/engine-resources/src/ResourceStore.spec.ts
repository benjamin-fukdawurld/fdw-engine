import { describe, expect, it, vi } from 'vitest';
import { ResourceError } from './errors';
import type { ResourceHandle } from './ResourceHandle';
import type { ResourceLoader } from './ResourceLoader';
import { ResourceStore } from './ResourceStore';
import { MemorySource } from './sources/MemorySource';
import { defineResourceType, defineServiceKey, ResourceBytesType } from './types';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const TextType = defineResourceType<string>('text');
const ChildType = defineResourceType<{ text: string }>('child');
const ParentType = defineResourceType<{ child: { text: string }; label: string }>('parent');

interface Harness {
  store: ResourceStore;
  mem: MemorySource;
  disposed: unknown[];
  loads: string[];
}

/** A store with a memory source mounted as default and a text loader. */
function harness(files: Record<string, string> = {}, options: ConstructorParameters<typeof ResourceStore>[0] = {}): Harness {
  const store = new ResourceStore({ debounceMs: 0, warn: () => undefined, ...options });
  const mem = new MemorySource(files);
  store.mount('mem', mem, { default: true });
  const disposed: unknown[] = [];
  const loads: string[] = [];
  const loader: ResourceLoader<string> = {
    type: TextType,
    async load(ctx) {
      loads.push(ctx.uri);
      return ctx.text();
    },
    dispose: (v) => void disposed.push(v),
    sizeOf: (v) => v.length,
  };
  store.registerLoader(loader);
  return { store, mem, disposed, loads };
}

describe('sharing and lifetime', () => {
  it('loads a resource and shares one entry between handles', async () => {
    const { store, loads } = harness({ 'a.txt': 'hello' });
    const h1 = store.load(TextType, 'a.txt');
    const h2 = store.load(TextType, 'a.txt');
    expect(await h1.ready).toBe('hello');
    expect(await h2.ready).toBe('hello');
    expect(loads).toHaveLength(1);
    expect(h1.status.value).toBe('ready');
    expect(h1.version.value).toBe(1);
    expect(h1.uri).toBe('mem:a.txt');
    expect(h1.require()).toBe('hello');
  });

  it('normalizes URIs: same entry with or without the scheme', async () => {
    const { store, loads } = harness({ 'a/b.txt': 'x' });
    const a = store.load(TextType, 'a/b.txt');
    const b = store.load(TextType, 'mem:a/./c/../b.txt');
    await Promise.all([a.ready, b.ready]);
    expect(loads).toHaveLength(1);
  });

  it('keeps the value cached once every handle is released, and revives it', async () => {
    const { store, loads, disposed } = harness({ 'a.txt': 'hello' });
    const h = store.load(TextType, 'a.txt');
    await h.ready;
    h.release();
    h.release(); // idempotent
    expect(disposed).toEqual([]);
    const again = store.load(TextType, 'a.txt');
    expect(again.status.value).toBe('ready');
    expect(await again.ready).toBe('hello');
    expect(loads).toHaveLength(1);
  });

  it('evicts the least recently used entries beyond the budget', async () => {
    const { store, disposed } = harness({ a: 'aaaa', b: 'bbbb', c: 'cccc' }, { budget: 8 });
    for (const name of ['a', 'b', 'c']) {
      const h = store.load(TextType, name);
      await h.ready;
      h.release();
    }
    expect(disposed).toEqual(['aaaa']);
    store.trim(0);
    expect(disposed).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('does not evict what has a handle', async () => {
    const { store, disposed } = harness({ a: 'aaaa' }, { budget: 1 });
    const h = store.load(TextType, 'a');
    await h.ready;
    store.trim();
    expect(disposed).toEqual([]);
    h.release();
    expect(disposed).toEqual(['aaaa']);
  });

  it('supports `using`', async () => {
    const { store } = harness({ a: 'x' }, { budget: 0 });
    let handle!: ResourceHandle<string>;
    {
      using h = store.load(TextType, 'a');
      handle = h;
      await h.ready;
    }
    await sleep();
    expect(handle.value).toBeUndefined(); // disposed with the last handle (budget 0)
  });

  it('retries a failed load on the next request', async () => {
    const { store, mem } = harness();
    const first = store.load(TextType, 'late.txt');
    await expect(first.ready).rejects.toMatchObject({ code: 'not-found' });
    expect(first.status.value).toBe('failed');
    expect(() => first.require()).toThrow(ResourceError);
    mem.set('late.txt', 'now');
    const second = store.load(TextType, 'late.txt');
    expect(await second.ready).toBe('now');
  });

  it('distinguishes entries by options through cacheKey', async () => {
    const store = new ResourceStore();
    store.mount('mem', new MemorySource({ x: 'abc' }), { default: true });
    const loads: unknown[] = [];
    store.registerLoader<string, { upper: boolean }>({
      type: TextType,
      cacheKey: (o) => String(o?.upper),
      async load(ctx) {
        loads.push(ctx.options);
        const t = await ctx.text();
        return ctx.options?.upper ? t.toUpperCase() : t;
      },
    });
    const a = store.load(TextType, 'x', { options: { upper: true } });
    const b = store.load(TextType, 'x', { options: { upper: false } });
    const c = store.load(TextType, 'x', { options: { upper: true } });
    expect(await a.ready).toBe('ABC');
    expect(await b.ready).toBe('abc');
    await c.ready;
    expect(loads).toHaveLength(2);
  });
});

describe('clone', () => {
  it('counts a clone as another handle', async () => {
    const { store, disposed } = harness({ a: 'a' }, { budget: 0 });
    const h = store.load(TextType, 'a');
    await h.ready;
    const copy = h.clone();
    h.release();
    expect(disposed).toEqual([]);
    expect(copy.require()).toBe('a');
    copy.release();
    expect(disposed).toEqual(['a']);
    expect(() => copy.clone()).toThrow(/released/);
  });
});

describe('define and peek', () => {
  it('defines an in-memory resource, disposed with its last handle', async () => {
    const { store, disposed } = harness();
    const h = store.define(TextType, 'generated:cube', 'cube');
    expect(h.status.value).toBe('ready');
    expect(await h.ready).toBe('cube');
    const peeked = store.peek(TextType, 'generated:cube');
    expect(peeked?.value).toBe('cube');
    expect(() => store.define(TextType, 'generated:cube', 'again')).toThrow(/already defined/);
    h.release();
    expect(disposed).toEqual([]);
    peeked!.release();
    expect(disposed).toEqual(['cube']);
    expect(store.peek(TextType, 'generated:cube')).toBeUndefined();
  });
});

describe('cancellation', () => {
  function slowStore() {
    const store = new ResourceStore({ warn: () => undefined });
    let started = 0;
    const aborted: string[] = [];
    store.mount('mem', new MemorySource(), { default: true });
    store.registerLoader({
      type: TextType,
      load: (ctx) =>
        new Promise<string>((_res, rej) => {
          started++;
          ctx.signal.addEventListener('abort', () => {
            aborted.push(ctx.uri);
            rej(new Error('aborted'));
          });
        }),
    });
    return { store, started: () => started, aborted };
  }

  it('aborts the load when the last handle is released', async () => {
    const { store, aborted } = slowStore();
    const a = store.load(TextType, 'x');
    const b = store.load(TextType, 'x');
    await sleep();
    a.release();
    expect(aborted).toEqual([]); // b still waits
    b.release();
    expect(aborted).toEqual(['mem:x']);
    expect(b.status.value).toBe('cancelled');
    await expect(b.ready).rejects.toMatchObject({ code: 'aborted' });
  });

  it('cancels a load still in the queue before it starts', async () => {
    const { store, started } = slowStore();
    const h = store.load(TextType, 'x');
    h.release();
    await sleep();
    expect(started()).toBe(0);
  });

  it('honors an external signal for its own handle only', async () => {
    const { store, aborted } = slowStore();
    const ctl = new AbortController();
    const mine = store.load(TextType, 'x', { signal: ctl.signal });
    const other = store.load(TextType, 'x');
    await sleep();
    ctl.abort();
    await expect(mine.ready).rejects.toMatchObject({ code: 'aborted' });
    expect(aborted).toEqual([]);
    expect(other.status.value).toBe('loading');
    other.release();
    expect(aborted).toEqual(['mem:x']);
  });

  it('a handle released before the load ends stops waiting', async () => {
    const { store, mem } = harness({ a: 'x' });
    void mem;
    const keep = store.load(TextType, 'a');
    const gone = store.load(TextType, 'a');
    gone.release();
    await expect(gone.ready).rejects.toMatchObject({ code: 'aborted' });
    expect(await keep.ready).toBe('x');
  });
});

describe('the queue', () => {
  function gatedStore(concurrency: number) {
    const store = new ResourceStore({ concurrency, warn: () => undefined });
    store.mount('mem', new MemorySource(), { default: true });
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    store.registerLoader({
      type: TextType,
      load: (ctx) =>
        new Promise<string>((resolve) => {
          order.push(ctx.uri);
          gates.set(ctx.uri, () => resolve(ctx.uri));
        }),
    });
    return { store, order, gates };
  }

  it('limits concurrency and serves priorities first, then arrival order', async () => {
    const { store, order, gates } = gatedStore(1);
    const hs = [
      store.load(TextType, 'low1', { priority: 'low' }),
      store.load(TextType, 'normal1'),
      store.load(TextType, 'high1', { priority: 'high' }),
      store.load(TextType, 'normal2'),
    ];
    await sleep();
    expect(order).toEqual(['mem:high1']);
    for (let i = 0; i < 3; i++) {
      gates.get(order.at(-1)!)!();
      await sleep();
    }
    expect(order).toEqual(['mem:high1', 'mem:normal1', 'mem:normal2', 'mem:low1']);
    gates.get(order.at(-1)!)!();
    await Promise.all(hs.map((h) => h.ready));
  });

  it('raises the priority of a queued entry that is requested urgently', async () => {
    const { store, order, gates } = gatedStore(1);
    store.load(TextType, 'first');
    await sleep(); // `first` holds the only slot
    store.load(TextType, 'a');
    store.load(TextType, 'b');
    store.load(TextType, 'b', { priority: 'high' });
    await sleep();
    gates.get('mem:first')!();
    await sleep();
    expect(order).toEqual(['mem:first', 'mem:b']);
  });
});

describe('dependencies', () => {
  function withParent(h: Harness, label = 'p') {
    h.store.registerLoader({
      type: ChildType,
      load: async (ctx) => ({ text: await ctx.text() }),
      dispose: (v) => void h.disposed.push(v.text),
    });
    h.store.registerLoader({
      type: ParentType,
      async load(ctx) {
        const child = ctx.use(ChildType, ctx.resolve('child.txt'));
        const own = await ctx.text();
        const value = await child.ready;
        return { child: value, label: `${label}:${own}` };
      },
      dispose: (v) => void h.disposed.push(v.label),
    });
  }

  it('loads dependencies relative to the resource and keeps them alive', async () => {
    const h = harness({ 'dir/p.txt': 'own', 'dir/child.txt': 'kid' }, { budget: 0 });
    withParent(h);
    const p = h.store.load(ParentType, 'dir/p.txt');
    const value = await p.ready;
    expect(value).toEqual({ child: { text: 'kid' }, label: 'p:own' });
    expect(p.dependencies).toHaveLength(1);
    expect(p.dependencies[0].uri).toBe('mem:dir/child.txt');
    // The dependency is held by the parent: no handle of its own, yet alive.
    expect(h.store.peek(ChildType, 'dir/child.txt')?.value).toEqual({ text: 'kid' });
  });

  it('releases dependencies with their parent', async () => {
    const h = harness({ 'dir/p.txt': 'own', 'dir/child.txt': 'kid' }, { budget: 0 });
    withParent(h);
    const p = h.store.load(ParentType, 'dir/p.txt');
    await p.ready;
    p.release();
    // The parent goes first, then its dependency.
    expect(h.disposed).toEqual(['p:own', 'kid']);
  });

  it('shares a dependency between parents', async () => {
    const h = harness({ 'd/p1.txt': '1', 'd/p2.txt': '2', 'd/child.txt': 'kid' }, { budget: 0 });
    withParent(h);
    const loads = vi.fn();
    h.store.registerLoader({
      type: ChildType,
      load: async (ctx) => (loads(), { text: await ctx.text() }),
    });
    const a = h.store.load(ParentType, 'd/p1.txt');
    const b = h.store.load(ParentType, 'd/p2.txt');
    await Promise.all([a.ready, b.ready]);
    expect(a.dependencies[0].value).toBe(b.dependencies[0].value);
    a.release();
    expect(h.store.peek(ChildType, 'd/child.txt')?.value).toBeDefined(); // b still needs it
  });

  it('cancels dependencies nobody else wants', async () => {
    const store = new ResourceStore({ warn: () => undefined });
    store.mount('mem', new MemorySource({ 'p.txt': 'x' }), { default: true });
    const aborted: string[] = [];
    store.registerLoader({
      type: ChildType,
      load: (ctx) =>
        new Promise((_res, rej) =>
          ctx.signal.addEventListener('abort', () => (aborted.push(ctx.uri), rej(new Error('x'))))
        ),
    });
    store.registerLoader({
      type: ParentType,
      async load(ctx) {
        const c = ctx.use(ChildType, 'slow.txt');
        return { child: await c.ready, label: '' };
      },
    });
    const p = store.load(ParentType, 'p.txt');
    await sleep(5);
    p.release();
    expect(aborted).toEqual(['mem:slow.txt']);
  });

  it('does not deadlock when parents fill every slot', async () => {
    const h = harness(
      { 'd/p1.txt': '1', 'd/p2.txt': '2', 'd/child.txt': 'kid' },
      { concurrency: 1 }
    );
    withParent(h);
    const a = h.store.load(ParentType, 'd/p1.txt');
    const b = h.store.load(ParentType, 'd/p2.txt');
    await expect(Promise.all([a.ready, b.ready])).resolves.toHaveLength(2);
  });

  it('reports the chain of a failing dependency', async () => {
    const h = harness({ 'dir/p.txt': 'own' }); // no child.txt
    withParent(h);
    const p = h.store.load(ParentType, 'dir/p.txt');
    const err = (await p.ready.catch((e) => e)) as ResourceError;
    expect(err).toBeInstanceOf(ResourceError);
    expect(err.code).toBe('dependency');
    expect(err.path).toEqual(['mem:dir/p.txt', 'mem:dir/child.txt']);
    expect((err.cause as ResourceError).code).toBe('not-found');
    expect(p.error.value).toBe(err);
  });

  it('refuses a dependency cycle with its path', async () => {
    const store = new ResourceStore({ warn: () => undefined });
    store.mount('mem', new MemorySource({ 'a.txt': '', 'b.txt': '', 'c.txt': '' }), { default: true });
    const Node = defineResourceType<string>('node');
    const next: Record<string, string> = { 'mem:a.txt': 'b.txt', 'mem:b.txt': 'c.txt', 'mem:c.txt': 'a.txt' };
    store.registerLoader({
      type: Node,
      async load(ctx) {
        const dep = ctx.use(Node, next[ctx.uri]);
        await dep.ready;
        return ctx.uri;
      },
    });
    const h = store.load(Node, 'a.txt');
    const err = (await h.ready.catch((e) => e)) as ResourceError;
    expect(err.code).toBe('dependency');
    expect(err.message).toMatch(/cycle/i);
    expect(err.cycle).toBe(true);
    expect(err.path[0]).toBe(err.path.at(-1)); // the cycle closes on itself
    expect(new Set(err.path)).toEqual(new Set(['mem:a.txt', 'mem:b.txt', 'mem:c.txt']));
  });

  it('refuses a resource that depends on itself', async () => {
    const store = new ResourceStore({ warn: () => undefined });
    store.mount('mem', new MemorySource({ 'a.txt': '' }), { default: true });
    store.registerLoader({
      type: TextType,
      async load(ctx) {
        ctx.use(TextType, 'a.txt');
        return '';
      },
    });
    await expect(store.load(TextType, 'a.txt').ready).rejects.toMatchObject({ code: 'dependency' });
  });
});

describe('progress and groups', () => {
  it('aggregates the progress of dependencies, in bytes when known', async () => {
    const store = new ResourceStore({ warn: () => undefined });
    store.mount('mem', new MemorySource(), { default: true });
    const gates: Record<string, (n: number) => void> = {};
    const finish: Record<string, () => void> = {};
    store.registerLoader({
      type: ChildType,
      load: (ctx) =>
        new Promise((resolve) => {
          gates[ctx.uri] = (n) => ctx.progress(n, 100);
          finish[ctx.uri] = () => resolve({ text: '' });
        }),
    });
    store.registerLoader({
      type: ParentType,
      async load(ctx) {
        ctx.progress(0, 100);
        const a = ctx.use(ChildType, 'a');
        const b = ctx.use(ChildType, 'b');
        ctx.progress(100, 100);
        await Promise.all([a.ready, b.ready]);
        return { child: { text: '' }, label: '' };
      },
    });
    const p = store.load(ParentType, 'p');
    await sleep(5);
    expect(p.progress.value).toBeCloseTo(1 / 3); // parent's own part is done
    gates['mem:a'](100);
    expect(p.progress.value).toBeCloseTo(2 / 3);
    gates['mem:b'](50);
    expect(p.progress.value).toBeCloseTo(2.5 / 3);
    finish['mem:a']();
    finish['mem:b']();
    await p.ready;
    expect(p.progress.value).toBe(1);
  });

  it('reports the progress of a group and rejects with the first failure', async () => {
    const { store } = harness({ a: '1', b: '2' });
    const ok = store.group([store.load(TextType, 'a'), store.load(TextType, 'b')]);
    expect(ok.pending.value).toBe(2);
    expect(ok.progress.value).toBe(0);
    await ok.ready;
    expect(ok.pending.value).toBe(0);
    expect(ok.progress.value).toBe(1);

    const bad = store.group([store.load(TextType, 'a'), store.load(TextType, 'missing')]);
    await expect(bad.ready).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('scopes', () => {
  it('releases every handle of a scope at once', async () => {
    const { store, disposed } = harness({ a: 'a', b: 'b' }, { budget: 0 });
    const scope = store.scope('level');
    const a = scope.load(TextType, 'a');
    const b = scope.adopt(store.load(TextType, 'b'));
    await Promise.all([a.ready, b.ready]);
    scope.dispose();
    expect(disposed.sort()).toEqual(['a', 'b']);
    expect(() => scope.load(TextType, 'a')).toThrow(/disposed/);
  });
});

describe('choosing a loader', () => {
  const ModelType = defineResourceType<string>('model');
  function modelStore(files: Record<string, string | Uint8Array>) {
    const store = new ResourceStore({ warn: () => undefined });
    store.mount('mem', new MemorySource(files), { default: true });
    store
      .registerLoader({ type: ModelType, extensions: ['gltf', 'glb'], load: async () => 'gltf' })
      .registerLoader({ type: ModelType, extensions: ['obj'], load: async () => 'obj' })
      .registerLoader({ type: ModelType, sniff: (h) => h[0] === 0x23, load: async () => 'sniffed' });
    return store;
  }

  it('picks by extension, then by sniffing the first bytes', async () => {
    const store = modelStore({ 'a.GLB': 'x', 'b.obj': 'x', 'c.bin': '# comment' });
    expect(await store.load(ModelType, 'a.GLB').ready).toBe('gltf');
    expect(await store.load(ModelType, 'b.obj').ready).toBe('obj');
    expect(await store.load(ModelType, 'c.bin').ready).toBe('sniffed');
  });

  it('fails with unsupported when nothing matches', async () => {
    const store = modelStore({ 'd.bin': 'zzz' });
    await expect(store.load(ModelType, 'd.bin').ready).rejects.toMatchObject({ code: 'unsupported' });
    const empty = new ResourceStore();
    empty.mount('mem', new MemorySource({ a: '' }), { default: true });
    await expect(empty.load(ModelType, 'a').ready).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('sources', () => {
  it('layers sources under a scheme by priority, falling through on not-found', async () => {
    const store = new ResourceStore({ warn: () => undefined });
    store.registerLoader({ type: TextType, load: (ctx) => ctx.text() });
    store.mount('game', new MemorySource({ 'a.txt': 'base', 'b.txt': 'base-b' }), { default: true });
    store.mount('game', new MemorySource({ 'a.txt': 'patch' }), { priority: 10 });
    expect(await store.load(TextType, 'a.txt').ready).toBe('patch');
    expect(await store.load(TextType, 'b.txt').ready).toBe('base-b');
  });

  it('routes by scheme and fails when none is mounted', async () => {
    const store = new ResourceStore({ warn: () => undefined });
    store.registerLoader({ type: TextType, load: (ctx) => ctx.text() });
    store.mount('one', new MemorySource({ a: '1' }));
    store.mount('two', new MemorySource({ a: '2' }));
    expect(await store.load(TextType, 'one:a').ready).toBe('1');
    expect(await store.load(TextType, 'two:a').ready).toBe('2');
    await expect(store.load(TextType, 'a').ready).rejects.toMatchObject({ code: 'not-found' });
  });

  it('wraps a loader exception as a decode error', async () => {
    const { store } = harness({ a: '{' });
    store.registerLoader({ type: ChildType, load: async (ctx) => JSON.parse(await ctx.text()) });
    await expect(store.load(ChildType, 'a').ready).rejects.toMatchObject({ code: 'decode' });
  });
});

describe('sub-resources', () => {
  const MeshType = defineResourceType<{ name: string }>('mesh');
  const ModelType = defineResourceType<{ meshes: ResourceHandle<{ name: string }>[] }>('model');

  function modelStore(files: Record<string, string>) {
    const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
    const mem = new MemorySource(files);
    store.mount('mem', mem, { default: true });
    const disposed: string[] = [];
    store.registerLoader({
      type: MeshType,
      load: async () => {
        throw new Error('meshes come from models');
      },
      dispose: (v) => void disposed.push(v.name),
    });
    store.registerLoader({
      type: ModelType,
      async load(ctx) {
        const names = (await ctx.text()).split(',');
        return { meshes: names.map((n, i) => ctx.provide(MeshType, `mesh/${i}`, { name: n })) };
      },
    });
    return { store, mem, disposed };
  }

  it('addresses sub-resources as uri#id, owned by their parent', async () => {
    const { store, disposed } = modelStore({ 'm.glb': 'trunk,leaf' });
    const model = store.load(ModelType, 'm.glb');
    await model.ready;
    const leaf = store.peek(MeshType, 'm.glb#mesh/1');
    expect(leaf?.value).toEqual({ name: 'leaf' });
    model.release();
    store.trim(0);
    expect(disposed).toEqual(['trunk']); // `leaf` still has a handle
    leaf!.release();
    expect(disposed).toEqual(['trunk', 'leaf']);
  });

  it('lets a dependent use a sub-resource and follow it on reload', async () => {
    const { store, mem } = modelStore({ 'm.glb': 'trunk' });
    store.watch(true);
    const model = store.load(ModelType, 'm.glb');
    await model.ready;
    const peeked = store.peek(MeshType, 'm.glb#mesh/0')!;
    expect(peeked.value?.name).toBe('trunk');
    mem.set('m.glb', 'TRUNK');
    await sleep(10);
    store.update();
    expect(store.peek(MeshType, 'm.glb#mesh/0')?.value?.name).toBe('TRUNK');
    expect(model.value!.meshes[0].value?.name).toBe('TRUNK');
    expect(model.version.value).toBe(2);
  });

  it('reads the bytes of a sub-resource provided by its parent', async () => {
    const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
    const mem = new MemorySource({ 'pack.bin': 'red|green' });
    store.mount('mem', mem, { default: true });
    const PackType = defineResourceType<string[]>('pack');
    const encoder = new TextEncoder();
    store.registerLoader({
      type: PackType,
      async load(ctx) {
        const parts = (await ctx.text()).split('|');
        parts.forEach((p, i) => ctx.provide(ResourceBytesType, `part/${i}`, encoder.encode(p)));
        return parts;
      },
    });
    store.registerLoader({ type: TextType, load: (ctx) => ctx.text() });
    store.watch(true);
    const pack = store.load(PackType, 'pack.bin');
    await pack.ready;
    const green = store.load(TextType, 'pack.bin#part/1');
    expect(await green.ready).toBe('green');
    // The parent changes: the dependent follows its new bytes.
    mem.set('pack.bin', 'red|blue');
    await sleep(10);
    store.update();
    await sleep(10);
    store.update();
    expect(green.value).toBe('blue');
  });
});

describe('services', () => {
  it('provides services to loaders and fails clearly when missing', async () => {
    const Backend = defineServiceKey<{ name: string }>('backend');
    const { store } = harness();
    store.registerLoader({
      type: ChildType,
      load: async (ctx) => ({ text: ctx.service(Backend).name }),
    });
    await expect(store.load(ChildType, 'x').ready).rejects.toMatchObject({ code: 'unsupported' });
    store.provideService(Backend, { name: 'webgpu' });
    expect(await store.load(ChildType, 'y').ready).toEqual({ text: 'webgpu' });
  });

  it('rebuilds what used a service when it is replaced, never in place', async () => {
    const Backend = defineServiceKey<{ name: string }>('backend');
    const h = harness();
    const update = vi.fn(() => true);
    h.store.registerLoader({
      type: ChildType,
      load: async (ctx) => ({ text: ctx.service(Backend).name }),
      update,
      dispose: (v) => void h.disposed.push(v.text),
    });
    h.store.provideService(Backend, { name: 'webgpu' });
    const handle = h.store.load(ChildType, 'tex');
    await handle.ready;
    h.store.provideService(Backend, { name: 'webgl2' });
    await sleep(5);
    h.store.update();
    expect(handle.value).toEqual({ text: 'webgl2' });
    expect(update).not.toHaveBeenCalled();
    expect(h.disposed).toEqual(['webgpu']);
  });
});

describe('hot reload', () => {
  it('reloads on change, keeping the old value until update()', async () => {
    const h = harness({ 'a.txt': 'one' });
    h.store.watch(true);
    const handle = h.store.load(TextType, 'a.txt');
    await handle.ready;
    h.mem.set('a.txt', 'two');
    await sleep(10);
    expect(handle.value).toBe('one');
    h.store.update();
    expect(handle.value).toBe('two');
    expect(handle.version.value).toBe(2);
    expect(h.disposed).toEqual(['one']);
  });

  it('groups a burst of changes into one reload', async () => {
    const h = harness({ 'a.txt': '1' }, { debounceMs: 20 });
    h.store.watch(true);
    const handle = h.store.load(TextType, 'a.txt');
    await handle.ready;
    h.mem.set('a.txt', '2').set('a.txt', '3').set('a.txt', '4');
    await sleep(60);
    h.store.update();
    expect(handle.value).toBe('4');
    expect(h.loads).toHaveLength(2);
  });

  it('keeps the old value and publishes the error when a reload fails', async () => {
    const h = harness({ 'a.json': '{"v":1}' });
    const J = defineResourceType<{ v: number }>('json');
    h.store.registerLoader({ type: J, load: async (ctx) => JSON.parse(await ctx.text()) });
    h.store.watch(true);
    const handle = h.store.load(J, 'a.json');
    await handle.ready;
    h.mem.set('a.json', '{ broken');
    await sleep(10);
    h.store.update();
    expect(handle.value).toEqual({ v: 1 });
    expect(handle.status.value).toBe('ready');
    expect(handle.error.value?.code).toBe('decode');
    h.mem.set('a.json', '{"v":2}');
    await sleep(10);
    h.store.update();
    expect(handle.value).toEqual({ v: 2 });
    expect(handle.error.value).toBeUndefined();
  });

  it('updates in place when the loader can, and frees the freshly loaded copy', async () => {
    const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
    const mem = new MemorySource({ a: 'one' });
    store.mount('mem', mem, { default: true });
    const disposed: string[] = [];
    store.registerLoader({
      type: ChildType,
      load: async (ctx) => ({ text: await ctx.text() }),
      update: (current, next) => ((current.text = next.text), true),
      dispose: (v) => void disposed.push(v.text),
    });
    store.watch(true);
    const handle = store.load(ChildType, 'a');
    const original = await handle.ready;
    mem.set('a', 'two');
    await sleep(10);
    store.update();
    expect(handle.value).toBe(original); // same object, updated
    expect(original.text).toBe('two');
    expect(handle.version.value).toBe(2);
    expect(disposed).toEqual(['two']); // `next` was only a source
  });

  it('falls back to replacement when update() declines', async () => {
    const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
    const mem = new MemorySource({ a: 'one' });
    store.mount('mem', mem, { default: true });
    store.registerLoader({
      type: ChildType,
      load: async (ctx) => ({ text: await ctx.text() }),
      update: () => false,
    });
    store.watch(true);
    const handle = store.load(ChildType, 'a');
    const original = await handle.ready;
    mem.set('a', 'two');
    await sleep(10);
    store.update();
    expect(handle.value).not.toBe(original);
    expect(handle.value?.text).toBe('two');
  });

  it('invalidates dependents, and frees the old value once they switched', async () => {
    const h = harness({ 'd/p.txt': 'own', 'd/child.txt': 'v1' });
    h.store.registerLoader({
      type: ChildType,
      load: async (ctx) => ({ text: await ctx.text() }),
      dispose: (v) => void h.disposed.push(`child:${v.text}`),
    });
    h.store.registerLoader({
      type: ParentType,
      async load(ctx) {
        const child = ctx.use(ChildType, ctx.resolve('child.txt'));
        return { child: await child.ready, label: `p+${(await child.ready).text}` };
      },
      dispose: (v) => void h.disposed.push(v.label),
    });
    h.store.watch(true);
    const p = h.store.load(ParentType, 'd/p.txt');
    await p.ready;

    h.mem.set('d/child.txt', 'v2');
    await sleep(10);
    h.store.update(); // the child is replaced…
    expect(h.disposed).toEqual([]); // …but the parent still uses v1
    await sleep(10);
    h.store.update(); // …then the parent
    expect(p.value?.label).toBe('p+v2');
    expect(p.value?.child.text).toBe('v2');
    expect(h.disposed).toEqual(['p+v1', 'child:v1']);
  });

  it('applies one staged change per call within a time budget, at least one', async () => {
    const h = harness({ a: '1', b: '1', c: '1' });
    h.store.watch(true);
    const hs = ['a', 'b', 'c'].map((n) => h.store.load(TextType, n));
    await Promise.all(hs.map((x) => x.ready));
    for (const n of ['a', 'b', 'c']) h.mem.set(n, '2');
    await sleep(15);
    h.store.update(-1); // a budget already spent: still progresses
    expect(hs.filter((x) => x.value === '2')).toHaveLength(1);
    h.store.update(1000);
    expect(hs.every((x) => x.value === '2')).toBe(true);
  });

  it('reload() resolves once staged, rejects on failure', async () => {
    const h = harness({ a: '1' });
    const handle = h.store.load(TextType, 'a');
    await handle.ready;
    h.mem.set('a', '2');
    await h.store.reload('a');
    expect(handle.value).toBe('1');
    h.store.update();
    expect(handle.value).toBe('2');
    h.mem.delete('a');
    await expect(h.store.reload('a')).rejects.toMatchObject({ code: 'not-found' });
    expect(handle.value).toBe('2');
  });

  it('reloads after the first load when the change comes during it', async () => {
    const h = harness({ a: '1' });
    const handle = h.store.load(TextType, 'a');
    const reloaded = h.store.reload('a'); // the first load is still pending
    await handle.ready;
    h.mem.set('a', '2');
    await reloaded;
    await sleep(10);
    h.store.update();
    expect(handle.value).toBe('2');
  });

  it('stops watching when disabled or when the entry is freed', async () => {
    const h = harness({ a: '1' }, { budget: 0 });
    const watchSpy = vi.spyOn(h.mem, 'watch');
    h.store.watch(true);
    const handle = h.store.load(TextType, 'a');
    await handle.ready;
    expect(watchSpy).toHaveBeenCalledTimes(1);
    h.store.watch(false);
    h.mem.set('a', '2');
    await sleep(10);
    h.store.update();
    expect(handle.value).toBe('1');
  });
});

describe('dispose', () => {
  it('frees everything and refuses new loads', async () => {
    const { store, disposed } = harness({ a: 'a' });
    const h = store.load(TextType, 'a');
    await h.ready;
    store.dispose();
    expect(disposed).toEqual(['a']);
    expect(() => store.load(TextType, 'a')).toThrow(/disposed/);
  });
});
