import { describe, expect, it, vi } from 'vitest';
import {
  createDecorator,
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
} from './instantiation';

describe('instantiation', () => {
  const IValue = createDecorator<{ value: string }>('test.value');

  it('returns stable identifiers and injects decorated parameters alongside explicit arguments', async () => {
    expect(createDecorator('test.value')).toBe(IValue);
    expect(String(IValue)).toBe('test.value');
    class Consumer {
      constructor(
        readonly label: string,
        @IValue readonly service: { value: string },
        readonly count: number,
      ) {}
    }
    const value = { value: 'registered' };
    const services = new ServiceCollection();
    services.set(IValue, value);
    const scope = new InstantiationService(services);
    const consumer = scope.createInstance(Consumer, 'label', 2);
    expect(consumer).toMatchObject({ label: 'label', service: value, count: 2 });
    await scope.dispose();
  });

  it('constructs lazy singleton descriptors with explicit arguments', async () => {
    const constructed = vi.fn();
    class Value {
      constructor(readonly value: string) {
        constructed();
      }
    }
    const services = new ServiceCollection();
    services.set(IValue, new SyncDescriptor(Value, ['lazy']));
    const scope = new InstantiationService(services);
    expect(constructed).not.toHaveBeenCalled();
    const value = scope.get(IValue);
    expect(value.value).toBe('lazy');
    expect(scope.get(IValue)).toBe(value);
    expect(constructed).toHaveBeenCalledTimes(1);
    await scope.dispose();
  });

  it('resolves parent singletons in their owner and allows child overrides', async () => {
    const IConsumer = createDecorator<Consumer>('test.scopeConsumer');
    class Consumer {
      constructor(@IValue readonly service: { value: string }) {}
    }
    const parent = new InstantiationService(
      new ServiceCollection(
        [IValue, { value: 'parent' }],
        [IConsumer, new SyncDescriptor(Consumer)],
      ),
    );
    const child = parent.createChild(new ServiceCollection([IValue, { value: 'child' }]));
    expect(child.get(IValue).value).toBe('child');
    expect(child.get(IConsumer)).toBe(parent.get(IConsumer));
    expect(child.get(IConsumer).service.value).toBe('parent');
    expect(child.createInstance(Consumer).service.value).toBe('child');
    await child.dispose();
    expect(parent.get(IValue).value).toBe('parent');
    await parent.dispose();
  });

  it('detects missing and circular services and clears failed resolution state', async () => {
    const IA = createDecorator<object>('test.circularA');
    const IB = createDecorator<object>('test.circularB');
    class A {
      constructor(@IB readonly b: object) {}
    }
    class B {
      constructor(@IA readonly a: object) {}
    }
    const services = new ServiceCollection([IA, new SyncDescriptor(A)]);
    const scope = new InstantiationService(services);
    expect(() => scope.get(IValue)).toThrow('Missing service: test.value');
    expect(() => scope.get(IA)).toThrow('Missing service: test.circularB');
    services.set(IB, new SyncDescriptor(B));
    expect(() => scope.get(IA)).toThrow('test.circularA -> test.circularB -> test.circularA');
    services.set(IB, {});
    expect(scope.get(IA)).toBeInstanceOf(A);
    await scope.dispose();
  });

  it('disposes only owned registrations in reverse dependency creation order, awaiting each', async () => {
    const order: string[] = [];
    const IDependency = createDecorator<Dependency>('test.disposableDependency');
    const IOwner = createDecorator<Owner>('test.disposableOwner');
    class Dependency {
      dispose() {
        order.push('dependency');
      }
    }
    class Owner {
      constructor(@IDependency readonly dependency: Dependency) {}
      async dispose() {
        order.push('owner:start');
        await Promise.resolve();
        order.push('owner:end');
      }
    }
    const externalDispose = vi.fn();
    const services = new ServiceCollection([
      IValue,
      { value: 'external', dispose: externalDispose },
    ]);
    services.set(IDependency, new SyncDescriptor(Dependency));
    services.set(IOwner, new SyncDescriptor(Owner));
    const parent = new InstantiationService(services);
    const child = parent.createChild();
    child.get(IOwner);
    child.createInstance(Owner);
    const callerOwned = child.createInstance(Dependency);
    const callerDispose = vi.spyOn(callerOwned, 'dispose');
    await child.dispose();
    expect(order).toEqual([]);
    const disposal = parent.dispose();
    expect(parent.dispose()).toBe(disposal);
    await disposal;
    expect(order).toEqual(['owner:start', 'owner:end', 'dependency']);
    expect(externalDispose).not.toHaveBeenCalled();
    expect(callerDispose).not.toHaveBeenCalled();
  });

  it('continues cleanup after errors and preserves the rejected disposal promise', async () => {
    const IFirst = createDecorator<object>('test.disposeFirst');
    const ISecond = createDecorator<object>('test.disposeSecond');
    const cleanup = vi.fn();
    const failure = new Error('cleanup failed');
    class First {
      dispose() {
        cleanup();
      }
    }
    class Second {
      async dispose() {
        throw failure;
      }
    }
    const scope = new InstantiationService(
      new ServiceCollection(
        [IFirst, new SyncDescriptor(First)],
        [ISecond, new SyncDescriptor(Second)],
      ),
    );
    scope.get(IFirst);
    scope.get(ISecond);
    const disposal = scope.dispose();
    await expect(disposal).rejects.toMatchObject({ errors: [failure] });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(scope.dispose()).toBe(disposal);
  });

  it('rejects resolution and construction immediately after disposal, including inherited services', async () => {
    class Consumer {
      constructor(@IValue readonly service: { value: string }) {}
    }
    const parent = new InstantiationService(new ServiceCollection([IValue, { value: 'parent' }]));
    const child = parent.createChild();
    const disposal = child.dispose();
    expect(() => child.get(IValue)).toThrow('disposed');
    expect(() => child.createInstance(Consumer)).toThrow('disposed');
    expect(() => child.createChild()).toThrow('disposed');
    await disposal;
    const liveChild = parent.createChild();
    await parent.dispose();
    expect(() => liveChild.get(IValue)).toThrow('disposed');
    expect(() => liveChild.createInstance(Consumer)).toThrow('disposed');
    await liveChild.dispose();
  });

  it('keeps replaced singletons owned without disposing external replacements', async () => {
    const cleanup = vi.fn();
    class Value {
      readonly value = 'owned';
      dispose = cleanup;
    }
    const services = new ServiceCollection([IValue, new SyncDescriptor(Value)]);
    const scope = new InstantiationService(services);
    const original = scope.get(IValue);
    const external = { value: 'external', dispose: vi.fn() };
    services.set(IValue, external);
    expect(scope.get(IValue)).toBe(external);
    expect(original).not.toBe(external);
    await scope.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(external.dispose).not.toHaveBeenCalled();
  });

  it('preserves registration changes made during construction', async () => {
    const external = { value: 'replacement', dispose: vi.fn() };
    const cleanup = vi.fn();
    const services = new ServiceCollection();
    class Value {
      readonly value = 'constructed';
      dispose = cleanup;
      constructor() {
        services.set(IValue, external);
      }
    }
    services.set(IValue, new SyncDescriptor(Value));
    const scope = new InstantiationService(services);
    expect(scope.get(IValue).value).toBe('constructed');
    expect(scope.get(IValue)).toBe(external);
    await scope.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(external.dispose).not.toHaveBeenCalled();
  });

  it('aborts consumer construction when a dependency closes the scope', async () => {
    const IDependency = createDecorator<object>('test.closingDependency');
    const cleanup = vi.fn();
    const constructed = vi.fn();
    let disposal: Promise<void> | undefined;
    class Dependency {
      constructor() {
        disposal = scope.dispose();
      }
      dispose = cleanup;
    }
    const scope = new InstantiationService(
      new ServiceCollection([IDependency, new SyncDescriptor(Dependency)]),
    );
    class Consumer {
      constructor(@IDependency readonly dependency: object) {
        constructed();
      }
    }
    expect(() => scope.createInstance(Consumer)).toThrow('disposed');
    await disposal;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(constructed).not.toHaveBeenCalled();
  });

  it('disposes shared constructed identities only once across multiple tokens', async () => {
    const IAlias = createDecorator<object>('test.sharedAlias');
    const shared = { dispose: vi.fn() };
    class Shared {
      constructor() {
        return shared;
      }
    }
    const scope = new InstantiationService(
      new ServiceCollection(
        [IValue, new SyncDescriptor(Shared)],
        [IAlias, new SyncDescriptor(Shared)],
      ),
    );
    expect(scope.get(IValue)).toBe(scope.get(IAlias));
    await scope.dispose();
    expect(shared.dispose).toHaveBeenCalledOnce();
  });

  it('owns child scopes and tears them down in reverse creation order before parent services', async () => {
    const order: string[] = [];
    const external = { value: 'external', dispose: vi.fn() };
    const IOwned = createDecorator<Owned>('test.childOwned');
    class Owned {
      constructor(readonly name: string) {}
      async dispose() {
        await Promise.resolve();
        order.push(this.name);
      }
    }
    const parent = new InstantiationService(
      new ServiceCollection([IValue, external], [IOwned, new SyncDescriptor(Owned, ['parent'])]),
    );
    parent.get(IOwned);
    const first = parent.createChild(
      new ServiceCollection([IOwned, new SyncDescriptor(Owned, ['first'])]),
    );
    const second = parent.createChild(
      new ServiceCollection([IOwned, new SyncDescriptor(Owned, ['second'])]),
    );
    first.get(IOwned);
    second.get(IOwned);
    expect(second.get(IValue)).toBe(external);
    await parent.dispose();
    expect(order).toEqual(['second', 'first', 'parent']);
    expect(external.dispose).not.toHaveBeenCalled();
    expect(() => first.get(IOwned)).toThrow('disposed');
    expect(() => second.createInstance(Owned, 'late')).toThrow('disposed');
  });

  it('awaits an already disposing child and continues after child cleanup errors', async () => {
    const cleanup = vi.fn();
    const IResource = createDecorator<object>('test.childFailure');
    class ParentResource {
      dispose = cleanup;
    }
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    class ChildResource {
      async dispose() {
        await pending;
        throw new Error('child cleanup');
      }
    }
    const parent = new InstantiationService(
      new ServiceCollection([IResource, new SyncDescriptor(ParentResource)]),
    );
    const child = parent.createChild(
      new ServiceCollection([IResource, new SyncDescriptor(ChildResource)]),
    );
    parent.get(IResource);
    child.get(IResource);
    const childDisposal = child.dispose();
    const childResult = expect(childDisposal).rejects.toThrow('Failed to dispose services');
    const parentResult = expect(parent.dispose()).rejects.toThrow('Failed to dispose services');
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    release();
    await Promise.all([childResult, parentResult]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('uses subclass parameter metadata independently from inherited metadata', async () => {
    const IOther = createDecorator<{ value: string }>('test.subclassOther');
    class Base {
      constructor(@IValue readonly service: { value: string }) {}
    }
    class Derived extends Base {
      constructor(
        readonly label: string,
        @IOther service: { value: string },
      ) {
        super(service);
      }
    }
    const scope = new InstantiationService(
      new ServiceCollection([IValue, { value: 'base' }], [IOther, { value: 'derived' }]),
    );
    expect(scope.createInstance(Derived, 'label')).toMatchObject({
      label: 'label',
      service: { value: 'derived' },
    });
    expect(scope.createInstance(Base).service.value).toBe('base');
    await scope.dispose();
  });

  it('inherits constructor metadata without mutating base class dependencies', async () => {
    class Base {
      constructor(@IValue readonly service: { value: string }) {}
    }
    class Derived extends Base {}
    const scope = new InstantiationService(new ServiceCollection([IValue, { value: 'base' }]));
    expect(scope.createInstance(Derived).service.value).toBe('base');
    expect(scope.createInstance(Base).service.value).toBe('base');
    await scope.dispose();
  });
});
