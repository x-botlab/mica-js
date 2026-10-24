import type { FunctionBuilder, FunctionRef, IRModule } from '@mica-js/ir';
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
  /** Device ids in dependency order. */
  readonly order: readonly string[];
}

/**
 * Generates the circuit entries.
 *
 * ```text
 * unified_initialize:                // once, before the first tick
 *   mcu1_initialize()
 *   led1_initialize()                // if the device has one
 *
 * unified_tick:                      // one simulation step
 *   mcu1_tick()                      // drivers publish their outputs
 *   solve_net_0()                    // the electrical network resolves
 *   led1_update()                    // loads observe the solved inputs
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

  constructor(module: IRModule) {
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

    const emitStep = (b: FunctionBuilder<readonly []>): void => {
      for (const deviceId of order) {
        const entry = byId.get(deviceId);
        if (entry?.tick !== undefined) b.call(entry.tick, []);
      }
      for (const solver of solvers) b.call(solver.solve, []);
      for (const deviceId of order) {
        const entry = byId.get(deviceId);
        if (entry?.update !== undefined) b.call(entry.update, []);
      }
    };

    const initialize = this.module.func(names.initialize, { params: [], results: [] });
    initialize.body((b) => {
      for (const deviceId of order) {
        const entry = byId.get(deviceId);
        if (entry?.initialize !== undefined) b.call(entry.initialize, []);
      }
      b.return([]);
    });

    const tick = this.module.func(names.tick, { params: [], results: [] });
    tick.body((b) => {
      emitStep(b);
      b.return([]);
    });

    // The batch entry keeps the loop inside the IR: one engine call per batch
    // instead of one host entry per tick, which is the throughput path.
    const batch = this.module.func(names.batch, { params: ['u32'], results: [] });
    batch.body((b, [count]) => {
      const header = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block([]);
      b.jump(header, [b.const('u32', 0)]);
      b.at(header, (ib, [index]) =>
        ib.branch(
          ib.int.cmp('lt', index, count),
          { target: body, args: [index] },
          { target: done, args: [] },
        ),
      );
      b.at(body, (ib, [index]) => {
        emitStep(ib);
        ib.jump(header, [ib.int.add(index, ib.const('u32', 1))]);
      });
      b.at(done, (ib) => ib.return([]));
    });

    return Object.freeze({
      names,
      initialize,
      tick,
      batch,
      order,
    });
  }
}
