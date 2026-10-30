import type { FunctionBuilder, FunctionRef, IRModule, StateRef } from '@mica-js/ir';
import type { ElectricalOperations } from './electrical-operations';
import type { DeviceLoopEntry } from './device-gen';
import type { NetSolverRuntime } from './solver-gen';
import type { CompiledNetlist } from './types';

/** Generated entry-point names. */
export interface MainLoopNames {
  readonly tick: string;
  readonly initialize: string;
  readonly batch: string;
}

/** Names used when the caller does not override them. */
export const DEFAULT_ENTRY_POINT_NAMES: MainLoopNames = Object.freeze({
  tick: 'unified_tick',
  initialize: 'unified_initialize',
  batch: 'unified_tick_batch',
});

/** The generated main loop. */
export interface MainLoopOutput {
  readonly names: MainLoopNames;
  readonly initialize: FunctionRef<readonly [], readonly []>;
  readonly tick: FunctionRef<readonly [], readonly []>;
  readonly batch: FunctionRef<readonly ['u32'], readonly []>;
  readonly progress: StateRef<'u32'>;
  /** Device ids in dependency order. */
  readonly order: readonly string[];
}

/**
 * Generates the circuit entries.
 *
 * ```text
 * unified_initialize:                // once, before the first tick
 *   drive1_initialize()
 *   sink1_initialize()               // if the device has one
 *
 * unified_tick:                      // one simulation step
 *   drive1_tick()                    // drivers publish their outputs
 *   solve_net_0()                    // the electrical network resolves
 *   sink1_update()                   // loads observe the solved inputs
 *
 * unified_tick_batch(count):         // the same step, looped inside the IR
 *   for i in 0 .. count { <step> }
 * ```
 *
 * Devices run in dependency order: a device that drives a net executes before
 * every device that senses it. Feedback loops fall back to declaration order
 * after the topological prefix, so clock cycles stay valid.
 */
export class MainLoopGenerator {
  private readonly module: IRModule;

  constructor(
    module: IRModule,
    private readonly electrical?: ElectricalOperations,
  ) {
    this.module = module;
  }

  /** Stable topological order of the devices; cycles fall back to declaration order. */
  order(entries: readonly DeviceLoopEntry[], netlist: CompiledNetlist): readonly string[] {
    const indexById = new Map(entries.map((entry, index) => [entry.deviceId, index]));
    const consumers = new Map<string, Set<string>>();
    const indegree = new Map<string, number>(entries.map((entry) => [entry.deviceId, 0]));

    for (const net of netlist.nets) {
      const driverDevices = new Set(net.drivers.map((pin) => pin.deviceId));
      const sinkDevices = new Set(net.sinks.map((pin) => pin.deviceId));
      for (const driver of driverDevices) {
        for (const sink of sinkDevices) {
          if (driver === sink) continue;
          let targets = consumers.get(driver);
          if (targets === undefined) {
            targets = new Set();
            consumers.set(driver, targets);
          }
          if (targets.has(sink)) continue;
          targets.add(sink);
          indegree.set(sink, (indegree.get(sink) ?? 0) + 1);
        }
      }
    }

    const ready = new Set(
      entries
        .filter((entry) => (indegree.get(entry.deviceId) ?? 0) === 0)
        .map((entry) => entry.deviceId),
    );
    const order: string[] = [];
    while (ready.size > 0) {
      let nextId: string | undefined;
      let nextIndex = Number.POSITIVE_INFINITY;
      for (const id of ready) {
        const index = indexById.get(id) ?? 0;
        if (index < nextIndex) {
          nextIndex = index;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      ready.delete(nextId);
      order.push(nextId);
      for (const consumer of consumers.get(nextId) ?? []) {
        const remaining = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, remaining);
        if (remaining === 0) ready.add(consumer);
      }
    }
    for (const entry of entries) {
      if (!order.includes(entry.deviceId)) order.push(entry.deviceId);
    }
    return Object.freeze(order);
  }

  /** Generates `initialize`, `tick` and the batched tick loop. */
  generate(
    entries: readonly DeviceLoopEntry[],
    solvers: readonly NetSolverRuntime[],
    netlist: CompiledNetlist,
    names: MainLoopNames = DEFAULT_ENTRY_POINT_NAMES,
  ): MainLoopOutput {
    const order = this.order(entries, netlist);
    const byId = new Map(entries.map((entry) => [entry.deviceId, entry]));

    const electrical = this.electrical;
    electrical?.finalize();
    const progress = this.module.state(`${names.tick}_completed`, 'u32', 0);
    const collect = (phase: 'initialize' | 'tick' | 'update') =>
      order.flatMap((id) => {
        const ref = byId.get(id)?.[phase];
        return ref === undefined ? [] : [ref];
      });
    const ensure = electrical === undefined ? [] : [electrical.ensure];
    const phases = [
      ...collect('tick'),
      ...solvers.map((solver) => solver.solve),
      ...ensure,
      ...collect('update'),
      ...ensure,
    ];
    const emitCalls = (
      b: FunctionBuilder<readonly []>,
      calls: readonly FunctionRef<readonly [], readonly []>[],
      finish: (b: FunctionBuilder<readonly []>) => undefined,
    ): undefined => {
      if (electrical === undefined) {
        for (const call of calls) b.call(call, []);
        return finish(b);
      }
      const emit = (b: FunctionBuilder<readonly []>, at: number): undefined => {
        const next = b.block([]);
        const failed = b.block([]);
        b.branch(
          b.int.cmp('eq', b.state.load(electrical.solver.fault), b.const('u8', 0)),
          { target: next, args: [] },
          { target: failed, args: [] },
        );
        b.at(failed, (b) => b.return([]));
        b.at(next, (b) => {
          const call = calls[at];
          if (call === undefined) return finish(b);
          b.call(call, []);
          return emit(b, at + 1);
        });
      };
      return emit(b, 0);
    };
    const completed = (b: FunctionBuilder<readonly []>): void => {
      if (electrical !== undefined) b.call(electrical.advanceTime, []);
      b.state.store(progress, b.int.add(b.state.load(progress), b.const('u32', 1)));
    };
    const initialize = this.module.func(names.initialize, { params: [], results: [] });
    initialize.body((b) =>
      emitCalls(b, [...collect('initialize'), ...ensure], (b) => b.return([])),
    );
    const tick = this.module.func(names.tick, { params: [], results: [] });
    tick.body((b) => {
      b.state.store(progress, b.const('u32', 0));
      return emitCalls(b, phases, (b) => {
        completed(b);
        b.return([]);
      });
    });
    const batch = this.module.func(names.batch, { params: ['u32'], results: [] });
    batch.body((b, [count]) => {
      const header = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block([]);
      b.state.store(progress, b.const('u32', 0));
      b.jump(header, [b.const('u32', 0)]);
      b.at(header, (b, [index]) =>
        b.branch(
          b.int.cmp('lt', index, count),
          { target: body, args: [index] },
          { target: done, args: [] },
        ),
      );
      b.at(body, (b, [index]) =>
        emitCalls(b, phases, (b) => {
          completed(b);
          b.jump(header, [b.int.add(index, b.const('u32', 1))]);
        }),
      );
      b.at(done, (b) => b.return([]));
    });

    return Object.freeze({
      names,
      initialize,
      tick,
      batch,
      progress,
      order,
    });
  }
}
