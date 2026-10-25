import type { ArrayRef, FunctionBuilder, Value } from '@mica-js/ir';
import type { CompiledCircuitMemory, DevicePowerDomainSlot, GlobalPowerDomainMap } from './types';

/**
 * Boolean power-domain gating (RFC 0007).
 *
 * A power domain is one `bool` in the shared `power_ready` array: `true` =
 * powered, `false` = the domain is unpowered. The array is seeded `true`, so a
 * circuit is fully powered until the host turns a domain off; `Circuit.turnOn` /
 * `turnOff` are the only writers at run time, and `Circuit.reset()` restores the
 * all-on seed.
 *
 * An unpowered domain gates three things:
 *
 * ```text
 * drive   solve_net_<id>  : a released driver stops holding its net
 * sample  pin.sampleDigital / Circuit.getPin : reads the determinate level 0
 * logic   unified_tick    : the device's own tick/update phases are skipped
 * ```
 *
 * Gating is emitted as compile-time array loads plus `bool.and` / `select`, so a
 * gated read stays one typed-array load and one select — no host boundary.
 * `voltage` is carried in {@link GlobalPowerDomainMap} and exposed as
 * {@link PowerGating.domainVoltages}: the RFC 0002 voltage solver uses it as the
 * high level of a bound pin and to seed that pin's thresholds.
 */

/** Resolved gating surface shared by every generator. */
export interface PowerGating {
  /** `power_ready` array; one bool per declared domain. */
  readonly ready: ArrayRef<'bool'>;
  /** Device id -> declared domains, in declaration order. */
  readonly devices: ReadonlyMap<string, ReadonlyMap<string, DevicePowerDomainSlot>>;
  /** Global pin id -> index of the domain gating that pin. */
  readonly pinDomains: ReadonlyMap<number, number>;
  /** Device id -> index of its primary (first declared) domain. */
  readonly primary: ReadonlyMap<string, number>;
  /**
   * Domain index -> nominal supply voltage (RFC 0002 §5), in declaration
   * order. The voltage solver uses it as the high level of a pin that belongs
   * to a domain, so a 5 V device drives 5 V without a per-pin model.
   */
  readonly domainVoltages: readonly number[];
}

/**
 * Builds the gating surface, or `undefined` when the circuit declares no power
 * domain and every generator can emit its ungated fast path.
 */
export function createPowerGating(
  memory: CompiledCircuitMemory,
  domains: GlobalPowerDomainMap,
): PowerGating | undefined {
  const ready = memory.powerReady;
  if (ready === undefined || domains.totalDomains === 0) return undefined;
  return Object.freeze({
    ready,
    devices: domains.devices,
    pinDomains: domains.pinDomains,
    primary: domains.primary,
    domainVoltages: Object.freeze(domains.slots.map((slot) => slot.voltage)),
  });
}

/**
 * Emits the readiness predicate of one pin, or `undefined` when the pin is not
 * bound to a domain (a device without domains keeps the always-powered path).
 */
export function emitPinPowered(
  builder: FunctionBuilder<readonly []>,
  gating: PowerGating | undefined,
  globalPinId: number,
): Value<'bool'> | undefined {
  if (gating === undefined) return undefined;
  return emitDomainReady(builder, gating, gating.pinDomains.get(globalPinId));
}

/**
 * Emits the readiness predicate of one device's own logic (its primary domain),
 * or `undefined` when the device declares no domain.
 */
export function emitDevicePowered(
  builder: FunctionBuilder<readonly []>,
  gating: PowerGating | undefined,
  deviceId: string,
): Value<'bool'> | undefined {
  if (gating === undefined) return undefined;
  return emitDomainReady(builder, gating, gating.primary.get(deviceId));
}

/**
 * Gates a value on a readiness predicate: unpowered reads the determinate level
 * `false` (digital `0`, analog `+0`), which is the RFC's sampling rule.
 */
export function selectPowered(
  builder: FunctionBuilder<readonly []>,
  powered: Value<'bool'> | undefined,
  value: Value<'bool'>,
): Value<'bool'> {
  if (powered === undefined) return value;
  return builder.select(powered, value, builder.const('bool', false));
}

function emitDomainReady(
  builder: FunctionBuilder<readonly []>,
  gating: PowerGating,
  index: number | undefined,
): Value<'bool'> | undefined {
  if (index === undefined) return undefined;
  return builder.array.load(gating.ready, builder.const('u32', index));
}
