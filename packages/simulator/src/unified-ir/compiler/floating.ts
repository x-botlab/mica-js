import type { IRModule } from '@mica-js/ir';
import { hashTopology } from '../runtime/floating';
import type { CompiledFloating, CompiledNetlist } from './types';

/**
 * RFC 0002 §4.5 — the compile-time half of floating sampling.
 *
 * The solver generator and the main loop need three things that only the
 * compiled netlist can supply:
 *
 * - **which nets float** — no strong driver and no rail. Such a node has no
 *   source of its own, so an unbiased one samples noise instead of reading a
 *   constant `false`;
 * - **the circuit seed** — a hash of the netlist, so the sequence is a property
 *   of the topology and two different circuits never flap in lockstep;
 * - **the sample clock** — two `u32` words of picoseconds since reset. The main
 *   loop advances them once per tick and every floating solver reads them, so
 *   the sample is a pure function of the time instead of hidden state.
 *
 * The clock is only allocated when at least one net actually samples, so a
 * circuit without floating nets keeps its previous memory layout.
 */

/** Name of the generated clock memory. */
export const FLOATING_CLOCK_MEMORY = 'floating_clock';

/** Picoseconds one circuit tick represents; mirrors `TICK_PS` in the runtime. */
export const FLOATING_TICK_PS = 1_000_000;

/**
 * Plans the floating sample of a compiled netlist.
 *
 * The netlist is already the canonical form of the circuit — nets in analysis
 * order, pins in declaration order — so hashing it gives a seed that is stable
 * across runs and sensitive to the wiring. Only nets with at least one sensing
 * pin are listed: a net nobody reads cannot influence the simulation, and
 * sampling it would allocate a clock for nothing.
 *
 * @param isSwitchable - Reports whether a net is an endpoint of a declared
 *   switch. Such a node is held by the connection lowering while its contact is
 *   closed and reads the settled low level while it is open, so it never
 *   samples: dynamic connectivity keeps the deterministic open level instead of
 *   adding noise to a deliberate disconnect.
 */
export function planFloating(
  module: IRModule,
  netlist: CompiledNetlist,
  isSwitchable: (netId: number) => boolean = () => false,
): CompiledFloating {
  const nets = netlist.nets
    .filter(
      (net) =>
        isFloating(net.drivers.length, net.rails.length) &&
        net.sinks.length > 0 &&
        !isSwitchable(net.netId),
    )
    .map((net) => net.netId);
  const seed = hashTopology(topologyParts(netlist));
  return Object.freeze({
    seed,
    nets: Object.freeze(nets),
    ...(nets.length === 0 ? {} : { clock: module.array(FLOATING_CLOCK_MEMORY, 'u32', [0, 0]) }),
  });
}

/**
 * Whether a node is left floating: no strong driver and no rail.
 *
 * Weak biases are a run-time property of `pin_pull`, so they cannot be decided
 * here; the emitted solver samples the noise only where no pin pulls up or
 * down either (see `emitNetLevel`).
 */
export function isFloating(driverCount: number, railCount: number): boolean {
  return driverCount === 0 && railCount === 0;
}

/** Canonical, order-stable description of the netlist used for the seed. */
function topologyParts(netlist: CompiledNetlist): readonly string[] {
  const parts: string[] = [];
  for (const net of netlist.nets) {
    const rails = net.rails.map((rail) => `${rail.name}:${rail.level ? 1 : 0}`).sort();
    const pins = net.pins.map((pin) => `${pin.endpoint}:${pin.role}`).sort();
    parts.push(`${net.netId}(${rails.join(',')})[${pins.join(',')}]`);
  }
  return parts;
}
