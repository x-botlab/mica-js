import type { FunctionBuilder, FunctionRef, IRModule, StateRef } from '@mica-js/ir';
import type { ElectricalOperations } from './electrical-operations';
import type { DeviceLoopEntry } from './device-gen';

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
  /** Device ids in declaration order. */
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
 *   electrical_ensure()             // solve only if the network changed
 *   sink1_update()                   // loads observe the solved inputs
 *
 * unified_tick_batch(count):         // the same step, looped inside the IR
 *   for i in 0 .. count { <step> }
 * ```
 *
 * Devices run in declaration order, with all tick phases before update phases.
 * Typed electrical sampling ensures pending network changes are solved.
 */
export class MainLoopGenerator {
  private readonly module: IRModule;

  constructor(
    module: IRModule,
    private readonly electrical: ElectricalOperations,
  ) {
    this.module = module;
  }

  /** Generates `initialize`, `tick` and the batched tick loop. */
  generate(
    entries: readonly DeviceLoopEntry[],
    names: MainLoopNames = DEFAULT_ENTRY_POINT_NAMES,
  ): MainLoopOutput {
    const order = Object.freeze(entries.map((entry) => entry.deviceId));
    const byId = new Map(entries.map((entry) => [entry.deviceId, entry]));

    const electrical = this.electrical;
    electrical.finalize();
    const progress = this.module.state(`${names.tick}_completed`, 'u32', 0);
    const collect = (phase: 'initialize' | 'tick' | 'update') =>
      order.flatMap((id) => {
        const ref = byId.get(id)?.[phase];
        return ref === undefined ? [] : [ref];
      });
    const ensure = [electrical.ensure];
    const phases = [...collect('tick'), ...ensure, ...collect('update'), ...ensure];
    const emitCalls = (
      b: FunctionBuilder<readonly []>,
      calls: readonly FunctionRef<readonly [], readonly []>[],
      finish: (b: FunctionBuilder<readonly []>) => undefined,
    ): undefined => {
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
      b.call(electrical.advanceTime, []);
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
