import type { FunctionBuilder, FunctionRef, IRModule, Value } from '@mica-js/ir';
import { PIN_MODE } from '../pin-space';
import type {
  CompiledCircuitMemory,
  CompiledNet,
  CompiledNetlist,
  CompiledPinConnection,
} from './types';

/** One generated net solver. */
export interface NetSolverRuntime {
  readonly netId: number;
  /** Generated `solve_net_<id>`. */
  readonly name: string;
  readonly net: CompiledNet;
  readonly solve: FunctionRef<readonly [], readonly []>;
}

/** Everything the solver generator reads from the prior compilation stages. */
export interface SolverGenerationContext {
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
}

/**
 * Generates the electrical solve, one `solve_net_<id>` function per net.
 *
 * Single driver — the only shape v1 compiles without `allowMultiDriver` — is a
 * branch-free path:
 *
 * ```text
 * solve_net_0:
 *   let mode   = PIN_MODE[driver]
 *   let output = PIN_OUTPUT[driver]
 *   let driven = mode == PUSH_PULL && output
 *   PIN_INPUT[load] = driven          // once per sink
 * ```
 *
 * Only a push-pull driver holds its net; high-z, open-drain and analog modes
 * leave it floating. A driver-less net loads the constant of its rail, or
 * `false` when it is truly floating.
 */
export class ElectricalSolverGenerator {
  private readonly context: SolverGenerationContext;

  constructor(context: SolverGenerationContext) {
    this.context = context;
  }

  generate(netlist: CompiledNetlist): readonly NetSolverRuntime[] {
    return Object.freeze(netlist.nets.map((net) => this.generateNetSolver(net)));
  }

  private generateNetSolver(net: CompiledNet): NetSolverRuntime {
    const name = `solve_net_${net.netId}`;
    const solve = this.context.module.func(name, { params: [], results: [] });

    solve.body((b) => {
      if (net.sinks.length > 0) {
        const driven =
          net.drivers.length === 0
            ? b.const('bool', net.level)
            : this.combineDrivers(b, net.drivers);
        if (driven !== undefined) {
          for (const sink of net.sinks) {
            b.array.store(this.context.memory.input, b.const('u32', sink.globalPinId), driven);
          }
        }
      }
      b.return([]);
    });

    return Object.freeze({ netId: net.netId, name, net, solve });
  }

  /**
   * Folds the drivers of one net into the level its sinks observe.
   *
   * A single driver yields `mode == push-pull && output`; several drivers (only
   * reachable with `allowMultiDriver`) are OR-ed into a wired-OR level.
   */
  private combineDrivers(
    b: FunctionBuilder<readonly []>,
    drivers: readonly CompiledPinConnection[],
  ): Value<'bool'> | undefined {
    let driven: Value<'bool'> | undefined;
    for (const driver of drivers) {
      const index = b.const('u32', driver.globalPinId);
      const mode = b.array.load(this.context.memory.mode, index);
      const output = b.array.load(this.context.memory.output, index);
      const pushed = b.int.cmp('eq', mode, b.const('u8', PIN_MODE.pushPull));
      const value = b.bool.and(pushed, output);
      driven = driven === undefined ? value : b.bool.or(driven, value);
    }
    return driven;
  }
}
