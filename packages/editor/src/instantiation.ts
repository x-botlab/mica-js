import type { IDisposable } from '@mica-js/core/lifecycle';

export interface IServiceIdentifier<T> {
  (target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void;
  readonly type: T;
  toString(): string;
}

// `unknown[]` would reject constructors with narrower explicit and injected parameters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T> = new (...args: any[]) => T;

type Dependency = { readonly id: IServiceIdentifier<unknown>; readonly index: number };
const identifiers = new Map<string, IServiceIdentifier<unknown>>();
const dependencies = new WeakMap<object, Dependency[]>();

export function createDecorator<T>(id: string): IServiceIdentifier<T> {
  const existing = identifiers.get(id);
  if (existing) return existing as IServiceIdentifier<T>;
  const identifier = ((target: object, propertyKey: string | symbol | undefined, index: number) => {
    if (typeof target !== 'function' || propertyKey !== undefined) {
      throw new TypeError('Service decorators can only decorate constructor parameters');
    }
    const entries = dependencies.get(target) ?? [];
    if (entries.some((entry) => entry.index === index)) {
      throw new Error(`Duplicate service decorator at parameter ${index}`);
    }
    entries.push({ id: identifier, index });
    dependencies.set(target, entries);
  }) as IServiceIdentifier<T>;
  identifier.toString = () => id;
  identifiers.set(id, identifier);
  return identifier;
}

export class SyncDescriptor<T> {
  constructor(
    readonly ctor: Constructor<T>,
    readonly staticArguments: readonly unknown[] = [],
  ) {}
}

type ServiceEntry<T> = T | SyncDescriptor<T>;

export class ServiceCollection {
  private readonly entries = new Map<IServiceIdentifier<unknown>, unknown>();

  constructor(...entries: readonly (readonly [IServiceIdentifier<unknown>, unknown])[]) {
    for (const [id, value] of entries) this.entries.set(id, value);
  }

  set<T>(id: IServiceIdentifier<T>, value: ServiceEntry<T>): ServiceEntry<T> | undefined {
    const previous = this.get(id);
    this.entries.set(id, value);
    return previous;
  }

  get<T>(id: IServiceIdentifier<T>): ServiceEntry<T> | undefined {
    return this.entries.get(id) as ServiceEntry<T> | undefined;
  }

  has<T>(id: IServiceIdentifier<T>): boolean {
    return this.entries.has(id);
  }
}

export class InstantiationService implements IDisposable {
  private readonly resolving: IServiceIdentifier<unknown>[] = [];
  private readonly owned: unknown[] = [];
  private readonly children = new Set<InstantiationService>();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly services = new ServiceCollection(),
    private readonly parent?: InstantiationService,
  ) {
    parent?.assertAlive();
    parent?.children.add(this);
  }

  createChild(services = new ServiceCollection()): InstantiationService {
    this.assertAlive();
    return new InstantiationService(services, this);
  }

  get<T>(id: IServiceIdentifier<T>): T {
    this.assertAlive();
    if (!this.services.has(id)) {
      if (this.parent) return this.parent.get(id);
      throw new Error(`Missing service: ${id}`);
    }
    const entry = this.services.get(id);
    if (!(entry instanceof SyncDescriptor)) return entry as T;
    if (this.resolving.includes(id)) {
      throw new Error(`Circular service dependency: ${[...this.resolving, id].join(' -> ')}`);
    }
    this.resolving.push(id);
    try {
      const instance = this.createInstance(entry.ctor, ...entry.staticArguments);
      this.owned.push(instance);
      this.assertAlive();
      if (this.services.get(id) === entry) this.services.set(id, instance);
      return instance;
    } finally {
      this.resolving.pop();
    }
  }

  /** Instances returned here belong to the caller, not to this service scope. */
  createInstance<T>(ctor: Constructor<T>, ...args: unknown[]): T {
    this.assertAlive();
    let target: object | null = ctor;
    let injections: readonly Dependency[] = [];
    while (target) {
      const entries = dependencies.get(target);
      if (entries) {
        injections = entries;
        break;
      }
      target = Object.getPrototypeOf(target) as object | null;
    }
    const byIndex = new Map(injections.map((entry) => [entry.index, entry.id]));
    const count = Math.max(
      ctor.length,
      args.length + injections.length,
      ...injections.map((d) => d.index + 1),
    );
    const parameters: unknown[] = [];
    let explicitIndex = 0;
    for (let index = 0; index < count; index++) {
      const id = byIndex.get(index);
      parameters.push(id ? this.get(id) : args[explicitIndex++]);
    }
    this.assertAlive();
    return new ctor(...parameters);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    // Schedule cleanup after publishing the promise, making reentrant disposal idempotent.
    this.disposal = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const child of [...this.children].reverse()) {
        try {
          await child.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      this.children.clear();
      const instances = [...new Set(this.owned)].reverse();
      this.owned.length = 0;
      for (const instance of instances) {
        try {
          if (instance && typeof (instance as IDisposable).dispose === 'function') {
            await (instance as IDisposable).dispose();
          }
        } catch (error) {
          errors.push(error);
        }
      }
      this.parent?.children.delete(this);
      if (errors.length) throw new AggregateError(errors, 'Failed to dispose services');
    });
    return this.disposal;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('InstantiationService is disposed');
    this.parent?.assertAlive();
  }
}
