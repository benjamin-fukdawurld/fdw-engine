import { describe, expect, it, vi } from 'vitest';
import { Registry } from './registry';
import { serviceId, ServiceRegistry } from './services';

interface Counter {
  count: number;
  dispose?(): void;
}

const ICounter = serviceId<Counter>('counter');
const IName = serviceId<string>('name');

describe('ServiceRegistry', () => {
  it('gives the service of a typed id, made at its first use', () => {
    const services = new ServiceRegistry();
    const factory = vi.fn(() => ({ count: 1 }));
    services.register(ICounter, factory);
    expect(factory).not.toHaveBeenCalled();
    const counter: Counter = services.get(ICounter);
    expect(counter.count).toBe(1);
    expect(services.get(ICounter)).toBe(counter);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('makes a service at once if not lazy', () => {
    const services = new ServiceRegistry();
    const factory = vi.fn(() => ({ count: 1 }));
    services.register(ICounter, factory, { lazy: false });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('makes a service with the others', () => {
    const services = new ServiceRegistry();
    services.register(ICounter, (accessor) => ({
      count: accessor.get(IName).length,
    }));
    services.register(IName, () => 'four');
    expect(services.get(ICounter).count).toBe(4);
  });

  it('refuses a missing service, one registered twice, and a cycle', () => {
    const services = new ServiceRegistry();
    expect(() => services.get(ICounter)).toThrow('No service counter');
    expect(services.find(ICounter)).toBeUndefined();
    services.register(IName, (accessor) => accessor.get(IName));
    expect(() => services.register(IName, () => '')).toThrow('already');
    expect(() => services.get(IName)).toThrow('needs itself');
  });

  it('disposes a service when unregistered', () => {
    const services = new ServiceRegistry();
    const dispose = vi.fn();
    const registration = services.register(ICounter, () => ({
      count: 0,
      dispose,
    }));
    services.get(ICounter);
    registration.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(services.has(ICounter)).toBe(false);
    // Not made, not disposed.
    const custom = vi.fn();
    services
      .register(ICounter, () => ({ count: 0 }), { dispose: custom })
      .dispose();
    expect(custom).not.toHaveBeenCalled();
  });

  it('gives a scope its services and those of its parent', () => {
    const root = new ServiceRegistry();
    root.register(IName, () => 'root');
    root.register(ICounter, () => ({ count: 0 }));
    const scope = root.createScope('acme.plugin');
    scope.register(IName, () => 'plugin');
    expect(scope.get(IName)).toBe('plugin');
    expect(scope.get(ICounter)).toBe(root.get(ICounter));
    expect(root.get(IName)).toBe('root');

    const limited = root.createScope('acme.other', [IName]);
    expect(limited.get(IName)).toBe('root');
    expect(limited.has(ICounter)).toBe(false);
  });

  it('makes a service of the parent with the services of the parent', () => {
    const root = new ServiceRegistry();
    root.register(IName, () => 'root');
    root.register(ICounter, (accessor) => ({
      count: accessor.get(IName).length,
    }));
    const scope = root.createScope('acme.plugin');
    scope.register(IName, () => 'plugin!');
    expect(scope.get(ICounter).count).toBe(4);
  });

  it('disposes what a scope registered, the last first, and the scopes with their parent', () => {
    const root = new ServiceRegistry();
    const disposed: string[] = [];
    const scope = root.createScope('acme.plugin');
    for (const name of ['first', 'second']) {
      scope.register(serviceId<Counter>(name), () => ({ count: 0 }), {
        lazy: false,
        dispose: () => disposed.push(name),
      });
    }
    root.register(ICounter, () => ({ count: 0 }), {
      lazy: false,
      dispose: () => disposed.push('root'),
    });
    scope.dispose();
    expect(disposed).toEqual(['second', 'first']);
    expect(() => scope.register(IName, () => '')).toThrow('disposed');

    const other = root.createScope('acme.other');
    other.register(IName, () => 'other', {
      lazy: false,
      dispose: () => disposed.push('other'),
    });
    root.dispose();
    expect(disposed).toEqual(['second', 'first', 'other', 'root']);
  });
});

describe('Registry', () => {
  it('registers items by id, and tells their changes', () => {
    const registry = new Registry<{ id: string; title: string }>('tool');
    const changes: string[] = [];
    registry.subscribe(({ kind, item }) => changes.push(`${kind} ${item.id}`));
    const move = registry.register({ id: 'move', title: 'Move' });
    const before = registry.all();
    registry.register({ id: 'rotate', title: 'Rotate' });
    expect(registry.all()).not.toBe(before);
    expect(registry.all().map((item) => item.id)).toEqual(['move', 'rotate']);
    expect(() => registry.register({ id: 'move', title: '' })).toThrow(
      'The tool move is already registered',
    );
    move.dispose();
    move.dispose();
    expect(registry.get('move')).toBeUndefined();
    expect(changes).toEqual(['add move', 'add rotate', 'remove move']);
  });
});
