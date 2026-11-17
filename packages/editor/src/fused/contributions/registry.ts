import type { ICondition, IContextKeyService } from '../context';
import type {
  IWorkbenchContributions,
  IWorkbenchToolbarItem,
  IWorkbenchView,
  IWorkbenchViewContainer,
} from '../types';

type Contribution = IWorkbenchViewContainer | IWorkbenchView | IWorkbenchToolbarItem;

export class ContributionRegistry {
  readonly containers: readonly IWorkbenchViewContainer[];
  readonly views: readonly IWorkbenchView[];
  readonly toolbar: readonly IWorkbenchToolbarItem[];
  readonly #conditions = new Map<string, ICondition>();
  readonly #context: IContextKeyService;

  constructor(
    context: IContextKeyService,
    builtin: IWorkbenchContributions,
    host: IWorkbenchContributions = {},
  ) {
    this.#context = context;
    const ids = new Set<string>();
    const collect = <T extends Contribution>(
      defaults: readonly T[] = [],
      additions: readonly T[] = [],
    ): readonly T[] => {
      for (const item of additions)
        if (item.id.startsWith('mica.')) throw new Error(`Reserved contribution ID: ${item.id}`);
      return Object.freeze(
        [...defaults, ...additions]
          .map((item) => {
            if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(item.id))
              throw new Error(`Contribution IDs must be namespaced: ${item.id}`);
            if (ids.has(item.id)) throw new Error(`Duplicate contribution ID: ${item.id}`);
            if (!item.title.trim()) throw new Error(`Missing contribution title: ${item.id}`);
            if (item.order !== undefined && !Number.isFinite(item.order))
              throw new Error(`Invalid contribution order: ${item.id}`);
            ids.add(item.id);
            if (item.when !== undefined)
              this.#conditions.set(`${item.id}:when`, context.compile(item.when));
            if ('enablement' in item && typeof item.enablement === 'string')
              this.#conditions.set(`${item.id}:enablement`, context.compile(item.enablement));
            const copy: T = { ...item };
            Object.freeze(copy);
            return copy;
          })
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)),
      );
    };
    this.containers = collect(builtin.containers, host.containers);
    this.views = collect(builtin.views, host.views);
    this.toolbar = Object.freeze(
      [...collect(builtin.toolbar, host.toolbar)].sort(
        (a, b) =>
          (a.group ?? '').localeCompare(b.group ?? '') ||
          (a.order ?? 0) - (b.order ?? 0) ||
          a.id.localeCompare(b.id),
      ),
    );
    for (const item of this.containers)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.icon))
        throw new Error(`Invalid container icon: ${item.id}`);
    for (const view of this.views)
      if (!this.containers.some((container) => container.id === view.containerId))
        throw new Error(`Unknown view container ${view.containerId} for ${view.id}`);
    for (const view of this.views)
      if (typeof view.mount !== 'function') throw new Error(`Missing view mount: ${view.id}`);
    for (const item of this.toolbar) {
      if (typeof item.execute !== 'function')
        throw new Error(`Missing toolbar execute: ${item.id}`);
      if (item.icon !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.icon))
        throw new Error(`Invalid toolbar icon: ${item.id}`);
    }
  }

  visible(item: Contribution, context = this.#context): boolean {
    const condition = this.#conditions.get(`${item.id}:when`);
    return condition === undefined || context.evaluate(condition);
  }

  enabled(item: IWorkbenchToolbarItem, context = this.#context): boolean {
    const condition = this.#conditions.get(`${item.id}:enablement`);
    return condition === undefined || context.evaluate(condition);
  }

  affected(names: ReadonlySet<string>): boolean {
    return [...this.#conditions.values()].some((condition) =>
      [...condition.keys].some((key) => names.has(key)),
    );
  }
}
