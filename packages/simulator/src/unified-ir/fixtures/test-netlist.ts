import type { IRModule } from '@mica-js/ir';
import { PIN_MODE, type NetRuntime, type PinConnection, type UnifiedPinMemory } from '../types';

/** One validated net: its declared connections split by role. */
export interface PlannedNet {
  readonly netId: number;
  readonly drivers: readonly PinConnection[];
  readonly loads: readonly PinConnection[];
}

/**
 * Generates the electrical solve for one net into the unified module.
 *
 * ```text
 * solve_net_0:
 *   let mode      = PIN_MODE[driver]
 *   let output    = PIN_OUTPUT[driver]
 *   let driven    = mode == PUSH_PULL && output
 *   PIN_INPUT[load] = driven          // once per load pin
 * ```
 *
 * The prototype's rule is deliberately branch-free: only a push-pull driver
 * holds the net, every other mode (high-z, open-drain, analog) leaves it
 * floating and the loads read `false`. A net without a driver has no
 * `solve_net_*` body at all and keeps its previous input values.
 */
export function generateNetSolver(
  module: IRModule,
  net: PlannedNet,
  memory: UnifiedPinMemory,
): NetRuntime {
  const solve = module.func(`solve_net_${net.netId}`, { params: [], results: [] });
  solve.body((b) => {
    const driver = net.drivers[0];
    if (driver === undefined || net.loads.length === 0) {
      b.return([]);
      return;
    }
    const index = b.const('u32', driver.globalPinId);
    const mode = b.array.load(memory.mode, index);
    const output = b.array.load(memory.output, index);
    const pushed = b.int.cmp('eq', mode, b.const('u8', PIN_MODE.pushPull));
    const driven = b.bool.and(pushed, output);
    for (const load of net.loads) {
      b.array.store(memory.input, b.const('u32', load.globalPinId), driven);
    }
    b.return([]);
  });

  return Object.freeze({
    netId: net.netId,
    solve,
    drivers: net.drivers,
    loads: net.loads,
  });
}
