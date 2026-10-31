import { toNumber, type IRStorage } from '@mica-js/ir';
import type { AllocatedElectricalNetwork } from '../unified-ir/compiler/electrical-network';
import { electricalFaultContext } from '../unified-ir/compiler/electrical-diagnostics';
import type { ElectricalOperations } from '../unified-ir/compiler/electrical-operations';
import type { ResistiveSolver } from '../unified-ir/compiler/resistive-solver';

/**
 * Internal readback of one solved circuit.
 *
 * The electrical solve, current orientation and active diagnostics stay inside
 * the simulator, but no host surface exposes them: RFC 0017 routes every
 * externally visible value through device topics. These helpers exist for the
 * solver suites and benchmarks, which need the raw numerical snapshot.
 */

import type { ElectricalCurrentTarget } from '../unified-ir/compiler/electrical-diagnostics';
export type { ElectricalCurrentTarget } from '../unified-ir/compiler/electrical-diagnostics';

export type ElectricalReading =
  | { readonly state: 'determinate'; readonly value: number }
  | { readonly state: 'floating' }
  | { readonly state: 'indeterminate' };

/** Active diagnostics of the last published electrical snapshot, plus any latched solve fault. */
export type ElectricalDiagnostic =
  | {
      readonly code: 'electrical/overcurrent';
      readonly severity: 'warning';
      readonly target: ElectricalCurrentTarget;
      readonly current: number;
      readonly maxAbsCurrent: number;
    }
  | {
      readonly code:
        | 'electrical/invalid-parameter'
        | 'electrical/source-conflict'
        | 'electrical/numerical-failure';
      readonly severity: 'error';
      /** Identifiable failed operation or resource; absent for a matrix-level failure. */
      readonly target?: ElectricalCurrentTarget;
      /** Resources associated with the affected network, not a list of proven culprits. */
      readonly resources: readonly ElectricalCurrentTarget[];
      readonly pins: readonly string[];
    };

function pinLocation(
  allocation: AllocatedElectricalNetwork,
  pinName: string,
): { readonly device: string; readonly pin: string } {
  const dot = pinName.indexOf('.');
  const device = dot <= 0 ? undefined : allocation.pins.get(pinName.slice(0, dot));
  const pin = device?.get(pinName.slice(dot + 1));
  if (pin === undefined) {
    const available = [...allocation.pins].flatMap(([deviceId, pins]) =>
      [...pins.keys()].map((name) => `${deviceId}.${name}`),
    );
    throw new Error(
      `Pin "${pinName}" not found. Available: ${available.length === 0 ? '(none)' : `[${available.join(', ')}]`}`,
    );
  }
  return { device: pinName.slice(0, dot), pin: pinName.slice(dot + 1) };
}

/** Solved digital input level after the circuit interpretation. */
export function electricalDigitalSample(
  allocation: AllocatedElectricalNetwork,
  operations: ElectricalOperations,
  storage: IRStorage,
  pinName: string,
): boolean {
  const { device, pin } = pinLocation(allocation, pinName);
  if (allocation.pins.get(device)?.get(pin)?.input === undefined) {
    throw new Error(`Pin "${pinName}" has no digital input capability`);
  }
  return storage.loadArray(operations.digitalSample, operations.pinIndices.get(pinName)!) === true;
}

/** Physical pin voltage; floating results never contain a synthetic voltage. */
export function electricalVoltage(
  allocation: AllocatedElectricalNetwork,
  solver: ResistiveSolver,
  storage: IRStorage,
  pinName: string,
): ElectricalReading {
  const { device, pin } = pinLocation(allocation, pinName);
  return electricalReading(
    solver.voltage,
    solver.voltageState,
    storage,
    allocation.pins.get(device)!.get(pin)!.node,
  );
}

/** Resistor/contact currents follow endpoint order; source and pin contributions flow outward. */
export function electricalCurrent(
  allocation: AllocatedElectricalNetwork,
  solver: ResistiveSolver,
  storage: IRStorage,
  resource: string | ElectricalCurrentTarget,
): ElectricalReading {
  const missing = (): never => {
    throw new Error(`Unknown electrical current resource ${JSON.stringify(resource)}`);
  };
  let target: ElectricalCurrentTarget;
  if (typeof resource === 'string') {
    const dot = resource.indexOf('.');
    if (dot <= 0) throw new Error(`Unknown resistor "${resource}"`);
    target = { kind: 'resistor', device: resource.slice(0, dot), name: resource.slice(dot + 1) };
  } else if (resource !== null && typeof resource === 'object') target = resource;
  else return missing();
  if (target.kind === 'resistor' || target.kind === 'contact') {
    const contact = target.kind === 'contact';
    const index = (contact ? allocation.contacts : allocation.resistors)
      .get(target.device)
      ?.get(target.name);
    if (index === undefined) {
      if (typeof resource === 'string') throw new Error(`Unknown resistor "${resource}"`);
      return missing();
    }
    return electricalReading(
      contact ? solver.contactCurrent : solver.current,
      contact ? solver.contactCurrentState : solver.currentState,
      storage,
      index,
    );
  }
  if (target.kind === 'source') {
    const index = allocation.sources.get(target.name);
    if (index === undefined) return missing();
    return electricalReading(solver.sourceCurrent, solver.sourceCurrentState, storage, index);
  }
  if (target.kind !== 'drive' && target.kind !== 'pull-up' && target.kind !== 'pull-down')
    return missing();
  const pin = allocation.pins.get(target.device)?.get(target.pin);
  if (pin === undefined) return missing();
  const branches =
    target.kind === 'drive'
      ? pin.drive === undefined
        ? undefined
        : [
            pin.drive.high,
            pin.drive.low,
            ...(pin.drive.analog === undefined ? [] : [pin.drive.analog.resistor]),
          ]
      : pin.bias === undefined
        ? undefined
        : [target.kind === 'pull-up' ? pin.bias.up : pin.bias.down];
  if (branches === undefined) return missing();
  let value = 0;
  for (const index of branches) {
    const current = electricalReading(solver.current, solver.currentState, storage, index);
    if (current.state !== 'determinate') return current;
    value -= current.value;
  }
  return { state: 'determinate', value };
}

/** Pull-based active diagnostics: one warning per resource; successful recovery removes it. */
export function electricalDiagnostics(
  allocation: AllocatedElectricalNetwork,
  solver: ResistiveSolver,
  storage: IRStorage,
): readonly ElectricalDiagnostic[] {
  const diagnostics: ElectricalDiagnostic[] = [];
  const check = (target: ElectricalCurrentTarget, limit: number | undefined) => {
    if (limit === undefined) return;
    const current = electricalCurrent(allocation, solver, storage, target);
    if (current.state === 'determinate' && Math.abs(current.value) > limit)
      diagnostics.push(
        Object.freeze({
          code: 'electrical/overcurrent',
          severity: 'warning',
          target: Object.freeze(target),
          current: current.value,
          maxAbsCurrent: limit,
        }),
      );
  };
  for (const [device, resistors] of allocation.resistors)
    for (const [name, index] of resistors)
      check({ kind: 'resistor', device, name }, allocation.currentLimits.get(index));
  for (const [device, pins] of allocation.pins)
    for (const [pin, description] of pins)
      check({ kind: 'drive', device, pin }, description.drive?.maxAbsCurrent);
  const fault = storage.loadState(solver.fault);
  if (fault !== 0)
    diagnostics.push(
      Object.freeze({
        code:
          fault === 1
            ? 'electrical/invalid-parameter'
            : fault === 2
              ? 'electrical/source-conflict'
              : 'electrical/numerical-failure',
        severity: 'error',
        ...electricalFaultContext(allocation, solver, storage),
      }),
    );
  return Object.freeze(diagnostics);
}

function electricalReading(
  values: ElectricalOperations['solver']['voltage'],
  states: ElectricalOperations['solver']['voltageState'],
  storage: IRStorage,
  index: number,
): ElectricalReading {
  const state = storage.loadArray(states, index);
  if (state === 1) return { state: 'floating' };
  if (state === 2) return { state: 'indeterminate' };
  return { state: 'determinate', value: toNumber(storage.loadArray(values, index)) };
}
